// Link preview endpoints (see ../linkpreview.ts). Everything here needs a session.
import type { FastifyInstance } from 'fastify';
import { q1 } from '../db.js';
import { extractLink, getImage, getRowById, pruneLinkPreviews, resolvePreview, type PreviewRow } from '../linkpreview.js';
import type { BlueBubbles } from '../sources/bluebubbles.js';

/** What clients get: text for the card, and where to load its pictures (always from this hub). */
function describe(row: PreviewRow, link: { url: string; rest: string }) {
  const v = row.etag ?? '0';
  return {
    state: row.state,
    url: link.url,
    host: row.host,
    title: row.title,
    siteName: row.site_name,
    description: row.description,
    /** The message's text without the link, for the text bubble next to the card. */
    rest: link.rest,
    image: row.has_image ? { src: `/api/link-previews/${row.id}/image?v=${v}`, width: row.image_w, height: row.image_h } : null,
    icon: row.has_icon ? `/api/link-previews/${row.id}/icon?v=${v}` : null,
  };
}

export function registerLinkRoutes(r: FastifyInstance, bb: BlueBubbles) {
  pruneLinkPreviews().catch(() => {});
  setInterval(() => pruneLinkPreviews().catch(() => {}), 24 * 3600_000).unref();

  // The preview for the first link in a message. Asked for only when the message is on screen: the first request for a
  // link may take a few seconds (the page is read then); later ones are answered from the database.
  r.get<{ Params: { id: string } }>('/api/messages/:id/link-preview', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return reply.code(400).send({ error: 'bad id' });
    const m = await q1<{ body: string | null; unsent: boolean; service: string; source_id: string }>(
      'select body, unsent, service, source_id from message where id = $1',
      [id],
    );
    if (!m) return reply.code(404).send({ error: 'message not found' });
    const link = m.unsent ? null : extractLink(m.body);
    if (!link) return { state: 'none', url: null, rest: m.body ?? '', image: null, icon: null };
    const apple = m.service === 'imessage';
    const row = await resolvePreview(link.url, apple ? () => bb.linkPreview(m.source_id) : undefined);
    reply.header('cache-control', 'private, max-age=300');
    return describe(row, link);
  });

  r.get<{ Params: { id: string; kind: string }; Querystring: { v?: string } }>('/api/link-previews/:id/:kind', async (req, reply) => {
    const id = Number(req.params.id);
    const kind = req.params.kind;
    if (!Number.isSafeInteger(id) || (kind !== 'image' && kind !== 'icon')) return reply.code(404).send({ error: 'not found' });
    const row = await getRowById(id);
    const data = row ? await getImage(id, kind) : null;
    if (!row || !data) return reply.code(404).send({ error: 'no picture' });
    reply.type('image/webp').header('x-content-type-options', 'nosniff');
    // The version in the URL changes whenever the picture does, so it can be kept for good.
    reply.header('cache-control', req.query.v ? 'private, max-age=31536000, immutable' : 'private, max-age=3600');
    return reply.send(data);
  });
}
