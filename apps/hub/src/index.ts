import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { initAuth, registerAuthRoutes } from './auth.js';
import { config } from './config.js';
import { migrate } from './db.js';
import { registerApiRoutes } from './routes/api.js';
import { redactUrl, registerMcp } from './mcp.js';
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

await migrate((m) => app.log.info(m));
fs.mkdirSync(config.attachmentsDir, { recursive: true });

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
await app.register(websocket);

const hasWeb = fs.existsSync(config.webDir);
// Registered even without a web build so reply.sendFile works for attachments.
await app.register(fastifyStatic, { root: hasWeb ? config.webDir : config.attachmentsDir, serve: hasWeb, wildcard: false, index: false });
if (hasWeb) {
  app.get('/*', (req, reply) => {
    const file = req.url.split('?')[0].replace(/^\/+/, '');
    if (file && !file.startsWith('api/') && fs.existsSync(`${config.webDir}/${file}`) && fs.statSync(`${config.webDir}/${file}`).isFile()) {
      if (file.startsWith('assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.sendFile(file);
    }
    if (file.startsWith('api/')) return reply.code(404).send({ error: 'not found' });
    reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html');
  });
}

const bb = new BlueBubbles(app.log);
const wa = new WhatsApp(app.log);

await initAuth(app.log);
registerAuthRoutes(app);
registerApiRoutes(app, bb, wa);
registerMcp(app);

app.setErrorHandler((err: any, _req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  reply.code(status).send({ error: err.message });
});

await app.listen({ port: config.port, host: '0.0.0.0' });

bb.start().catch((e) => app.log.error(e, 'BlueBubbles start failed'));
wa.start().catch((e) => app.log.error(e, 'WhatsApp start failed'));

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.close().finally(() => process.exit(0));
  });
}
