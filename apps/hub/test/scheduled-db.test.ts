// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://... npm test. Skipped otherwise.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const url = process.env.TEST_DATABASE_URL;

test('scheduled messages: claiming, once-only sending and the missed window', { skip: !url }, async () => {
  process.env.DATABASE_URL = url;
  process.env.MIGRATIONS_DIR = new URL('../migrations', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const { q, q1, migrate, pool } = await import('../src/db.ts');
  const sched = await import('../src/scheduled.ts');
  await migrate(() => {});
  await q('truncate scheduled_message restart identity');
  const conv = await q1<{ id: number }>(`insert into conversation (network, source_id, is_group) values ('whatsapp', 'test-' || random()::text, false) returning id`);
  const ins = (secs: number, status = 'scheduled') =>
    q1<{ id: number }>(
      `insert into scheduled_message (tid, conversation_id, service, text, send_at, status) values ('c1', $1, 'whatsapp', 'hi', now() + make_interval(secs => $2), $3) returning id`,
      [conv!.id, secs, status],
    );
  const future = await ins(3600);
  const due = await ins(-30);
  const late = await ins(-(sched.MISSED_AFTER_MS / 1000) - 60);

  // Two schedulers claiming at once: the due row goes to exactly one of them.
  const [a, b] = await Promise.all([sched.claimDue(), sched.claimDue()]);
  const claimed = [...a, ...b].map((r) => r.id);
  assert.deepEqual(claimed, [due!.id]);
  assert.equal((await sched.claimDue()).length, 0, 'a claimed row is not claimed again');

  // The overdue one is marked missed, not sent; the future one is untouched.
  await sched.expireScheduled();
  assert.equal((await q1('select status, error from scheduled_message where id = $1', [late!.id]))!.status, 'failed');
  assert.match((await q1('select error from scheduled_message where id = $1', [late!.id]))!.error, /Missed/);
  assert.equal((await q1('select status from scheduled_message where id = $1', [future!.id]))!.status, 'scheduled');

  // A row stuck in 'sending' after a crash is failed, never re-sent.
  await q(`update scheduled_message set claimed_at = now() - interval '10 minutes' where id = $1`, [due!.id]);
  await sched.expireScheduled();
  assert.equal((await q1('select status from scheduled_message where id = $1', [due!.id]))!.status, 'failed');
  assert.equal((await sched.claimDue()).length, 0);

  // A message that came due while the hub was down, less than 24h late, is claimed.
  const recent = await ins(-3600 * 5);
  assert.deepEqual((await sched.claimDue()).map((r) => r.id), [recent!.id]);

  // A retry waits for retry_at.
  const retry = await ins(-60);
  await q(`update scheduled_message set retry_at = now() + interval '1 minute' where id = $1`, [retry!.id]);
  assert.equal((await sched.claimDue()).length, 0);
  await pool.end();
});
