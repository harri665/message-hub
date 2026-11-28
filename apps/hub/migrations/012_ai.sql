-- AI features through Cloudflare Workers AI (src/ai/): photo descriptions, search by meaning, answers and reply suggestions.
-- Needs the pgvector extension, which the stack's Postgres image (services/db/Dockerfile) includes.
create extension if not exists vector;

-- What a vision model saw in an image attachment, so photos can be found by searching.
-- description_state: null = not tried yet, ok, skipped (stickers, unsupported or tiny images), error (failed;
-- retried a few times, description_tries counts the attempts).
alter table attachment
  add column description text,
  add column description_state text check (description_state in ('ok', 'skipped', 'error')),
  add column description_model text,
  add column description_tries int not null default 0,
  add column described_at timestamptz;
create index attachment_describe_todo on attachment (message_id)
  where mime like 'image/%' and (description_state is null or description_state = 'error');
-- Word search (and Claude's search_messages) finds photos by their description, the same way it finds message text.
alter table attachment add column description_tsv tsvector generated always as (to_tsvector('simple', coalesce(description, ''))) stored;
create index attachment_description_tsv on attachment using gin (description_tsv);

-- Search by meaning: runs of consecutive messages in one chat (a few minutes of conversation), embedded together,
-- because a single "ok" or "haha" means nothing on its own. stale = the text needs (re)building and embedding.
create table search_chunk (
  id bigserial primary key,
  conversation_id bigint not null references conversation(id) on delete cascade,
  first_message_id bigint not null,
  first_sent_at timestamptz not null,
  last_sent_at timestamptz not null,
  message_count int not null,
  text text not null default '',
  text_hash text,
  embedding vector(1024),
  model text,
  stale boolean not null default true
);
create index search_chunk_conv on search_chunk (conversation_id, last_sent_at desc);
create index search_chunk_todo on search_chunk (last_sent_at desc) where stale;
create index search_chunk_embedding on search_chunk using hnsw (embedding vector_cosine_ops);

-- Which chunk a message went into; null = not grouped yet. System and unsent messages are grouped too (and left out of
-- the text), so the partial index only ever holds messages still waiting.
alter table message add column search_chunk_id bigint references search_chunk(id) on delete set null;
create index message_unindexed on message (conversation_id, sent_at) where search_chunk_id is null;
create index message_search_chunk on message (search_chunk_id) where search_chunk_id is not null;

-- Neurons spent per UTC day (Cloudflare's free allowance resets at 00:00 UTC), by feature and model.
create table ai_usage (
  day date not null,
  feature text not null,
  model text not null,
  requests int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  neurons double precision not null default 0,
  primary key (day, feature, model)
);
