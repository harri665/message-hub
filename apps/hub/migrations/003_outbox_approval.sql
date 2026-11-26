-- Messages Claude (or another MCP client) asks to send. Nothing here is sent until the signed-in user approves it in the web app.
create table pending_send (
  id bigserial primary key,
  tid text not null,
  thread_title text,                    -- shown to the user, as it was when requested
  conversation_id bigint not null references conversation(id) on delete cascade,
  service text not null,                -- 'imessage' | 'sms' | 'rcs' | 'whatsapp'
  text text not null,
  reply_to_message_id bigint references message(id) on delete set null,
  requested_by text not null,           -- name of the MCP token
  status text not null default 'pending', -- pending | approved | rejected | sent | failed | expired
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  sent_at timestamptz,
  message_id bigint references message(id) on delete set null
);
create index pending_send_status_idx on pending_send (status, created_at desc);
