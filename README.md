# ringside-data

Hourly-refreshed leaderboard data for the Ringside browser extension. Served as a static JSON from GitHub — zero infrastructure, zero user config.

## How it works

1. GitHub Actions cron (`0 * * * *`) runs `scripts/refresh.mjs`.
2. Script fetches from public no-key sources:
   - **OpenRouter** `/api/v1/models` — catalog, pricing, context
   - **Aider polyglot** — code benchmark (YAML on GitHub)
   - **LMArena** HF Space CSV — chat Elo (if CSV still published)
   - **LiveBench** — CSV (chat + code)
3. Normalizes to `{ chat, code, image, video }`, writes `leaderboard.json`.
4. Commits and pushes. The extension fetches `https://raw.githubusercontent.com/<you>/ringside-data/main/leaderboard.json`.

Each source fails independently. `sources` field in the JSON shows what succeeded.

## Setup (one-time, ~2 minutes)

1. Fork/push this folder to a public repo named `ringside-data`.
2. Settings → Actions → General → "Workflow permissions" → **Read and write**.
3. Actions tab → "Refresh leaderboard" → Run workflow (seeds `leaderboard.json`).
4. In `ringside-extension/config.js`, set `DATA_URL` to your raw GitHub URL.

## Local dev

```bash
npm install
npm run refresh        # writes leaderboard.json to cwd
```

## Adding sources

Add a `fetchX()` function in `scripts/refresh.mjs`, call it via `tryFetch('x', fetchX)`, and merge into `out` in `merge()`. Each source should be independent and wrapped in try/catch.
