# RotorOps Bridge

Connects **Microsoft Flight Simulator 2024** to your RotorOps company. It watches
the sim over SimConnect, detects when you fly, and files the flight — hours, fuel,
touchdown rate, incidents — against whatever contract you dispatched.

The web app can't do this itself: SimConnect is a local IPC API with no route out
of a browser tab. This process is the only thing that talks to the sim.

```
MSFS 2024  ──SimConnect──►  bridge  ──HTTPS──►  Supabase  ◄──  web app
```

## Two ways to run it

**As an .exe** (no Node needed on the machine that runs it) — see
[Building the exe](#building-the-exe). Double-click it; it walks you through
pairing on first launch.

**From source**, for development:

- Node 22.6+ (uses native TypeScript type stripping — no build step)
- MSFS 2024, running and past the main menu
- No MSFS SDK needed. `node-simconnect` speaks the wire protocol directly, so
  there's no `SimConnect.dll` and no native compilation.

## Setup

```bash
cd bridge
npm install
```

In the app, go to **Settings → Sim Link** and generate a pairing code, then:

```bash
npm run pair -- ABCD2345
```

That exchanges the code for a device token stored at
`%APPDATA%\RotorOps\bridge.json`. The code expires after 15 minutes and is
single-use; the token is what the bridge authenticates with afterwards. Supabase
URL and publishable key are read from the project's `.env`.

## Building the exe

```bash
npm run build
```

Produces `dist/rotorops-bridge.exe` — about 89 MB, because it contains the whole
Node runtime. It's a [Node Single Executable Application][sea]: the TypeScript is
bundled to one file with esbuild, turned into a SEA blob, and injected into a
copy of `node.exe`.

[sea]: https://nodejs.org/api/single-executable-applications.html

The Supabase URL and **publishable** key are baked in at build time so the exe
works from anywhere with no config file. That key is public by design — the web
app already ships it in its client JavaScript, and every table behind it is
protected by row-level security. A `.env` beside the exe still overrides it, as
do `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` in the environment.

Your device token is *not* baked in. It's created at pairing time and stored in
`%APPDATA%\RotorOps\bridge.json`, so the exe is safe to copy between machines —
each one pairs separately, and you can revoke any of them from Settings.

Two things to expect:

- **Windows SmartScreen will warn on first run.** Injecting the blob invalidates
  `node.exe`'s Authenticode signature, so the exe is unsigned. Signing it needs a
  code-signing certificate.
- **Antivirus false positives** are common for SEA builds, since "an exe with a
  script payload injected" is also what some malware looks like.

Rebuild whenever you change anything under `src/`.

## Flying

1. Dispatch a contract in the app — pick the contract and the aircraft.
2. Start the bridge, then fly it in MSFS:

```bash
npm start          # from source
```

or just run `rotorops-bridge.exe`.

3. Fly the route. On engine shutdown the bridge files the flight and prints the
   result:

```
[19:42:07] Flight logged: Airbus H125 KSQL -> KHAF
[19:42:07]   0.62h  148 lb fuel  landing: excellent
[19:42:07]   Contract "Coastal survey run": COMPLETE
[19:42:07]   Payout +$4,410  fuel -$133  ops -$372  =  +$3,905
[19:42:07]   Reputation +3
[19:42:07]   Airframe wear now 12.4%
```

A flight with no dispatched contract is logged as a positioning flight: hours and
wear accrue, fuel is charged, nothing pays out.

## What gets measured

| Logged value | Source |
|---|---|
| Flight time | `ABSOLUTE TIME` delta — sim clock, so pausing doesn't inflate it |
| Fuel used | `FUEL TOTAL QUANTITY WEIGHT` delta |
| Payload | `TOTAL WEIGHT − EMPTY WEIGHT − FUEL` |
| Landing quality | `VERTICAL SPEED` on the frame before ground contact |
| Departure / arrival | Nearest airport from the SimConnect facility cache |
| Incidents | Engine failure, overtorque, sling cable break, low rotor RPM |

Touchdown is sampled per frame; everything else at 1 Hz.

Success is not a dice roll. You succeeded if you landed at the contract
destination, in one piece, carrying the required payload. Helicopter work often
ends off-airport, so landing within 3 nm of the filed destination counts as
arriving there even when no airport is the nearest facility.

## Aircraft matching

The bridge matches the sim's `TITLE` against `sim_title` on your fleet, falling
back to loose containment and then to the internal ID. MSFS titles carry livery
and variant suffixes, so exact matches are the exception.

If a flight ends and nothing matches, the bridge says so and files nothing. Fix
it by adding the exact title to that aircraft's `sim_title_aliases`.

## Checking your install

```bash
npm run probe
```

Load any flight and run this. It prints a live snapshot, the airports in the
facility cache, and — importantly — which rotor-specific SimVars this build of
MSFS 2024 actually exposes.

The rotor SimVars in `src/simvars.ts` are verified against the MSFS 2024 SDK
docs ([Helicopter Variables][heli], [Aircraft Engine Variables][eng]) and
cross-checked against the token enum in `WASM/include/MSFS/Legacy/gauges.h` of
the installed SDK.

[heli]: https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimVars/Helicopter_Variables.htm
[eng]: https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimVars/Aircraft_SimVars/Aircraft_Engine_Variables.htm

Three things that catch people out, all confirmed in the docs:

- `SLING OBJECT ATTACHED` and `SLING HOOK IN PICKUP MODE` are **not** indexed,
  even though the sling variables either side of them are.
- `ROTOR RPM PCT` is indexed by **engine** index, not rotor, and its native unit
  is *percent over 100*. The bridge requests `percent` so SimConnect converts to
  a 0-100 scale.
- There is no overtorque SimVar in MSFS 2024. `GENERAL ENG DAMAGE PERCENT` is
  the closest the sim exposes, and that's what the incident log records.

Each variable still gets its own SimConnect data definition, so an aircraft with
no sling costs one field rather than the whole telemetry stream. `probe` reports
which resolved on your install.

## Troubleshooting

**"could not reach SimConnect"** — MSFS isn't running, or is still on the main
menu. The bridge retries every 5 seconds. The message lists every address it
tried; if your sim listens somewhere unusual, set `SIMCONNECT_PORT`.

Addresses come from MSFS's own `SimConnect.xml` rather than the registry. The
library's registry lookup shells out to a helper script that can't be bundled
into an exe, so the bridge reads the config file directly — which also means a
custom `<Port>` is picked up automatically.

**"does not match any aircraft in your fleet"** — run `probe`, copy the exact
`aircraft` title, and add it to that aircraft's aliases.

**Nothing logs after landing** — the flight closes on *engine shutdown*, not on
touchdown. Shut down, or use **Log manually** in the app.

**Flight discarded** — a run under 0.02h that never left the ground is treated as
a ramp test, not a flight.

## Using your own 3D models

Scene dressing spawns whatever SimObjects your install has. Custom models work
the same way as stock ones — the bridge asks MSFS what exists and spawns by
title, so nothing here needs rebuilding when you add one.

### 1. Get the model into MSFS as a SimObject

Export to glTF 2.0 with the MSFS extensions. Both exporters ship in your SDK:

- **Blender** — `MSFS 2024 SDK\Tools\Blender\addons\io_scene_gltf2_msfs_2024`
- **3ds Max** — `MSFS 2024 SDK\Tools\3dsMax`

Then package it as a SimObject. Minimum structure:

```
MyPackage/
  SimObjects/Misc/MyCargoPallet/
    sim.cfg            <- defines the title MSFS reports
    model/
      model.cfg
      MyCargoPallet.gltf
      MyCargoPallet.bin
```

The `title` in `sim.cfg` is the string the bridge matches on. Drop the built
package in your Community folder.

Category matters: the bridge enumerates `BOAT` and `GROUND` separately, so a
boat needs to be a boat SimObject to land in the boat pool.

### 2. Find out what MSFS calls it

```bash
npm run probe
```

Or check the diagnostics log after connecting — the bridge lists what it found:

```
Scene objects available: 12 boats, 47 ground.
Ground objects: Fuel_Truck | Pushback_Tug | MyCargoPallet | ...
```

Titles must match **exactly**. A title in your config that the sim doesn't
report is logged as `configured object(s) not found in this install`, so a typo
fails loudly rather than silently spawning nothing.

### 3. Map it to a job

Copy `scene-objects.example.json` to `%APPDATA%\RotorOps\scene-objects.json`
and name your titles against a role or scene type:

```json
{
  "roles": {
    "logistics": { "pool": "ground", "titles": ["MyCargoPallet"],
                   "count": 4, "spreadNm": 0.05 }
  }
}
```

Explicit titles beat the built-in keyword matching, so a model you authored for
the job is always preferred to one guessed by name. Anything you don't override
keeps the default behaviour.

Restart the bridge to pick up changes — it reads the file once on connect and
logs how many mappings it loaded.

### What models can and can't do

Spawned SimObjects are **static props**. They sit where they're placed with a
heading, and that's all — no animation, no pathing, nobody waves at you. The sim
settles them onto terrain or sea level.

For anything that moves, `aICreateNonATCAircraft` with `aISetAircraftFlightPlan`
gives an AI aircraft that actually flies a route — useful for a police helicopter
already on scene, or a spotter overhead. That isn't wired up yet.
