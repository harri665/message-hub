export type Service = 'imessage' | 'sms' | 'rcs' | 'whatsapp';
export type Network = 'apple' | 'whatsapp';

export interface ThreadSummary {
  tid: string;
  is_group: boolean;
  last_at: string;
  unread: number;
  conversation_ids: number[];
  networks: Network[];
  title: string;
  last_body: string | null;
  last_from_me: boolean | null;
  last_service: Service | null;
  last_kind: string | null;
  last_unsent: boolean | null;
  last_has_attachment: boolean | null;
  last_sender_name: string | null;
  muted: boolean;
  muted_until: string | null;
  archived: boolean;
  /** Version of the profile photo (see /api/avatars/:tid), or null when there is none. */
  avatar: string | null;
}

export interface ThreadDetail {
  tid: string;
  isGroup: boolean;
  avatar: string | null;
  muted: boolean;
  archived: boolean;
  title: string;
  conversations: { id: number; network: Network; title: string | null; lastMessageAt: string | null; unread: number; lastService: Service }[];
  members: { id: number; network: Network; address: string; name: string | null }[];
  /** Pinned messages (private to the hub), newest pin first. */
  pins: Pin[];
}

export interface Pin {
  id: number;
  pinnedAt: string;
  sentAt: string;
  fromMe: boolean;
  /** First 200 characters of the message, or null for an attachment with no text. */
  text: string | null;
  /** Who sent it; null for you. */
  sender: string | null;
  hasAttachment: boolean;
}

export interface Attachment { id: number; mime: string | null; filename: string | null; size: number | null; width: number | null; height: number | null }
export interface Reaction { emoji: string; fromMe: boolean; name: string | null }

export interface Message {
  id: number;
  conversation_id: number;
  service: Service;
  from_me: boolean;
  kind: 'text' | 'system';
  body: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  edited_at: string | null;
  unsent: boolean;
  pinned_at: string | null;
  status: 'sending' | 'sent' | 'failed';
  sender_person_id: number | null;
  sender_name: string | null;
  attachments: Attachment[];
  reactions: Reaction[];
  reply_to_id: number | null;
  reply_to_body: string | null;
  reply_to_from_me: boolean | null;
  reply_to_name: string | null;
}

export interface SearchResult extends Message { tid: string; thread_title: string | null; is_group: boolean; snippet: string | null }

export interface MessagePage { before?: string; after?: string; around?: number }

export interface McpToken { id: string; name: string; createdAt: string; lastUsedAt: string | null }

export interface SendRequest {
  id: number;
  tid: string;
  thread_title: string | null;
  service: Service;
  text: string;
  requested_by: string;
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed' | 'expired';
  error: string | null;
  created_at: string;
  reply_to_message_id: number | null;
  reply_to_body: string | null;
  reply_to_from_me: boolean | null;
}

export type SearchService = 'apple' | 'whatsapp' | '';

export interface ContactMatch {
  personId: number;
  name: string;
  /** The person's existing conversation, if there is one. */
  tid: string | null;
  addresses: { network: Network; address: string }[];
}

/** Which services can reach an address. null: couldn't be checked. */
export interface AddressCheck { address: string; imessage: boolean | null; sms: boolean; whatsapp: boolean | null }

export type ComposeService = 'imessage' | 'sms' | 'whatsapp';

export interface Status {
  bluebubbles: {
    configured: boolean; url: string | null; connected: boolean; privateApi: boolean; serverVersion: string | null; osVersion: string | null;
    lastSyncAt: string | null; importing: boolean; error: string | null;
  };
  whatsapp: {
    configured: boolean; reachable: boolean; loggedIn: boolean; connected: boolean; pairing: boolean;
    qr: string | null; jid: string | null; pushName: string | null; error: string | null;
  };
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json', ...init.headers } : init.headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('mh:logged-out'));
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) });

export const api = {
  me: () => request<{ loggedIn: boolean; needsSetup: boolean }>('/api/auth/me'),
  login: (password: string) => post<{ ok: true }>('/api/auth/login', { password }),
  setup: (password: string, setupCode: string) => post<{ ok: true }>('/api/auth/setup', { password, setupCode }),
  saveBlueBubbles: (url: string, password: string) =>
    request<{ ok: true }>('/api/settings/bluebubbles', { method: 'PUT', body: JSON.stringify({ url, password }) }),
  logout: () => post('/api/auth/logout'),
  status: () => request<Status>('/api/status'),
  threads: (archived = false) => request<ThreadSummary[]>(`/api/threads?limit=300${archived ? '&archived=1' : ''}`),
  archivedSummary: () => request<{ archivedCount: number; archivedUnread: number }>('/api/threads/archived-summary'),
  archive: (tid: string, archived: boolean) => post(`/api/threads/${tid}/${archived ? 'archive' : 'unarchive'}`),
  thread: (tid: string) => request<ThreadDetail>(`/api/threads/${tid}`),
  messages: (tid: string, page: MessagePage = {}) => {
    const qs = new URLSearchParams({ limit: '60' });
    if (page.before) qs.set('before', page.before);
    if (page.after) qs.set('after', page.after);
    if (page.around) qs.set('around', String(page.around));
    return request<Message[]>(`/api/threads/${tid}/messages?${qs}`);
  },
  markRead: (tid: string) => post(`/api/threads/${tid}/read`),
  mute: (tid: string, muted: boolean, hours: number | null = null) => post(`/api/threads/${tid}/mute`, { muted, hours }),
  pin: (id: number) => post<{ ok: true; pinned: boolean }>(`/api/messages/${id}/pin`),
  unpin: (id: number) => post<{ ok: true; pinned: boolean }>(`/api/messages/${id}/unpin`),
  send: (tid: string, body: { text: string; conversationId?: number; replyToId?: number }) => post(`/api/threads/${tid}/send`, body),
  sendFile: (tid: string, file: File, conversationId?: number, caption?: string, voice = false) => {
    const form = new FormData();
    // Fields first: the server reads them from the multipart stream before the file.
    if (conversationId) form.set('conversationId', String(conversationId));
    if (caption) form.set('caption', caption);
    if (voice) form.set('voice', 'true');
    form.set('file', file);
    return post(`/api/threads/${tid}/send-file`, form);
  },
  reactions: () => request<Record<Network, string[]>>('/api/reactions'),
  react: (messageId: number, emoji: string | null) => post(`/api/messages/${messageId}/react`, { emoji }),
  typing: (tid: string, conversationId: number, typing: boolean, audio = false) =>
    post(`/api/threads/${tid}/typing`, { conversationId, typing, audio }),
  contacts: (q: string) => request<ContactMatch[]>(`/api/contacts?q=${encodeURIComponent(q)}`),
  checkAddress: (address: string) => request<AddressCheck>(`/api/compose/check?address=${encodeURIComponent(address)}`),
  compose: (addresses: string[], service: ComposeService, text: string) =>
    post<{ ok: true; tid: string }>('/api/compose', { addresses, service, text }),
  search: (q: string, opts: { tid?: string; service?: SearchService; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams({ q, limit: String(opts.limit ?? 40), offset: String(opts.offset ?? 0) });
    if (opts.tid) qs.set('tid', opts.tid);
    if (opts.service) qs.set('service', opts.service);
    return request<SearchResult[]>(`/api/search?${qs}`);
  },
  mcpTokens: () => request<McpToken[]>('/api/mcp/tokens'),
  createMcpToken: (name: string) => post<{ id: string; name: string; token: string }>('/api/mcp/tokens', { name }),
  deleteMcpToken: (id: string) => request<{ ok: true }>(`/api/mcp/tokens/${id}`, { method: 'DELETE' }),
  sendRequests: (status = 'pending') => request<SendRequest[]>(`/api/send-requests?status=${status}`),
  approveSendRequest: (id: number) => post<SendRequest>(`/api/send-requests/${id}/approve`),
  rejectSendRequest: (id: number) => post<SendRequest>(`/api/send-requests/${id}/reject`),
  waPair: () => post('/api/whatsapp/pair'),
  waLogout: () => post('/api/whatsapp/logout'),
};

export const SERVICE_LABEL: Record<Service, string> = {
  imessage: 'iMessage',
  sms: 'SMS',
  rcs: 'RCS',
  whatsapp: 'WhatsApp',
};
