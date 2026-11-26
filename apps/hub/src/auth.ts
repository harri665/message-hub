import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { kvGet, kvSet, q, q1 } from './db.js';

export const COOKIE = 'mh_session';
const HASH_KEY = 'auth.passwordHash';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const WINDOW_MS = 15 * 60_000;
const PER_CLIENT_LIMIT = 10;
/** Failed attempts from everyone combined; stops guessing spread across many (or spoofed) addresses. */
const GLOBAL_LIMIT = 50;
const attempts = new Map<string, { count: number; resetAt: number }>();
let globalFailures = { count: 0, resetAt: 0 };
let setupCode: string | null = null;

/** When no password exists yet, generate a one-time setup code and print it to the logs. */
export async function initAuth(log: FastifyBaseLogger) {
  if (config.appPassword || (await kvGet<string>(HASH_KEY))) return;
  setupCode = process.env.SETUP_CODE || randomBytes(8).toString('hex');
  log.warn(`No password set yet. Open the web app and use setup code ${setupCode} to create one.`);
}

async function needsSetup() {
  return !config.appPassword && !(await kvGet<string>(HASH_KEY));
}

async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 64)).toString('base64')}`;
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
  return equalHashes(await scrypt(input, Buffer.from(salt, 'base64'), 64), Buffer.from(hash, 'base64'));
}

/**
 * Who is trying to sign in. Behind Cloudflare, CF-Connecting-IP is set by Cloudflare and can't be chosen by the
 * client (unlike X-Forwarded-For); otherwise the TCP peer address.
 */
function clientKey(req: FastifyRequest) {
  const cf = req.headers['cf-connecting-ip'];
  return (typeof cf === 'string' && cf) || req.socket.remoteAddress || 'unknown';
}

function rateLimited(key: string) {
  const now = Date.now();
  if (globalFailures.resetAt < now) globalFailures = { count: 0, resetAt: now + WINDOW_MS };
  if (globalFailures.count >= GLOBAL_LIMIT) return true;
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
  }
  const entry = attempts.get(key);
  return !!entry && entry.resetAt >= now && entry.count >= PER_CLIENT_LIMIT;
}

function recordFailure(key: string) {
  const now = Date.now();
  globalFailures.count++;
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count++;
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
  // Secure whenever the request came over HTTPS (Cloudflare sets X-Forwarded-Proto); the LAN address is plain HTTP.
  const secure = config.secureCookies || req.protocol === 'https';
  reply.setCookie(COOKIE, id, { path: '/', httpOnly: true, sameSite: 'strict', secure, expires });
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    const key = clientKey(req);
    if (rateLimited(key)) return reply.code(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    if (!req.body?.password || !(await passwordMatches(req.body.password))) {
      recordFailure(key);
      return reply.code(401).send({ error: 'Wrong password' });
    }
    attempts.delete(key);
    await startSession(req, reply);
    return { ok: true };
  });

  app.post<{ Body: { password?: string; setupCode?: string } }>('/api/auth/setup', async (req, reply) => {
    if (!(await needsSetup())) return reply.code(409).send({ error: 'A password is already set' });
    const key = clientKey(req);
    if (rateLimited(key)) return reply.code(429).send({ error: 'Too many attempts. Try again in 15 minutes.' });
    const code = req.body?.setupCode?.trim().toLowerCase() ?? '';
    const sha = (s: string) => createHash('sha256').update(s).digest();
    if (!setupCode || !code || !equalHashes(sha(code), sha(setupCode))) {
      recordFailure(key);
      return reply.code(401).send({ error: 'Wrong setup code. It is in the hub logs.' });
    }
    const pw = req.body?.password ?? '';
    if (pw.length < 10) return reply.code(400).send({ error: 'Use at least 10 characters' });
    await kvSet(HASH_KEY, await hashPassword(pw));
    setupCode = null;
    attempts.delete(key);
    await startSession(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[COOKIE];
    if (id) await q('delete from session where id = $1', [id]);
    reply.clearCookie(COOKIE, { path: '/', sameSite: 'strict' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({
    loggedIn: await sessionValid(req.cookies[COOKIE]),
    needsSetup: await needsSetup(),
  }));
}
