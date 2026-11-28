-- Messages the user scheduled to send later. The hub sends them (scheduled.ts), so they go out even when every app is closed.
create table scheduled_message (
  id bigserial primary key,
  tid text not null,
  conversation_id bigint not null references conversation(id) on delete cascade,
  service text not null,                  -- 'imessage' | 'sms' | 'rcs' | 'whatsapp', as shown in the app
  text text not null,
  reply_to_message_id bigint references message(id) on delete set null,
  send_at timestamptz not null,
  status text not null default 'scheduled', -- scheduled | sending | sent | failed | cancelled
  error text,
  attempts int not null default 0,
  retry_at timestamptz,                   -- set after a failed attempt that is safe to retry
  claimed_at timestamptz,                 -- when the scheduler took it (status 'sending')
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  message_id bigint references message(id) on delete set null
);
create index scheduled_message_due_idx on scheduled_message (send_at) where status = 'scheduled';
create index scheduled_message_tid_idx on scheduled_message (tid, send_at);
