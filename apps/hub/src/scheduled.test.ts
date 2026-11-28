import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isMissed, isSafeToRetry, MAX_AHEAD_MS, MISSED_AFTER_MS, parseSendAt, retryDelayMs, ScheduleError,
} from './schedulerules.ts';

const now = Date.parse('2026-12-01T12:00:00Z');

test('missed window: late by less than 24 hours is still sent', () => {
  assert.equal(isMissed(now - 1000, now), false);
  assert.equal(isMissed(now - MISSED_AFTER_MS + 1000, now), false);
  assert.equal(isMissed(now - MISSED_AFTER_MS, now), true);
  assert.equal(isMissed(now - 3 * MISSED_AFTER_MS, now), true);
});

test('sendAt must be in the future and within a year', () => {
  assert.equal(+parseSendAt('2026-12-02T09:00:00Z', now), Date.parse('2026-12-02T09:00:00Z'));
  assert.throws(() => parseSendAt('2026-12-01T11:00:00Z', now), ScheduleError);
  assert.throws(() => parseSendAt(new Date(now + 1000).toISOString(), now), /future/);
  assert.throws(() => parseSendAt(new Date(now + MAX_AHEAD_MS + 86_400_000).toISOString(), now), /year/);
  assert.throws(() => parseSendAt('not a date', now), ScheduleError);
  assert.throws(() => parseSendAt(undefined, now), ScheduleError);
  assert.throws(() => parseSendAt(null, now), ScheduleError);
});

test('retries only when the message clearly was not sent', () => {
  assert.equal(isSafeToRetry(Object.assign(new Error('Not sent: fetch failed'), { statusCode: 502 })), true);
  assert.equal(isSafeToRetry(Object.assign(new Error('x'), { statusCode: 503 })), true);
  assert.equal(isSafeToRetry(Object.assign(new Error("The Mac didn't confirm the message in time."), { statusCode: 504 })), false);
  assert.equal(isSafeToRetry(Object.assign(new Error('Not sent: bad request'), { statusCode: 400 })), false);
  assert.ok(retryDelayMs(1) < retryDelayMs(2));
});
