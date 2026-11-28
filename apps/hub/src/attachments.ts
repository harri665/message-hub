// Getting an attachment's file onto disk. Attachments are downloaded from the Mac (BlueBubbles) or WhatsApp the first
// time something needs them: the web app showing a photo, or the AI describing it. Callers asking for the same
// attachment at the same time share one download.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { q1 } from './db.js';
import type { BlueBubbles } from './sources/bluebubbles.js';
import type { WhatsApp } from './sources/whatsapp.js';

const inflight = new Map<number, Promise<string>>();

/** The attachment's path relative to ATTACHMENTS_DIR, downloading it first if it isn't on disk. */
export async function attachmentFile(bb: BlueBubbles, wa: WhatsApp, id: number): Promise<string> {
  const a = await q1<{ storage_path: string | null; network: string }>(
    `select a.storage_path, c.network from attachment a
     join message m on m.id = a.message_id join conversation c on c.id = m.conversation_id where a.id = $1`,
    [id],
  );
  if (!a) throw Object.assign(new Error('attachment not found'), { statusCode: 404 });
  if (a.storage_path && fs.existsSync(path.join(config.attachmentsDir, a.storage_path))) return a.storage_path;
  let p = inflight.get(id);
  if (!p) {
    p = (a.network === 'apple' ? bb.downloadAttachment(id) : wa.downloadAttachment(id)).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}
