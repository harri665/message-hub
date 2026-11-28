import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasFilters, parseDate, parseSearch } from './searchquery.js';

const TZ = 'America/Denver';
// Thursday 2026-11-26 10:00 in Denver (MST, UTC-7).
const NOW = new Date('2026-11-26T17:00:00Z');
const p = (s: string) => parseSearch(s, { now: NOW, tz: TZ });

test('plain text has no filters', () => {
  const r = p('pizza tonight');
  assert.equal(r.text, 'pizza tonight');
  assert.equal(hasFilters(r), false);
});

test('from and has with spaces after the colon', () => {
  const r = p('from: harri665 has: image');
  assert.deepEqual(r.from, ['harri665']);
  assert.deepEqual(r.has, ['image']);
  assert.equal(r.text, '');
});

test('no space after the colon works too, and text stays', () => {
  const r = p('dinner from:mom has:link plans');
  assert.deepEqual(r.from, ['mom']);
  assert.deepEqual(r.has, ['link']);
  assert.equal(r.text, 'dinner plans');
});

test('quoted values', () => {
  assert.deepEqual(p('from: "Cole Writer" hi').from, ['Cole Writer']);
  assert.deepEqual(p('from:"Cole Writer"').from, ['Cole Writer']);
  assert.deepEqual(p('in:"Family Chat" x').in, ['Family Chat']);
  assert.equal(p('from:"Cole Writer" hi').text, 'hi');
});

test('quoted phrases without an operator stay as text', () => {
  assert.equal(p('"see you" soon').text, '"see you" soon');
});

test('several has values (AND) and aliases', () => {
  const r = p('has: image has: link has:sound has:embed has:IMAGE');
  assert.deepEqual(r.has, ['image', 'link', 'audio', 'attachment']);
});

test('has with an unknown value is kept as text and reported', () => {
  const r = p('has: banana hello');
  assert.deepEqual(r.has, []);
  assert.equal(r.text, 'has: banana hello');
  assert.deepEqual(r.ignored, ['has: banana']);
});

test('unknown operators are plain text', () => {
  const r = p('note: buy milk http://x:80 time 10:30');
  assert.equal(r.text, 'note: buy milk http://x:80 time 10:30');
  assert.equal(hasFilters(r), false);
});

test('operators are case-insensitive', () => {
  assert.deepEqual(p('FROM: Mom').from, ['Mom']);
});

test('an operator at the end with no value is dropped', () => {
  const r = p('pizza from:');
  assert.equal(r.text, 'pizza');
  assert.deepEqual(r.from, []);
});

test('an operator followed by another operator has no value', () => {
  const r = p('from: has: image');
  assert.deepEqual(r.from, []);
  assert.deepEqual(r.has, ['image']);
});

test('filters only, no free text', () => {
  const r = p('has: image in: Mom');
  assert.equal(r.text, '');
  assert.deepEqual(r.in, ['Mom']);
  assert.equal(hasFilters(r), true);
});

test('in strips a leading #', () => {
  assert.deepEqual(p('in:#Family').in, ['Family']);
});

test('service, is', () => {
  const r = p('service: whatsapp is: unread is:reply service:imessage');
  assert.deepEqual(r.service, ['whatsapp', 'imessage']);
  assert.deepEqual(r.is, ['unread', 'reply']);
  assert.deepEqual(p('service:fax').service, []);
  assert.equal(p('is: bogus').text, 'is: bogus');
});

test('dates: ISO day', () => {
  const r = parseDate('2026-11-25', NOW, TZ)!;
  assert.equal(r.start, '2026-11-25T07:00:00.000Z');
  assert.equal(r.end, '2026-11-26T07:00:00.000Z');
});

test('dates: month', () => {
  const r = parseDate('2026-11', NOW, TZ)!;
  assert.equal(r.start, '2026-11-01T06:00:00.000Z');
  assert.equal(r.end, '2026-12-01T07:00:00.000Z');
});

test('dates: summer offset (MDT) and DST day', () => {
  assert.equal(parseDate('2026-07-04', NOW, TZ)!.start, '2026-07-04T06:00:00.000Z');
  // 2026-11-01 is the day the clocks go back: 25 hours long.
  const r = parseDate('2026-11-01', NOW, TZ)!;
  assert.equal(r.start, '2026-11-01T06:00:00.000Z');
  assert.equal(r.end, '2026-11-02T07:00:00.000Z');
});

test('dates: short forms', () => {
  assert.equal(parseDate('nov 25', NOW, TZ)!.start, '2026-11-25T07:00:00.000Z');
  assert.equal(parseDate('November 25th', NOW, TZ)!.start, '2026-11-25T07:00:00.000Z');
  assert.equal(parseDate('25 nov', NOW, TZ)!.start, '2026-11-25T07:00:00.000Z');
  assert.equal(parseDate('11/25', NOW, TZ)!.start, '2026-11-25T07:00:00.000Z');
  assert.equal(parseDate('11/25/2025', NOW, TZ)!.start, '2025-11-25T07:00:00.000Z');
  assert.equal(parseDate('nov 25 2025', NOW, TZ)!.start, '2025-11-25T07:00:00.000Z');
  assert.equal(parseDate('nov 2025', NOW, TZ)!.start, '2025-11-01T06:00:00.000Z');
  assert.equal(parseDate('2026/11/25', NOW, TZ)!.start, '2026-11-25T07:00:00.000Z');
});

test('dates: a date with no year that is still ahead means last year', () => {
  assert.equal(parseDate('dec 25', NOW, TZ)!.start, '2025-12-25T07:00:00.000Z');
});

test('dates: today and yesterday in the hub time zone', () => {
  assert.equal(parseDate('today', NOW, TZ)!.start, '2026-11-26T07:00:00.000Z');
  assert.equal(parseDate('yesterday', NOW, TZ)!.start, '2026-11-25T07:00:00.000Z');
  // 02:00 UTC on the 27th is still the 26th in Denver.
  const late = new Date('2026-11-27T02:00:00Z');
  assert.equal(parseDate('today', late, TZ)!.start, '2026-11-26T07:00:00.000Z');
});

test('dates: garbage is not a date', () => {
  for (const s of ['', 'banana', '2026-13-01', '2026-02-30', 'nov 40', '13/40', 'foo 25', '99999']) {
    assert.equal(parseDate(s, NOW, TZ), null, s);
  }
});

test('before / after / during', () => {
  const b = p('before: 2026-11-25');
  assert.equal(b.sentBefore, '2026-11-25T07:00:00.000Z');
  assert.equal(b.sentAfter, undefined);
  const a = p('after: 2026-11-25');
  assert.equal(a.sentAfter, '2026-11-26T07:00:00.000Z');
  const d = p('during: 2026-11-25');
  assert.equal(d.sentAfter, '2026-11-25T07:00:00.000Z');
  assert.equal(d.sentBefore, '2026-11-26T07:00:00.000Z');
  const mo = p('during: 2026-11');
  assert.equal(mo.sentAfter, '2026-11-01T06:00:00.000Z');
  assert.equal(mo.sentBefore, '2026-12-01T07:00:00.000Z');
});

test('multi-word dates take only what they need', () => {
  const r = p('after: nov 25 pizza');
  assert.equal(r.sentAfter, '2026-11-26T07:00:00.000Z');
  assert.equal(r.text, 'pizza');
  const y = p('before: yesterday pizza from: mom');
  assert.equal(y.sentBefore, '2026-11-25T07:00:00.000Z');
  assert.equal(y.text, 'pizza');
  assert.deepEqual(y.from, ['mom']);
  assert.equal(p('after: nov 25 2025').sentAfter, '2025-11-26T07:00:00.000Z');
});

test('after and before together make a window; the tightest wins', () => {
  const r = p('after: 2026-11-01 before: 2026-11-20 after: 2026-11-10');
  assert.equal(r.sentAfter, '2026-11-11T07:00:00.000Z');
  assert.equal(r.sentBefore, '2026-11-20T07:00:00.000Z');
});

test('a bad date stays as text', () => {
  const r = p('after: someday hello');
  assert.equal(r.sentAfter, undefined);
  assert.equal(r.text, 'after: someday hello');
});

test('the example from the task', () => {
  const r = p('from: harri665 has: image');
  assert.deepEqual({ from: r.from, has: r.has, text: r.text }, { from: ['harri665'], has: ['image'], text: '' });
});

test('unterminated quote is tolerated', () => {
  const r = p('from: "Cole Wri');
  assert.deepEqual(r.from, ['Cole Wri']);
});

test('very long input is bounded', () => {
  const r = p('x '.repeat(5000));
  assert.ok(r.text.length <= 500);
});
