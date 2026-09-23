// Builds docs/index.html — a public, read-only table of Trades Thursday
// Regional events for pros, matching the internal dashboard's Regional
// table layout (Event/Host, Status, Venue Type, Registered) — no login.
// Also builds one docs/events/{id}.html per event: registrations,
// companies, a companies-distribution chart, a user-by-title chart, and a
// plain registrant list (first name + company only — see the privacy note
// on fetchEventMembers below for why nothing more identifying is shown).
//
// Data sources:
//   - Goldcast (GOLDCAST_API_TOKEN secret): event identity/timing/venue type,
//     and per-event registrant records (event-members endpoint).
//   - Airtable (AIRTABLE_API_KEY secret, optional): Host Name only — a
//     dedicated, narrowly-scoped read-only token, separate from the
//     internal dashboard's own key. If this secret isn't set yet, the Host
//     column just renders "—" rather than failing the whole build.
//   - Snowflake, queried directly by this script — see fetchActiveOrgEmails
//     below. Independent of the private dashboard/Vercel entirely.
//     Registrant emails are matched in memory and immediately reduced to
//     two counts per event; the emails themselves are never written to
//     disk or into the generated HTML, only the resulting numbers. Same
//     "don't fail the whole build" pattern as Airtable above: missing
//     config or a failed query just leaves the HCP / Non-HCP column at
//     "— / —".
//
// The event-members endpoint carries each registrant's email and phone
// number too, but this is a public, search-indexable, no-login site — only
// first name + company are ever pulled into the generated HTML. Never
// fetches/renders phone, email, last name, payout, or attendance data.

const GOLDCAST_BASE_URL = "https://customapi.goldcast.io";
const AIRTABLE_BASE_URL = "https://api.airtable.com/v0";
const AIRTABLE_BASE_ID = "apppUZpHj2G87aOUL";
const CONFIRMED_EVENTS_TABLE_ID = "tbl5JUSq8O02BiNCh";
// Identical query to the private dashboard's lib/snowflake.ts —
// intentionally kept in sync rather than imported, since these are two
// separate repos with two separate deploy targets.
const ACTIVE_ORG_EMAILS_QUERY = `
  SELECT LOWER(best_email) AS EMAIL
  FROM analytics.main.dim_organization
  WHERE excluded_org = 0 AND best_email IS NOT NULL
  UNION
  SELECT LOWER(c.contact_email) AS EMAIL
  FROM analytics.main.dim_salesforce_contact c
  JOIN analytics.main.dim_organization o
    ON o.organization_id = c.organization_id
  WHERE o.excluded_org = 0 AND c.contact_email IS NOT NULL
`;

async function fetchActiveOrgEmails(config) {
  const required = ["account", "username", "warehouse", "role", "privateKey", "privateKeyPass"];
  if (required.some((k) => !config[k])) {
    console.warn("Snowflake config incomplete — HCP / Non-HCP column will show \"— / —\"");
    return null;
  }

  const snowflake = (await import("snowflake-sdk")).default;
  snowflake.configure({
    customLogger: {
      error: (m) => console.error(m),
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
  });

  const connection = snowflake.createConnection({
    account: config.account,
    username: config.username,
    authenticator: "SNOWFLAKE_JWT",
    privateKey: config.privateKey,
    privateKeyPass: config.privateKeyPass,
    warehouse: config.warehouse,
    role: config.role,
  });

  try {
    await new Promise((resolve, reject) => {
      connection.connect((err) => (err ? reject(err) : resolve()));
    });
    const rows = await new Promise((resolve, reject) => {
      connection.execute({
        sqlText: ACTIVE_ORG_EMAILS_QUERY,
        complete: (err, _stmt, r) => (err ? reject(err) : resolve(r ?? [])),
      });
    });
    return new Set(rows.map((r) => r.EMAIL).filter((e) => typeof e === "string"));
  } catch (err) {
    console.warn("Snowflake query failed:", err.message);
    return null;
  } finally {
    await new Promise((resolve) => connection.destroy(() => resolve()));
  }
}

const PROGRAM_PREFIX = /trades thursday/i;
const REGIONAL_PATTERN = /regional/i;
const PLACEHOLDER_TITLE = /\[city\]/i;

const CITY_STATE = {
  denver: "CO", minneapolis: "MN", phoenix: "AZ", "las vegas": "NV",
  "san diego": "CA", seattle: "WA", sausalito: "CA", austin: "TX",
  houston: "TX", dallas: "TX", miami: "FL", chicago: "IL", tampa: "FL",
  charlotte: "NC", orlando: "FL", atlanta: "GA", philadelphia: "PA",
  "new york": "NY", "los angeles": "CA", cleveland: "OH", nashville: "TN",
  columbus: "OH",
};

const VENUE_TYPE_TAG_MAP = {
  "4b2f31b0-d49a-40ca-931e-448c17fec4c7": "Bar",
  "fd1e4f34-74c7-4cff-9343-eeee0f878ac7": "Restaurant",
  "19ba251c-d1fb-417c-afae-7b61721b4488": "Catering",
  "cbc128de-db3c-46f2-a175-badb9682d3f6": "Other",
};

// Donut/bar palette — matches the internal dashboard's --chart-1/--chart-2
// pairing philosophy (distinct, non-brand hues) extended out to 10 slots
// plus a neutral "Other" grey.
const CHART_COLORS = [
  "#003a6d", "#c2410c", "#1e40af", "#be185d", "#0891b2",
  "#7c3aed", "#b45309", "#4d7c0f", "#9d174d", "#334155",
];
const CHART_OTHER_COLOR = "#9ca3af";

function displayNameFromTitle(title) {
  const match = title.match(/trades thursday\s*[:—-]\s*(.+)/i);
  return match ? match[1].trim() : title;
}

function cityFromDisplayName(displayName) {
  const city = displayName.replace(/regional hub|regional meetup/i, "").trim();
  return { city, state: CITY_STATE[city.toLowerCase()] ?? "" };
}

function venueTypeFromTags(tags) {
  if (!tags) return "";
  for (const t of tags) {
    if (VENUE_TYPE_TAG_MAP[t]) return VENUE_TYPE_TAG_MAP[t];
  }
  return "";
}

async function fetchAllPages(url, token) {
  const events = [];
  let next = url;
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) throw new Error(`Goldcast fetch failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    events.push(...data.results);
    next = data.next;
  }
  return events;
}

async function fetchEventDetail(id, token) {
  const res = await fetch(`${GOLDCAST_BASE_URL}/event/${id}/`, {
    headers: { Authorization: `Token ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// Real endpoint, confirmed live 2026-09-17 (already used server-side by the
// internal dashboard's fetchCheckInStaffHosts, lib/goldcast.ts) — each
// result carries user.first_name/last_name/email/phone_number/company/
// title. Only first_name, last_name, and company are read out of it here;
// email/phone_number are never touched, even though this endpoint carries
// them — this is a public, no-login, search-indexable site.
async function fetchEventMembers(eventId, token) {
  const members = [];
  let next = `${GOLDCAST_BASE_URL}/event/event-members/?event=${eventId}&limit=250`;
  while (next) {
    const res = await fetch(next, { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) return members; // best-effort — an unreachable event just gets empty analytics, not a failed build
    const data = await res.json();
    members.push(...data.results);
    next = data.next;
  }
  return members;
}

// Only "Registered" rows count — same rule the private dashboard's
// Audience Mix uses (see lib/data.ts's classifyAudience). Immediately
// reduces to two counts; the emails themselves never leave this function.
function classifyAudienceMix(members, activeOrgEmails) {
  if (!activeOrgEmails) return { hcpCustomers: null, nonCustomers: null };
  let hcp = 0;
  let non = 0;
  for (const m of members) {
    if (m.status !== "Registered") continue;
    const email = m.user?.email?.trim().toLowerCase();
    if (!email) continue;
    if (activeOrgEmails.has(email)) hcp++;
    else non++;
  }
  return { hcpCustomers: hcp, nonCustomers: non };
}

function computeAnalytics(members) {
  const companyCounts = new Map();
  const titleCounts = new Map();
  const registrants = [];

  for (const m of members) {
    const firstName = m.user?.first_name?.trim();
    const lastName = m.user?.last_name?.trim();
    const company = m.user?.company?.trim();
    const title = m.user?.title?.trim();

    if (company) companyCounts.set(company, (companyCounts.get(company) ?? 0) + 1);
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    if (fullName) registrants.push({ name: fullName, company: company || "—" });
  }

  const sortedCompanies = [...companyCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topCompanies = sortedCompanies.slice(0, 10);
  const otherCompanyCount = sortedCompanies.length - topCompanies.length;
  const otherRegistrantCount = sortedCompanies.slice(10).reduce((sum, [, n]) => sum + n, 0);

  const sortedTitles = [...titleCounts.entries()].sort((a, b) => b[1] - a[1]);
  const maxTitleCount = sortedTitles[0]?.[1] ?? 1;

  registrants.sort((a, b) => a.name.localeCompare(b.name));

  return {
    registrationCount: members.length,
    companyCount: companyCounts.size,
    topCompanies,
    otherCompanyCount,
    otherRegistrantCount,
    titles: sortedTitles.map(([label, count]) => ({
      label,
      count,
      pct: Math.round((count / maxTitleCount) * 100),
    })),
    registrants,
  };
}

// Host Name only — no phone/email field is ever requested here, even if
// the token in use happens to have broader read access than this script
// needs.
async function fetchRegionalHostNames(apiKey) {
  const map = new Map();
  if (!apiKey) return map;
  let offset;
  do {
    const params = new URLSearchParams();
    params.append("filterByFormula", "{Event Type}='Regional Hub'");
    params.append("fields[]", "Goldcast Event ID");
    params.append("fields[]", "Host Name");
    if (offset) params.append("offset", offset);
    const res = await fetch(
      `${AIRTABLE_BASE_URL}/${AIRTABLE_BASE_ID}/${CONFIRMED_EVENTS_TABLE_ID}?${params}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!res.ok) {
      console.warn(`Airtable fetch failed (${res.status}) — Host column will show "—"`);
      return new Map();
    }
    const data = await res.json();
    for (const r of data.records) {
      const gcid = r.fields["Goldcast Event ID"];
      const hostNames = r.fields["Host Name"];
      if (gcid && hostNames) map.set(gcid, hostNames.join(", "));
    }
    offset = data.offset;
  } while (offset);
  return map;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Matches EventsTable.tsx's STATUS_CLASS/STATUS_LABEL exactly (Regional
// only ever reaches Coming up/Started/Closed — no "Closing", that state is
// defined by check-in closure + payout settlement, neither of which
// exists on Regional).
function computeStatus(startIso, endIso) {
  const now = Date.now();
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (now < start) return { label: "Coming up", cls: "st-upcoming" };
  if (now > end) return { label: "Closed", cls: "st-ended" };
  return { label: "Started", cls: "st-live" };
}

function formatTime(startIso, tzRaw) {
  const tz = (tzRaw || "UTC").split(" (")[0].trim();
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: tz,
    }).format(new Date(startIso));
  } catch {
    return startIso;
  }
}

// Absolute, not relative ("3 minutes ago") — this is a static file
// rebuilt every 5 minutes, so a relative label would silently go stale
// between rebuilds with no client-side JS ticking it forward.
function formatUpdatedAt(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "UTC",
  }).format(date);
}

const SHARED_STYLE_TOKENS = `
  :root {
    --bg: #f8f9fb; --surface: #ffffff; --surface-2: #f3f4f6;
    --ink: #111827; --ink-soft: #4b5563; --ink-faint: #6b7280;
    --line: #e5e7eb; --line-strong: #d1d5db;
    --brand-navy: #003a6d; --accent: #003a6d; --accent-soft: #e3e8ef;
    --good: #166534; --good-soft: #dcfce7;
    --warn: #92400e; --warn-soft: #fef3c7;
    --critical: #991b1b; --critical-soft: #fee2e2;
    --info: #1e40af; --info-soft: #dbeafe;
    --shadow: 0 1px 2px rgba(17, 24, 39, 0.06), 0 1px 0 rgba(17, 24, 39, 0.03);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --surface: #17191f; --surface-2: #1d2028;
      --ink: #f3f4f6; --ink-soft: #a3a8b3; --ink-faint: #6b7280;
      --line: #2a2d36; --line-strong: #383c47;
      --brand-navy: #6fa8dc; --accent: #6fa8dc; --accent-soft: #1c2740;
      --good: #4ade80; --good-soft: #16321f;
      --warn: #fbbf24; --warn-soft: #3a2c10;
      --critical: #f87171; --critical-soft: #3a1a1a;
      --info: #60a5fa; --info-soft: #1c2c4d;
    }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--ink); font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; padding: 2.5rem 1.25rem 4rem; }
`;

function conicGradient(slices) {
  let acc = 0;
  const stops = slices.map(({ color, pct }) => {
    const start = acc;
    acc += pct;
    return `${color} ${start}% ${acc}%`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

// Server-renders each event time in the EVENT's own timezone (see
// formatTime above) — this can't know the viewer's timezone ahead of
// time, so it's the honest first paint. This script then swaps every
// .ev-time-auto element's text to the VIEWER's own local timezone,
// resolved via Intl.DateTimeFormat's default (no `timeZone` passed) — a
// standard browser API, not IP-based geolocation. Same technique as the
// internal dashboard's EventTimeLabel.tsx component.
const VIEWER_TIME_SCRIPT = `<script>
(function () {
  document.querySelectorAll(".ev-time-auto[data-start-iso]").forEach(function (el) {
    var iso = el.getAttribute("data-start-iso");
    if (!iso) return;
    try {
      el.textContent = new Intl.DateTimeFormat("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(new Date(iso));
    } catch (e) { /* leave the server-rendered fallback in place */ }
  });
  document.querySelectorAll(".updated-time-auto[data-updated-iso]").forEach(function (el) {
    var iso = el.getAttribute("data-updated-iso");
    if (!iso) return;
    try {
      el.textContent = new Intl.DateTimeFormat("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(new Date(iso));
    } catch (e) { /* leave the server-rendered UTC fallback in place */ }
  });
})();
</script>`;

function buildEventPage(row, analytics, updatedAtLabel, updatedAtIso) {
  const { registrationCount, companyCount, topCompanies, otherCompanyCount, otherRegistrantCount, titles, registrants } = analytics;

  const slices = topCompanies.map(([, count], i) => ({ color: CHART_COLORS[i], pct: registrationCount ? (count / registrationCount) * 100 : 0 }));
  if (otherRegistrantCount > 0) slices.push({ color: CHART_OTHER_COLOR, pct: registrationCount ? (otherRegistrantCount / registrationCount) * 100 : 0 });

  const legendRows = topCompanies.map(([name, count], i) => `
        <div class="legend-row"><span class="legend-dot" style="background:${CHART_COLORS[i]}"></span><span class="legend-name">${escapeHtml(name)}</span><span class="legend-count">${count}</span></div>`).join("");
  const otherLegendRow = otherRegistrantCount > 0
    ? `\n        <div class="legend-row"><span class="legend-dot" style="background:${CHART_OTHER_COLOR}"></span><span class="legend-name">Other (${otherCompanyCount} companies)</span><span class="legend-count">${otherRegistrantCount}</span></div>`
    : "";

  const barRows = titles.map((t) => `
        <div class="bar-row"><div class="bar-label">${escapeHtml(t.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${t.pct}%;"></div></div><div class="bar-value">${t.count}</div></div>`).join("");

  const regRows = registrants.map((r) => `
        <div class="reg-row"><span class="reg-name">${escapeHtml(r.name)}</span><span class="reg-company">${escapeHtml(r.company)}</span></div>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(row.cityState)} — Trades Thursday Analytics</title>
<style>
${SHARED_STYLE_TOKENS}
  .wrap { max-width: 920px; margin: 0 auto; }
  .top-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
  .back { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-soft); text-decoration: none; font-size: 0.85rem; font-weight: 600; }
  .back:hover { color: var(--accent); }
  .updated-tag { font-size: 0.75rem; color: var(--ink-faint); background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 5px 12px; white-space: nowrap; }
  .hdr { margin-bottom: 24px; }
  .hdr h1 { font-size: 1.4rem; margin: 0 0 4px; color: var(--brand-navy); }
  .hdr .sub { color: var(--ink-faint); font-size: 0.9rem; }
  .stat-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
  .stat-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 20px 22px; }
  .stat-label { font-size: 0.8rem; color: var(--ink-faint); font-weight: 600; }
  .stat-value { font-size: 2.4rem; font-weight: 700; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .chart-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 22px 24px; margin-top: 20px; }
  .chart-card:first-of-type { margin-top: 0; }
  .chart-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .chart-card-title { font-size: 0.95rem; font-weight: 700; }
  .chart-card-count { font-size: 0.78rem; color: var(--ink-faint); }
  .donut-row { display: flex; align-items: center; gap: 36px; flex-wrap: wrap; }
  .donut { width: 200px; height: 200px; border-radius: 50%; flex-shrink: 0; background: ${conicGradient(slices)}; position: relative; }
  .donut::after { content: ""; position: absolute; inset: 32px; border-radius: 50%; background: var(--surface); }
  .legend { display: flex; flex-direction: column; gap: 9px; flex: 1; min-width: 220px; }
  .legend-row { display: flex; align-items: center; gap: 9px; font-size: 0.83rem; }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .legend-name { flex: 1; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-count { color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .bar-chart { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: grid; grid-template-columns: 140px 1fr 32px; align-items: center; gap: 10px; }
  .bar-label { font-size: 0.8rem; color: var(--ink-soft); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { background: var(--surface-2); border-radius: 4px; height: 16px; }
  .bar-fill { background: var(--accent); height: 100%; border-radius: 4px; }
  .bar-value { font-size: 0.78rem; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
  .reg-list { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
  .reg-row { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 0.83rem; }
  .reg-name { font-weight: 600; flex-shrink: 0; }
  .reg-company { color: var(--ink-faint); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { font-size: 0.78rem; color: var(--ink-faint); margin-top: 16px; line-height: 1.5; }
  .empty { color: var(--ink-faint); font-size: 0.85rem; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="top-row">
      <a class="back" href="../index.html">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        All Regional Events
      </a>
      <div class="updated-tag">Last updated <span class="updated-time-auto" data-updated-iso="${escapeHtml(updatedAtIso)}">${escapeHtml(updatedAtLabel)}</span></div>
    </div>

    <div class="hdr">
      <h1>${escapeHtml(row.cityState)}</h1>
      <div class="sub ev-time-auto" data-start-iso="${escapeHtml(row.startTimeIso)}">${escapeHtml(row.when)}</div>
    </div>

    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">Registrations</div><div class="stat-value">${registrationCount}</div></div>
      <div class="stat-card"><div class="stat-label">Companies</div><div class="stat-value">${companyCount}</div></div>
    </div>

    ${registrationCount === 0 ? '<div class="chart-card"><p class="empty">No registrants yet.</p></div>' : `
    <div class="chart-card">
      <div class="chart-card-title">Companies Distribution</div>
      <div class="donut-row" style="margin-top:16px;">
        <div class="donut"></div>
        <div class="legend">${legendRows}${otherLegendRow}
        </div>
      </div>
      <p class="note">Top 10 companies by registrant count${otherCompanyCount > 0 ? `, everything else grouped into "Other"` : ""}.</p>
    </div>

    <div class="chart-card">
      <div class="chart-card-title">User By Title</div>
      <div class="bar-chart">${barRows}
      </div>
    </div>

    <div class="chart-card">
      <div class="chart-card-head"><div class="chart-card-title">Registrants</div><div class="chart-card-count">${registrationCount} registered</div></div>
      <div class="reg-list">${regRows}
      </div>
      <p class="note">Name + company only — no email or phone number is published here.</p>
    </div>
    `}
  </div>
  ${VIEWER_TIME_SCRIPT}
</body>
</html>
`;
}

async function main() {
  const goldcastToken = process.env.GOLDCAST_API_TOKEN;
  if (!goldcastToken) throw new Error("GOLDCAST_API_TOKEN is not set");
  const airtableKey = process.env.AIRTABLE_API_KEY || "";

  const url = `${GOLDCAST_BASE_URL}/event/?search=${encodeURIComponent("Trades Thursday")}&limit=100`;
  const raw = await fetchAllPages(url, goldcastToken);

  const regional = raw.filter((e) => {
    if (PLACEHOLDER_TITLE.test(e.title)) return false;
    if (!PROGRAM_PREFIX.test(e.title)) return false;
    return REGIONAL_PATTERN.test(e.title);
  });

  regional.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const hostNamesByGcid = await fetchRegionalHostNames(airtableKey);
  const activeOrgEmails = await fetchActiveOrgEmails({
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USERNAME,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    role: process.env.SNOWFLAKE_ROLE,
    privateKey: process.env.SNOWFLAKE_PRIVATE_KEY,
    privateKeyPass: process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
  });
  const updatedAt = new Date();
  const updatedAtLabel = formatUpdatedAt(updatedAt);

  const fs = await import("node:fs/promises");
  await fs.mkdir("docs/events", { recursive: true });

  const rows = [];
  for (const e of regional) {
    const detail = await fetchEventDetail(e.id, goldcastToken);
    const tags = detail?.tags ?? e.tags ?? null;
    const displayName = displayNameFromTitle(e.title);
    const { city, state } = cityFromDisplayName(displayName);
    const cityState = [city, state].filter(Boolean).join(", ") || displayName;
    const status = computeStatus(e.start_time, e.end_time);
    const venueType = venueTypeFromTags(tags);
    const hostName = hostNamesByGcid.get(e.id) || "—";

    const members = await fetchEventMembers(e.id, goldcastToken);
    const analytics = computeAnalytics(members);
    const audienceMix = classifyAudienceMix(members, activeOrgEmails);
    const hcpNonHcp =
      audienceMix.hcpCustomers !== null && audienceMix.nonCustomers !== null
        ? `${audienceMix.hcpCustomers} / ${audienceMix.nonCustomers}`
        : "— / —";

    const row = {
      id: e.id,
      cityState,
      when: formatTime(e.start_time, e.timezone),
      startTimeIso: e.start_time,
      hostName,
      status,
      venueType,
      registered: e.registrant_count ?? analytics.registrationCount ?? 0,
      hcpNonHcp,
    };
    rows.push(row);

    const eventHtml = buildEventPage(row, analytics, updatedAtLabel, updatedAt.toISOString());
    await fs.writeFile(`docs/events/${e.id}.html`, eventHtml);
  }

  const tableRows = rows.map((r) => `
      <tr>
        <td>
          <div class="ev-name">${escapeHtml(r.cityState)}</div>
          <div class="ev-sub ev-time-auto" data-start-iso="${escapeHtml(r.startTimeIso)}">${escapeHtml(r.when)}</div>
          <div class="ev-host">${escapeHtml(r.hostName)}</div>
        </td>
        <td>
          <span class="status ${r.status.cls}"><i></i>${escapeHtml(r.status.label)}</span>
        </td>
        <td>${escapeHtml(r.venueType || "—")}</td>
        <td class="mono-cell">${escapeHtml(r.registered)}</td>
        <td class="mono-cell">—</td>
        <td class="mono-cell">${escapeHtml(r.hcpNonHcp)}</td>
        <td><a class="analytics-btn" href="events/${r.id}.html">View analytics →</a></td>
      </tr>`).join("\n");

  // Colors/typography match app/globals.css exactly (--bg/--surface/--ink/
  // --good/--warn/--critical/--info/--brand-navy) so this reads as the
  // same product as the internal dashboard, not a separate-looking page.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trades Thursday — Regional Events</title>
<style>
${SHARED_STYLE_TOKENS}
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; color: var(--brand-navy); }
  p.lede { color: var(--ink-soft); margin: 0 0 2rem; }
  .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); min-width: 820px; }
  thead th { text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-faint); padding: 0.65rem 1rem; border-bottom: 1px solid var(--line); background: var(--surface-2); }
  tbody td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 0.875rem; }
  tbody tr:last-child td { border-bottom: none; }
  .ev-name { font-weight: 700; }
  .ev-sub { color: var(--ink-soft); font-size: 0.8125rem; margin-top: 2px; }
  .ev-host { color: var(--ink-faint); font-size: 0.8125rem; margin-top: 4px; }
  .mono-cell { font-variant-numeric: tabular-nums; color: var(--ink); }
  .status { display: inline-flex; align-items: flex-start; gap: 6px; font-weight: 600; font-size: 0.8125rem; }
  .status i { margin-top: 5px; width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .status.st-live { color: var(--good); }
  .status.st-live i { background: var(--good); }
  .status.st-ended { color: var(--critical); }
  .status.st-ended i { background: var(--critical); }
  .status.st-upcoming { color: var(--info); }
  .status.st-upcoming i { background: var(--info); }
  .analytics-btn { display: inline-block; white-space: nowrap; font-size: 0.8125rem; font-weight: 600; color: var(--accent); text-decoration: none; }
  .analytics-btn:hover { text-decoration: underline; }
  footer { margin-top: 1.5rem; color: var(--ink-faint); font-size: 0.8rem; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Trades Thursday — Regional Events</h1>
    <p class="lede">Upcoming Regional hub events.</p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Event</th><th>Status</th><th>Venue Type</th><th>Registered</th><th>Verified</th><th>HCP / Non-HCP</th><th></th></tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="7">No upcoming Regional events right now — check back soon.</td></tr>'}
        </tbody>
      </table>
    </div>
    <footer>This page refreshes automatically every 5 minutes. Last updated <span class="updated-time-auto" data-updated-iso="${escapeHtml(updatedAt.toISOString())}">${escapeHtml(updatedAtLabel)}</span></footer>
  </div>
  ${VIEWER_TIME_SCRIPT}
</body>
</html>
`;

  await fs.writeFile("docs/index.html", html);
  console.log(`Wrote docs/index.html with ${rows.length} upcoming Regional events, plus ${rows.length} per-event analytics pages.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
