/**
 * Economy scale (user approved 2026-09-14).
 *
 * Aircraft cost about half their real-world price (aircraft-catalog.ts), so
 * contract pay is doubled to keep growth to tens of contracts rather than
 * hundreds. PAY_SCALE multiplies every payout the app generates: scene work,
 * patrols, charters, industry hauls, plane contracts and Cargo Hub jobs. Trade
 * runs are priced by the server, which applies the same factor in
 * dispatch_trade_run (20260926000000_half_real_economy.sql).
 */
export const PAY_SCALE = 2;

/**
 * The dearest aircraft a new company may take as its free starter. Planes used
 * to offer every airframe, a $28.5M Citation included. Mirrored in
 * create_company.
 */
export const STARTER_MAX_COST = 175_000;
