# TailTrip Mini App

Static web app (HTML + CSS + JS, no build) hosted on Cloudflare Pages
or GitHub Pages. Telegram opens this inside its in-app web view; the
app communicates with the bot via `Telegram.WebApp.sendData()`.

## Architecture

```
[Telegram client] --opens-->  [Cloudflare Pages: index.html]
       |                              |
       |  user fills form             |
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

| File | Purpose |
|---|---|
| `index.html` | Single-page app shell. Loads Telegram's JS runtime + `app.css` + `app.js` and provides the `#view-root` slot. |
| `app.css`    | Fox-themed design tokens + layout. CSS custom properties drive the palette. Dark-mode via media query. |
| `app.js`     | Boots `Telegram.WebApp`, handles the M1 round-trip submit. Future modules (wizard, board, editor) extend from here. |
| `views/`     | Per-view modules — populated from M2 onward. |

## Local development

Telegram only accepts HTTPS URLs for Mini Apps, so for live testing in
the Telegram client you need to deploy. For visual tweaking offline:

```bash
cd webapp
python -m http.server 8000  # then open http://localhost:8000
```

The Telegram runtime won't be present, so `Telegram.WebApp` is
undefined. The app degrades gracefully: buttons fire `alert(payload)`
instead of `sendData()`.

## Deploying to Cloudflare Pages

1. Push `webapp/` to a public repo (or use the existing repo + a
   "webapp" sub-directory build).
2. Cloudflare Pages → "Create a project" → connect repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: (leave blank)
   - Build output directory: `webapp`
4. Deploy. CF gives you `https://<project>.pages.dev`.
5. Set `TAILTRIP_MINIAPP_URL=https://<project>.pages.dev` in the bot's
   `.env`. The bot's `KeyboardButton(web_app=WebAppInfo(url=...))` reads
   from there.
6. Telegram requires the Mini App URL to be registered with BotFather:
   `/setmenubutton` → paste the URL. (Optional — you can also open
   the app via per-message `KeyboardButton`, which doesn't need
   registration.)

## Versioning

`app.js` ends with a `(function () { … })()` IIFE that includes a
version comment at the top. Bump it when shipping breaking changes to
the bot ↔ Mini App contract (the JSON payload schema).

Current version: **v0.1 (M1 scaffold)**.
