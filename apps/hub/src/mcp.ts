// MCP server: lets Claude (Claude Code, claude.ai connectors, other MCP clients) search and read the inbox.
// Read-only on purpose. Access is by tokens created in the web app's Settings; only their hashes are stored.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { requireSession } from './auth.js';
import { config } from './config.js';
import { kvGet, kvSet, q } from './db.js';
import { listThreads, searchMessages, threadConversations, threadMessages } from './queries.js';

// ---------- tokens ----------

interface McpToken { id: string; name: string; hash: string; createdAt: string; lastUsedAt: string | null }
const TOKENS_KEY = 'mcp.tokens';
const TOKEN_PREFIX = 'mh_';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const tokens = async () => (await kvGet<McpToken[]>(TOKENS_KEY)) ?? [];

async function checkToken(token: string | undefined): Promise<boolean> {
  if (!token?.startsWith(TOKEN_PREFIX)) return false;
  const hash = Buffer.from(sha256(token), 'hex');
  const list = await tokens();
  const hit = list.find((t) => timingSafeEqual(Buffer.from(t.hash, 'hex'), hash));
  if (!hit) return false;
  // Record use at most once a minute.
  if (!hit.lastUsedAt || Date.now() - Date.parse(hit.lastUsedAt) > 60_000) {
    hit.lastUsedAt = new Date().toISOString();
    await kvSet(TOKENS_KEY, list);
  }
  return true;
}

/** Hides tokens that appear in a URL path, so they never reach the logs. */
export function redactUrl(url: string) {
  return url.replace(/\/mcp\/[^/?#]+/, '/mcp/[token]');
}

// ---------- formatting ----------

const SERVICE: Record<string, string> = { imessage: 'iMessage', sms: 'SMS', rcs: 'RCS', whatsapp: 'WhatsApp' };

const fmtTime = (iso: string | Date | null) => {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};

const clip = (s: string | null | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);

function messageLine(m: any, opts: { thread?: boolean } = {}) {
  const who = m.kind === 'system' ? (m.sender_name ?? 'Someone') : m.from_me ? 'Me' : (m.sender_name ?? 'Unknown');
  const parts = [`[${m.id}] ${fmtTime(m.sent_at)}`];
  if (opts.thread) parts.push(`in "${m.thread_title ?? 'Unknown'}" (${m.tid})`);
  parts.push(`${SERVICE[m.service] ?? m.service}`);
  let text = m.unsent ? '(unsent)' : (m.body ?? '');
  if (m.kind === 'system') text = `(${text})`;
  const atts = (m.attachments ?? []) as { filename: string | null; mime: string | null }[];
  if (atts.length) text += `${text ? ' ' : ''}[${atts.map((a) => `${a.mime?.split('/')[0] ?? 'file'}: ${a.filename ?? 'attachment'}`).join(', ')}]`;
  const reacts = (m.reactions ?? []) as { emoji: string; fromMe: boolean; name: string | null }[];
  if (reacts.length) text += ` (reactions: ${reacts.map((r) => `${r.emoji} ${r.fromMe ? 'Me' : (r.name ?? '?')}`).join(', ')})`;
  if (m.reply_to_id) text = `(replying to "${clip(m.reply_to_body, 60)}") ${text}`;
  return `${parts.join(' | ')} | ${who}: ${clip(text, 2000)}`;
}

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

// ---------- server ----------

const isoDate = z.string().describe('Date or date-time, e.g. 2026-11-01 or 2026-11-01T18:00:00-07:00');

function buildServer() {
  const server = new McpServer(
    { name: 'message-hub', version: '0.1.0' },
    {
      instructions:
        "Read-only access to the user's messages: iMessage, SMS and RCS from their iPhone, and WhatsApp, merged by person. " +
        'Conversation ids look like p12 (all 1:1 chats with one person across services) or c34 (a group). ' +
        `Times are shown in ${config.timeZone} as YYYY-MM-DD HH:MM. Numbers in [brackets] are message ids. ` +
        'Find a person with list_conversations(match), search text with search_messages, then read context with read_conversation.',
    },
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Full-text search over message text, newest first. Every word must appear; words match as prefixes ("pizz" finds "pizza"). ' +
        'Use "quoted words" for a phrase and -word to exclude a word. Filter by conversation, service, sender or date. ' +
        'Returns message ids; pass one to read_conversation as around_message_id to see the surrounding messages.',
      inputSchema: {
        query: z.string().min(1).describe('Words to find'),
        conversation: z.string().regex(/^[pc]\d+$/).optional().describe('Limit to one conversation id, e.g. p12'),
        service: z.enum(['imessage', 'sms', 'rcs', 'whatsapp', 'apple']).optional().describe('apple means iMessage, SMS and RCS'),
        from_me: z.boolean().optional().describe('true: only messages the user sent; false: only messages they received'),
        sent_after: isoDate.optional(),
        sent_before: isoDate.optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const rows = await searchMessages({
        text: a.query, tid: a.conversation, service: a.service, fromMe: a.from_me,
        after: a.sent_after, before: a.sent_before, limit: a.limit, offset: a.offset,
      });
      if (!rows.length) return textResult(a.offset ? 'No more matches.' : `No messages match "${a.query}".`);
      const more = rows.length === a.limit ? `\nMore may exist: call again with offset=${a.offset + a.limit}.` : '';
      return textResult(`${rows.length} matches, newest first:\n${rows.map((m) => messageLine(m, { thread: true })).join('\n')}${more}`);
    },
  );

  server.registerTool(
    'list_conversations',
    {
      title: 'List conversations',
      description:
        'Conversations newest first, with the last message. Use match to find a person or group by name, phone number or email.',
      inputSchema: {
        match: z.string().optional().describe('Part of a name, phone number or email'),
        unread_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(30),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const rows = await listThreads({ match: a.match, unreadOnly: a.unread_only, limit: a.limit, offset: a.offset });
      if (!rows.length) return textResult(a.match ? `No conversations match "${a.match}".` : 'No conversations.');
      const lines = rows.map((t: any) => {
        const last = t.last_unsent ? '(unsent)' : (t.last_body ?? (t.last_has_attachment ? '[attachment]' : ''));
        const who = t.last_from_me ? 'Me: ' : t.is_group && t.last_sender_name ? `${t.last_sender_name}: ` : '';
        return [
          `${t.tid}`, t.title, t.is_group ? 'group' : 'person', `last ${fmtTime(t.last_at)}`,
          t.unread ? `${t.unread} unread` : null, `${who}${clip(last, 140)}`,
        ].filter(Boolean).join(' | ');
      });
      const more = rows.length === a.limit ? `\nMore may exist: call again with offset=${a.offset + a.limit}.` : '';
      return textResult(lines.join('\n') + more);
    },
  );

  server.registerTool(
    'read_conversation',
    {
      title: 'Read a conversation',
      description:
        'Messages from one conversation, oldest to newest. By default the most recent ones. ' +
        'around_message_id shows the messages around a search hit; before (a date-time) pages back to older messages.',
      inputSchema: {
        conversation: z.string().regex(/^[pc]\d+$/).describe('Conversation id from list_conversations or search_messages, e.g. p12'),
        around_message_id: z.number().int().optional(),
        before: isoDate.optional().describe('Only messages sent before this time'),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const convs = await threadConversations(a.conversation);
      if (!convs.length) return { ...textResult(`No conversation ${a.conversation}.`), isError: true };
      const [info] = await listThreads({ tid: a.conversation, limit: 1 });
      const members = await q(
        `select distinct coalesce(pn.name, h.display_name, h.address) as name, h.address, h.network
         from conversation_member cm join handle h on h.id = cm.handle_id
         left join person_name pn on pn.person_id = h.person_id where cm.conversation_id = any($1)`,
        [convs.map((c) => c.id)],
      );
      const rows = await threadMessages(convs.map((c) => c.id), {
        around: a.around_message_id, before: a.before, limit: a.limit,
      });
      const head = [
        `Conversation ${a.conversation}: ${info?.title ?? 'Unknown'}${convs[0].is_group ? ' (group)' : ''}`,
        `Members: ${members.map((m) => (m.name === m.address ? m.address : `${m.name} (${m.address})`)).join(', ') || 'unknown'}`,
        `Services: ${[...new Set(convs.map((c) => (c.network === 'whatsapp' ? 'WhatsApp' : 'iMessage/SMS/RCS')))].join(', ')}`,
      ];
      if (!rows.length) return textResult(`${head.join('\n')}\nNo messages${a.before ? ' before that time' : ''}.`);
      const oldest = rows[0].sent_at instanceof Date ? rows[0].sent_at.toISOString() : rows[0].sent_at;
      return textResult(
        `${head.join('\n')}\n\n${rows.map((m) => messageLine(m)).join('\n')}\n\nOlder messages: call again with before="${oldest}".`,
      );
    },
  );

  return server;
}

// ---------- routes ----------

export function registerMcp(app: FastifyInstance) {
  const handle = async (req: FastifyRequest<{ Params: { token?: string } }>, reply: FastifyReply) => {
    const header = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!(await checkToken(header ?? req.params.token))) {
      await new Promise((r) => setTimeout(r, 500));
      return reply.code(401).send({ error: 'A valid Message Hub access token is required. Create one in Settings.' });
    }
    // Stateless: a fresh server and transport per request, closed when the response ends.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };
  for (const url of ['/mcp', '/mcp/:token']) {
    app.route({ method: ['GET', 'POST', 'DELETE'], url, handler: handle });
  }

  // Token management for the web app.
  app.register(async (r) => {
    r.addHook('preHandler', requireSession);
    r.get('/api/mcp/tokens', async () =>
      (await tokens()).map(({ hash: _hash, ...t }) => t),
    );
    r.post<{ Body: { name?: string } }>('/api/mcp/tokens', async (req) => {
      const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const entry: McpToken = {
        id: randomUUID(), name: req.body?.name?.trim().slice(0, 60) || 'Claude', hash: sha256(token),
        createdAt: new Date().toISOString(), lastUsedAt: null,
      };
      await kvSet(TOKENS_KEY, [...(await tokens()), entry]);
      return { id: entry.id, name: entry.name, token };
    });
    r.delete<{ Params: { id: string } }>('/api/mcp/tokens/:id', async (req) => {
      await kvSet(TOKENS_KEY, (await tokens()).filter((t) => t.id !== req.params.id));
      return { ok: true };
    });
  });
}
