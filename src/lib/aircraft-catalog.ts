/**
 * The helicopter catalogue.
 *
 * Name, price, payload, range, cruise and seats come from the sim's own
 * aircraft list, so the market matches what you can actually fly. Everything
 * the economy needs but that list doesn't carry -- fuel burn, operating cost,
 * reliability, maintenance factor -- is derived below from engine type and
 * weight class.
 *
 * Those derived figures are deliberately formulaic rather than researched
 * per-airframe: they're consistent with each other, which is what matters when
 * you're comparing two aircraft on cost per hour. They are not manufacturer
 * performance data.
 */

import type { AircraftArchetype, AircraftTag } from "./game-data";

type Engine = "piston" | "turbine" | "twin_turbine";

type CatalogEntry = {
  id: string;
  name: string;
  /** What MSFS reports as TITLE. Fuzzy-matched, so close is good enough. */
  simTitle: string;
  price: number;
  /** Useful load in pounds -- what the contract's min_payload is checked against. */
  payload: number;
  rangeNm: number;
  cruiseKts: number;
  seats: number;
  engine: Engine;
  sling?: boolean;
  hoist?: boolean;
  tags: AircraftTag[];
};

/** Small piston trainers through to heavy-lift cranes. */
const CATALOG: CatalogEntry[] = [
  // --- Piston: training and light utility ---------------------------------
  { id: "MOSQUITO-XE", name: "Mosquito XE", simTitle: "Mosquito XE", price: 17200, payload: 312, rangeNm: 50, cruiseKts: 62, seats: 1, engine: "piston", tags: ["trainer"] },
  { id: "MINI-500", name: "Revolution Mini-500", simTitle: "Revolution Mini-500", price: 24400, payload: 413, rangeNm: 196, cruiseKts: 65, seats: 1, engine: "piston", tags: ["trainer"] },
  { id: "M24-ORION", name: "M24 Orion", simTitle: "M24 Orion", price: 11900, payload: 520, rangeNm: 323, cruiseKts: 65, seats: 1, engine: "piston", tags: ["trainer"] },
  { id: "VELOCITY", name: "Velocity", simTitle: "Velocity", price: 5400, payload: 437, rangeNm: 35, cruiseKts: 60, seats: 1, engine: "piston", tags: ["trainer"] },
  { id: "R22", name: "Robinson R22", simTitle: "Robinson R22", price: 5100, payload: 500, rangeNm: 209, cruiseKts: 96, seats: 1, engine: "piston", tags: ["trainer"] },
  { id: "CABRI-G2", name: "Guimbal Cabri G2", simTitle: "Guimbal Cabri G2", price: 23000, payload: 618, rangeNm: 400, cruiseKts: 100, seats: 1, engine: "piston", tags: ["trainer"] },
  { id: "S300", name: "Schweizer S300", simTitle: "Schweizer S300", price: 80200, payload: 950, rangeNm: 195, cruiseKts: 86, seats: 2, engine: "piston", tags: ["trainer", "light_utility"] },
  { id: "BELL-47G2", name: "Bell 47-G2", simTitle: "Bell 47-G2", price: 71300, payload: 1057, rangeNm: 214, cruiseKts: 73, seats: 2, engine: "piston", sling: true, tags: ["trainer", "light_utility"] },
  { id: "BELL-47G2-EXT", name: "Bell 47-G2 Extended Fuel", simTitle: "Bell 47-G2 - Extended Fuel", price: 64000, payload: 1057, rangeNm: 306, cruiseKts: 73, seats: 2, engine: "piston", sling: true, tags: ["trainer", "light_utility"] },
  { id: "R44", name: "Robinson R44", simTitle: "Robinson R44", price: 102800, payload: 748, rangeNm: 304, cruiseKts: 110, seats: 3, engine: "piston", tags: ["trainer", "light_utility"] },
  { id: "CH1-SKYHOOK", name: "Cessna CH-1 Skyhook", simTitle: "Cessna CH-1 Skyhook", price: 86000, payload: 1020, rangeNm: 230, cruiseKts: 94, seats: 3, engine: "piston", tags: ["light_utility"] },

  // --- Light single turbine ------------------------------------------------
  { id: "R66", name: "Robinson R66", simTitle: "Robinson R66", price: 218700, payload: 1200, rangeNm: 350, cruiseKts: 110, seats: 4, engine: "turbine", tags: ["light_utility", "survey"] },
  { id: "EC120", name: "Eurocopter EC120 Colibri", simTitle: "Eurocopter EC120 Colibri", price: 224800, payload: 1230, rangeNm: 393, cruiseKts: 122, seats: 4, engine: "turbine", tags: ["light_utility", "vip", "survey"] },
  { id: "SA342", name: "Eurocopter SA342 Gazelle", simTitle: "Eurocopter SA342", price: 149800, payload: 1050, rangeNm: 195, cruiseKts: 143, seats: 5, engine: "turbine", tags: ["light_utility", "patrol"] },
  { id: "B206B", name: "Bell 206B JetRanger", simTitle: "Bell 206B JetRanger", price: 136300, payload: 800, rangeNm: 374, cruiseKts: 120, seats: 5, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "B206L", name: "Bell 206 LongRanger", simTitle: "Bell 206 LongRanger", price: 275000, payload: 1950, rangeNm: 317, cruiseKts: 109, seats: 6, engine: "turbine", sling: true, tags: ["light_utility", "vip", "patrol"] },
  { id: "MD530F", name: "MD 530F", simTitle: "MD 530F", price: 258500, payload: 1519, rangeNm: 232, cruiseKts: 135, seats: 4, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "H500CD", name: "Hughes 500C/D", simTitle: "Hughes 500C/D", price: 231400, payload: 1422, rangeNm: 321, cruiseKts: 103, seats: 5, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "H500E", name: "Hughes 500E", simTitle: "Hughes 500E", price: 269700, payload: 1367, rangeNm: 261, cruiseKts: 130, seats: 4, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "SA315B", name: "Eurocopter SA315B Lama", simTitle: "Eurocopter SA315B Lama", price: 225200, payload: 2294, rangeNm: 278, cruiseKts: 103, seats: 5, engine: "turbine", sling: true, tags: ["light_utility", "heavy_lift"] },
  { id: "ALOUETTE-III", name: "Alouette III", simTitle: "Alouette III", price: 310700, payload: 1809, rangeNm: 290, cruiseKts: 110, seats: 6, engine: "turbine", sling: true, hoist: true, tags: ["light_utility", "sar"] },
  { id: "H125", name: "Airbus H125 (AS350 B3)", simTitle: "Airbus H125", price: 443900, payload: 1937, rangeNm: 340, cruiseKts: 140, seats: 7, engine: "turbine", sling: true, tags: ["light_utility", "firefighting", "survey", "vip"] },
  { id: "EC130", name: "Eurocopter EC130", simTitle: "Eurocopter EC130", price: 402300, payload: 2285, rangeNm: 327, cruiseKts: 128, seats: 7, engine: "turbine", sling: true, tags: ["light_utility", "vip", "survey"] },
  { id: "B407", name: "Bell 407", simTitle: "Bell 407", price: 341800, payload: 2347, rangeNm: 300, cruiseKts: 100, seats: 6, engine: "turbine", sling: true, tags: ["light_utility", "medevac", "patrol"] },
  { id: "WESTLAND-SCOUT", name: "Westland Scout", simTitle: "Westland Scout", price: 270300, payload: 1860, rangeNm: 274, cruiseKts: 106, seats: 6, engine: "turbine", sling: true, tags: ["light_utility", "patrol"] },
  { id: "OH58", name: "Bell OH-58 Kiowa", simTitle: "Bell OH-58 Kiowa", price: 21400, payload: 1300, rangeNm: 140, cruiseKts: 100, seats: 1, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },

  // --- Light and medium twins ---------------------------------------------
  { id: "BO105", name: "MBB Bo 105", simTitle: "MBB Bo 105", price: 277500, payload: 2080, rangeNm: 600, cruiseKts: 110, seats: 4, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "medevac", "sar"] },
  { id: "MI2", name: "Mil Mi-2", simTitle: "Mil Mi-2", price: 115400, payload: 1050, rangeNm: 313, cruiseKts: 104, seats: 5, engine: "twin_turbine", sling: true, tags: ["light_utility", "medium_utility"] },
  { id: "MI2-HOPLITE", name: "Mi-2 Hoplite", simTitle: "Mi-2 Hoplite", price: 127700, payload: 1543, rangeNm: 240, cruiseKts: 95, seats: 8, engine: "twin_turbine", sling: true, tags: ["medium_utility"] },
  { id: "H135", name: "Airbus H135", simTitle: "Airbus H135", price: 512500, payload: 3150, rangeNm: 343, cruiseKts: 137, seats: 7, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "medevac", "patrol"] },
  { id: "H135-EXT", name: "Airbus H135 Extended Fuel", simTitle: "Airbus H135 - Extended Fuel", price: 643200, payload: 3208, rangeNm: 343, cruiseKts: 137, seats: 7, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "medevac", "patrol"] },
  { id: "B222B", name: "Bell 222B", simTitle: "Cowan Simulation Bell 222B", price: 720500, payload: 3342, rangeNm: 397, cruiseKts: 126, seats: 10, engine: "twin_turbine", sling: true, tags: ["medium_utility", "vip", "medevac"] },
  { id: "B429", name: "Bell 429 GlobalRanger", simTitle: "Bell 429 GlobalRanger", price: 640700, payload: 2755, rangeNm: 390, cruiseKts: 150, seats: 7, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "medevac", "vip", "patrol"] },
  { id: "H145", name: "Airbus H145", simTitle: "Airbus H145", price: 618000, payload: 2960, rangeNm: 343, cruiseKts: 137, seats: 10, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "medevac", "sar"] },
  { id: "H145-CIVILIAN", name: "Airbus H145 Civilian", simTitle: "Airbus H145 Civilian", price: 793800, payload: 3807, rangeNm: 343, cruiseKts: 137, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "vip", "sar"] },
  { id: "H145-EMS", name: "Airbus H145 Emergency Medical", simTitle: "Airbus H145 Emergency Medical", price: 668800, payload: 3426, rangeNm: 343, cruiseKts: 137, seats: 6, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "medevac", "sar"] },
  { id: "H145-FIRE", name: "Airbus H145 Firefighting", simTitle: "Airbus H145 Firefighting", price: 762500, payload: 3813, rangeNm: 343, cruiseKts: 137, seats: 5, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "firefighting", "sar"] },
  { id: "H145-GEND", name: "Airbus H145 Gendarmerie", simTitle: "Airbus H145 Gendarmerie", price: 865800, payload: 3527, rangeNm: 343, cruiseKts: 137, seats: 9, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "patrol", "sar"] },
  { id: "H145-LUX", name: "Airbus H145 Luxury", simTitle: "Airbus H145 Luxury", price: 700200, payload: 3207, rangeNm: 343, cruiseKts: 137, seats: 9, engine: "twin_turbine", tags: ["medium_utility", "vip"] },
  { id: "H145-MIL", name: "Airbus H145 Military", simTitle: "Airbus H145 Military", price: 688200, payload: 3438, rangeNm: 343, cruiseKts: 137, seats: 7, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "patrol", "sar"] },
  { id: "AS365", name: "Eurocopter AS365 Dauphin", simTitle: "Eurocopter AS365 Dauphin", price: 913200, payload: 3926, rangeNm: 432, cruiseKts: 145, seats: 12, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "offshore", "sar", "medevac"] },
  { id: "H160", name: "Airbus H160", simTitle: "Airbus H160", price: 873600, payload: 4552, rangeNm: 475, cruiseKts: 138, seats: 13, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "offshore", "vip", "sar"] },
  { id: "S76", name: "Sikorsky S-76", simTitle: "Sikorsky S-76", price: 764000, payload: 2958, rangeNm: 411, cruiseKts: 142, seats: 14, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "offshore", "vip", "medevac"] },
  { id: "UH1", name: "Bell UH-1 Iroquois", simTitle: "Bell UH-1 Iroquois", price: 743200, payload: 3880, rangeNm: 276, cruiseKts: 110, seats: 17, engine: "turbine", sling: true, hoist: true, tags: ["medium_utility", "firefighting", "sar"] },
  { id: "UH1H", name: "Bell UH-1H", simTitle: "Bell UH-1H", price: 724600, payload: 3880, rangeNm: 276, cruiseKts: 110, seats: 16, engine: "turbine", sling: true, hoist: true, tags: ["medium_utility", "firefighting", "sar"] },

  // --- Heavy twins and lifters --------------------------------------------
  { id: "SH60", name: "Sikorsky SH-60 Seahawk", simTitle: "Sikorsky SH-60 Seahawk", price: 1537700, payload: 6684, rangeNm: 450, cruiseKts: 130, seats: 8, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "offshore"] },
  { id: "MH60", name: "Sikorsky MH-60", simTitle: "Sikorsky MH-60", price: 1711500, payload: 7110, rangeNm: 1940, cruiseKts: 152, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "offshore"] },
  { id: "UH60", name: "Sikorsky UH-60 Black Hawk", simTitle: "Sikorsky UH-60 Black Hawk", price: 1648100, payload: 7110, rangeNm: 1199, cruiseKts: 152, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "firefighting"] },
  { id: "UH60-LR", name: "UH-60 Black Hawk Low Range", simTitle: "UH-60 Black Hawk - Low Range", price: 1950700, payload: 7020, rangeNm: 518, cruiseKts: 152, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "firefighting"] },
  { id: "H225", name: "Airbus H225", simTitle: "Airbus H225", price: 2026300, payload: 8990, rangeNm: 532, cruiseKts: 140, seats: 26, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "offshore", "sar"] },
  { id: "MI17", name: "Mil Mi-17", simTitle: "Mil Mi-17", price: 2533300, payload: 8818, rangeNm: 430, cruiseKts: 140, seats: 36, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "firefighting"] },
  { id: "S64", name: "Sikorsky S-64 Skycrane", simTitle: "Sikorsky S-64 Skycrane", price: 2403400, payload: 20000, rangeNm: 374, cruiseKts: 80, seats: 4, engine: "twin_turbine", sling: true, tags: ["heavy_lift"] },
  { id: "S64-FIRE", name: "Sikorsky S-64 Skycrane Firefighting", simTitle: "Sikorsky S-64 Skycrane - Firefighting", price: 2620700, payload: 20000, rangeNm: 374, cruiseKts: 80, seats: 5, engine: "twin_turbine", sling: true, tags: ["heavy_lift", "firefighting"] },
  { id: "S64-LIFT", name: "Sikorsky S-64 Skycrane Lifting", simTitle: "Sikorsky S-64 Skycrane - Lifting", price: 2620700, payload: 20000, rangeNm: 374, cruiseKts: 80, seats: 5, engine: "twin_turbine", sling: true, tags: ["heavy_lift"] },
  { id: "CH47", name: "Boeing CH-47 Chinook", simTitle: "Boeing CH-47 Chinook", price: 7903200, payload: 24000, rangeNm: 1216, cruiseKts: 160, seats: 55, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "firefighting", "offshore"] },
  { id: "V22", name: "Bell Boeing V-22 Osprey", simTitle: "Bell Boeing V-22 Osprey", price: 10884600, payload: 20000, rangeNm: 2230, cruiseKts: 275, seats: 32, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "offshore", "sar"] },
];

// ---------------------------------------------------------------------------
// Derived economics
// ---------------------------------------------------------------------------

/** Pounds of fuel per hour, scaled by engine type and useful load. */
function fuelBurn(e: CatalogEntry): number {
  if (e.engine === "piston") return Math.round(20 + e.payload * 0.055);
  if (e.engine === "turbine") return Math.round(60 + e.payload * 0.12);
  return Math.round(120 + e.payload * 0.13);
}

/**
 * Hourly operating cost excluding fuel -- crew, insurance, reserves.
 * Fuel is charged separately by flight resolution at $0.90/lb.
 */
function opCost(e: CatalogEntry): number {
  if (e.engine === "piston") return Math.round(60 + e.payload * 0.08);
  if (e.engine === "turbine") return Math.round(180 + e.payload * 0.12);
  return Math.round(350 + e.payload * 0.15);
}

function footprint(e: CatalogEntry): "small" | "medium" | "large" {
  if (e.payload < 1300) return "small";
  if (e.payload < 4000) return "medium";
  return "large";
}

function reliability(e: CatalogEntry): number {
  if (e.engine === "piston") return 78;
  if (e.engine === "turbine") return 86;
  return 91;
}

/** How hard the airframe is on a maintenance budget. */
function maintenanceFactor(e: CatalogEntry): number {
  const base = e.engine === "piston" ? 0.8 : e.engine === "turbine" ? 1.1 : 1.5;
  // Very heavy machines cost disproportionately more to keep airworthy.
  const size = e.payload > 15000 ? 0.9 : e.payload > 6000 ? 0.4 : 0;
  return Number((base + size).toFixed(1));
}

function category(e: CatalogEntry): string {
  if (e.engine === "piston") return "light_piston";
  if (e.engine === "turbine") return "light_turbine";
  return e.payload >= 6000 ? "heavy_twin" : "medium_twin";
}

/** The catalogue, expanded into the shape the rest of the app expects. */
export const CATALOG_ARCHETYPES: AircraftArchetype[] = CATALOG.map((e) => ({
  internal_id: e.id,
  display_name: e.name,
  sim_title: e.simTitle,
  category: category(e),
  engine_type: e.engine,
  cruise_kts: e.cruiseKts,
  max_range_nm: e.rangeNm,
  fuel_burn_pph: fuelBurn(e),
  payload_lbs: e.payload,
  pax_seats: e.seats,
  sling_load: e.sling ?? false,
  hoist: e.hoist ?? false,
  footprint: footprint(e),
  reliability: reliability(e),
  maintenance_factor: maintenanceFactor(e),
  acquisition_cost: e.price,
  op_cost_hr: opCost(e),
  tags: e.tags,
}));
