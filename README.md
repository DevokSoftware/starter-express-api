# NBA standings API

Serves NBA regular-season standings from ESPN's public JSON endpoint. No sports API key or subscription is required.

## Run

Use Node.js 20 or newer. Install with `npm ci`, then run `npm start`.

Configure PostgreSQL using `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, and optionally `DB_PORT` (defaults to 5432). Set `DB_SSL=false` for a local database without SSL. The server creates the existing `standings` table if needed and listens on `PORT` (defaults to 3001).

## Standings

`GET /standings?season=2026` returns the 2026–27 regular season. Omitting `season` defaults to 2026. Seasons use their **starting year**; the backend translates this to ESPN's ending year (`2027`). Invalid season parameters return HTTP 400.

The response retains the fields used by the website: `parameters.season`, `response[].season`, `response[].team.id`, `response[].win.total`, and `lastUpdate`. All 30 ESPN team IDs are translated to the website's existing IDs. Wins, losses, conference rank, home/away records, and streaks come from named ESPN statistics. `lastUpdate` uses Lisbon time.

Results are cached in PostgreSQL for one hour, separately for each season and provider. Old RapidAPI rows are ignored automatically; no database reset is needed. Upstream errors, incomplete standings, and wrong-season responses are not cached and return HTTP 500. An actual zero-win record remains zero.

ESPN's endpoint is undocumented and its availability and format can change. It is fetched by the backend, not directly by the website.

## Verify

Run `npm test`. Tests use a captured ESPN response and cover ID mapping, season translation, cache isolation and expiration, invalid data, and the website's HTTP endpoint.

