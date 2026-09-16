// Builds docs/index.html — a public, read-only listing of Trades Thursday
// Regional events, for pros (no login, no host/payout data — see README).
// Run on a schedule by .github/workflows/update.yml, using GOLDCAST_API_TOKEN
// as a GitHub Actions secret (never exposed in this repo's files or output).

const GOLDCAST_BASE_URL = "https://customapi.goldcast.io";
const PROGRAM_PREFIX = /trades thursday/i;
const REGIONAL_PATTERN = /regional/i;
const PLACEHOLDER_TITLE = /\[city\]/i;

const CITY_STATE = {
  denver: "CO",
  minneapolis: "MN",
  phoenix: "AZ",
  "las vegas": "NV",
  "san diego": "CA",
  seattle: "WA",
  sausalito: "CA",
  austin: "TX",
  houston: "TX",
  dallas: "TX",
  miami: "FL",
  chicago: "IL",
  tampa: "FL",
  charlotte: "NC",
  orlando: "FL",
  atlanta: "GA",
  philadelphia: "PA",
  "new york": "NY",
  "los angeles": "CA",
  cleveland: "OH",
  nashville: "TN",
  columbus: "OH",
};

function displayNameFromTitle(title) {
  const match = title.match(/trades thursday\s*[:—-]\s*(.+)/i);
  return match ? match[1].trim() : title;
}

function cityFromDisplayName(displayName) {
  const city = displayName.replace(/regional hub|regional meetup/i, "").trim();
  return { city, state: CITY_STATE[city.toLowerCase()] ?? "" };
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function formatDateRange(startIso, endIso, tzRaw) {
  const tz = (tzRaw || "UTC").split(" (")[0].trim();
  try {
    const start = new Date(startIso);
    const dateStr = new Intl.DateTimeFormat("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: tz,
    }).format(start);
    const timeStr = new Intl.DateTimeFormat("en-US", {
      hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: tz,
    }).format(start);
    return `${dateStr} · ${timeStr}`;
  } catch {
    return startIso;
  }
}

async function main() {
  const token = process.env.GOLDCAST_API_TOKEN;
  if (!token) throw new Error("GOLDCAST_API_TOKEN is not set");

  const url = `${GOLDCAST_BASE_URL}/event/?search=${encodeURIComponent("Trades Thursday")}&limit=100`;
  const raw = await fetchAllPages(url, token);

  const regional = raw.filter((e) => {
    if (PLACEHOLDER_TITLE.test(e.title)) return false;
    if (!PROGRAM_PREFIX.test(e.title)) return false;
    return REGIONAL_PATTERN.test(e.title);
  });

  const now = Date.now();
  const upcoming = regional.filter((e) => new Date(e.end_time).getTime() >= now);
  upcoming.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const detailed = [];
  for (const e of upcoming) {
    const detail = await fetchEventDetail(e.id, token);
    detailed.push({ ...e, registration_cta_link: detail?.registration_cta_link ?? null, location: detail?.location ?? "" });
  }

  const rows = detailed.map((e) => {
    const displayName = displayNameFromTitle(e.title);
    const { city, state } = cityFromDisplayName(displayName);
    const cityState = [city, state].filter(Boolean).join(", ") || displayName;
    const when = formatDateRange(e.start_time, e.end_time, e.timezone);
    const link = e.registration_cta_link;
    return `
      <li class="event-card">
        <div class="event-name">${escapeHtml(cityState)}</div>
        <div class="event-when">${escapeHtml(when)}</div>
        ${e.location ? `<div class="event-loc">${escapeHtml(e.location)}</div>` : ""}
        ${link ? `<a class="event-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">Register →</a>` : ""}
      </li>`;
  }).join("\n");

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
  }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #17181b; --ink: #edeae2; --ink-soft: #b7b2a4; --ink-faint: #7c786d; --line: #33342f; --accent: #5fb3a3; --surface: #1f2124; }
  }
  * { box-sizing: border-box; }
  body { background: var(--paper); color: var(--ink); font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; margin: 0; padding: 2.5rem 1.25rem 4rem; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  p.lede { color: var(--ink-soft); margin: 0 0 2rem; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
  .event-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.25rem; }
  .event-name { font-weight: 700; font-size: 1.05rem; }
  .event-when { color: var(--ink-soft); margin-top: 2px; }
  .event-loc { color: var(--ink-faint); font-size: 0.9rem; margin-top: 2px; }
  .event-link { display: inline-block; margin-top: 10px; color: var(--accent); font-weight: 600; text-decoration: none; }
  .event-link:hover { text-decoration: underline; }
  footer { margin-top: 2.5rem; color: var(--ink-faint); font-size: 0.8rem; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Trades Thursday — Regional Events</h1>
    <p class="lede">Upcoming Regional hub events. Click through to register on Goldcast.</p>
    <ul>
      ${rows || '<li class="event-card">No upcoming Regional events right now — check back soon.</li>'}
    </ul>
    <footer>Last updated ${escapeHtml(updatedAt)}</footer>
  </div>
</body>
</html>
`;

  const fs = await import("node:fs/promises");
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile("docs/index.html", html);
  console.log(`Wrote docs/index.html with ${detailed.length} upcoming Regional events.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
