-- Link previews: what the card for a link shows (title, site, picture), stored once per URL.
-- Details come from the sender's own phone when it sent them (iMessage payload, WhatsApp link preview, source =
-- 'imessage' / 'whatsapp', never expire) and otherwise from the page's own tags (source = 'web', re-read after expires_at).
-- Pictures are already resized: image_data is a WebP at most 640 px wide, icon_data a 96 px WebP.
create table link_preview (
  id bigserial primary key,
  url text not null unique,
  host text not null,
  title text,
  site_name text,
  description text,
  image_data bytea,
  image_w int,
  image_h int,
  icon_data bytea,
  etag text,                           -- short hash of what is shown; the cache-busting version in picture URLs
  source text not null check (source in ('imessage', 'whatsapp', 'web')),
  state text not null check (state in ('ok', 'none', 'error')),  -- none = the page has nothing to show, error = could not be read
  error text,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz
);
create index link_preview_expires on link_preview (expires_at) where expires_at is not null;
