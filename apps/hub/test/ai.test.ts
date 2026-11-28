import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.TIME_ZONE = 'America/Denver';
const { decide, neuronsFor, resetsAt, utcDay } = await import('../src/ai/usage.ts');
const { chunkText, groupMessages, indexLine } = await import('../src/ai/searchindex.ts');
const { parseReplies } = await import('../src/ai/assist.ts');
const { completionText, vectorLiteral } = await import('../src/ai/workers.ts');
const { skipReason } = await import('../src/ai/photos.ts');

test('neuronsFor uses the per-model price and charges unknown models the most', () => {
  // gpt-oss-120b: 31818 / 68182 Neurons per million tokens.
  assert.equal(Math.round(neuronsFor('@cf/openai/gpt-oss-120b', 1000, 60) * 10) / 10, 35.9);
  assert.ok(neuronsFor('@cf/someone/new-model', 1000, 60) > neuronsFor('@cf/moonshotai/kimi-k2.5', 1000, 60) - 1);
  assert.equal(neuronsFor('@cf/baai/bge-m3', 1_000_000, 0), 1075);
});

test('decide spends the allowance in order of priority', () => {
  const limit = 10_000;
  assert.deepEqual(decide('interactive', 1000, limit), { ok: true, fallback: false });
  assert.deepEqual(decide('interactive', 8500, limit), { ok: true, fallback: true });
  assert.deepEqual(decide('interactive', 10_000, limit), { ok: false, fallback: true });
  assert.equal(decide('new', 8900, limit).ok, true);
  assert.equal(decide('new', 9000, limit).ok, false);
  assert.equal(decide('backlog', 6900, limit).ok, true);
  assert.equal(decide('backlog', 7000, limit).ok, false);
});

test('the allowance day is the UTC day and resets at 00:00 UTC', () => {
  const evening = new Date('2026-11-27T23:30:00-07:00'); // 06:30 UTC on the 28th
  assert.equal(utcDay(evening), '2026-11-28');
  assert.equal(resetsAt(evening).toISOString(), '2026-11-29T00:00:00.000Z');
});

const msg = (id: number, minutes: number, body: string | null, extra: Record<string, unknown> = {}) => ({
  id, sent_at: new Date(Date.UTC(2026, 10, 20, 12, 0) + minutes * 60_000).toISOString(), from_me: false, kind: 'text', unsent: false,
  body, sender_name: 'Mom', attachments: [], ...extra,
});

test('indexLine names the sender, shows photo descriptions and leaves out system and unsent messages', () => {
  assert.equal(indexLine(msg(1, 0, 'see you  soon')), 'Mom: see you soon');
  assert.equal(indexLine(msg(1, 0, 'hi', { from_me: true })), 'Me: hi');
  assert.equal(
    indexLine(msg(1, 0, null, { attachments: [{ mime: 'image/jpeg', filename: 'a.jpg', description: 'A dog on a beach.' }, { mime: 'image/png', filename: 'b.png', description: null }] })),
    'Mom: [photo: A dog on a beach.] [photo]',
  );
  assert.equal(indexLine(msg(1, 0, 'left the group', { kind: 'system' })), null);
  assert.equal(indexLine(msg(1, 0, 'oops', { unsent: true })), null);
  assert.equal(indexLine(msg(1, 0, null)), null);
});

test('groupMessages splits at long pauses and holds back a conversation that is still going', () => {
  const now = Date.UTC(2026, 10, 20, 15, 0);
  const msgs = [msg(1, 0, 'a'), msg(2, 5, 'b'), msg(3, 60, 'c'), msg(4, 62, 'd'), msg(5, 170, 'e')];
  // 5 was sent 10 minutes before `now`: its chunk waits.
  assert.deepEqual(groupMessages(msgs, indexLine, now).map((g) => g.map((m) => m.id)), [[1, 2], [3, 4]]);
  // An hour later it is settled.
  assert.deepEqual(groupMessages(msgs, indexLine, now + 3600_000).map((g) => g.map((m) => m.id)), [[1, 2], [3, 4], [5]]);
  // A cut-off list never finishes its last chunk.
  assert.deepEqual(groupMessages(msgs, indexLine, now + 3600_000, true).map((g) => g.map((m) => m.id)), [[1, 2], [3, 4]]);
});

test('groupMessages caps the size of a chunk', () => {
  const long = Array.from({ length: 70 }, (_, i) => msg(i + 1, i, 'x'));
  const groups = groupMessages(long, indexLine, Date.UTC(2027, 0, 1));
  assert.deepEqual(groups.map((g) => g.length), [30, 30, 10]);
  const wide = Array.from({ length: 6 }, (_, i) => msg(i + 1, i, 'y'.repeat(400)));
  assert.ok(groupMessages(wide, indexLine, Date.UTC(2027, 0, 1)).every((g) => g.reduce((n, m) => n + (indexLine(m)?.length ?? 0), 0) <= 1500));
});

test('chunkText starts with the chat and the day in the hub time zone', () => {
  assert.equal(
    chunkText('Mom', false, '2026-11-20T05:00:00Z', '2026-11-20T06:00:00Z', ['Mom: hi', 'Me: hey']),
    'Chat with Mom, Nov 19, 2026\nMom: hi\nMe: hey',
  );
  assert.match(chunkText('Ski Trip', true, '2026-11-20T18:00:00Z', '2026-11-21T18:00:00Z', ['a']), /^Chat with Ski Trip \(group\), Nov 20, 2026 to Nov 21, 2026\n/);
});

test('parseReplies reads JSON, arrays and plain lists', () => {
  assert.deepEqual(parseReplies('{"replies": ["Sounds good!", "Can we do 7?", "Sorry, can\'t tonight"]}'), ['Sounds good!', 'Can we do 7?', "Sorry, can't tonight"]);
  assert.deepEqual(parseReplies('Here you go:\n["a", "b", "a", "c", "d"]'), ['a', 'b', 'c']);
  assert.deepEqual(parseReplies('1. "Yes!"\n2) No thanks\n- Maybe later'), ['Yes!', 'No thanks', 'Maybe later']);
  assert.deepEqual(parseReplies('{"replies": [{"text": "ok"}]}'), ['ok']);
});

test('completionText reads both response shapes and drops thinking', () => {
  assert.equal(completionText({ choices: [{ message: { content: '<think>hmm</think> Hello' } }] }), 'Hello');
  assert.equal(completionText({ result: { response: 'Hi there' } }), 'Hi there');
  assert.equal(completionText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
  assert.equal(completionText({}), '');
});

test('vectorLiteral writes pgvector text form', () => {
  assert.equal(vectorLiteral([0.5, -1, Number.NaN]), '[0.5,-1,0]');
});

test('skipReason leaves out stickers, unsupported formats and tiny images', () => {
  assert.equal(skipReason({ mime: 'image/jpeg', filename: 'IMG_1.jpg', width: 3000 }), null);
  assert.equal(skipReason({ mime: 'image/webp', filename: 'x.webp', width: 512 }), 'sticker');
  assert.equal(skipReason({ mime: 'image/png', filename: 'sticker.png', width: 800 }), 'sticker');
  assert.equal(skipReason({ mime: 'image/svg+xml', filename: 'a.svg', width: 100 }), 'unsupported format');
  assert.equal(skipReason({ mime: 'image/png', filename: 'dot.png', width: 10 }), 'too small');
  assert.equal(skipReason({ mime: 'image/webp', filename: 'photo.webp', width: 1200 }), null);
});
