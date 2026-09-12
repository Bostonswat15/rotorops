---
name: rotorops-sim
description: Run and test RotorOps Manager against MSFS 2024 on this Windows machine - launch the desktop app, run the bridge probes (probe dump, spawn-test, sling and hoist tests), read the bridge diagnostics log, apply Supabase migrations, and check contract/objective/scene logic with offline tests. Use when the user asks how to run the app, what to type in cmd, why a contract did not tick or log, why a scene object did not spawn or looks wrong, or to test a mission, objective, prop or aircraft in the sim.
---

# RotorOps: run, probe, diagnose

The user runs everything from **Windows Command Prompt** and wants exact, copy-pasteable
commands, one per block. Repo: `C:\Users\patri\Desktop\Flightsimapp\rotor-zenith-ops-main`.

## Launch the app

1. Quit any running copy first: right-click the RotorOps tray icon -> Quit. Closing the
   window only hides it to the tray, and a stale copy keeps running the old bridge.
2. Run:

```bash
C:\Users\patri\Desktop\Flightsimapp\rotor-zenith-ops-main\start.bat reveal
```

- `start.bat` runs `npm --prefix desktop start`, which builds the web app with the
  **node-server** preset (`desktop/build-app.mjs`) and bundles the bridge before opening
  Electron. Never tell the user to run root `npm run build` for the desktop app: that is
  the Cloudflare preset and produces "app server did not start".
- `reveal` sets `ROTOROPS_REVEAL=1`: the hidden SAR casualty position is logged and drawn
  on the In Flight map. Leave it off for normal play.
- Bridge changes only take effect after a relaunch. Check the build time of
  `desktop/dist/bridge.cjs` against the commit time if a fix "didn't work".
- A contract already on the board keeps whatever was baked in at generation (zones,
  hover heights, labels, casualty candidates). Changes to generation need
  Missions -> Clear board -> Generate.

## Bridge probes (MSFS running, aircraft loaded, past the main menu)

Run from the repo folder (`cd` there first). All take `--` before their arguments.

| Command | What it answers |
|---|---|
| `npm --prefix bridge run probe -- dump` | Writes every title the sim enumerates to `bridge/simobjects.txt` (sections HELICOPTER, AIRCRAFT, BOAT, GROUND) and lists which rotor SimVars resolve |
| `npm --prefix bridge run spawn-test -- title "<exact title>"` | Places one object ~60 m ahead for 2 minutes. Add `<throttle%> <spoiler%>` to drive an effect emitter |
| `npm --prefix bridge run spawn-test -- <role>` | Stages a whole role's scene ahead (e.g. `medevac`) |
| `npm --prefix bridge run sling` | Prints sling/hoist/weight state on change while the user works the controls |
| `npm --prefix bridge run sling -- fire` | Also fires `SLING_PICKUP_RELEASE` every 5 s |
| `npm --prefix bridge run sling -- hoist` | Maps the MSFS hoist events (a `NAME_UNRECOGNIZED` right after a `mapping` line = sim does not know it), then extends/retracts while printing `hoist=` |

Newly installed Community packages only appear after a full MSFS restart.

## Diagnostics log

Everything the bridge logs, plus renderer errors, lands in:

`C:\Users\patri\AppData\Roaming\rotorops-desktop\rotorops-diagnostics.log`

Filter out the noise and look at a time window (timestamps are UTC; the machine is UTC-4):

```bash
L=/c/Users/patri/AppData/Roaming/rotorops-desktop/rotorops-diagnostics.log
awk -F'[][]' '$2 >= "2026-09-12T21:00:00"' "$L" | grep -v "CORS policy" | tail -40
```

Useful patterns: `armed`, `Objective complete`, `All objectives complete`, `logging`,
`Failed to submit`, `Pending:`, `Requested`, `Placed "`, `walking a`, `strayed`,
`No road`, `Road lookup`, `Lined`, `signalled`, `relit`, `REVEAL`, `SimConnect exception`.
Read the log before guessing - most "it doesn't work" reports were answered by it.

Road lookups are cached at `C:\Users\patri\AppData\Roaming\RotorOps\road-cache.json`.

## Migrations

Claude cannot run them: that needs the database password or service_role key, which must
never be requested or handled. The user pastes the file into the **Supabase SQL editor**
(project ref `cnwohnndmqqppftmzses`). Rules:

- Re-run **forward from** the file needed, never an older file alone. `CREATE OR REPLACE
  FUNCTION` has no idea it is going backwards; re-running `20260826120000_sim_bridge.sql`
  once rolled six functions back to pre-coop versions.
- To re-apply several in order, concatenate them into `apply-migrations.sql` (gitignored).
- Every `CREATE POLICY` must be preceded by `DROP POLICY IF EXISTS` so files are re-runnable.

## Offline tests (no sim needed)

There is no test runner. Write throwaway scripts in the session scratchpad.

- Bridge code: `node --experimental-strip-types <script>.ts`, importing via absolute
  `file:///C:/Users/patri/Desktop/Flightsimapp/rotor-zenith-ops-main/bridge/src/...ts` URLs.
  `ObjectiveTracker.update(sample, now)` takes a synthetic clock for timed objectives.
- App code (`src/lib/*`, uses extensionless and `@/` imports): copy the script into the
  repo root as a dotfile and run `./node_modules/.bin/tsx.exe ./.<name>.tmp.ts`, then delete it.
- Overpass from Node needs a `User-Agent` header or it returns 406 (the browser adds one
  in the app). Overpass is frequently overloaded (504/429/12 s hangs) - a failure there is
  not proof the query is wrong; A/B the old query before blaming a change.
- Type-check both halves: `cd bridge && npx tsc --noEmit`, and from the repo root
  `./node_modules/.bin/tsc.exe --noEmit -p tsconfig.json`.
