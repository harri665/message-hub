// AI features (Cloudflare Workers AI): background jobs and the web app's API. Everything here is off until
// CF_ACCOUNT_ID and CF_API_TOKEN are set; see README "AI features".
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { requireSession } from '../auth.js';
import { aiEnabled, config } from '../config.js';
import { threadConversations } from '../queries.js';
import type { BlueBubbles } from '../sources/bluebubbles.js';
import type { WhatsApp } from '../sources/whatsapp.js';
import { bus, type LiveEvent } from '../store.js';
import { ask, suggestReplies } from './assist.js';
import { describePhotos, photoStats } from './photos.js';
import { indexRound, indexStats, markChunkStale, relevantHits, searchByMeaning } from './searchindex.js';
import { accountUsage, hubUsedToday, resetsAt, usageToday, usedToday } from './usage.js';

/** Starts the photo describer and the search indexer (every minute, and soon after new messages arrive). */
export function startAi(bb: BlueBubbles, wa: WhatsApp, log: FastifyBaseLogger) {
  if (!aiEnabled()) {
    log.info('AI features are off (set CF_ACCOUNT_ID and CF_API_TOKEN to turn them on)');
    return;
  }
  const photos = () => describePhotos(bb, wa, log).catch((e) => log.error(e, 'photo descriptions failed'));
  const index = () => indexRound(log).catch((e) => log.error(e, 'search indexing failed'));
  let soon: NodeJS.Timeout | null = null;
  bus.on('live', (ev: LiveEvent) => {
    if (ev.type === 'message' && !ev.historical && !soon) {
      // New photos get described within seconds; a burst of messages triggers one round.
      soon = setTimeout(() => { soon = null; photos(); }, 5_000);
    }
    // An edited, unsent or newly described message changes its chunk's text.
    if (ev.type === 'message-updated') markChunkStale(ev.messageId).catch(() => {});
  });
  setTimeout(() => { photos(); index(); }, 15_000).unref();
  setInterval(photos, 60_000).unref();
  setInterval(index, 60_000).unref();
  log.info({ models: config.ai.models, dailyNeurons: config.ai.dailyNeurons }, 'AI features on');
}

export function registerAiRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireSession);

    r.get('/api/ai/status', async () => {
      if (!aiEnabled()) return { enabled: false };
      const acc = await accountUsage();
      const [used, hubUsed, usage, photos, search] = await Promise.all([usedToday(), hubUsedToday(), usageToday(), photoStats(), indexStats()]);
      return {
        enabled: true,
        // usedToday: the shared account's total as the budget sees it; hubUsedToday: this hub alone.
        owner: config.ai.owner || null, hubUsedToday: Math.round(hubUsed), usedToday: Math.round(used),
        remaining: Math.max(0, Math.round(config.ai.dailyNeurons - used)), limit: config.ai.dailyNeurons,
        account: { usedToday: acc.used === null ? null : Math.round(acc.used), checkedAt: acc.checkedAt, error: acc.error },
        resetsAt: resetsAt().toISOString(), usage, photos, search, models: config.ai.models,
      };
    });

    r.get<{ Querystring: { q?: string; tid?: string; limit?: string } }>('/api/ai/search', async (req) => {
      const text = String(req.query.q ?? '').trim();
      if (text.length < 2) return [];
      const convIds = req.query.tid ? (await threadConversations(req.query.tid)).map((c) => c.id) : undefined;
      return relevantHits(await searchByMeaning({ text, convIds, limit: Number(req.query.limit ?? 10) }));
    });

    r.post<{ Body: { q?: string; tid?: string } }>('/api/ai/ask', async (req, reply) => {
      const question = String(req.body?.q ?? '').trim().slice(0, 500);
      if (question.length < 3) return reply.code(400).send({ error: 'Ask a question first.' });
      return ask(question, req.body?.tid || undefined);
    });

    r.post<{ Params: { tid: string } }>('/api/threads/:tid/suggest-replies', async (req) => suggestReplies(req.params.tid));
  });
}
