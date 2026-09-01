# RotorOps Desktop

The whole thing as one Windows app: the company UI, its server, and the MSFS 2024
bridge in a single process tree.

```
RotorOps.exe
├── Electron window ──── the React UI
├── Nitro server ─────── the app, on a private localhost port
└── MSFS bridge ──────── SimConnect, in the main process
                              │
                              └── HTTPS ──► Supabase (the shared server)
```

Supabase is the multiplayer server. Everyone in a company talks to the same
Postgres, so cash, fleet and contracts are shared live.

## Why there's no pairing code here

The standalone `bridge.exe` needs a pairing code because it's a separate process
with no idea who you are. In the desktop app the renderer is already signed in,
so on first launch it mints a code and hands it to the main process over IPC.
You never see it. The resulting device token lands in
`%APPDATA%\RotorOps\bridge.json` exactly as before, and you can revoke it from
Settings like any other device.

## Build

```bash
cd desktop
npm install
npm run dist
```

That runs three steps:

1. `build-app.mjs` — builds the web app with the **node-server** Nitro preset
2. `build-bridge.mjs` — bundles `bridge/src` into `dist/bridge.cjs`
3. `electron-builder` — packages it

The preset matters. The project's default Nitro target is Cloudflare Workers,
which emits a Worker module, not something that can listen on a port — it starts
and exits silently. `build-app.mjs` sets `NITRO_PRESET=node-server` so the
desktop app can run the server locally. Don't build with a plain `bun run build`
and expect the desktop app to work.

### If the installer step fails

electron-builder unpacks a signing toolchain that contains macOS symlinks, and
Windows only lets administrators create symlinks by default:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
```

Two ways past it:

- Turn on **Settings → System → For developers → Developer Mode**, which grants
  symlink privilege to normal users, then rerun.
- Or run the build from an Administrator terminal.

Either way `npm run dist` then produces `dist/RotorOps Setup <version>.exe`.

Without that, `npx electron-builder --win --dir` still produces a working
`dist/win-unpacked/RotorOps.exe` — no installer, but the app runs. It's about
190 MB because Chromium and Node ship inside it.

The app is unsigned, so SmartScreen will warn on first run.

## Running from source

```bash
npm start
```

Uses `../.output` from the last build. Set `ROTOROPS_URL` to point the window at
a deployed site instead of the local server:

```bash
ROTOROPS_URL=https://your-app.lovable.app npm start
```

## Closing vs quitting

Closing the window hides it to the tray so the bridge keeps logging while you
fly. The tray tooltip shows sim connection and the current flight. Quit from the
tray menu to stop the bridge.

## What the renderer can see

`preload.js` exposes exactly one object, `window.rotorops`:

| Call | Purpose |
|---|---|
| `hasToken()` | is this install already linked |
| `provision(code)` | redeem a pairing code, start the bridge |
| `status()` / `onStatus(fn)` | sim connection and live flight figures |
| `recentLog()` / `onEvent(fn)` | bridge activity |
| `restart()` | reconnect the bridge |

Nothing else from Node crosses into the page — `contextIsolation` is on and
`nodeIntegration` is off. `src/lib/desktop.ts` wraps this and returns `null` in a
browser, so the web build keeps the pairing-code flow.
