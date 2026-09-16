// Builds docs/index.html — a public, read-only table of Trades Thursday
// Regional events for pros, matching the internal dashboard's Regional
// table layout (Event/Host, Status, Venue Type, Registered) — no login.
//
// Data sources:
//   - Goldcast (GOLDCAST_API_TOKEN secret): event identity/timing/venue type.
//   - Airtable (AIRTABLE_API_KEY secret, optional): Host Name only — a
//     dedicated, narrowly-scoped read-only token, separate from the
//     internal dashboard's own key. If this secret isn't set yet, the Host
//     column just renders "—" rather than failing the whole build.
//
// Never fetches/renders phone, email, payout, or attendance data — none of
// that exists in this repo's data sources at all, by design.

const GOLDCAST_BASE_URL = "https://customapi.goldcast.io";
const AIRTABLE_BASE_URL = "https://api.airtable.com/v0";
const AIRTABLE_BASE_ID = "apppUZpHj2G87aOUL";
const CONFIRMED_EVENTS_TABLE_ID = "tbl5JUSq8O02BiNCh";

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

function computeStatus(startIso, endIso) {
  const now = Date.now();
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (now < start) return { label: "Coming up", cls: "status-upcoming" };
  if (now > end) return { label: "Closed", cls: "status-closed" };
  return { label: "Started", cls: "status-started" };
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
    rows.push({
      cityState,
      when: formatTime(e.start_time, e.timezone),
      hostName,
      status,
      venueType,
      registered: e.registrant_count ?? 0,
    });
  }

  const tableRows = rows.map((r) => `
      <tr>
        <td>
          <div class="ev-name">${escapeHtml(r.cityState)}</div>
          <div class="ev-sub">${escapeHtml(r.when)}</div>
          <div class="ev-host">${escapeHtml(r.hostName)}</div>
        </td>
        <td><span class="status-pill ${r.status.cls}">${escapeHtml(r.status.label)}</span></td>
        <td>${escapeHtml(r.venueType || "—")}</td>
        <td class="num">${escapeHtml(r.registered)}</td>
      </tr>`).join("\n");

  const updatedAt = new Date().toISOString();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trades Thursday — Regional Events</title>
<style>
  :root {
    --paper: #f6f4ef; --ink: #1d1c19; --ink-soft: #55524a; --ink-faint: #8a8578;
    --line: #e2ddd1; --accent: #1f6f63; --surface: #ffffff;
    --pending: #92400e; --pending-soft: #fef3c7;
    --good: #166534; --good-soft: #dcfce7;
    --neutral: #374151; --neutral-soft: #e5e7eb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #17181b; --ink: #edeae2; --ink-soft: #b7b2a4; --ink-faint: #7c786d;
      --line: #33342f; --accent: #5fb3a3; --surface: #1f2124;
      --pending: #fbbf24; --pending-soft: #3a2c10;
      --good: #4ade80; --good-soft: #16321f;
      --neutral: #d1d5db; --neutral-soft: #2a2c30;
    }
  }
  * { box-sizing: border-box; }
  body { background: var(--paper); color: var(--ink); font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; padding: 2.5rem 1.25rem 4rem; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  p.lede { color: var(--ink-soft); margin: 0 0 2rem; }
  .table-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); min-width: 560px; }
  thead th { text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-faint); padding: 0.65rem 1rem; border-bottom: 1px solid var(--line); }
  tbody td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 0.92rem; }
  tbody tr:last-child td { border-bottom: none; }
  .ev-name { font-weight: 700; }
  .ev-sub { color: var(--ink-soft); font-size: 0.85rem; margin-top: 2px; }
  .ev-host { color: var(--ink-faint); font-size: 0.85rem; margin-top: 4px; }
  .num { font-variant-numeric: tabular-nums; }
  .status-pill { display: inline-flex; padding: 3px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
  .status-upcoming { background: var(--pending-soft); color: var(--pending); }
  .status-started { background: var(--good-soft); color: var(--good); }
  .status-closed { background: var(--neutral-soft); color: var(--neutral); }
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
          <tr><th>Event</th><th>Status</th><th>Venue Type</th><th>Registered</th></tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="4">No upcoming Regional events right now — check back soon.</td></tr>'}
        </tbody>
      </table>
    </div>
    <footer>Last updated ${escapeHtml(updatedAt)}</footer>
  </div>
</body>
</html>
`;

  const fs = await import("node:fs/promises");
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile("docs/index.html", html);
  console.log(`Wrote docs/index.html with ${rows.length} upcoming Regional events.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
