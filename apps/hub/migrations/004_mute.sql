-- Muted conversations: no notifications, shown as muted. 'infinity' means muted until turned off.
-- WhatsApp chats follow the mute setting on the WhatsApp account; others are muted from the web app.
alter table conversation add column muted_until timestamptz;
