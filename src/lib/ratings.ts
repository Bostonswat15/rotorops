/**
 * Pilot ratings: the check rides a pilot has to pass inside a company.
 *
 * Two kinds. Everyone the owner invites flies a company check ride before they
 * can take contracts, and a type rating check ride for each aircraft type in
 * the fleet before they can fly it. One rating covers a whole family -- every
 * H125, every Caravan -- and an aircraft with no family is its own type. The
 * owner is exempt from both.
 *
 * The server books the rides (on joining, on every purchase or lease) and
 * enforces them at dispatch; see 20260919000000_pilot_ratings.sql. This file
 * mirrors the rules for the UI only.
 */

import { CATALOG_ARCHETYPES } from "./aircraft-catalog";

/** The rating key for the company check ride. */
export const CHECKOUT_RATING = "checkout";

/** Examiner fee, charged the first time a check ride is dispatched. Retakes are free. */
export const RATING_FEE = 1000;

/** Flight score a check ride has to reach, on top of every objective done. */
export const RATING_PASS_SCORE = 60;

const byId = new Map(CATALOG_ARCHETYPES.map((a) => [a.internal_id, a]));

/**
 * Which rating an aircraft needs. Mirrors public.rating_info, which reads the
 * same catalogue from aircraft_type_families.
 */
export function ratingOf(ac: {
  internal_id?: string | null;
  sim_title?: string | null;
  display_name?: string | null;
}): { rating: string; label: string; wing: "rotary" | "fixed" } {
  const cat = ac.internal_id ? byId.get(ac.internal_id) : undefined;
  if (cat) {
    return {
      rating: cat.family ?? cat.internal_id,
      label: cat.family ?? cat.display_name,
      wing: cat.wing ?? "rotary",
    };
  }
  const custom = !ac.internal_id || ac.internal_id === "CUSTOM";
  return {
    rating: custom ? `custom:${ac.sim_title ?? ac.display_name ?? "aircraft"}` : ac.internal_id!,
    label: ac.display_name ?? ac.internal_id ?? "aircraft",
    wing: "rotary",
  };
}

/** Is this contract a company or type rating check ride? */
export function isRatingRide(m: { role?: string | null }) {
  return m?.role === "rating_ride";
}
