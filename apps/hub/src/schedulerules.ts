// The scheduler's pure rules, kept apart from the database code so tests can load them alone.
export const MISSED_AFTER_MS = 24 * 3_600_000;
export const MAX_AHEAD_MS = 366 * 24 * 3_600_000;
export const MIN_AHEAD_MS = 5_000;
export const MAX_ACTIVE = 200;
export const MAX_ATTEMPTS = 3;
export const TICK_MS = 15_000;
/** A row stuck in 'sending' this long means the hub died mid-send. We can't know whether it went out, so it is not retried. */
export const STUCK_AFTER_MS = 5 * 60_000;

export class ScheduleError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}


/** True when a message due at sendAt is too late to send now. */
export function isMissed(sendAt: Date | number, now: Date | number = Date.now()): boolean {
  return +now - +sendAt >= MISSED_AFTER_MS;
}

/** Parses and checks a send time. Returns the Date, or throws a ScheduleError with a message for the user. */
export function parseSendAt(v: unknown, now: Date | number = Date.now()): Date {
  const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : new Date(NaN);
  if (Number.isNaN(+d)) throw new ScheduleError(400, 'sendAt must be a date and time, like 2026-12-01T09:00:00-07:00.');
  if (+d < +now + MIN_AHEAD_MS) throw new ScheduleError(400, 'Pick a time in the future.');
  if (+d > +now + MAX_AHEAD_MS) throw new ScheduleError(400, "Messages can be scheduled up to a year ahead.");
  return d;
}

/** Wait before retrying after the given number of attempts so far (1-based). */
export function retryDelayMs(attempts: number): number {
  return attempts <= 1 ? 60_000 : 5 * 60_000;
}

/** Only retry when the send clearly never reached the service. A timeout may have sent it, so it is not retried. */
export function isSafeToRetry(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string } | undefined;
  if (e?.statusCode === 504) return false;
  if (e?.statusCode === 503) return true;
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|not connected|isn't connected|unreachable/i.test(e?.message ?? '');
}

