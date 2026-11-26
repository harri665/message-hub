-- A real contact, merged across networks by phone number or email.
create table person (
  id bigserial primary key,
  display_name text,
  created_at timestamptz not null default now()
);

-- One address on one network: a phone/email on Apple, a JID on WhatsApp.
create table handle (
  id bigserial primary key,
  network text not null,               -- 'apple' | 'whatsapp'
  address text not null,               -- as the network reports it
  normalized text,                     -- E.164 phone or lowercased email, used to merge people
  display_name text,                   -- best name we know for this handle
  name_source text,                    -- 'contacts' | 'push' | null
  person_id bigint references person(id) on delete set null,
  unique (network, address)
);
create index handle_normalized_idx on handle (normalized);
create index handle_person_idx on handle (person_id);

create table conversation (
  id bigserial primary key,
  network text not null,               -- 'apple' | 'whatsapp'
  source_id text not null,             -- BlueBubbles chat GUID or WhatsApp chat JID
  title text,
  is_group boolean not null default false,
  last_message_at timestamptz,
  unread_count int not null default 0,
  archived boolean not null default false,
  unique (network, source_id)
);
create index conversation_last_idx on conversation (last_message_at desc nulls last);

create table conversation_member (
  conversation_id bigint not null references conversation(id) on delete cascade,
  handle_id bigint not null references handle(id) on delete cascade,
  primary key (conversation_id, handle_id)
);
create index conversation_member_handle_idx on conversation_member (handle_id);

create table message (
  id bigserial primary key,
  conversation_id bigint not null references conversation(id) on delete cascade,
  service text not null,               -- 'imessage' | 'sms' | 'rcs' | 'whatsapp'
  source_id text not null,             -- network message id
  sender_handle_id bigint references handle(id) on delete set null,
  from_me boolean not null default false,
  kind text not null default 'text',   -- 'text' | 'system'
  body text,
  sent_at timestamptz not null,
  delivered_at timestamptz,
  read_at timestamptz,
  edited_at timestamptz,
  unsent boolean not null default false,
  reply_to_source_id text,
  status text not null default 'sent', -- 'sending' | 'sent' | 'failed'
  tsv tsvector generated always as (to_tsvector('simple', coalesce(body, ''))) stored,
  unique (service, source_id)
);
create index message_conv_sent_idx on message (conversation_id, sent_at desc);
create index message_source_idx on message (source_id);
create index message_tsv_idx on message using gin (tsv);

create table attachment (
  id bigserial primary key,
  message_id bigint not null references message(id) on delete cascade,
  source_id text not null,             -- BlueBubbles attachment GUID or WhatsApp message id
  mime text,
  filename text,
  size bigint,
  width int,
  height int,
  storage_path text,                   -- relative to ATTACHMENTS_DIR once downloaded
  unique (message_id, source_id)
);

create table reaction (
  id bigserial primary key,
  message_id bigint not null references message(id) on delete cascade,
  sender_key text not null,            -- 'me' or handle id, one reaction per sender per message
  sender_handle_id bigint references handle(id) on delete set null,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (message_id, sender_key)
);

create table session (
  id text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

-- Best known name per person: Mac/phone contacts first, then WhatsApp push names.
create view person_name as
  select distinct on (person_id) person_id, display_name as name
  from handle
  where person_id is not null and display_name is not null
  order by person_id, case name_source when 'contacts' then 0 when 'push' then 1 else 2 end, id;

-- A readable address per person when no name is known (phone numbers first).
create view person_address as
  select distinct on (person_id) person_id, coalesce(normalized, address) as address
  from handle
  where person_id is not null and address not like 'lid:%'
  order by person_id, (coalesce(normalized, address) like '+%') desc, id;

-- Which inbox thread a conversation belongs to: 1:1 chats merge per person ("p<id>"), groups stay separate ("c<id>").
create view conversation_thread as
  select c.id as conversation_id,
         case when c.is_group then 'c' || c.id
              else coalesce('p' || (select min(h.person_id) from conversation_member cm join handle h on h.id = cm.handle_id
                                    where cm.conversation_id = c.id), 'c' || c.id) end as tid
  from conversation c;

create table kv (
  key text primary key,
  value jsonb not null
);

-- Events written by the WhatsApp connector, consumed (and deleted) by the hub.
create table if not exists wa_event (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  payload jsonb not null
);

create or replace function wa_event_notify() returns trigger as $$
begin
  perform pg_notify('wa_event', '');
  return null;
end;
$$ language plpgsql;

create trigger wa_event_notify after insert on wa_event
  for each statement execute function wa_event_notify();
