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
- **Auto-update (built 2026-09-14, at the user's request):** installed copies update from the
  GitHub releases with `electron-updater` (`desktop/main.js` `setupUpdates`; check at startup
  and every 4 h, background download, "Restart now / Later" dialog defaulting to Later while a
  flight is tracked, install on quit, tray "Check for updates" / "Restart to update"). Needs:
  `build.publish` github Bostonswat15/rotorops and `nsis.artifactName`
  `RotorOps-Setup-${version}.${ext}` (GitHub renames spaces in asset names) in
  `desktop/package.json`; `release.yml` stamps the tag's version into `desktop/package.json`
  before electron-builder and uploads `desktop/dist/latest.yml` and `*.blockmap` with the
  installer. Skipped when not packaged (start.bat); the package-for-friends zip logs an updater
  error. Everyone on v0.6.0 or earlier installs the first updater release by hand. **Not yet
  seen working:** needs two releases with the updater (e.g. v0.6.1 updating to v0.6.2).
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
  change must start from the 20260923 copy (`20260923000000_cargo_inventory.sql`, which also
  carries `bridge_state`; before it, 20260922 `20260922000000_fix_incident_lists.sql`, which
  changes only its five `v_incidents || 'literal'` lines to `array_append` -- the untyped literal
  was parsed as an array, so every flight with an incident failed to submit with "malformed
  array literal"). 20260919 also carries `dispatch_mission` and
  `cancel_dispatch`; 20260918 last carried `dispatch_trade_run` and `industry_tick`;
  `service_aircraft` and `bridge_state` were last carried in 20260916. The Finance and Bases
  pages show a notice until theirs is run. 20260918 was built by carrying each function forward
  programmatically from its newest file, never retyped. Then `20260920000000_company_switch.sql`
  (carries `bridge_device` and `create_pairing_code` from 20260826120000_sim_bridge.sql), then
  `20260921000000_delete_company.sql`, then `20260922000000_fix_incident_lists.sql`, then
  `20260923000000_cargo_inventory.sql` (built by carrying `bridge_state` from 20260916 and
  `rotorops_resolve_flight` from 20260922 with anchored substitutions). Then
  `20260924000000_cert_rep_floors.sql` (data only: lower cert check ride reputation floors,
  user approved 2026-09-14 -- turbine 50, hoist 55, medevac 60, offshore 65, firefighting 70,
  sar 75, heavy_lift 80; mirrored in `CERT_UNLOCKS`). Settings shows "Need N more reputation"
  / cash instead of a Book check ride button that only errors.
- **In Flight keeps flights apart:** a contract dispatched to a different aircraft than the one
  loaded in the sim (`simAircraft.matchedId`) is not drawn as this flight; the panel shows it
  as positioning with a note naming the aircraft the contract is on. Since v0.6.3/v0.6.4 In
  Flight and the Dashboard show only your own contracts, jobs, flights and aircraft
  (`assigned_pilot_id` / `pilot_id` = you); company totals stay shared.
- **Plane contracts pay by distance (user approved 2026-09-14):** `pay_per_nm` on each
  `FIXED_WING_TEMPLATES` entry; payout = `base_payout x PAY_FEE_SHARE (0.5)` + per-stop fees +
  `pay_per_nm x` miles (a delivery counts the flight home, `pay_nm`), then variance and
  reputation as before. Light $40/nm (was $25, raised 2026-09-15 option B) (mail, instruction, ferry, spotting, floatplane, hopper,
  bush resupply), utility $60/nm (scheduled freight, exec charter, survey, fisheries, air
  ambulance), premium $90/nm (overnight freight, regional shuttle, organ transport). Skydive
  stays flat. Only new boards: existing contracts keep their baked payout.
- **Bush planes, cargo and lease (user approved 2026-09-14):** the Mission Board only offers plane
  templates some plane in the fleet can fly (`fleetCanFly`: payload, shortest leg vs range, a
  role tag; `isFixedWingAircraft` by catalogue id), falling back to every certified template.
  Four light bush contracts, all `bush` tag, $40/nm: Backcountry Parcels (250 lb, 15-60 nm, raised 2026-09-15 to base $8,000 + $60/nm;
  base $3,200), Hunting Camp Drop (350 lb, 20-80, $4,500), Cabin Supply Hop (300 lb, 10-50,
  $3,800) as bush-strip round trips, Wildlife Survey (200 lb, 20-70, $4,200, survey). Cargo Hub
  plane pay $20/nm; plane jobs sized by `planeLimits` from the biggest plane: 60 lb to 70% of
  its payload (max 2,500), passengers up to its seats behind the pilot. Lease rate 0.03% of
  price per flight hour (`20260925000000_lease_rate.sql`, new leases only; mirrored in
  market.tsx).
- **Half-real economy (user approved 2026-09-14):** every catalogue aircraft (88) is priced at
  about half its real-world value (helicopters were the sim's own figures, 5-15x too low; e.g.
  H125 $1.3M, H145 $4.25M, Cabri $175k, C152 $30k, Caravan $1.4M). `src/lib/economy.ts`:
  `PAY_SCALE = 2` multiplies every app-generated payout (missions, patrols, charters,
  industries, fixed-wing, cargo `jobPay`, game-data templates); `STARTER_MAX_COST = 175_000`
  limits free starters (both wings, cheapest first). `20260926000000_half_real_economy.sql`
  (built by `scratchpad/build-economy.mjs`; carries create_company from 20260827120300,
  company_loan_limit from 20260914, dispatch_trade_run from 20260918): starting cash Easy $1M /
  Normal $500k / Hard $250k, starter guard, loan limit $250k + half resale, trade run margin x2,
  and reprices owned non-leased aircraft to the new prices. Contracts already on a board keep
  their old payout. Cert costs, lease deposit (2%) and royalties unchanged.
- **Free starters sell for $0 (user chose option a, 2026-09-14):** `aircraft.is_starter`
  (`20260927000000_starter_no_sale.sql`, built by `scratchpad/build-starter.mjs`; carries
  create_company from 20260926 and aircraft_sale_value from 20260914). Backfilled where
  `aircraft.created_at = companies.created_at`. `aircraft_sale_value` returns 0 for a starter;
  loan limit, balance sheet and repair costs still use its catalogue price. Not in the client
  UPDATE grants. Aircraft page says "Free starter · can't be sold for cash"; Maintenance shows
  "$0 (free starter)". Offered, not built: Dashboard "Profit this week" counting only operating
  transactions, and rounding cash to whole dollars.
- **Industry camps on In Flight and in the sim (user asked 2026-09-14; chose industry camps and
  stock objects, no add-on tent -- stock MSFS has no tent):** In Flight draws the company's
  industries as square markers (`FlightMap` `places`/`onPlaceClick`); clicking one sets the
  guide line ("To camp") until clicked again or Clear. `20260928000000_camps_on_bridge.sql`
  carries bridge_state from 20260923 adding `industries` (id, kind, name, lat/lon). Bridge:
  `SceneDirector.stage({ group })` tracks props per group apart from `spawned`; `clear()` leaves
  groups, `clearGroup()` removes one (props still pending are removed on arrival).
  `runner.ts` `maybeCamps` (every 10 s): stages `industryPlan` props via `campTitle(kind)` at camps
  within 5 nm, removes past 8 nm, max 3, skips a camp an armed industry contract stages within
  0.5 nm. **Not yet flown.**
- **Company check ride follows the aircraft (2026-09-15):** `20260929000000_checkout_follows_aircraft.sql`
  carries dispatch_mission from 20260919; dispatching the `checkout` rating ride rebuilds its
  steps from its own reach/land for the aircraft's wing (heli hover < 50 ft 30 s + reach 0.6 +
  land 1.5; plane reach 1.0 + land 2). The Mission Board shows it on both wing tabs.
- **Plane certification check rides (user approved 2026-09-15):** `PLANE_CHECKRIDE_PROFILES` in
  `src/lib/checkrides.ts`, title suffix " (plane)" (`isPlaneCheckride`), same `scene_type:
  "checkride"` so no migration. Turbine: climb 5,000 ft AGL within 3 nm of a point 10 nm out,
  land (2 nm). Medevac: land at a field 15-60 nm (runway >= 1,500 ft or unmapped, never water),
  180 lb payload, land home. Offshore: overfly < 1,000 ft AGL (1 nm) at mapped offshore water
  15-25 nm, else 20 nm random bearing. Firefighting: 3 overflies < 1,000 ft (0.6 nm) 1.5 nm around
  a point 10 nm out. Heavy Lift: 1,000 lb aboard, land at a field 20-60 nm, land home. SAR: search
  1.5 nm radius 6 nm out, no beacon, land home. **Hoist has no plane version** (user: a plane
  can't do it in MSFS 2024). Settings books by wing (Book (helicopter) / Book (plane) for a mixed
  fleet, "helicopter only" note); plane rides show on the plane tab and dispatch only to planes,
  helicopter rides only to helicopters. **Not yet flown:** a plane sighting a search casualty,
  payload boarding on a plane.
- **Industry game mode (user approved 2026-09-15, planes included):** `companies.play_mode`
  'career' | 'industry' and `free_camp_kind` (`20260930000000_industry_mode.sql`; drops the
  6-arg create_company and recreates it with `_play_mode`, `_free_camp`; carries place_industry
  from 20260904 with the free, fully staffed first camp). `src/lib/play-mode.ts`: Industry mode
  Mission Board shows only industry/trade/fuel_run/checkride/rating_ride rows; Generate skips
  scans, scenes, charters, patrols and plane templates, loops the sites 3x and keeps 6 hauls
  (helicopter hauls or plane hauls per tab), each `withFreight` (Cargo Hub `jobPay` for
  min_payload/0.85 lb over distance_nm, on top of the goods). Cargo Hub goods jobs 2 -> 6. New
  Industry company: no starter aircraft, a free lumber camp/farm/quarry/fishing camp placed later
  on the Trading Hall. Settings has a Game mode select (owners/managers).
- **Claiming sites in Industry mode (user chose 2026-09-15: Industry only, full build cost):**
  `20261001000000_claim_industries.sql` adds `industries.claimed_at`, `industry_is_owned(id)`
  (Career, `source = 'built'`, or claimed) and `claim_industry(id)` (charges
  `industry_defs.build_cost`, ledger type `industry_claim`). Carried forward with ownership
  guards: set_industry_workers (staffing > 0), invest_in_industry, dispatch_trade_run (both
  ends), industry_tick (a mill only draws on an owned camp), bridge_state (only owned camps
  dressed). App: `ownsIndustry(company, site)` in play-mode.ts; the Trading Hall lists owned
  sites and a "Nearby sites" section with Claim buttons; Mission Board hauls, Cargo Hub goods
  jobs and In Flight camps use owned sites only.
- **Deleting a site (user asked 2026-09-15, free, no refund):** `delete_industry(id)`
  (`20261002000000_delete_industry.sql`): owners/managers, owned sites only; refused while a
  haul/trade run/goods job to or from it, or a fuel run from it, is in progress; deletes its
  available board missions first (refund triggers tidy stock), then the site (investments
  cascade). Trading Hall: two-click "Delete site" on each owned site card.
- **Cargo Hub, OnAir-style (user approved all three stages, 2026-09-14):** jobs are `missions`
  rows with a `manifest` ({wing, items[{name,qty,unit_lb}], pax}), `pickup_*`/`drop_*` places,
  `expires_at` (48 h), `scene_type = 'cargo'`; the Mission Board, Dashboard and In Flight's
  contract query all exclude them (`manifest IS NULL` / `trip_id IS NULL`). Page
  `src/routes/_authenticated/cargo.tsx` (nav "Cargo Hub", added to `routeTree.gen.ts` by hand);
  generation, pay, weights and the load-sheet check in `src/lib/cargo.ts`; airfield merge moved
  to `src/lib/airfields.ts` (shared with the Mission Board). Numbers: 190 lb a passenger with a
  bag, seats = pax_seats - 1; limit = sim max gross - empty (cargo + pax + chosen fuel), else
  catalogue `payload_lbs` for cargo + pax only; pickups/drops 2 nm at a field, 0.5 nm at a
  site/hospital (x1.35, min 0.25, as objectives); hold still 8 s to load or unload; pay
  rotary $1,000 + $18/nm + $1.85/lb, fixed $900 + $12/nm + $1.50/lb, x1.7 off-airport, x1.8 plane
  into a bush strip, x0.9-1.15 variance, x(1 + rep/200) (fitted to today's charter and freight
  contracts); rotary legs 10-60 nm to fields, 5-40 to sites/hospitals, 150-1,200 lb, <= 4 pax;
  fixed 30-200 nm field to field, 200-2,500 lb, <= 8 pax; base + 2 (rotary, within 25 nm) or 3
  (fixed, within 80 nm) nearby fields get 3-4 jobs each, max 12, plus 2 rotary goods jobs from
  company industries (tier 1 to its processor, tier 2 to the base market) that take stock at
  dispatch via `industry_deliveries`. Server: `dispatch_trip(aircraft, job_ids[], fuel_lb)`
  (ratings as dispatch_mission, one pickup, seats, weight, fuel capacity; one active trip per
  aircraft), `cancel_trip`, `release_trip_jobs` (undelivered back to available, goods refunded),
  `bridge_trip_loaded`, `bridge_deliver_job` (payout x ace_pilot, rep = difficulty, XP 10 +
  5 x difficulty, loan 10%, settles goods, completes the trip when the last job lands),
  `bridge_set_aircraft_limits`. Legs log as positioning flights with `flight_logs.trip_id`;
  resolve keeps the aircraft `on_mission` while its trip is open and cancels the trip on a
  crash. Bridge: `bridge/src/trips.ts` (pure: tripAction, aboardLb, fuelTanks), runner
  `maybeTrip` writes cargo to the casualty payload station (summed with a casualty), sets fuel
  per legacy tank (`FUEL TANK <name> QUANTITY`, gallons, only tanks reporting a capacity) and
  warns if the sim then reads a different fuel weight, reports empty/max gross/fuel capacity
  once per aircraft per session; emits `trip` status for the In Flight trip card and map.
  **Not yet run or flown:** the migration, MAX GROSS WEIGHT / FUEL TANK * CAPACITY resolving on
  this install, writing fuel tanks on the 206/H125/Dolphin, the payload station taking cargo on
  a plane.
- **Several companies per account (built 2026-09-13):** the sidebar header is a switcher
  (`src/components/company-switcher.tsx`: `my_companies`, `set_active_company`, Start a new
  company, Join with a code; `CompanySetup` takes `onCancel`/`initialMode`). After any switch,
  create or join the app runs `queryClient.resetQueries()`. Server side (20260920):
  `bridge_device()` swaps in the device owner's active company (same pick as
  `current_company()`), so every bridge wrapper follows a switch with no re-pairing;
  `create_pairing_code` pairs to the active company (it took the first OWNED one, so pure
  pilots couldn't pair); trigger `guard_active_company_switch` on `profiles.active_company_id`
  refuses a change while the user has an `in_progress` contract in another company (covers
  switch, found, join). A positioning flight has no contract, so the switcher confirms in the
  desktop app when the bridge reports a flight. No cap on companies per account. **Not yet run
  or tried.** Deleting (20260921): `delete_company(_company_id, _confirm_name)` only -- the
  "company delete" policy and DELETE grant are gone. Owner only, name typed (case-insensitive),
  refused while any contract is `in_progress`; moves every member's `sim_devices` paired to it to
  that member's oldest other company, then deletes the row and lets everything cascade (the
  refund and leave triggers already skip a deleted company). UI: owner-only section at the
  bottom of Settings, plus a menu item in the switcher. After founding or joining, the layout
  calls `ensureDesktopBridgeLinked()` (src/lib/company.ts), which re-provisions the desktop
  bridge when no paired "RotorOps Desktop" device is left.
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
- **Failed flight submissions are retried (built 2026-09-14):** `bridge/src/pending-flights.ts`
  keeps them in `%APPDATA%\RotorOps\pending-flights.json` with the exact telemetry sent.
  `classifyFailure`: server "mission already resolved / not found / assigned to another pilot"
  -> dropped; a 5xx on a positioning flight -> not retried (may have logged; nothing stops a
  duplicate); everything else (no response, 4xx, 5xx on a contract) -> retried after 1, 2, 5, 10
  min then every 15, for 48 h. `api.ts` throws `RpcError` with the HTTP status (null = no
  response). The runner retries all at start, due ones every 30 s, drops a contract entry once
  `bridge_state.dispatched` no longer lists it, and the resumed-after-restart submit defers to
  a queued flight for the same contract. Desktop runner only; the CLI `run` loop in index.ts
  does not queue. **Not yet seen retrying live.**
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
- **Planes are not helicopters (2026-09-15):** rotor-RPM and
  sling-cable incidents are only collected when the scorer is `rotary` (`flight.ts`); a plane
  reports ROTOR RPM PCT too and was losing 15 points. Payload steps say people or freight by
  label (`carriesPeople` in `objectives.ts`): "land by the casualty" only on rescues, "land and
  stop to load" for freight and hauls, and the bridge says "Loaded" rather than "Get them to the
  receiving field". Plane cards show `Field:` instead of Scene/nearest field/Diversion field, and
  In Flight says "To field". Plane contracts (`isFixedWingMission`) only offer planes at
  dispatch (user chose plane-only 2026-09-15): an EC130 shares the "light utility" tag and was
  offered ferry flights. Client-side only, like plane check rides; `dispatch_mission` does not check.
- **Shorter plane legs, grass strips, bush first (user approved 2026-09-15):** plane
  `leg_range`s shortened (bush: Backcountry 10-30, Cabin 8-25, Hunting 12-35, Wildlife 12-35,
  Bush Strip Resupply 25-70, Mail Run 12-35/leg, Lodge Hopper 15-45, Floatplane 8-30; others
  e.g. Ferry 30-100, Scheduled Freight 30-90, Organ Transport 60-200). Pay per job kept where
  it was (user, 2026-09-15): each `base_payout` rose by twice the per-nm pay lost at the typical
  distance (e.g. Backcountry 8,000 -> 12,200, Ferry 2,400 -> 8,400, Organ Transport 18,500 ->
  38,300), so pay per hour rose instead. `findAerodromes` also takes `aeroway=airstrip` (nodes and
  ways, and drawn airstrips as runways), keeps up to 1,500 fields (was 400, which dropped near
  strips), and turns a land runway >= 800 ft that no field within 3 nm claims into its own strip
  named by position ("Grass strip 12 nm NE"; `stripName`). The sim's facility list still has
  no runways, so strips only the sim knows stay out of bush jobs. Mission Board: the first
  `BUSH_BOARD_SHARE` (3) of 6 plane contracts come from `isBushTemplate` (bush_strip, bush or
  floats tag) when the fleet can fly any; bush tries give up after 12.
 simulated winch, walker leash/AGL waypoints, terrain casualty
  candidates, roadside road placement after cache fix, auto-logging on a clean full flight.
- **Offered, not done:** road fire engines instead of airport crash tenders on highway scenes;
  immediate bridge refresh on dispatch (currently up to 30 s); ridgeline casualties still
  random (no ridge data); round the fractional cash display.
