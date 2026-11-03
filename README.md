# WDTM daily jewellery ad harvest

Every morning GitHub runs `harvest.js`. It opens the Meta Ad Library in a hidden
Chrome (logged out), searches Kyle's jewellery terms newest first, keeps ads that
started in the last 48 hours, and sends them to the n8n workflow, which finds
emails, checks them with Bouncer and adds them to Instantly.

Based on Kyle's adlib harvester v16. No third-party scraping service.

## Settings

Repo > Settings > Secrets and variables > Actions

| Name | Where | What |
|---|---|---|
| `N8N_WEBHOOK_URL` | Secrets | Production URL from the "Ads From GitHub" node in n8n |
| `N8N_WEBHOOK_SECRET` | Secrets | A long random password. Same value as the n8n credential |
| `COUNTRIES` | Variables (optional) | `GB` by default. e.g. `GB,IE` |
| `LOOKBACK_HOURS` | Variables (optional) | `48` by default |

Search terms live at the top of `harvest.js`.

## Running it

- Runs by itself daily at 06:17 UTC
- To test: Actions tab > Daily jewellery ad harvest > Run workflow
- If a run fails, GitHub emails you. Open the run: the log says why, and a
  `debug` download shows a screenshot of what Chrome saw

## If GitHub gets blocked by Meta

Meta is stricter with server connections than home ones. If runs keep failing
with "blocked" messages, the same script runs on your own computer:

```
npm install
npx playwright install chromium
N8N_WEBHOOK_URL=... N8N_WEBHOOK_SECRET=... node harvest.js
```

Test without sending anything: `node harvest.js --dry-run` (writes `ads.json`).
