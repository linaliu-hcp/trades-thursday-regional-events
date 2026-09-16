# Trades Thursday — Regional Events (Public)

A public, read-only listing of upcoming Trades Thursday **Regional** events,
for pros — no login required.

This is intentionally isolated from the internal ops dashboard
(`trades-thursday-dashboard`, private repo): it has its own read-only
Goldcast API token (repo secret, never exposed in this repo's files or
output), fetches directly from Goldcast, and only ever renders event
name/city/state/date/time and a public registration link — no host
contact info, no payout data, no attendance/anomaly data.

## How it works

- `.github/workflows/update.yml` runs `scripts/build.mjs` every 30 minutes
  (and on every push to `main`), regenerating `docs/index.html` from
  Goldcast's live event list, then commits the result if it changed.
- GitHub Pages serves `docs/index.html` from `main` — a fully static page,
  no server, no secrets in the served output.

## Setup (one-time)

1. Add a repo secret `GOLDCAST_API_TOKEN` (Settings → Secrets and
   variables → Actions).
2. Enable GitHub Pages: Settings → Pages → Source: Deploy from a branch →
   Branch: `main`, folder: `/docs`.
