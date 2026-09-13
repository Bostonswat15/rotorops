/**
 * Which kind of industry site a contract collects from, read from its title.
 *
 * bridge_state sends a contract's title and role but nothing about the site,
 * and every industry job already names it: "Timber Haul — Lumber Camp",
 * "Milled Lumber to Market — KXYZ", "Trade Run — lumber", "Fuel Run — avgas
 * to KXYZ". Reading the title covers contracts already on the board, which a
 * new column would not.
 *
 * Labels and goods mirror src/lib/industries.ts and src/lib/goods.ts.
 */

export type IndustryKind =
  | 'forest' | 'sawmill'
  | 'farmland' | 'grain_mill'
  | 'oil_well' | 'refinery'
  | 'quarry' | 'steel_works'
  | 'fishing_camp' | 'cannery';

/** Roles whose props are an industry site. */
export const INDUSTRY_ROLES = new Set(['industry', 'trade', 'fuel_run']);

/** Site labels (INDUSTRY_DEFS[kind].label), lowercased. */
const BY_LABEL: [string, IndustryKind][] = [
  ['lumber camp', 'forest'],
  ['sawmill', 'sawmill'],
  ['grain mill', 'grain_mill'],
  ['farm', 'farmland'],
  ['oil well', 'oil_well'],
  ['refinery', 'refinery'],
  ['quarry', 'quarry'],
  ['steel works', 'steel_works'],
  ['fishing camp', 'fishing_camp'],
  ['cannery', 'cannery'],
];

/** Goods by name and by id, and the site that produces them. Longer names first. */
const BY_GOOD: [string, IndustryKind][] = [
  ['milled lumber', 'sawmill'], ['lumber', 'sawmill'], ['timber', 'forest'],
  ['flour', 'grain_mill'], ['grain', 'farmland'],
  ['crude oil', 'oil_well'], ['crude', 'oil_well'],
  ['aviation fuel', 'refinery'], ['avgas', 'refinery'],
  ['structural steel', 'steel_works'], ['steel', 'steel_works'],
  ['iron ore', 'quarry'], ['ore', 'quarry'],
  ['packed seafood', 'cannery'], ['seafood', 'cannery'],
  ['fresh catch', 'fishing_camp'], ['fish', 'fishing_camp'],
];

const hasWord = (text: string, word: string) =>
  new RegExp(`(^|[^a-z])${word.replace(/ /g, '\\s+')}([^a-z]|$)`).test(text);

export function industryKindFromTitle(title: string | null | undefined): IndustryKind | null {
  const t = (title ?? '').toLowerCase();
  const dash = t.indexOf('—');
  const before = dash >= 0 ? t.slice(0, dash) : t;
  const after = dash >= 0 ? t.slice(dash + 1) : '';

  // "<Good> Haul — <Site>": the site named after the dash is the pickup.
  for (const [label, kind] of BY_LABEL) if (hasWord(after, label)) return kind;
  // "<Good> to Market — ICAO": the good before the dash says who made it.
  for (const [good, kind] of BY_GOOD) if (hasWord(before, good)) return kind;
  // "Trade Run — lumber", "Fuel Run — avgas to ICAO": the good after it. Whole
  // words only, so an ICAO like KORE is not iron ore.
  for (const [good, kind] of BY_GOOD) if (hasWord(after, good)) return kind;
  return null;
}
