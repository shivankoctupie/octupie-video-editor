# Quick start: the local product server

This walks you through running the browser editor, review, and publishing product on your own machine. It is local-first: with no configuration it runs offline with an in-memory database, publishing disabled, and no network adapters. Everything that reaches beyond that boundary is opt-in through environment variables.

## 1. Prerequisites

- Node.js 22.5.0 or newer (the server store uses the built-in `node:sqlite` module, added in 22.5.0; `npm run doctor` checks this).
- FFmpeg and FFprobe on `PATH` for rendering (check with `npm run doctor`).
- `npm install` once in the repo.

## 2. Configure users and a shared database

Tokens come only from the environment. Define at least one user, and point the server and worker at the same on-disk database so they cooperate (an in-memory database cannot be shared between processes).

```bash
export OVE_SERVER_DB=./output/server/ove.db
export OVE_SERVER_STORAGE=./output/server/storage
export OVE_SERVER_USERS='[
  {"id":"u-ed","tenantId":"t1","username":"editor","role":"editor","token":"replace-with-a-long-random-token-1"},
  {"id":"u-ap","tenantId":"t1","username":"approver","role":"approver","token":"replace-with-a-long-random-token-2"}
]'
```

Roles are viewer, editor, approver, publisher, admin. Tokens must be at least 16 characters and unique. Use real random strings; the ones above are placeholders.

## 3. Start the server and the worker

```bash
npm run dev       # builds the React client, then serves on http://127.0.0.1:8722 (override with OVE_SERVER_PORT)
npm run worker    # in a second terminal: claims and renders queued jobs, then persists QA
```

`npm run dev` builds the browser client into `public/` and starts the server, so the printed URL always serves the current editor. For a compiled run use `npm run build` then `npm start`. While iterating on the client, run `npm run dev:server` in one terminal and `npm run dev:client` in another (Vite dev server with hot reload, proxying the API to the running server).

## 4. Sign in and edit

Open the printed URL and paste an editor token. The window is a real timeline editor: a media bin on the left, a synchronized preview in the centre, an inspector on the right, and a multi-track timeline across the bottom.

1. Create a project (New in the top bar opens an in-app dialog).
2. Import media into the bin: click Import files, or drag files onto the bin. Videos show a poster thumbnail, images a preview, audio a decoded waveform.
3. Build the edit: double-click a media item, or drag it onto the timeline, to add a clip at the playhead. Drag clips to move them, drag their edges to trim, and split the selected clip at the playhead. Add caption/text clips from the Text button. Tracks for video, overlays, captions, and audio can be added, reordered, muted, and locked.
4. Keyboard: Space plays/pauses, the playhead follows playback and dragging it seeks the preview; S or Ctrl/Cmd+B splits, Delete removes, Ctrl/Cmd+Z undoes (Shift to redo), and +/- zoom the timeline.
5. Select a clip to edit its timing, source in/out, text, position/scale/rotation/opacity, volume, and caption styling in the inspector. Every edit updates the preview and timeline immediately.
6. A draft version autosaves as you work; Save version writes an explicit immutable version. Reloading reproduces the timeline exactly.
7. The Manage panel (top bar) holds the secondary flows: versions, submit/approve review, enqueue a render (the worker runs it), read the QA report, publish, the activity/audit trail, and local generation or rights-cleared import.

## 5. Optional: enable materialization (web and Google Drive import)

Materialization pulls real bytes and is default-denied. Grant it explicitly:

```bash
export OVE_SERVER_GRANTS='[
  {"action":"network","grantedBy":"operator","grantedAt":"2026-08-03T00:00:00.000Z"},
  {"action":"media-upload","grantedBy":"operator","grantedAt":"2026-08-03T00:00:00.000Z"}
]'
```

Web import requires reusable-rights metadata (license, attribution, source, reusable=true) and passes SSRF and redirect/byte/type/time checks. Google Drive import uses the official Drive v3 media endpoint only; provide an OAuth token via an env var and name it:

```bash
export OVE_DRIVE_TOKEN_ENV=OVE_DRIVE_TOKEN
export OVE_DRIVE_TOKEN=ya29.your-oauth-access-token
```

The token is read at call time, sent only in the Authorization header, and never logged.

## 6. Optional: enable HTTPS webhook publishing

Publishing is off by default. To arm the webhook adapter, add a `publishing` grant and configure an endpoint and host allowlist:

```bash
export OVE_WEBHOOK_URL=https://hooks.example.com/octupie
export OVE_WEBHOOK_HOSTS=hooks.example.com
export OVE_WEBHOOK_SECRET_ENV=OVE_WEBHOOK_SECRET   # optional; the secret value goes in OVE_WEBHOOK_SECRET
```

A publish still requires an approved version, a publisher or admin role, confirmed rights, a passed QA gate, the enabled adapter, and an unused idempotency key. Any missing gate is refused with the exact gate named in the response. SSRF and DNS-rebinding checks run before a byte is sent.

## 7. Verify

```bash
npm test            # unit + integration: reducer, EditPlan mapping, product acceptance, browser smoke
npm run typecheck   # server (NodeNext) and client (Vite) TypeScript projects
npm run build       # Vite client build into public/, then the server compile

# Real-browser interaction test (drag, trim, split, undo, zoom, play, save, reload):
npm run e2e:install # one time: downloads Playwright Chromium
npm run e2e         # starts the built server and drives the editor in Chromium
```

The local product gates are listed in `PRODUCT_ACCEPTANCE.json`, each proven by `tests/product-acceptance.test.ts` and `tests/browser-smoke.test.ts`. The editor itself is covered by the reducer and mapping unit tests and by the Playwright flow in `tests/e2e/editor.spec.ts`. The security boundary is documented in `SECURITY.md`.
