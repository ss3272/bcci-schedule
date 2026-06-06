# 🏏 India Cricket Dashboard

A production-ready full-stack dashboard that tracks BCCI match schedules and updates for both the India **Men's** and **Women's** cricket teams.

![Dashboard Preview](https://img.shields.io/badge/status-production--ready-green) ![Node](https://img.shields.io/badge/node-%3E%3D18-blue) ![License](https://img.shields.io/badge/license-ISC-lightgrey)

## Features

- **Live BCCI scraping** — Playwright (headless) + Axios fallback for JS-rendered pages
- **Men's & Women's tabs** — separate views with upcoming / live / results filters
- **Color-coded match types** — Test (red), ODI (blue), T20I (green)
- **Daily auto-sync** — node-cron at 7:00 AM IST; GitHub Actions as backup runner
- **Smart diff** — only inserts/updates changed records per sync
- **AI only on-demand** — Claude Haiku called ONLY when scraping fails or user requests a series summary
- **Mobile responsive** — works on all screen sizes
- **SQLite** — zero-dependency, file-based database; no external DB needed

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Scraping | Playwright (Chromium headless) + Axios + Cheerio |
| Database | SQLite via better-sqlite3 |
| Scheduler | node-cron |
| Frontend | Vanilla JS + HTML5 + CSS3 |
| AI Fallback | Claude Haiku (`claude-haiku-4-5`) via Anthropic SDK |
| CI/CD | GitHub Actions |

## Quick Start

### Prerequisites

- Node.js >= 18
- npm >= 9

### 1. Clone and install

```bash
git clone https://github.com/ss3272/bcci-schedule.git
cd bcci-schedule
npm install
npx playwright install chromium
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY if you want AI features
```

### 3. Initialize the database

```bash
npm run setup
```

### 4. Run the server

```bash
npm start
# Development (auto-reload):
npm run dev
```

Open http://localhost:3000

### 5. Trigger a manual sync

```bash
# Via npm script (standalone, no server needed):
npm run sync

# Or via the dashboard UI — click "Sync Now"

# Or via API:
curl -X POST http://localhost:3000/api/sync
```

## Project Structure

```
bcci-schedule/
├── src/
│   ├── scraper/
│   │   ├── bcci-scraper.js    # Playwright + Axios scraper
│   │   ├── parser.js          # Multi-strategy HTML parser
│   │   └── ai-fallback.js     # Claude Haiku fallback (on-demand only)
│   ├── db/
│   │   ├── schema.sql         # SQLite schema
│   │   └── db.js              # DB queries
│   ├── scheduler/
│   │   └── cron.js            # node-cron daily job
│   ├── api/
│   │   └── routes.js          # Express API routes
│   └── public/
│       ├── index.html         # Dashboard UI
│       ├── style.css
│       └── app.js             # Frontend JS
├── scripts/
│   └── sync.js                # Standalone sync runner
├── .github/
│   └── workflows/
│       └── daily-sync.yml     # GitHub Actions cron
├── data/                      # SQLite DB (git-ignored)
├── snapshots/                 # HTML snapshots (git-ignored)
├── .env.example
└── server.js                  # Express entry point
```

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/matches/men` | All men's matches (query: `status`, `limit`) |
| `GET` | `/api/matches/women` | All women's matches |
| `GET` | `/api/matches/upcoming` | Next 30 days, both teams (query: `days`) |
| `GET` | `/api/matches/all` | All matches for both teams |
| `POST` | `/api/sync` | Trigger manual scrape (body: `{ team: "both" }`) |
| `GET` | `/api/sync/status` | Check if sync is in progress |
| `GET` | `/api/sync/log` | Last 10 sync logs (query: `limit`) |
| `POST` | `/api/series/summary` | AI series summary (body: `{ series_id, team }`) |
| `GET` | `/api/ai-usage` | AI call log and cost summary |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/cron/status` | Cron scheduler status |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `CRON_TIME` | `30 1 * * *` | Cron schedule in UTC (default = 7 AM IST) |
| `DISABLE_CRON` | `false` | Set `true` to disable auto-scheduler |
| `ANTHROPIC_API_KEY` | — | Anthropic key for AI features (optional) |
| `NODE_ENV` | `development` | Environment |

## AI Usage Policy

Claude API is called **only** in these three cases:

1. **Scraper fallback** — Playwright returns empty/unexpected HTML (< 1000 bytes)
2. **Series summary** — User clicks "AI Summary" on a specific series card
3. **Auto-categorize** — A new series title can't be mapped to a match format

All AI calls use `claude-haiku-4-5` (cheapest model). Every call is logged to `ai_usage_log` for cost tracking. Routine cron runs **never** call the AI.

## Deployment

### Railway / Render (recommended)

1. Push to GitHub
2. Connect repo in Railway/Render dashboard
3. Set environment variables (`ANTHROPIC_API_KEY`, `PORT`)
4. Railway auto-detects Node.js and runs `npm start`

### VPS

```bash
npm install --production
npx playwright install chromium --with-deps
npm start
```

For process management, use PM2:

```bash
npm install -g pm2
pm2 start server.js --name cricket-dashboard
pm2 save
```

### GitHub Actions (daily sync)

Add `ANTHROPIC_API_KEY` to your repository secrets:
Settings → Secrets and variables → Actions → New repository secret

The workflow runs daily at 01:30 UTC (7:00 AM IST) and uploads the SQLite DB as an artifact.

## Data Sources

- **Primary:** bcci.tv (Men's and Women's schedule pages)
- **Fallback:** ESPN Cricinfo (if BCCI is blocked or returns empty HTML)

All times stored as UTC in the database and displayed in IST (UTC+5:30) in the UI.

## License

ISC
