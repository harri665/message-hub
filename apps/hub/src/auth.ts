import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { q, q1 } from './db.js';

export const COOKIE = 'mh_session';

const attempts = new Map<string, { count: number; resetAt: number }>();

function passwordMatches(input: string) {
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(config.appPassword).digest();
  return timingSafeEqual(a, b);
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

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    if (rateLimited(req.ip)) return reply.code(429).send({ error: 'too many attempts, try again later' });
    if (!req.body?.password || !passwordMatches(req.body.password)) {
      return reply.code(401).send({ error: 'wrong password' });
    }
    attempts.delete(req.ip);
    const id = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
    await q('insert into session (id, expires_at, user_agent) values ($1, $2, $3)', [id, expires, req.headers['user-agent'] ?? null]);
    await q('delete from session where expires_at < now()');
    reply.setCookie(COOKIE, id, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, expires,
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[COOKIE];
    if (id) await q('delete from session where id = $1', [id]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ loggedIn: await sessionValid(req.cookies[COOKIE]) }));
}
