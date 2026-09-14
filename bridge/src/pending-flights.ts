/**
 * Flights that failed to log, kept on disk and retried until they do.
 *
 * A submission the server turned away used to be gone: the bridge warned once
 * and moved on, and the contract sat "in progress" with every objective ticked.
 * Measured 2026-09-14: a server bug rejected every flight with an incident
 * ('malformed array literal: "hard landing"'), and fixing the server could not
 * bring back the flights already thrown away.
 *
 * Kept in a file beside bridge.json, so closing the app doesn't lose them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PendingFlight = {
  /** The contract id, or `positioning:<started_at>` for a flight without one. */
  key: string;
  aircraftId: string;
  missionId: string | null;
  /** Exactly what was submitted, so a retry sends the same flight. */
  telemetry: Record<string, unknown>;
  aircraft: string;
  mission: string | null;
  firstFailedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
};

/** Wait before each retry: 1, 2, 5 and 10 minutes, then every 15. */
export const RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000, 900_000];
/** Stop after two days of failing. */
export const GIVE_UP_AFTER_MS = 48 * 3600_000;

/** What the server says when no retry can ever succeed. */
const PERMANENT = [
  'mission already resolved',
  'mission not found for this company',
  'aircraft not found for this company',
  'this contract is assigned to another pilot',
];

/**
 * Whether a failed submission is worth sending again.
 *
 * - `retry`: it never got a response, or the database rejected it. A rejected
 *   call rolls back, so sending it again can't log it twice.
 * - `drop`: the server said this flight can never be logged.
 * - `unsure`: a server or gateway error (a 504 is the usual one) that may have
 *   come after the flight was written. A contract is still retried -- the
 *   server refuses one that is already resolved, so it can't log twice. A
 *   positioning flight has nothing to refuse it with, so it isn't.
 */
export function classifyFailure(e: unknown, missionId: string | null): 'retry' | 'drop' | 'unsure' {
  const message = e instanceof Error ? e.message : String(e);
  if (PERMANENT.some((p) => message.includes(p))) return 'drop';
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 500) return missionId ? 'retry' : 'unsure';
  return 'retry';
}

export class PendingFlights {
  // Written out rather than as parameter properties: type stripping only
  // erases types, and a parameter property emits real assignment code.
  private readonly path: string;
  private readonly now: () => number;
  private flights: PendingFlight[] = [];

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    try {
      if (existsSync(path)) {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(raw)) {
          this.flights = raw.filter(
            (f): f is PendingFlight => !!f && typeof f.key === 'string' && typeof f.aircraftId === 'string',
          );
        }
      }
    } catch {
      // An unreadable file is worth less than a working bridge: start empty.
    }
  }

  get size() {
    return this.flights.length;
  }

  list(): PendingFlight[] {
    return [...this.flights];
  }

  /** The ones whose next attempt has come round. */
  due(): PendingFlight[] {
    const t = this.now();
    return this.flights.filter((f) => f.nextAttemptAt <= t);
  }

  hasMission(missionId: string) {
    return this.flights.some((f) => f.missionId === missionId);
  }

  /** Queue a flight after its first failed attempt, replacing any with the same key. */
  add(
    input: Pick<PendingFlight, 'aircraftId' | 'missionId' | 'telemetry' | 'aircraft' | 'mission'>,
    error: string,
  ): PendingFlight {
    const t = this.now();
    const key = input.missionId ?? `positioning:${String(input.telemetry.started_at ?? t)}`;
    const entry: PendingFlight = {
      ...input,
      key,
      firstFailedAt: t,
      attempts: 1,
      nextAttemptAt: t + RETRY_DELAYS_MS[0],
      lastError: error,
    };
    this.flights = [...this.flights.filter((f) => f.key !== key), entry];
    this.save();
    return entry;
  }

  /**
   * Record another failed attempt and schedule the next. Returns false when the
   * flight has been failing for too long and has been dropped instead.
   */
  failed(key: string, error: string): boolean {
    const f = this.flights.find((x) => x.key === key);
    if (!f) return false;
    const t = this.now();
    if (t - f.firstFailedAt >= GIVE_UP_AFTER_MS) {
      this.remove(key);
      return false;
    }
    f.attempts += 1;
    f.lastError = error;
    f.nextAttemptAt = t + RETRY_DELAYS_MS[Math.min(f.attempts - 1, RETRY_DELAYS_MS.length - 1)];
    this.save();
    return true;
  }

  remove(key: string) {
    const before = this.flights.length;
    this.flights = this.flights.filter((f) => f.key !== key);
    if (this.flights.length !== before) this.save();
  }

  private save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.flights, null, 2));
    } catch {
      // Still held in memory for this session; only a restart would lose it.
    }
  }
}
