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
}

export interface ThreadDetail {
  tid: string;
  isGroup: boolean;
  title: string;
  conversations: { id: number; network: Network; title: string | null; lastMessageAt: string | null; unread: number; lastService: Service }[];
  members: { id: number; network: Network; address: string; name: string | null }[];
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

export interface SearchResult extends Message { tid: string; thread_title: string | null }

export interface Status {
  bluebubbles: {
    configured: boolean; connected: boolean; privateApi: boolean; serverVersion: string | null; osVersion: string | null;
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
  me: () => request<{ loggedIn: boolean }>('/api/auth/me'),
  login: (password: string) => post<{ ok: true }>('/api/auth/login', { password }),
  logout: () => post('/api/auth/logout'),
  status: () => request<Status>('/api/status'),
  threads: () => request<ThreadSummary[]>('/api/threads?limit=300'),
  thread: (tid: string) => request<ThreadDetail>(`/api/threads/${tid}`),
  messages: (tid: string, before?: string) =>
    request<Message[]>(`/api/threads/${tid}/messages?limit=60${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  markRead: (tid: string) => post(`/api/threads/${tid}/read`),
  send: (tid: string, body: { text: string; conversationId?: number; replyToId?: number }) => post(`/api/threads/${tid}/send`, body),
  sendFile: (tid: string, file: File, conversationId?: number, caption?: string) => {
    const form = new FormData();
    // Fields first: the server reads them from the multipart stream before the file.
    if (conversationId) form.set('conversationId', String(conversationId));
    if (caption) form.set('caption', caption);
    form.set('file', file);
    return post(`/api/threads/${tid}/send-file`, form);
  },
  search: (q: string) => request<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),
  waPair: () => post('/api/whatsapp/pair'),
  waLogout: () => post('/api/whatsapp/logout'),
};

export const SERVICE_LABEL: Record<Service, string> = {
  imessage: 'iMessage',
  sms: 'SMS',
  rcs: 'RCS',
  whatsapp: 'WhatsApp',
};
