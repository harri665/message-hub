import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Message } from '../api.ts';

// Link cards, like iPhone Messages: a picture on top, the page title and the site under it; a compact row when there
// is no picture. The hub reads the page (or uses the preview the sender's phone made) and serves the pictures itself.

export interface LinkPreviewData {
  state: 'ok' | 'none' | 'error';
  url: string | null;
  host?: string;
  title?: string | null;
  siteName?: string | null;
  /** The message's text without the link, for the text bubble beside the card. */
  rest: string;
  image: { src: string; width: number | null; height: number | null } | null;
  icon: string | null;
}

const HAS_LINK = /\b(?:https?:\/\/|www\.)\S/i;

/** Asks the hub for the preview of the first link in a message. Only messages that show a link ask. */
export function useLinkPreview(m: Pick<Message, 'id' | 'body' | 'unsent' | 'kind'>): LinkPreviewData | null {
  const wanted = m.kind === 'text' && !m.unsent && !!m.body && HAS_LINK.test(m.body);
  const { data } = useQuery({
    queryKey: ['link-preview', m.id, m.body],
    enabled: wanted,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<LinkPreviewData> => {
      const res = await fetch(`/api/messages/${m.id}/link-preview`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`link preview ${res.status}`);
      return res.json();
    },
  });
  return wanted && data?.state === 'ok' && data.url ? data : null;
}

function Favicon({ src, host }: { src: string | null; host: string }) {
  const [bad, setBad] = useState(false);
  if (src && !bad) return <img className="lc-icon" src={src} alt="" width={40} height={40} loading="lazy" decoding="async" onError={() => setBad(true)} />;
  return <span className="lc-icon lc-icon-blank" aria-hidden="true">{(host[0] ?? '?').toUpperCase()}</span>;
}

export function LinkCard({ p }: { p: LinkPreviewData }) {
  const [imgBad, setImgBad] = useState(false);
  const host = p.host ?? '';
  const title = p.title || p.siteName || host;
  const site = host || p.siteName || '';
  const big = p.image && !imgBad ? p.image : null;
  return (
    <a className={`link-card ${big ? 'has-image' : 'compact'}`} href={p.url!} target="_blank" rel="noreferrer noopener" title={p.url!}>
      {big && (
        <img
          className="lc-image"
          src={big.src}
          alt=""
          width={big.width ?? undefined}
          height={big.height ?? undefined}
          style={big.width && big.height ? { aspectRatio: `${big.width} / ${big.height}` } : undefined}
          loading="lazy"
          decoding="async"
          onError={() => setImgBad(true)}
        />
      )}
      {!big && <Favicon src={p.icon} host={host} />}
      <span className="lc-text">
        <span className="lc-title">{title}</span>
        <span className="lc-site">{site}</span>
      </span>
    </a>
  );
}
