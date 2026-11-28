import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Fastify from 'fastify';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { initAuth, registerAuthRoutes, requireSession } from './auth.js';
import { config } from './config.js';
import { migrate } from './db.js';
import { registerApiRoutes } from './routes/api.js';
import { registerLinkRoutes } from './routes/links.js';
import { redactUrl, registerMcp } from './mcp.js';
import { startScheduler } from './scheduled.js';
import { BlueBubbles } from './sources/bluebubbles.js';
import { WhatsApp } from './sources/whatsapp.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }),
    },
  },
  trustProxy: true,
  bodyLimit: 2 * 1024 * 1024,
});

// Security headers on every response (routes like /api/attachments tighten them further).
app.addHook('onRequest', async (req, reply) => {
  const host = req.host;
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
  reply.header(
    'content-security-policy',
    [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' blob: data:",
      "media-src 'self' blob:", `connect-src 'self' ws://${host} wss://${host}`, "font-src 'self'", "manifest-src 'self'",
      "worker-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'",
    ].join('; '),
  );
  if (req.protocol === 'https') reply.header('strict-transport-security', 'max-age=15552000');
});

// Cross-site request forgery: state-changing API calls must come from this app's own pages. Browsers send
// Sec-Fetch-Site (and Origin) on these requests; other sites, including sibling subdomains, are refused.
app.addHook('onRequest', async (req, reply) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.url.startsWith('/api/')) return;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return reply.code(403).send({ error: 'Cross-site request refused' });
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* malformed origin: refused below */
    }
    if (originHost !== req.host) return reply.code(403).send({ error: 'Cross-site request refused' });
  } else if (origin === 'null') {
    return reply.code(403).send({ error: 'Cross-site request refused' });
  }
});

await migrate((m) => app.log.info(m));
fs.mkdirSync(config.attachmentsDir, { recursive: true });

// JSON and the app's own files compress well; images and video are skipped (already compressed).
await app.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'], brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } } });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
await app.register(websocket);

const hasWeb = fs.existsSync(config.webDir);
// Registered even without a web build so reply.sendFile works for attachments.
await app.register(fastifyStatic, { root: hasWeb ? config.webDir : config.attachmentsDir, serve: hasWeb, wildcard: false, index: false });
if (hasWeb) {
  app.get('/*', (req, reply) => {
    const file = req.url.split('?')[0].replace(/^\/+/, '');
    // Only look at paths that stay inside the web build.
    const abs = path.resolve(config.webDir, file);
    const inside = abs.startsWith(config.webDir + path.sep);
    if (file && inside && !file.startsWith('api/') && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      if (file.startsWith('assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.sendFile(file);
    }
    // API paths and discovery probes (MCP clients look for OAuth metadata) must not get the app's HTML.
    if (file.startsWith('api/') || file.startsWith('.well-known/')) return reply.code(404).send({ error: 'not found' });
    reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html');
  });
}

const bb = new BlueBubbles(app.log);
const wa = new WhatsApp(app.log);

await initAuth(app.log);
registerAuthRoutes(app);
registerApiRoutes(app, bb, wa);
app.register(async (r) => {
  r.addHook('preHandler', requireSession);
  registerLinkRoutes(r, bb);
});
registerMcp(app);

// Errors that set a status on purpose carry a message meant for the user; anything else (database errors,
// unexpected failures) is logged and answered generically, so internals don't leak.
app.setErrorHandler((err: any, _req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  const message = err.statusCode ? err.message : 'Something went wrong on the server.';
  reply.code(status).send({ error: message });
});

await app.listen({ port: config.port, host: '0.0.0.0' });

bb.start().catch((e) => app.log.error(e, 'BlueBubbles start failed'));
wa.start().catch((e) => app.log.error(e, 'WhatsApp start failed'));
startScheduler(bb, wa, app.log);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
