# RotorOps Manager

A career/company-management game for helicopter (and some fixed-wing) flying in **MSFS 2024**:
contracts, fleet, crew, maintenance, industries, pilot skills. A web app (TanStack Start,
React 19, Supabase) runs inside an **Electron** shell that also hosts the **SimConnect bridge**,
which watches the sim, stages scene props, tracks contract objectives and logs flights.

Read `AGENTS.md` too: this repo syncs with Lovable, so never rewrite pushed history.

For running, probing the sim, reading the diagnostics log, migrations and offline testing,
use the project skill **`rotorops-sim`** (`.claude/skills/rotorops-sim/SKILL.md`).

## Layout

| Path | What |
|---|---|
| `src/routes/_authenticated/*.tsx` | App pages (file routes). `flight.tsx` is the full-screen In Flight page |
| `src/components/live-flight-panel.tsx` | Telemetry + objective list + map, used by In Flight |
| `src/components/flight-map.tsx` | Leaflet map: aircraft, scene, search ring, waypoints, casualty |
| `src/lib/missions.ts` | Contract templates and generation, placement sites, scene placement |
| `src/lib/osm.ts` | Overpass queries: site scan (`findSites`), cliffs, power lines/towers, industries |
| `src/lib/aircraft-catalog.ts` | Buyable aircraft; `simTitle` must match what MSFS reports; `family`/`variant` group the Market |
| `bridge/src/runner.ts` | Bridge orchestration: arming contracts, staging, boarding, signal smoke, winch call-outs, auto-logging |
| `bridge/src/objectives.ts` | `ObjectiveTracker` - every objective kind, zones, the simulated winch |
| `bridge/src/scene-actors.ts` | `SceneDirector` - enumerate, stage, freeze, walkers + leash, effect emitters |
| `bridge/src/roads.ts` | Nearest OSM road for roadside scenes, racing mirrors, disk cache |
| `bridge/src/search.ts` | Hidden SAR casualty resolution and detection model |
| `bridge/src/telemetry.ts`, `simvars.ts`, `flight.ts` | SimConnect session, SimVars, flight start/end |
| `desktop/main.js` | Electron main: local Nitro server + bridge in-process + IPC status |
| `supabase/migrations/` | Schema and SECURITY DEFINER RPCs (`rotorops_resolve_flight`, `bridge_state`, `set_base_sites`, ...) |
| `start.bat` | Launcher (`start.bat reveal` for SAR testing) |

## How things fit

- **Contracts** are generated in the browser (`missions.ts`) from templates plus per-base
  **placement sites** (roads, rivers, shore, offshore, lakes, cliffs, hospitals) scanned
  once from OSM and cached on `bases.placement_sites` via `set_base_sites`. Objectives,
  radii, hover limits and SAR `target_candidates` are **baked in at generation** - existing
  contracts do not pick up generation changes.
- **The bridge** polls `bridge_state` every 30 s, arms the contract dispatched to the loaded
  aircraft (matched by sim title), stages its scene, tracks objectives per telemetry sample,
  persists each completion, and submits the flight when every objective is done and the
  aircraft has been settled on the ground for 5 s (or on engine shutdown). It also submits
  after a restart with no flown segment, trusting the objectives for arrival and payload.
- **SAR casualty** positions are derived in the bridge from the mission id (never stored
  server-side). Cliff/river/beach/vessel scenes pick from mapped terrain candidates.
- **The server** (`rotorops_resolve_flight`) pays out, charges costs, applies wear, XP and
  reputation. Arrival is judged by ICAO match, which is why the bridge overrides arrival
  when objectives are complete (scene contracts end at hospitals, not the destination).

## Hard-won facts about MSFS 2024 / SimConnect (measured, not assumed)

- **No helicopter tried has a sim-driven sling or hoist.** H125 Cargo, H125 Rescue, AS365,
  HH-65B Dolphin SAR all report `NUM SLING CABLES = 0`; `HOIST_SWITCH_EXTEND` is accepted and
  ignored (`HOIST_DEPLOYED_*` are not even recognised). Hence the **simulated winch** (steady
  hover 40 s within 0.1 nm, < 200 ft, < 10 kts) and weight-based sling/boarding.
- **SimConnect cannot see or place scenery.** Pylons, buildings and roads are terrain built
  from OSM; OSM coordinates are the proxy (patrol waypoints snap to real towers).
- **Enumeration is incomplete.** `category=Human` objects (Animated Humans `ahqw ...`) are
  never listed but **spawn fine by title**, so plans name them outright.
- **Effect packs are airplane-category objects** (enumerate under AIRCRAFT) whose emitters
  are gated on flight-model values: 30West smoke = throttle bands (grey) or **spoiler handle**
  1-5% (orange). Write `SPOILERS HANDLE POSITION`, not the surface position.
- **`setDataOnSimObject` needs `{ buffer: RawBuffer, arrayCount: 0, tagged: false }`** or a
  `SimConnectData[]`. A bare buffer or `{ value }` throws inside your own catch and looks like
  the sim refusing. This silently broke casualty weight and smoke for a while.
- A fresh AI object keeps initialising after its id arrives: **re-send** effect values and
  waypoint lists at ~2 s and ~6 s.
- Frozen walkers march on the spot (AutoPlay walk clip). Walkers get an `AI WAYPOINT LIST`
  loop instead, plus a 40 m **leash** that pins strays.
- `PLANE ALT ABOVE GROUND` is to terrain, not treetops - low hover limits are impossible in
  forest.
- Contracts arm twice at startup (~3 s apart, forced restage). Anything async (road lookups)
  must check a staging generation and the cache on every retry.
- Overpass: needs a User-Agent outside the browser, is often overloaded, caps results in id
  order (use a near-field pass plus a wide pass), and a single union query fails as a whole -
  keep optional lookups (cliffs) separate.

## Conventions

- Comments explain **why**, often with the measurement that forced the change. Match that.
- Commits: imperative subject, a body explaining the cause and what was measured, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Commit locally as work lands;
  **do not push or tag unless the user asks** in that moment.
- Files are CRLF on disk; scripted edits must detect and preserve line endings.
- Scene staging defaults to base-game objects (`stockOnly`); explicit titles from packs the
  user installed are fine. Never recommend buying models without checking stock first.
- Never request or handle the Supabase service_role key or database password. The publishable
  key in client code is public by design. `.env` stays gitignored.

## Open items (as of 2026-09-12)

- **Released `v0.4.4`** (2026-09-12, commit `dffbe95`, built by `release.yml` on tag push).
  Later work is committed locally, not pushed; tag or push only when the user asks.
- **Migration to run:** `20260912000000_cliff_sites.sql` (adds the `cliff` key to
  `set_base_sites`). Until run, cliff rescues fall back to old placement.
- **Migrations to run (2026-09-13), in order:** `20260913000000_transaction_aircraft.sql`
  (aircraft on ledger rows, for profit per aircraft), `20260914000000_maintenance_and_loans.sql`
  (100-hour inspections, wear cost, breakdowns, resale curve, loans, balance sheet),
  `20260915000000_fuel_farms.sql` (fuel farms, fuel runs), then
  `20260916000000_crash_restart.sql` (a crash is repairable damage and resets the contract to
  restart from its origin), then `20260917000000_flight_score.sql` (score columns on
  flight_logs, grade prices pay/XP/rep, avg score on the roster), then
  `20260918000000_industry_flow.sql` (hauls move stock via `industry_deliveries`, mills get
  `input_stock`, floats tag backfill), then `20260919000000_pilot_ratings.sql` (check rides
  inside a company). Each of the last six carries `rotorops_resolve_flight` forward; any later
  change must start from the 20260919 copy. 20260919 also carries `dispatch_mission` and
  `cancel_dispatch`; 20260918 last carried `dispatch_trade_run` and `industry_tick`;
  `service_aircraft` and `bridge_state` were last carried in 20260916. The Finance and Bases
  pages show a notice until theirs is run. 20260918 was built by carrying each function forward
  programmatically from its newest file, never retyped.
- **Pilot ratings (user's rules):** owner exempt; everyone else (managers too, and existing
  members) flies a company check ride before taking contracts and a type rating per aircraft
  family in the fleet (`family ?? internal_id`; `src/lib/ratings.ts` mirrors
  `aircraft_type_families`, a seeded copy of the catalogue -- add new catalogue aircraft to it
  in a migration or they rate as their own type server-side). Rides are `role = 'rating_ride'`
  missions booked server-side and reserved (`book_rating_ride`, triggers on company_members
  insert/role change and aircraft insert, `ensure_my_rating_rides` on Mission Board load).
  Heli: hover < 50 ft AGL 30 s, reach 3 nm, land; plane: reach 5 nm, land. Pass = all objectives
  + score >= 60 (no score = no pass); fail returns it to the board; no rep; 150 XP. $1,000
  examiner fee on first dispatch (user approved "when booked"; moved to dispatch because rides
  are auto-booked when cash may be short -- told the user).
- **Plane work and industry flow (user approved all of it):** Planes board 3 -> 6 per Generate
  (18 tries, since floatplane/mail can return null). New fixed-wing templates in
  `src/lib/fixed-wing.ts`: Skydive Lift ($2,800, new bridge `climb` objective, 10,000 ft AGL
  within 3 nm), Mail Run (3 stops, $3,000 + $1,000/stop), Lodge/Island Hopper (2 stops + home,
  $6,500), Floatplane Lodge Run ($5,500, `floats` tag, land_off on lake/shore, needs water
  within 10 nm of base), Fire Spotting Patrol (3 overflies < 3,000 ft AGL, $6,000); Aerial Line
  Patrol is `generatePowerlinePatrol(..., "fixed")` ($5,000, < 1,500 ft AGL, 0.35 nm zones,
  Overpass lookups shared via `once`). Regional Shuttle payload 6,000 -> 2,500 lb. Industry
  (`src/lib/industries.ts`): 2 helicopter + 2 plane hauls per Generate; plane hauls land at the
  airport nearest the source (<= 25 nm) and nearest the buyer, >= 15 nm apart, 800-4,000 lb;
  finished goods sell to regional market airports 40-200 nm out at base value x (1 + nm/200).
  Hauls take stock at dispatch (`dispatch_mission` checks stock and that min_payload matches
  the goods' weight), deliver into the buyer's `input_stock` (or stock), refund on fail, cancel
  or delete, and stay reserved through a crash reset. Mills burn flown-in input at full rate,
  then pull from their camp at half rate (`CAMP_PULL_SHARE`).
  **Not yet flown:** `climb`, floatplane on water counting as on-ground (land_off and boarding
  depend on it), the bridge boarding weight into an aeroplane's payload stations, 0.35 nm line
  zones for planes. **Noted, not changed:** raw-good hauls pay very little (a plane timber
  haul came out at ~$195) because timber/grain base values are $4-6 a unit.
- **Airstrips and runway matching (user approved 2026-09-13):** `findAerodromes` (osm.ts) also
  pulls `aeroway=runway` ways (a second Overpass query, after the fields) and gives each field
  its longest land runway, `runway_ft` (drawn extent, else the `length` tag; 0 = only water
  runways, null = none mapped), plus that runway's `surface`. The Mission Board copies OSM runway
  data onto the bridge's airports (ident match, else within 1 nm, which also drops the OSM
  duplicate). `fieldSuits` (fixed-wing.ts): longest runway >= `min_runway_ft`; `bush_strip`
  templates (Bush Strip Resupply, Lodge/Island Hopper) only take fields whose longest runway is
  unpaved or < 3,000 ft, never unmapped ones; other jobs take unmapped fields only when
  `min_runway_ft` <= 2,500 (the briefing says the length is unknown); water-only never. Surveys
  aren't filtered (nobody lands at their reference field). Land objectives store the field's
  `lat`/`lon`, plus `runway_ft`/`surface` for the card's strip line (`stripOf`). The bridge places
  a landing by the sim's ident, by the stored position when the sim doesn't know the ident or
  puts it > 3 nm away, and with neither accepts any landing -- only after the aircraft has left
  the ground since the previous objective (it used to tick "Land at X" off while parked). Base
  returns store a position only when the base names no ICAO. **Not yet flown or run live.**
- **Flight score (built 2026-09-13):** `bridge/src/score.ts`, run by `FlightTracker`. Its new
  OPTIONAL SimVars (CATEGORY, LIGHT BEACON/STROBE/LANDING, PLANE BANK/PITCH DEGREES, AIRSPEED
  INDICATED, OVERSPEED/STALL WARNING, G FORCE, TIME OF DAY, AMBIENT VISIBILITY) all resolved in
  `probe` on this install (2026-09-13, HH65B Dolphin - SAR). Accepted is not yet the same as
  read correctly in flight: a first scored flight should confirm bank/pitch signs, CATEGORY's
  string, and that the beacon rule sees the lights at engine start. A missing SimVar only
  drops its rule. CATEGORY decides rotary vs fixed limits (defaults rotary). No cloud-base
  SimVar is read, so the low-cloud half of the low-visibility bonus isn't implemented.
- **Crash rule (user's, 2026-09-13):** crash -> wear 100, grounded, Repair = 10% of price and
  restores pre-crash wear; contract back on the board reserved for that pilot with
  `restart_from` = origin; rep -2 x difficulty; only counts if the flight departs
  `restart_from` (bridge holds objectives until then).
- **OnAir-inspired roadmap** (user picked these 2026-09-13). Built: maintenance/resale, loans,
  fuel farms on the new Bases tab ($25k/10,000 lb, +$15k per 10,000 lb, bulk $0.65/lb vs $0.90
  pump; refinery avgas via `fuel_run` missions, filled on success, refunded on fail or delete).
  Remaining, in dependency order: FBO hangar and crew rooms (unpriced; nothing to save until
  parking or crew costs exist) -> flight score (needs bridge SimVars for lights, bank, pitch, IAS,
  stall/overspeed, time of day, visibility) -> job deadlines/urgency and cargo types (fragile
  uses the score's G/bank tracking) -> staff (mechanics make maintenance take time, flight
  attendants need passenger counts on contracts, training) -> regular routes, tours and races
  -> hourly rental, airport ownership, company value leaderboard. There is no scheduler:
  anything billed over time must be charged lazily on elapsed real time, like `industry_tick`.
  Propose numbers for each before building (only the fuel farm's are approved).
- **Unapproved tuning:** hoist-contract hover limits were raised (Vessel/Swiftwater 150 ft,
  Cliff/Ridgeline 180 ft, from 80-120 ft). Revert if the user objects.
- **Industry site props (built at the user's request):** building a camp places nothing
  permanent (SimConnect can't add scenery). Props appear only while an industry contract is
  armed. `planFor` gives each kind its own base-game plant (`industryPlan` in
  `scene-actors.ts`, hints checked against `bridge/simobjects.txt`); the kind is read from the
  contract title (`bridge/src/industry-kind.ts`). Trade and fuel runs are staged at their first
  `reach` (the pickup), not the scene point (their delivery end). Plane hauls place nothing.
  `scene-objects.json` can override one kind via `roles["industry:<kind>"]`. Fishing skiffs spawn
  at the site point, which may be on land; not yet seen in the sim.
- **Not yet flown in the sim:** simulated winch, walker leash/AGL waypoints, terrain casualty
  candidates, roadside road placement after cache fix, auto-logging on a clean full flight.
- **Offered, not done:** road fire engines instead of airport crash tenders on highway scenes;
  immediate bridge refresh on dispatch (currently up to 30 s); ridgeline casualties still
  random (no ridge data); round the fractional cash display.
