// Helicopter archetypes for seeding & mission catalog.
import { CATALOG_ARCHETYPES as CATALOG_ARCHETYPES_IMPL } from "./aircraft-catalog";
/**
 * Fixed-wing or rotary.
 *
 * The whole app was helicopters, so this defaults to rotary everywhere and
 * nothing that already existed has to change. It matters because the two fly
 * completely different work: a plane cannot hover over a cliff, and a
 * helicopter does not want a 3000 ft strip.
 */
export type WingType = "rotary" | "fixed";

export type AircraftTag =
  | "trainer"
  | "light_utility"
  | "medium_utility"
  | "heavy_lift"
  | "offshore"
  | "sar"
  | "medevac"
  | "patrol"
  | "vip"
  | "firefighting"
  | "survey"
  // Fixed-wing work.
  | "cargo"
  | "bush"
  | "airline"
  /** On floats: lands on water, and can't use a runway. */
  | "floats";

export const ALL_TAGS: AircraftTag[] = [
  "trainer",
  "light_utility",
  "medium_utility",
  "heavy_lift",
  "offshore",
  "sar",
  "medevac",
  "patrol",
  "vip",
  "firefighting",
  "survey",
  "cargo",
  "bush",
  "airline",
  "floats",
];

export const TAG_LABELS: Record<AircraftTag, string> = {
  trainer: "Trainer",
  light_utility: "Light Utility",
  medium_utility: "Medium Utility",
  heavy_lift: "Heavy Lift",
  offshore: "Offshore",
  sar: "SAR",
  medevac: "Medevac",
  patrol: "Patrol",
  vip: "VIP",
  firefighting: "Firefighting",
  survey: "Survey",
  cargo: "Freight",
  bush: "Bush / Short Field",
  airline: "Regional Airline",
  floats: "Floatplane",
};

export const ALL_CERTS = [
  "basic_utility",
  "training",
  "turbine",
  "offshore",
  "hoist",
  "medevac",
  "heavy_lift",
  "firefighting",
  "sar",
] as const;

export const CERT_LABELS: Record<string, string> = {
  basic_utility: "Basic Utility Ops",
  training: "Flight Training",
  turbine: "Turbine Endorsement",
  offshore: "Offshore Operations",
  hoist: "Hoist Operations",
  medevac: "Medevac Certified",
  heavy_lift: "Heavy Lift Authority",
  firefighting: "Aerial Firefighting",
  sar: "Search & Rescue",
};

export const CERT_UNLOCKS: Record<string, { cost: number; minRep: number }> = {
  turbine: { cost: 15000, minRep: 55 },
  hoist: { cost: 25000, minRep: 65 },
  medevac: { cost: 50000, minRep: 70 },
  offshore: { cost: 60000, minRep: 70 },
  firefighting: { cost: 80000, minRep: 75 },
  heavy_lift: { cost: 120000, minRep: 80 },
  sar: { cost: 100000, minRep: 80 },
};

export type AircraftArchetype = {
  internal_id: string;
  /** Rotary unless stated. Decides which half of the mission board applies. */
  wing?: WingType;
  display_name: string;
  /** Model this is a configuration of, when the sim ships several. */
  family?: string;
  /** Short name for the configuration within that family. */
  variant?: string;
  sim_title: string;
  category: string;
  engine_type: "piston" | "turbine" | "twin_turbine";
  cruise_kts: number;
  max_range_nm: number;
  fuel_burn_pph: number;
  payload_lbs: number;
  pax_seats: number;
  sling_load: boolean;
  hoist: boolean;
  footprint: "small" | "medium" | "large";
  reliability: number;
  maintenance_factor: number;
  acquisition_cost: number;
  op_cost_hr: number;
  tags: AircraftTag[];
};

export { CATALOG_ARCHETYPES } from "./aircraft-catalog";

// The full catalogue, sourced from the sim's own aircraft list.
// Kept under the original name so every caller is unchanged.
export const AIRCRAFT_ARCHETYPES: AircraftArchetype[] = CATALOG_ARCHETYPES_IMPL;

/**
 * Which half of the Market and mission board a fleet belongs on.
 *
 * Owned aircraft carry no wing column -- only the catalogue knows -- so it is
 * looked up by internal_id. Custom and modded airframes aren't in the catalogue
 * and count as rotary, like everything that predates planes. Only an all-plane
 * fleet flips to fixed; a mixed fleet keeps the helicopter-first default.
 */
export function fleetWing(
  aircraft: readonly { internal_id?: string | null }[] | null | undefined,
): WingType {
  if (!aircraft?.length) return "rotary";
  const fixed = new Set(
    AIRCRAFT_ARCHETYPES.filter((a) => a.wing === "fixed").map((a) => a.internal_id),
  );
  return aircraft.every((a) => a.internal_id != null && fixed.has(a.internal_id))
    ? "fixed"
    : "rotary";
}

export type MissionTemplate = {
  role: string;
  title: string;
  description: string;
  required_tags: AircraftTag[];
  required_certs: string[];
  min_payload: number;
  base_payout: number;
  distance_nm: number;
  difficulty: number;
  weather_factor: number;
};

export const MISSION_TEMPLATES: MissionTemplate[] = [
  {
    role: "training",
    title: "Discovery Flight",
    description: "Take a first-time student up for a 1-hour intro.",
    required_tags: ["trainer"],
    required_certs: ["training"],
    min_payload: 200,
    base_payout: 650,
    distance_nm: 40,
    difficulty: 1,
    weather_factor: 1,
  },
  {
    role: "tourism",
    title: "Coastal Sightseeing",
    description: "Scenic loop with 3 passengers over the coastline.",
    required_tags: ["light_utility"],
    required_certs: [],
    min_payload: 600,
    base_payout: 1400,
    distance_nm: 60,
    difficulty: 1,
    weather_factor: 2,
  },
  {
    role: "executive",
    title: "Executive Transfer",
    description: "Direct VIP shuttle from city pad to private estate.",
    required_tags: ["vip"],
    required_certs: [],
    min_payload: 800,
    base_payout: 4800,
    distance_nm: 120,
    difficulty: 2,
    weather_factor: 2,
  },
  {
    role: "survey",
    title: "Pipeline Inspection",
    description: "Slow patrol along a remote pipeline corridor.",
    required_tags: ["survey", "patrol", "light_utility"],
    required_certs: [],
    min_payload: 400,
    base_payout: 2600,
    distance_nm: 180,
    difficulty: 2,
    weather_factor: 2,
  },
  {
    role: "construction",
    title: "Tower Lift",
    description: "External sling load to a mountaintop construction site.",
    required_tags: ["light_utility", "medium_utility"],
    required_certs: ["basic_utility"],
    min_payload: 1500,
    base_payout: 6200,
    distance_nm: 80,
    difficulty: 3,
    weather_factor: 3,
  },
  {
    role: "patrol",
    title: "Law Enforcement Overwatch",
    description: "Provide aerial support for ground units.",
    required_tags: ["patrol"],
    required_certs: [],
    min_payload: 600,
    base_payout: 3100,
    distance_nm: 90,
    difficulty: 2,
    weather_factor: 2,
  },
  {
    role: "medevac",
    title: "Medevac Pickup",
    description: "Urgent patient transfer from rural hospital.",
    required_tags: ["medevac"],
    required_certs: ["medevac"],
    min_payload: 1200,
    base_payout: 8500,
    distance_nm: 140,
    difficulty: 3,
    weather_factor: 3,
  },
  {
    role: "offshore",
    title: "Offshore Crew Change",
    description: "Transport rig crew to platform 110nm offshore.",
    required_tags: ["offshore"],
    required_certs: ["offshore"],
    min_payload: 3000,
    base_payout: 12500,
    distance_nm: 220,
    difficulty: 4,
    weather_factor: 4,
  },
  {
    role: "sar",
    title: "SAR Hoist Extraction",
    description: "Hoist a stranded climber from a ridge.",
    required_tags: ["sar"],
    required_certs: ["sar", "hoist"],
    min_payload: 1000,
    base_payout: 16500,
    distance_nm: 100,
    difficulty: 5,
    weather_factor: 5,
  },
  {
    role: "firefighting",
    title: "Bucket Drop Run",
    description: "Bambi bucket drops on an active wildfire.",
    required_tags: ["firefighting"],
    required_certs: ["firefighting"],
    min_payload: 2500,
    base_payout: 11500,
    distance_nm: 70,
    difficulty: 4,
    weather_factor: 4,
  },
  {
    role: "logistics",
    title: "Heavy Lift Logistics",
    description: "Position a 12,000lb transformer to remote substation.",
    required_tags: ["heavy_lift"],
    required_certs: ["heavy_lift"],
    min_payload: 12000,
    base_payout: 28000,
    distance_nm: 60,
    difficulty: 5,
    weather_factor: 3,
  },
  {
    role: "supply",
    title: "Remote Supply Run",
    description: "Deliver supplies to an isolated outpost.",
    required_tags: ["light_utility", "medium_utility"],
    required_certs: [],
    min_payload: 1200,
    base_payout: 3600,
    distance_nm: 150,
    difficulty: 2,
    weather_factor: 3,
  },
];

export function isAircraftEligible(
  aircraft: { tags: string[]; payload_lbs: number; max_range_nm: number; status: string },
  mission: { required_tags: string[]; min_payload: number; distance_nm: number },
): { eligible: boolean; reason?: string } {
  if (aircraft.status !== "available") return { eligible: false, reason: "Aircraft not available" };
  if (aircraft.payload_lbs < mission.min_payload)
    return { eligible: false, reason: `Needs ${mission.min_payload}lb payload` };
  if (aircraft.max_range_nm < mission.distance_nm)
    return { eligible: false, reason: `Needs ${mission.distance_nm}nm range` };
  if (mission.required_tags.length > 0) {
    const ok = mission.required_tags.some((t) => aircraft.tags.includes(t));
    if (!ok) return { eligible: false, reason: `Requires role: ${mission.required_tags.join(" / ")}` };
  }
  return { eligible: true };
}

export function companyHasCerts(certs: string[], required: string[]): boolean {
  return required.every((c) => certs.includes(c));
}

// Validate aircraft config against realism mode. Returns warnings for suspicious stats.
export function validateAircraft(
  a: Partial<AircraftArchetype> & { payload_lbs?: number; cruise_kts?: number; fuel_burn_pph?: number },
  mode: "strict" | "balanced" | "sandbox",
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (mode === "sandbox") return { errors, warnings };
  if ((a.cruise_kts ?? 0) > 200) warnings.push("Cruise speed >200kts is exceptional for a helicopter.");
  if ((a.cruise_kts ?? 0) > 260 && mode === "strict") errors.push("Cruise speed exceeds physical limits.");
  if ((a.payload_lbs ?? 0) > 30000) warnings.push("Payload >30,000lb exceeds known production helicopters.");
  if ((a.payload_lbs ?? 0) > 60000 && mode === "strict") errors.push("Payload is implausible.");
  if (a.engine_type !== "piston" && (a.fuel_burn_pph ?? 0) < 80)
    warnings.push("Fuel burn unusually low for a turbine helicopter.");
  if ((a.payload_lbs ?? 0) > 10000 && (a.fuel_burn_pph ?? 0) < 500)
    warnings.push("Heavy aircraft with very low burn — verify stats.");
  if ((a.reliability ?? 0) > 99 && mode === "strict") warnings.push("Reliability above 99 is unrealistic.");
  return { errors, warnings };
}

// Mission generator
export function generateMissionFromTemplate(
  t: MissionTemplate,
  repBonus: number,
  baseIcao: string | null,
) {
  const variance = 0.85 + Math.random() * 0.4;
  return {
    role: t.role,
    title: t.title,
    description: t.description,
    required_tags: t.required_tags,
    required_certs: t.required_certs,
    min_payload: t.min_payload,
    payout: Math.round(t.base_payout * variance * (1 + repBonus / 200)),
    distance_nm: Math.round(t.distance_nm * (0.8 + Math.random() * 0.5)),
    difficulty: t.difficulty,
    weather_factor: t.weather_factor,
    // Helicopter work runs out of a base and comes home to it. Origin and
    // destination used to be drawn from a global airport list, which sent you
    // from Los Angeles to Amsterdam regardless of where you actually operate.
    origin: baseIcao,
    destination: baseIcao,
  };
}