-- Pinned messages: private to the hub (nothing is sent to iMessage or WhatsApp, and phones never see them).
-- A pin is just a timestamp on the message; null means not pinned. Deleting the message removes the pin.
alter table message add column pinned_at timestamptz;
create index message_pinned_idx on message (conversation_id, pinned_at desc) where pinned_at is not null;
