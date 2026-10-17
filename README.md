# BugFlix

A mobile-first, installable PWA (Next.js + TypeScript) that plays whatever the DeployBug gate says is current, using Mux Player.

## Configuration

Set these environment variables (see `.env.example`). They are only read on the server and are never sent to the browser.

| Variable | Purpose |
| --- | --- |
| `DEPLOYBUG_GATE_URL` | Base URL of the DeployBug gate |
| `BUGFLIX_GATE_TOKEN` | Bearer token sent as `Authorization: Bearer <token>` |

## Running

```bash
npm install
npm run dev
npm run build && npm start
```

`npm run typecheck` type-checks the app and the service worker.

## How it works

- `/` asks `/api/media/current`, which calls `GET {DEPLOYBUG_GATE_URL}/media/current` server-side and hands the playback ID to `@mux/mux-player-react`.
  - `200` with `playbackId` (or `playback_id`) plays it. `title` and `description` are shown only when the gate returns them.
  - `204`, an empty body, or a body without a playback ID shows **Nothing scheduled yet** and re-checks every 30 seconds.
  - Any other response or a network failure shows the error state with a retry button.
- `/status` asks `/api/deploy/status`, which calls `GET {DEPLOYBUG_GATE_URL}/deploy/status` and shows the HTTP status and response body.
- `sw/sw.ts` is compiled to `public/sw.js` before `dev` and `build`. It caches the app shell for offline launch and never caches `/api/*` or video streams.

## Installing

- **Android (Chrome):** open the site, then use the install prompt or *Add to Home screen*.
- **iOS (Safari):** tap Share, then *Add to Home Screen*.
