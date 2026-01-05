# ResyBot (TypeScript CLI)

This repo contains a **local, TypeScript-based CLI** for creating a list of reservation tasks and **executing them automatically at scheduled times**.

## Features

- Create and manage reservation tasks
- Optional proxy support
- Persisted schedules (once/daily/weekly)
- Auto-execution runner (`runner` mode) intended to stay running
- Discord webhook notifications

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
```

## Location workflow (discover → enrich → review → start)

This repo supports a **file-driven location workflow**:

1) Create a location workspace from a place string (geocodes + discovers top-rated venues, then enriches/caches metadata):

```bash
npm run location:init -- --place "West Village, New York, NY" --radius-m 2000 --min-rating 4.5 --min-rating-count 50
```

This writes:
- `data/locations/<locationKey>/location.json`
- `data/locations/<locationKey>/venues.json`
- `data/locations/<locationKey>/venues.report.md`
- raw API caches under `data/venue-meta/<locationKey>/<venueId>/{venue.json,config.json}`

2) Review and select restaurants:
- Edit `data/locations/<locationKey>/venues.json` and flip `enabled` true/false
- Or skim `data/locations/<locationKey>/venues.report.md`

3) Generate reservations + schedules and apply them into the bot:

```bash
npm run location:start -- --location <locationKey> --mode replace --party-size 2 --time 20:15 --flex-minutes 45
```

Add `--run` to start the runner immediately (blocks in the foreground).

## Run

### Interactive menu (recommended)

```bash
npm run menu
```

### Config file workflow (simple + repeatable)

Edit the gitignored [`resybot.config.json`](resybot.config.json) (accounts + desired reservations). The **first account is used as primary**, and the **second account is used as a backup** when booking fails.

1) Copy the example (optional):

```bash
copy resybot.config.example.json resybot.config.json
```

2) Edit `resybot.config.json` with your:
- accounts (auth token + payment id)
- reservations (restaurantId/venueId, date, time, partySize)
- optional `run` schedule for when to start trying

3) Apply the config into `data/`:

```bash
npm run apply-config
```

4) Start the runner:

```bash
npm run runner
```

### Runner (keeps schedules active)

```bash
npm run runner
```

## Data storage

This app persists data in the gitignored `data/` directory (configurable via `RESYBOT_DATA_DIR`):

- `data/accounts.json`
- `data/tasks.json`
- `data/schedules.json`
- `data/proxies.json`
- `data/info.json` (Discord webhook)

## Migrating from the legacy Python version

If you previously used the Python version’s JSON files, you can import them:

```bash
npm run import-legacy
```

By default this imports from `legacy-python/client`. To specify a different folder:

```bash
npm run import-legacy -- --from path/to/legacy/client
```

## Legacy Python (for reference)

The previous Python implementation lives under `legacy-python/`.

## Notes / responsible use

Use responsibly and comply with Resy’s terms and any applicable local laws. This tool is intended for legitimate personal use.

## License

MIT — see [`LICENSE`](LICENSE).
