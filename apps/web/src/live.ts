import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Service } from './api.ts';
import { clearTyping, setTyping } from './stores.ts';

interface LivePreview {
  tid: string;
  body: string | null;
  service: Service;
  from_me: boolean;
  sender_name: string | null;
  is_group: boolean;
  title: string | null;
  has_attachment: boolean;
  muted?: boolean;
  archived?: boolean;
}

type LiveMsg =
  | { type: 'message'; conversationId: number; messageId: number; fromMe: boolean; tid?: string; preview?: LivePreview }
  | { type: 'message-updated'; conversationId: number; messageId: number }
  | { type: 'conversation-updated'; conversationId: number }
  | { type: 'status'; source: string }
  | { type: 'send-request' }
  | { type: 'refresh' }
  | { type: 'typing'; tid: string; conversationId: number; network: 'apple' | 'whatsapp'; typing: boolean; audio: boolean; name: string | null; sender: string | null };

/** Keeps a WebSocket to the hub open and turns its events into cache invalidations and notifications. */
export function useLive(enabled: boolean, openTid: string | null) {
  const qc = useQueryClient();
  // Kept in a ref so switching conversations doesn't reconnect the socket.
  const tidRef = useRef(openTid);
  tidRef.current = openTid;
  const reportRef = useRef<() => void>(() => {});

  // The open conversation changed: tell the hub (it subscribes to that WhatsApp chat's typing).
  useEffect(() => reportRef.current(), [openTid]);

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let timer: number | undefined;
    const pending = new Set<string>();

    // While this page is visible and focused, WhatsApp shows this device online, as WhatsApp Web does.
    let lastSent = '';
    const report = (force = false) => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      const msg = JSON.stringify({ type: 'activity', active: !document.hidden && document.hasFocus(), tid: tidRef.current });
      if (!force && msg === lastSent) return;
      lastSent = msg;
      ws.send(msg);
    };
    reportRef.current = () => report();
    const onActivity = () => report();
    window.addEventListener('focus', onActivity);
    window.addEventListener('blur', onActivity);
    document.addEventListener('visibilitychange', onActivity);
    const heartbeat = window.setInterval(() => report(true), 30_000);

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
        report(true);
        invalidate(['threads']);
        invalidate(['messages']);
        invalidate(['thread']);
        invalidate(['send-requests']);
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data) as LiveMsg;
        switch (ev.type) {
          case 'message':
            invalidate(['threads']);
            invalidate(['messages']);
            if (!ev.fromMe && ev.tid) clearTyping(ev.tid);
            if (!ev.fromMe && ev.preview) notify(ev.preview, tidRef.current);
            break;
          case 'typing':
            setTyping(ev.tid, `${ev.conversationId}:${ev.sender ?? ''}`, ev.typing, {
              name: ev.name, audio: ev.audio,
              // iMessage sends one "started typing" and no repeats, so its indicator lasts longer.
              ttlMs: ev.network === 'apple' ? 60_000 : 25_000,
            });
            break;
          case 'message-updated':
            invalidate(['messages']);
            invalidate(['thread']);
            invalidate(['threads']);
            break;
          case 'conversation-updated':
            invalidate(['threads']);
            break;
          case 'status':
            invalidate(['status']);
            break;
          case 'send-request':
            invalidate(['send-requests']);
            invalidate(['messages']);
            invalidate(['threads']);
            break;
          case 'refresh':
            invalidate(['threads']);
            invalidate(['messages']);
            invalidate(['thread']);
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
      clearInterval(heartbeat);
      reportRef.current = () => {};
      window.removeEventListener('focus', onActivity);
      window.removeEventListener('blur', onActivity);
      document.removeEventListener('visibilitychange', onActivity);
    };

  }, [enabled, qc]);
}

function notify(p: LivePreview, openTid: string | null) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Muted chats (in WhatsApp, or muted here) and archived chats never notify.
  if (p.muted || p.archived) return;
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
