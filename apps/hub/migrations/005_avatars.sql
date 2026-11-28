-- Profile photos: one row per handle (a contact's photo) or per conversation (a group's icon), stored as a 256px WebP.
-- A row with a null etag means "checked, no photo", so people without one aren't asked about again until the check expires.
create table avatar (
  id bigserial primary key,
  handle_id bigint unique references handle(id) on delete cascade,
  conversation_id bigint unique references conversation(id) on delete cascade,
  source_key text,                     -- what the source said identifies this photo (WhatsApp picture id, or a hash of the Apple contact photo)
  etag text,                           -- short hash of `data`; also the cache-busting version in URLs
  data bytea,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(handle_id, conversation_id) = 1)
);
