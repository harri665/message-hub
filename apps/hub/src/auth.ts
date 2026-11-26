import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { kvGet, kvSet, q, q1 } from './db.js';

export const COOKIE = 'mh_session';
const HASH_KEY = 'auth.passwordHash';

const attempts = new Map<string, { count: number; resetAt: number }>();
let setupCode: string | null = null;

/** When no password exists yet, generate a one-time setup code and print it to the logs. */
export async function initAuth(log: FastifyBaseLogger) {
  if (config.appPassword || (await kvGet<string>(HASH_KEY))) return;
  setupCode = process.env.SETUP_CODE || randomBytes(4).toString('hex');
  log.warn(`No password set yet. Open the web app and use setup code ${setupCode} to create one.`);
}

async function needsSetup() {
  return !config.appPassword && !(await kvGet<string>(HASH_KEY));
}

function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 64).toString('base64')}`;
}

function equalHashes(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

async function passwordMatches(input: string) {
  if (config.appPassword) {
    return equalHashes(createHash('sha256').update(input).digest(), createHash('sha256').update(config.appPassword).digest());
  }
  const stored = await kvGet<string>(HASH_KEY);
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  return equalHashes(scryptSync(input, Buffer.from(salt, 'base64'), 64), Buffer.from(hash, 'base64'));
}

function rateLimited(ip: string) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

export async function sessionValid(id: string | undefined): Promise<boolean> {
  if (!id) return false;
  const row = await q1('select 1 from session where id = $1 and expires_at > now()', [id]);
  return !!row;
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  if (!(await sessionValid(req.cookies[COOKIE]))) {
    return reply.code(401).send({ error: 'not logged in' });
  }
}

async function startSession(req: FastifyRequest, reply: FastifyReply) {
  const id = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  await q('insert into session (id, expires_at, user_agent) values ($1, $2, $3)', [id, expires, req.headers['user-agent'] ?? null]);
  await q('delete from session where expires_at < now()');
  reply.setCookie(COOKIE, id, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, expires });
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    if (rateLimited(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!req.body?.password || !(await passwordMatches(req.body.password))) {
      return reply.code(401).send({ error: 'Wrong password' });
    }
    attempts.delete(req.ip);
    await startSession(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { password?: string; setupCode?: string } }>('/api/auth/setup', async (req, reply) => {
    if (!(await needsSetup())) return reply.code(409).send({ error: 'A password is already set' });
    if (rateLimited(req.ip)) return reply.code(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    const code = req.body?.setupCode?.trim().toLowerCase();
    if (!setupCode || !code || code !== setupCode) return reply.code(401).send({ error: 'Wrong setup code. It is in the hub logs.' });
    const pw = req.body?.password ?? '';
    if (pw.length < 10) return reply.code(400).send({ error: 'Use at least 10 characters' });
    await kvSet(HASH_KEY, hashPassword(pw));
    setupCode = null;
    attempts.delete(req.ip);
    await startSession(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[COOKIE];
    if (id) await q('delete from session where id = $1', [id]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({
    loggedIn: await sessionValid(req.cookies[COOKIE]),
    needsSetup: await needsSetup(),
  }));
}
