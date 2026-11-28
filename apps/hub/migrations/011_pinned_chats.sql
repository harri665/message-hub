-- Pinned chats: kept at the top of the conversation list, in the order they were pinned. Private to the hub (nothing is
-- sent to iMessage or WhatsApp). Pinning a thread pins every chat in it; a thread is pinned while any of its chats is.
alter table conversation add column pinned_at timestamptz;
create index conversation_pinned_idx on conversation (pinned_at) where pinned_at is not null;
-- Pinning single messages (006) is no longer offered. message.pinned_at stays so older builds keep working, but is cleared.
update message set pinned_at = null where pinned_at is not null;
