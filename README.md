# TailTrip Mini App

Static web app (HTML + CSS + JS, no build) deployed to **GitHub Pages**
at <https://davidpcahill.github.io/tailtrip-webapp/>.

Telegram opens this inside its in-app web view; the app communicates
with the bot via `Telegram.WebApp.sendData()`.

## Architecture

```
[Telegram client] --opens-->  [GH Pages: index.html or board.html]
       |                              |
       |  user fills form / taps      |
       |                              v
       |                       Telegram.WebApp.sendData(JSON)
       |                              |
       v                              v
[Bot (long-polling)]  <-- web_app_data update --
       |
       v
[SQLite event log + pinned board updated in chat]
```

No server of our own. The Mini App is a pure form; all writes flow
through the bot's existing event handlers.

## Files

| File              | Purpose |
|-------------------|---------|
| `index.html`      | Wizard entry — 4-step trip-creation flow (Origin → When → Destination → Confirm) |
| `board.html`      | Live Board view — per-traveler 11-stage progress, opened from `/board` |
| `app.css`         | Shared fox-themed design tokens + layout. CSS custom properties drive the palette. Dark-mode via media query. |
| `board.css`       | Board-only styles (stage dots, route ribbon, traveler card) |
| `app.js`          | Wizard logic + airport-search ranking (mirrors `domain/airports.py`) |
| `board.js`        | Board renderer + snapshot decoder (mirrors `bot/board_snapshot.py`) |
| `airports.json`   | Top ~187 IATA airports — mirror of `src/tailtrip/data/airports.json` |
| `.nojekyll`       | Tells GitHub Pages not to Jekyll-process the directory |

## Two repos, one source of truth

The Mini App lives in **two places**:

1. **Source of truth**: `webapp/` in the bot repo (this directory).
   Edit here. The bot's tests reference these files indirectly via
   `airports.json` parity.
2. **Deploy mirror**: <https://github.com/davidpcahill/tailtrip-webapp>.
   GitHub Pages serves it at the URL above. **Don't edit the mirror
   directly** — edits there get blown away on the next deploy.

After editing `webapp/`, push to the mirror with:

```bash
uv run tailtrip-deploy-webapp
```

That helper clones the mirror, rsyncs `webapp/` over it, commits any
diff with the same subject as the bot repo's HEAD, and pushes. GitHub
Pages rebuilds in ~1 minute.

## Local development

For visual tweaking before deploying:

```bash
cd webapp
python3 -m http.server 8000
# then open http://localhost:8000/ (wizard) or
#           http://localhost:8000/board.html?snapshot=... (board)
```

The Telegram runtime won't be present, so `window.Telegram.WebApp` is
undefined. The app degrades gracefully — buttons fire `alert(payload)`
or `console.log` instead of `sendData()` / `close()`.

## Bot config

After deploying, the bot needs to know the URL. Set in `.env`:

```
TAILTRIP_MINIAPP_URL=https://davidpcahill.github.io/tailtrip-webapp/
```

When set, `/newtrip` opens the Mini App wizard in DM. When unset, the
bot falls back to the legacy inline-keyboard wizard.

Optional: register the URL with BotFather (`/setmenubutton`) so the
Mini App also appears as the bot's persistent menu button. Per-message
buttons via `KeyboardButton(web_app=...)` work without registration.

## Versioning

Each `.js` file's IIFE comment includes a version. Bump when shipping
a breaking change to the bot ↔ Mini App JSON contract.

Current: **v0.6 · M6 live board**.
