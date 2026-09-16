/**
 * The aircraft catalogue: helicopters, and since the company outgrew them,
 * fixed-wing too.
 *
 * Name, payload, range, cruise and seats come from the sim's own aircraft
 * list, so the market matches what you can actually fly. Prices are about half
 * of each aircraft's real-world value (user approved 2026-09-14): the sim's own
 * figures had helicopters at a fifth to a fifteenth of real life. Everything
 * the economy needs but that list doesn't carry -- fuel burn, operating cost,
 * reliability, maintenance factor -- is derived below from engine type and
 * weight class.
 *
 * Those derived figures are deliberately formulaic rather than researched
 * per-airframe: they're consistent with each other, which is what matters when
 * you're comparing two aircraft on cost per hour. They are not manufacturer
 * performance data.
 */

import type { AircraftArchetype, AircraftTag, WingType } from "./game-data";

type Engine = "piston" | "turbine" | "twin_turbine";

type CatalogEntry = {
  id: string;
  name: string;
  /** What MSFS reports as TITLE. Fuzzy-matched, so close is good enough. */
  simTitle: string;
  /**
   * Model this is a configuration of, when the sim ships more than one.
   *
   * These are separate aircraft in MSFS, not liveries -- an H125 Cargo and an
   * H125 Rescue load different airframes with different capabilities -- so
   * each needs its own catalogue entry and its own sim title to match
   * against. Grouping them under one name is purely so the market reads as
   * one model with a choice of fit, rather than six near-identical cards.
   *
   * Absent means the model ships one way and stands alone.
   */
  family?: string;
  /** Short name for this configuration within the family. */
  variant?: string;
  price: number;
  /** Useful load in pounds -- what the contract's min_payload is checked against. */
  payload: number;
  rangeNm: number;
  cruiseKts: number;
  seats: number;
  engine: Engine;
  sling?: boolean;
  hoist?: boolean;
  /** Rotary unless stated -- the catalogue was helicopters only to begin with. */
  wing?: WingType;
  /** Shortest strip it will operate from, in feet. Fixed-wing only. */
  runwayFt?: number;
  tags: AircraftTag[];
};

/** Small piston trainers through to heavy-lift cranes. */
const CATALOG: CatalogEntry[] = [
  // --- Piston: training and light utility ---------------------------------
  // Every entry below is confirmed present in the install this catalog was
  // checked against -- either a stock MSFS 2024 aircraft (its package folder
  // exists under StreamedPackages/Official2024) or an owned community add-on
  // (found under Community/Community2024 earlier this session). The dozen
  // entries this replaced -- Mosquito XE, Mini-500, M24 Orion, Velocity, R22,
  // Schweizer S300, Bell 47-G2 (x2), R44, CH-1 Skyhook, EC120, SA342 Gazelle
  // -- had no package anywhere: not vanilla, not community, not even an
  // AI-only traffic model. Buying one would have bought an aircraft the sim
  // could never load, breaking the sim_title match the whole flight-tracking
  // loop depends on. R22 and R44 specifically are AI traffic only in MSFS
  // 2024 (SimConnect enumerates them as passive, non-flyable) despite being
  // the classic real-world trainer -- worth knowing if that surprises you.
  { id: "CABRI-G2", name: "Guimbal Cabri G2", simTitle: "Cabri G2", price: 175000, payload: 618, rangeNm: 400, cruiseKts: 100, seats: 2, engine: "piston", tags: ["trainer"] },

  // --- Light single turbine ------------------------------------------------
  { id: "R66", name: "Robinson R66", simTitle: "Robinson R66", family: "Robinson R66", variant: "Standard", price: 475000, payload: 1200, rangeNm: 350, cruiseKts: 110, seats: 4, engine: "turbine", tags: ["light_utility", "survey"] },
  { id: "EC135", name: "Airbus EC135", simTitle: "Eurocopter EC-135T1 Passenger", family: "Eurocopter EC-135T1", variant: "Passenger", price: 750000, payload: 1450, rangeNm: 335, cruiseKts: 133, seats: 6, engine: "turbine", hoist: true, tags: ["light_utility", "medevac", "survey"] },
  { id: "B206B", name: "Bell 206B JetRanger", simTitle: "206B3", price: 325000, payload: 800, rangeNm: 374, cruiseKts: 120, seats: 5, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "B206L", name: "Bell 206 LongRanger", simTitle: "Bell 206 LongRanger", price: 550000, payload: 1950, rangeNm: 317, cruiseKts: 109, seats: 6, engine: "turbine", sling: true, tags: ["light_utility", "vip", "patrol"] },
  { id: "MD530F", name: "MD 530F", simTitle: "MD 530F", price: 800000, payload: 1519, rangeNm: 232, cruiseKts: 135, seats: 4, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "H500CD", name: "Hughes 500C/D", simTitle: "Hughes 500C/D", price: 300000, payload: 1422, rangeNm: 321, cruiseKts: 103, seats: 5, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "H500E", name: "Hughes 500E", simTitle: "Hughes 500E", price: 425000, payload: 1367, rangeNm: 261, cruiseKts: 130, seats: 4, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },
  { id: "SA315B", name: "Eurocopter SA315B Lama", simTitle: "Eurocopter SA315B Lama", price: 275000, payload: 2294, rangeNm: 278, cruiseKts: 103, seats: 5, engine: "turbine", sling: true, tags: ["light_utility", "heavy_lift"] },
  { id: "ALOUETTE-III", name: "Alouette III", simTitle: "Alouette III", price: 250000, payload: 1809, rangeNm: 290, cruiseKts: 110, seats: 6, engine: "turbine", sling: true, hoist: true, tags: ["light_utility", "sar"] },
  { id: "H125", name: "Airbus H125 (AS350 B3)", simTitle: "H125", family: "Airbus H125", variant: "Standard (AS350 B3)", price: 1300000, payload: 1937, rangeNm: 340, cruiseKts: 140, seats: 7, engine: "turbine", sling: true, tags: ["light_utility", "firefighting", "survey", "vip"] },
  // H125 configurations, as the sim actually ships them. These are not
  // liveries: the sim loads a different aircraft for each, and what it can do
  // changes with it -- Cargo flies a hook, Rescue carries a hoist, and the
  // "No Hoist" rescue variant deliberately has neither, which is a trap worth
  // pricing honestly rather than letting someone buy it for SAR work.
  { id: "H125-CARGO", name: "Airbus H125 Cargo", simTitle: "H125 Cargo", family: "Airbus H125", variant: "Cargo", price: 1325000, payload: 2205, rangeNm: 340, cruiseKts: 140, seats: 2, engine: "turbine", sling: true, tags: ["light_utility", "medium_utility", "survey"] },
  { id: "H125-RESCUE", name: "Airbus H125 Rescue", simTitle: "H125 Rescue", family: "Airbus H125", variant: "Rescue", price: 1550000, payload: 1870, rangeNm: 340, cruiseKts: 140, seats: 5, engine: "turbine", sling: true, hoist: true, tags: ["light_utility", "sar", "medevac"] },
  { id: "H125-RESCUE-NH", name: "Airbus H125 Rescue (no hoist)", simTitle: "H125 Rescue No Hoist", family: "Airbus H125", variant: "Rescue (no hoist)", price: 1425000, payload: 1902, rangeNm: 340, cruiseKts: 140, seats: 5, engine: "turbine", sling: true, tags: ["light_utility", "medevac"] },
  { id: "H125-PAX", name: "Airbus H125 Passenger", simTitle: "H125 Passengers", family: "Airbus H125", variant: "Passenger", price: 1350000, payload: 1764, rangeNm: 340, cruiseKts: 140, seats: 6, engine: "turbine", tags: ["light_utility", "vip"] },
  { id: "H125-AERIAL", name: "Airbus H125 Aerial Application", simTitle: "H125 AerialApp", family: "Airbus H125", variant: "Aerial application", price: 1450000, payload: 2094, rangeNm: 300, cruiseKts: 130, seats: 1, engine: "turbine", sling: true, tags: ["light_utility", "firefighting", "survey"] },
  { id: "EC130", name: "Eurocopter EC130", simTitle: "Eurocopter EC130", price: 1000000, payload: 2285, rangeNm: 327, cruiseKts: 128, seats: 7, engine: "turbine", sling: true, tags: ["light_utility", "vip", "survey", "medevac"] },
  { id: "B407", name: "Bell 407", simTitle: "Bell 407", price: 1100000, payload: 2347, rangeNm: 300, cruiseKts: 100, seats: 6, engine: "turbine", sling: true, tags: ["light_utility", "medevac", "patrol"] },
  { id: "WESTLAND-SCOUT", name: "Westland Scout", simTitle: "Westland Scout", price: 150000, payload: 1860, rangeNm: 274, cruiseKts: 106, seats: 6, engine: "turbine", sling: true, tags: ["light_utility", "patrol"] },
  { id: "OH58", name: "Bell OH-58 Kiowa", simTitle: "58D", price: 200000, payload: 1300, rangeNm: 140, cruiseKts: 100, seats: 1, engine: "turbine", sling: true, tags: ["light_utility", "patrol", "survey"] },

  // --- Light and medium twins ---------------------------------------------
  { id: "BO105", name: "MBB Bo 105", simTitle: "MBB Bo 105", price: 325000, payload: 2080, rangeNm: 600, cruiseKts: 110, seats: 4, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "medevac", "sar"] },
  { id: "MI2", name: "Mil Mi-2", simTitle: "Mil Mi-2", family: "Mil Mi-2", variant: "Standard", price: 125000, payload: 1050, rangeNm: 313, cruiseKts: 104, seats: 5, engine: "twin_turbine", sling: true, tags: ["light_utility", "medium_utility"] },
  { id: "MI2-HOPLITE", name: "Mi-2 Hoplite", simTitle: "Mi-2 Hoplite", family: "Mil Mi-2", variant: "Hoplite", price: 150000, payload: 1543, rangeNm: 240, cruiseKts: 95, seats: 8, engine: "twin_turbine", sling: true, tags: ["medium_utility"] },
  { id: "H135", name: "Airbus H135", simTitle: "Airbus H135", family: "Airbus H135", variant: "Standard", price: 2250000, payload: 3150, rangeNm: 343, cruiseKts: 137, seats: 7, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "medevac", "patrol"] },
  { id: "H135-EXT", name: "Airbus H135 Extended Fuel", simTitle: "Airbus H135 - Extended Fuel", family: "Airbus H135", variant: "Extended fuel", price: 2400000, payload: 3208, rangeNm: 343, cruiseKts: 137, seats: 7, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "medevac", "patrol"] },
  { id: "B222B", name: "Bell 222B", simTitle: "Cowan Simulation Bell 222B", price: 425000, payload: 3342, rangeNm: 397, cruiseKts: 126, seats: 10, engine: "twin_turbine", sling: true, tags: ["medium_utility", "vip", "medevac"] },
  { id: "B429", name: "Bell 429 GlobalRanger", simTitle: "Bell 429 GlobalRanger", price: 2500000, payload: 2755, rangeNm: 390, cruiseKts: 150, seats: 7, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "medevac", "vip", "patrol"] },
  { id: "H145", name: "Airbus H145", simTitle: "Airbus H145", family: "Airbus H145", variant: "Standard", price: 4250000, payload: 2960, rangeNm: 343, cruiseKts: 137, seats: 10, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "medevac", "sar"] },
  { id: "H145-CIVILIAN", name: "Airbus H145 Civilian", simTitle: "Airbus H145 Civilian", family: "Airbus H145", variant: "Civilian", price: 4750000, payload: 3807, rangeNm: 343, cruiseKts: 137, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "vip", "sar"] },
  { id: "H145-EMS", name: "Airbus H145 Emergency Medical", simTitle: "Airbus H145 Emergency Medical", family: "Airbus H145", variant: "Emergency medical", price: 4900000, payload: 3426, rangeNm: 343, cruiseKts: 137, seats: 6, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "medevac", "sar"] },
  { id: "H145-FIRE", name: "Airbus H145 Firefighting", simTitle: "Airbus H145 Firefighting", family: "Airbus H145", variant: "Firefighting", price: 4600000, payload: 3813, rangeNm: 343, cruiseKts: 137, seats: 5, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "firefighting", "sar"] },
  { id: "H145-GEND", name: "Airbus H145 Gendarmerie", simTitle: "Airbus H145 Gendarmerie", family: "Airbus H145", variant: "Gendarmerie", price: 4500000, payload: 3527, rangeNm: 343, cruiseKts: 137, seats: 9, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "patrol", "sar"] },
  { id: "H145-LUX", name: "Airbus H145 Luxury", simTitle: "Airbus H145 Luxury", family: "Airbus H145", variant: "Luxury", price: 5500000, payload: 3207, rangeNm: 343, cruiseKts: 137, seats: 9, engine: "twin_turbine", tags: ["medium_utility", "vip"] },
  { id: "H145-MIL", name: "Airbus H145 Military", simTitle: "Airbus H145 Military", family: "Airbus H145", variant: "Military", price: 4500000, payload: 3438, rangeNm: 343, cruiseKts: 137, seats: 7, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "patrol", "sar"] },
  { id: "AS365", name: "Eurocopter AS365 Dauphin", simTitle: "AS365 N2 - Utility", family: "Eurocopter AS365 Dauphin", variant: "N2 Utility", price: 1100000, payload: 3926, rangeNm: 432, cruiseKts: 145, seats: 12, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "offshore", "sar", "medevac"] },
  { id: "H160", name: "Airbus H160", simTitle: "Airbus H160", price: 7000000, payload: 4552, rangeNm: 475, cruiseKts: 138, seats: 13, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "offshore", "vip", "sar"] },
  { id: "S76", name: "Sikorsky S-76", simTitle: "Sikorsky S-76", price: 2250000, payload: 2958, rangeNm: 411, cruiseKts: 142, seats: 14, engine: "twin_turbine", hoist: true, tags: ["medium_utility", "offshore", "vip", "medevac"] },
  { id: "UH1", name: "Bell UH-1 Iroquois", simTitle: "Bell UH-1 Iroquois", family: "Bell UH-1 Iroquois", variant: "UH-1", price: 600000, payload: 3880, rangeNm: 276, cruiseKts: 110, seats: 17, engine: "turbine", sling: true, hoist: true, tags: ["medium_utility", "firefighting", "sar"] },
  { id: "UH1H", name: "Bell UH-1H", simTitle: "BELL UH-1H Iroquois Cargo", family: "Bell UH-1 Iroquois", variant: "UH-1H Cargo", price: 550000, payload: 3880, rangeNm: 276, cruiseKts: 110, seats: 16, engine: "turbine", sling: true, hoist: true, tags: ["medium_utility", "firefighting", "sar"] },

  // --- Heavy twins and lifters --------------------------------------------
  { id: "SH60", name: "Sikorsky SH-60 Seahawk", simTitle: "Sikorsky SH-60 Seahawk", price: 3500000, payload: 6684, rangeNm: 450, cruiseKts: 130, seats: 8, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "offshore"] },
  { id: "MH60", name: "Sikorsky MH-60", simTitle: "MH60 Sierra", family: "Sikorsky MH-60", variant: "Sierra", price: 6000000, payload: 7110, rangeNm: 1940, cruiseKts: 152, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "offshore"] },
  // HH-65 Dolphin: owned here, absent from the catalogue until the install was
  // enumerated -- which is how someone ends up flying one the fleet cannot
  // recognise, with a contract that silently tracks nothing.
  { id: "HH65B-SAR", name: "Aerospatiale HH-65B Dolphin (SAR)", simTitle: "HH65B Dolphin - SAR", family: "Aerospatiale HH-65 Dolphin", variant: "HH-65B SAR", price: 2000000, payload: 3200, rangeNm: 400, cruiseKts: 140, seats: 8, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "sar", "offshore", "medevac"] },
  { id: "HH65A-SAR", name: "Aerospatiale HH-65A Dolphin (SAR)", simTitle: "HH65A Dolphin - SAR", family: "Aerospatiale HH-65 Dolphin", variant: "HH-65A SAR", price: 1800000, payload: 3100, rangeNm: 390, cruiseKts: 138, seats: 8, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "sar", "offshore", "medevac"] },
  { id: "HH65B-HITRON", name: "Aerospatiale HH-65B Dolphin (HITRON)", simTitle: "HH65B Dolphin - HITRON", family: "Aerospatiale HH-65 Dolphin", variant: "HH-65B HITRON", price: 2100000, payload: 3150, rangeNm: 400, cruiseKts: 140, seats: 7, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "sar", "patrol"] },
  // MH-60 ships as three distinct airframes, not liveries.
  { id: "MH60R", name: "Sikorsky MH-60R Romeo", simTitle: "MH60 Romeo", family: "Sikorsky MH-60", variant: "Romeo", price: 7000000, payload: 7110, rangeNm: 1940, cruiseKts: 152, seats: 9, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "offshore", "patrol"] },
  { id: "MH60T", name: "Sikorsky MH-60T Tango", simTitle: "MH60 Tango", family: "Sikorsky MH-60", variant: "Tango", price: 6500000, payload: 7110, rangeNm: 1940, cruiseKts: 152, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "medevac"] },
  // R66 configurations.
  { id: "R66-SPRAY", name: "Robinson R66 Spray System", simTitle: "R66 Turbine Spray System", family: "Robinson R66", variant: "Spray system", price: 500000, payload: 1150, rangeNm: 330, cruiseKts: 105, seats: 2, engine: "turbine", tags: ["light_utility", "survey"] },
  // AS365 Dauphin configurations beyond the base utility fit.
  { id: "AS365-SAR", name: "Eurocopter AS365 N2 Dauphin (SAR)", simTitle: "AS365 N2 - SAR", family: "Eurocopter AS365 Dauphin", variant: "N2 SAR", price: 1300000, payload: 3820, rangeNm: 432, cruiseKts: 145, seats: 9, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "sar", "offshore", "medevac"] },
  { id: "AS365-VIP", name: "Eurocopter AS365 N2 Dauphin (VIP)", simTitle: "AS365 N2 - VIP", family: "Eurocopter AS365 Dauphin", variant: "N2 VIP", price: 1250000, payload: 3610, rangeNm: 432, cruiseKts: 145, seats: 8, engine: "twin_turbine", tags: ["medium_utility", "vip"] },
  { id: "AS365-PAX", name: "Eurocopter AS365 N2 Dauphin (Passenger)", simTitle: "AS365 N2 - Passenger", family: "Eurocopter AS365 Dauphin", variant: "N2 Passenger", price: 1150000, payload: 3740, rangeNm: 432, cruiseKts: 145, seats: 12, engine: "twin_turbine", tags: ["medium_utility", "vip", "offshore"] },
  { id: "AS365FN-SAR", name: "Eurocopter AS365 F/N Dauphin (SAR)", simTitle: "AS365 F/N - SAR", family: "Eurocopter AS365 Dauphin", variant: "F/N SAR", price: 1200000, payload: 3790, rangeNm: 420, cruiseKts: 143, seats: 9, engine: "twin_turbine", sling: true, hoist: true, tags: ["medium_utility", "sar", "offshore"] },
  // EC135 configurations.
  { id: "EC135-AMB", name: "Eurocopter EC-135T1 Ambulance", simTitle: "Eurocopter EC-135T1 Ambulance", family: "Eurocopter EC-135T1", variant: "Ambulance", price: 825000, payload: 1380, rangeNm: 335, cruiseKts: 133, seats: 4, engine: "twin_turbine", hoist: true, tags: ["light_utility", "medevac"] },
  { id: "EC135-SAR", name: "Eurocopter EC-135T1 Search and Rescue", simTitle: "Eurocopter EC-135T1 Search and Rescue", family: "Eurocopter EC-135T1", variant: "Search and rescue", price: 875000, payload: 1410, rangeNm: 335, cruiseKts: 133, seats: 5, engine: "twin_turbine", sling: true, hoist: true, tags: ["light_utility", "sar", "medevac"] },
  { id: "EC135-SIGHT", name: "Eurocopter EC-135T1 Sightseeing", simTitle: "Eurocopter EC-135T1 Sightseeing", family: "Eurocopter EC-135T1", variant: "Sightseeing", price: 725000, payload: 1340, rangeNm: 335, cruiseKts: 133, seats: 7, engine: "twin_turbine", tags: ["light_utility", "vip"] },
  { id: "UH60", name: "Sikorsky UH-60 Black Hawk", simTitle: "Sikorsky UH-60 Black Hawk", family: "Sikorsky UH-60 Black Hawk", variant: "Standard", price: 2750000, payload: 7110, rangeNm: 1199, cruiseKts: 152, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "firefighting"] },
  { id: "UH60-LR", name: "UH-60 Black Hawk Low Range", simTitle: "UH-60 Black Hawk - Low Range", family: "Sikorsky UH-60 Black Hawk", variant: "Low range", price: 2500000, payload: 7020, rangeNm: 518, cruiseKts: 152, seats: 11, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "sar", "firefighting"] },
  { id: "H225", name: "Airbus H225", simTitle: "Airbus H225", price: 4500000, payload: 8990, rangeNm: 532, cruiseKts: 140, seats: 26, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "offshore", "sar"] },
  { id: "MI17", name: "Mil Mi-17", simTitle: "Mil Mi-17", price: 2500000, payload: 8818, rangeNm: 430, cruiseKts: 140, seats: 36, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "firefighting"] },
  { id: "S64", name: "Sikorsky S-64 Skycrane", simTitle: "S-64F Skycrane Default Configuration", family: "Sikorsky S-64 Skycrane", variant: "Default", price: 9000000, payload: 20000, rangeNm: 374, cruiseKts: 80, seats: 4, engine: "twin_turbine", sling: true, tags: ["heavy_lift"] },
  { id: "S64-FIRE", name: "Sikorsky S-64 Skycrane Firefighting", simTitle: "S-64F Skycrane Firefighting Configuration", family: "Sikorsky S-64 Skycrane", variant: "Firefighting", price: 10000000, payload: 20000, rangeNm: 374, cruiseKts: 80, seats: 5, engine: "twin_turbine", sling: true, tags: ["heavy_lift", "firefighting"] },
  { id: "S64-LIFT", name: "Sikorsky S-64 Skycrane Lifting", simTitle: "S-64F Skycrane Lifting Configuration", family: "Sikorsky S-64 Skycrane", variant: "Lifting", price: 9500000, payload: 20000, rangeNm: 374, cruiseKts: 80, seats: 5, engine: "twin_turbine", sling: true, tags: ["heavy_lift"] },
  { id: "CH47", name: "Boeing CH-47 Chinook", simTitle: "CH47D", price: 12500000, payload: 24000, rangeNm: 1216, cruiseKts: 160, seats: 55, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "firefighting", "offshore"] },
  { id: "V22", name: "Bell Boeing V-22 Osprey", simTitle: "Bell Boeing V-22 Osprey", price: 42500000, payload: 20000, rangeNm: 2230, cruiseKts: 275, seats: 32, engine: "twin_turbine", sling: true, hoist: true, tags: ["heavy_lift", "offshore", "sar"] },
];

/**
 * The fixed-wing catalogue.
 *
 * Same derived-economics treatment as the helicopters, plus a shortest-strip
 * figure -- the one number that actually decides whether a contract into a
 * 1,800 ft bush strip is flyable in a King Air.
 *
 * Titles are the stock MSFS 2024 aircraft, so the market matches what you can
 * load without buying anything.
 */
const FIXED_WING: CatalogEntry[] = [
  // --- Piston trainers and tourers ----------------------------------------
  { id: "C152", name: "Cessna 152", simTitle: "Cessna 152", price: 30000, payload: 520, rangeNm: 415, cruiseKts: 107, seats: 2, engine: "piston", wing: "fixed", runwayFt: 1400, tags: ["trainer"] },
  { id: "C172", name: "Cessna 172 Skyhawk", simTitle: "Cessna Skyhawk", price: 150000, payload: 878, rangeNm: 640, cruiseKts: 122, seats: 4, engine: "piston", wing: "fixed", runwayFt: 1600, tags: ["trainer", "light_utility"] },
  { id: "DA40", name: "Diamond DA40 NG", simTitle: "Diamond DA40", price: 200000, payload: 838, rangeNm: 940, cruiseKts: 154, seats: 4, engine: "piston", wing: "fixed", runwayFt: 1500, tags: ["trainer", "light_utility"] },
  // SR22, Baron G58 and Longitude below: unlike Kodiak/ATR72, these have real
  // evidence of being present -- their livery packages are in this install's
  // manifest, which implies a base aircraft exists for the livery to apply
  // to, most likely carried forward from MSFS2020 backward compatibility.
  // But I only found the liveries, not a base package I could point to
  // directly, so this is inference rather than confirmed the way Cabri G2 or
  // the DHC-6 are. Worth a quick check in-sim if one of these ever shows up
  // as "aircraft not found" on a contract.
  { id: "SR22", name: "Cirrus SR22", simTitle: "Cirrus SR22", price: 350000, payload: 1075, rangeNm: 1050, cruiseKts: 183, seats: 4, engine: "piston", wing: "fixed", runwayFt: 1900, tags: ["light_utility", "vip"] },
  { id: "G36", name: "Beechcraft Bonanza G36", simTitle: "Bonanza G36", price: 400000, payload: 1050, rangeNm: 920, cruiseKts: 176, seats: 6, engine: "piston", wing: "fixed", runwayFt: 2000, tags: ["light_utility", "vip"] },

  // --- Bush and short field ------------------------------------------------
  { id: "XCUB", name: "CubCrafters XCub", simTitle: "CubCrafters XCub", price: 200000, payload: 780, rangeNm: 800, cruiseKts: 130, seats: 2, engine: "piston", wing: "fixed", runwayFt: 500, tags: ["bush", "light_utility"] },
  { id: "SAVAGE", name: "Zlin Savage Cub", simTitle: "Savage Cub", price: 75000, payload: 470, rangeNm: 380, cruiseKts: 92, seats: 2, engine: "piston", wing: "fixed", runwayFt: 400, tags: ["bush", "trainer"] },
  { id: "DHC2", name: "De Havilland DHC-2 Beaver", simTitle: "DHC-2 Beaver", family: "De Havilland DHC-2 Beaver", variant: "Landplane", price: 450000, payload: 2100, rangeNm: 455, cruiseKts: 125, seats: 7, engine: "piston", wing: "fixed", runwayFt: 1200, tags: ["bush", "cargo", "light_utility"] },
  // Kodiak 100 dropped: no package anywhere in this install, not even an
  // AI-only one -- neither stock nor a known community add-on. Two confirmed
  // stock aircraft cover the same STOL-utility niche it would have filled.
  { id: "PC12NGX", name: "Pilatus PC-12 NGX", simTitle: "Pilatus PC-12 NGX", price: 2500000, payload: 3120, rangeNm: 1600, cruiseKts: 285, seats: 9, engine: "turbine", wing: "fixed", runwayFt: 2400, tags: ["bush", "cargo", "vip", "medium_utility"] },
  { id: "DHC6", name: "DHC-6 Twin Otter", simTitle: "DHC-6 Twin Otter", price: 2000000, payload: 4280, rangeNm: 780, cruiseKts: 160, seats: 19, engine: "twin_turbine", wing: "fixed", runwayFt: 1200, tags: ["bush", "cargo", "medium_utility"] },

  // --- Twins and turboprops ------------------------------------------------
  { id: "BE58", name: "Beechcraft Baron G58", simTitle: "Baron G58", price: 750000, payload: 1750, rangeNm: 1480, cruiseKts: 200, seats: 6, engine: "piston", wing: "fixed", runwayFt: 2300, tags: ["light_utility", "vip", "patrol"] },
  { id: "DA62", name: "Diamond DA62", simTitle: "Diamond DA62", price: 650000, payload: 1477, rangeNm: 1280, cruiseKts: 192, seats: 7, engine: "piston", wing: "fixed", runwayFt: 2100, tags: ["light_utility", "survey", "patrol"] },
  { id: "C208", name: "Cessna 208B Grand Caravan EX", simTitle: "Cessna 208B Grand Caravan EX", family: "Cessna 208B Caravan", variant: "Grand Caravan EX", price: 1400000, payload: 4200, rangeNm: 960, cruiseKts: 186, seats: 13, engine: "turbine", wing: "fixed", runwayFt: 1800, tags: ["cargo", "bush", "medium_utility"] },
  // Caravan configurations, as the sim ships them. Cargo trades the cabin for
  // payload; floats trade a runway for anywhere flat and wet; Medic is the one
  // that can actually take a medevac contract.
  { id: "C208-CARGO", name: "Cessna 208B Caravan (Cargo)", simTitle: "C208B Cargo", family: "Cessna 208B Caravan", variant: "Cargo", price: 1350000, payload: 4600, rangeNm: 960, cruiseKts: 186, seats: 2, engine: "turbine", wing: "fixed", runwayFt: 1800, tags: ["cargo", "bush"] },
  { id: "C208-MEDIC", name: "Cessna 208B Caravan (Medic)", simTitle: "C208B Medic", family: "Cessna 208B Caravan", variant: "Medic", price: 1450000, payload: 3900, rangeNm: 960, cruiseKts: 186, seats: 6, engine: "turbine", wing: "fixed", runwayFt: 1800, tags: ["medevac", "medium_utility"] },
  { id: "C208-FLOATS", name: "Cessna 208B Caravan (Floats)", simTitle: "C208B Floats Passengers", family: "Cessna 208B Caravan", variant: "Floats", price: 1550000, payload: 3600, rangeNm: 860, cruiseKts: 170, seats: 10, engine: "turbine", wing: "fixed", runwayFt: 2400, tags: ["bush", "medium_utility", "floats"] },
  { id: "C208-PAX", name: "Cessna 208B Caravan (Passenger)", simTitle: "C208B Passengers", family: "Cessna 208B Caravan", variant: "Passenger", price: 1400000, payload: 4000, rangeNm: 960, cruiseKts: 186, seats: 13, engine: "turbine", wing: "fixed", runwayFt: 1800, tags: ["medium_utility", "vip"] },
  { id: "C208-SKYDIVE", name: "Cessna 208B Caravan (Skydive)", simTitle: "C208B Skydive", family: "Cessna 208B Caravan", variant: "Skydive", price: 1350000, payload: 4100, rangeNm: 900, cruiseKts: 186, seats: 12, engine: "turbine", wing: "fixed", runwayFt: 1800, tags: ["medium_utility"] },
  { id: "C208-SCI", name: "Cessna 208B Caravan (Scientific)", simTitle: "C208B Scientific", family: "Cessna 208B Caravan", variant: "Scientific", price: 1500000, payload: 3800, rangeNm: 960, cruiseKts: 186, seats: 6, engine: "turbine", wing: "fixed", runwayFt: 1800, tags: ["survey", "medium_utility"] },
  { id: "DHC2-FLOATS", name: "DHC-2 Beaver (Floats, Cargo)", simTitle: "DHC-2 Beaver Floats / Cargo", family: "De Havilland DHC-2 Beaver", variant: "Floats / cargo", price: 500000, payload: 2100, rangeNm: 455, cruiseKts: 125, seats: 2, engine: "piston", wing: "fixed", runwayFt: 1400, tags: ["cargo", "bush", "floats"] },
  { id: "TBM930", name: "Daher TBM 930", simTitle: "TBM 930", price: 2100000, payload: 1980, rangeNm: 1730, cruiseKts: 252, seats: 6, engine: "turbine", wing: "fixed", runwayFt: 2400, tags: ["vip", "medevac"] },
  { id: "B350", name: "Beechcraft King Air 350i", simTitle: "King Air 350i", price: 4000000, payload: 5150, rangeNm: 1800, cruiseKts: 312, seats: 11, engine: "twin_turbine", wing: "fixed", runwayFt: 3300, tags: ["vip", "medevac", "cargo", "survey"] },

  // --- Jets ----------------------------------------------------------------
  { id: "SF50", name: "Cirrus Vision Jet SF50", simTitle: "Vision Jet SF50", price: 1700000, payload: 1450, rangeNm: 1275, cruiseKts: 300, seats: 7, engine: "turbine", wing: "fixed", runwayFt: 2900, tags: ["vip"] },
  { id: "CJ4", name: "Cessna Citation CJ4", simTitle: "Citation CJ4", price: 5500000, payload: 2900, rangeNm: 2165, cruiseKts: 451, seats: 10, engine: "twin_turbine", wing: "fixed", runwayFt: 3300, tags: ["vip", "medevac"] },
  { id: "LONGITUDE", name: "Cessna Citation Longitude", simTitle: "Citation Longitude", price: 14250000, payload: 3500, rangeNm: 3500, cruiseKts: 483, seats: 12, engine: "twin_turbine", wing: "fixed", runwayFt: 4800, tags: ["vip", "airline"] },

  // --- Regional ------------------------------------------------------------
  // ATR 72-600 dropped for the same reason -- no evidence it exists here at
  // all. King Air 350i above already covers regional/airline-tag work; the
  // catalogue is a passenger short at the top end without a true airliner,
  // which is a real gap worth a proper confirmed replacement if you want one.
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
export const CATALOG_ARCHETYPES: AircraftArchetype[] = [...CATALOG, ...FIXED_WING].map((e) => ({
  internal_id: e.id,
  wing: e.wing ?? "rotary",
  display_name: e.name,
  family: e.family,
  variant: e.variant,
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
