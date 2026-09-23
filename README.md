# Trades Thursday — Regional Events (Public)

A public, read-only listing of upcoming Trades Thursday **Regional** events,
for pros — no login required.

This is intentionally isolated from the internal ops dashboard
(`trades-thursday-dashboard`, private repo): it has its own read-only
Goldcast API token (repo secret, never exposed in this repo's files or
output), fetches directly from Goldcast, and only ever renders event
name/city/state/date/time, a public registration link, and (as of
2026-09-23) an aggregate HCP / Non-HCP registrant split per event — no
host contact info, no payout data, no attendance/anomaly data, and no
individual registrant identity ever behind that split (see
`scripts/build.mjs`'s `classifyAudienceMix` — registrant emails are
matched in memory against Snowflake's active-org email set and
immediately reduced to two counts; the emails themselves are never
written anywhere).

## How it works

- `.github/workflows/update.yml` runs `scripts/build.mjs` every 5 minutes
  (GitHub's actual cron trigger time can slip a few minutes under load —
  not a hard real-time guarantee, just close to it)
  (and on every push to `main`), regenerating `docs/index.html` from
  Goldcast's live event list, then commits the result if it changed.
- GitHub Pages serves `docs/index.html` from `main` — a fully static page,
  no server, no secrets in the served output.

## Setup (one-time)

1. Add a repo secret `GOLDCAST_API_TOKEN` (Settings → Secrets and
   variables → Actions).
2. Add six more repo secrets for the HCP / Non-HCP split, mirroring the
   private dashboard's own env var names exactly (same dedicated service
   account, sourced from 1Password — never hardcoded anywhere in this
   repo): the account identifier, username, warehouse, role, and the
   private key + passphrase pair.
3. Enable GitHub Pages: Settings → Pages → Source: Deploy from a branch →
   Branch: `main`, folder: `/docs`.
