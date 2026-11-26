import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Service } from './api.ts';

interface LivePreview {
  tid: string;
  body: string | null;
  service: Service;
  from_me: boolean;
  sender_name: string | null;
  is_group: boolean;
  title: string | null;
  has_attachment: boolean;
}

type LiveMsg =
  | { type: 'message'; conversationId: number; messageId: number; fromMe: boolean; tid?: string; preview?: LivePreview }
  | { type: 'message-updated'; conversationId: number; messageId: number }
  | { type: 'conversation-updated'; conversationId: number }
  | { type: 'status'; source: string }
  | { type: 'refresh' };

/** Keeps a WebSocket to the hub open and turns its events into cache invalidations and notifications. */
export function useLive(enabled: boolean, openTid: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let timer: number | undefined;
    const pending = new Set<string>();

    // Batch invalidations so bursts of events cause one refetch per query.
    const flush = () => {
      timer = undefined;
      for (const key of pending) qc.invalidateQueries({ queryKey: JSON.parse(key) });
      pending.clear();
    };
    const invalidate = (key: unknown[]) => {
      pending.add(JSON.stringify(key));
      if (!timer) timer = window.setTimeout(flush, 250);
    };

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/api/live`);
      ws.onopen = () => {
        retry = 1000;
        invalidate(['threads']);
        invalidate(['messages']);
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data) as LiveMsg;
        switch (ev.type) {
          case 'message':
            invalidate(['threads']);
            invalidate(['messages']);
            if (!ev.fromMe && ev.preview) notify(ev.preview, openTid);
            break;
          case 'message-updated':
            invalidate(['messages']);
            invalidate(['threads']);
            break;
          case 'conversation-updated':
            invalidate(['threads']);
            break;
          case 'status':
            invalidate(['status']);
            break;
          case 'refresh':
            invalidate(['threads']);
            invalidate(['messages']);
            invalidate(['status']);
            break;
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, openTid, qc]);
}

function notify(p: LivePreview, openTid: string | null) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden && p.tid === openTid) return;
  const who = p.sender_name ?? 'Someone';
  const title = p.is_group && p.title ? `${who} in ${p.title}` : who;
  const body = p.body ?? (p.has_attachment ? 'Sent an attachment' : '');
  const n = new Notification(title, { body, tag: p.tid });
  n.onclick = () => {
    window.focus();
    location.hash = `#/t/${p.tid}`;
    n.close();
  };
}
