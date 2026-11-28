# message-hub

Self-hosted web app that syncs iMessage, SMS and WhatsApp from my iPhone into one continuous inbox I can read and reply to from any browser.

- **iMessage / SMS** come through the macOS VM on Proxmox running Messages.app and BlueBubbles Server.
- **WhatsApp** comes through `services/wa-connector`, a linked-device client built on whatsmeow.
- **`apps/hub`** stores everything in Postgres, merges each person's iMessage and WhatsApp chats into one timeline, and serves the web app.
- **`apps/web`** is the React PWA: inbox, merged conversations, search, attachments, replies, WhatsApp pairing.
- **`apps/desktop`** is a native Linux client (C++ / Qt Quick) in the MacShell style, with notifications and a small background footprint. See [its README](apps/desktop/README.md).

## Profile photos

Threads show real photos in the web app and the desktop app, with initials as the fallback. A group shows its own icon. A person shows their iMessage contact photo (from the Mac's Contacts, via BlueBubbles) when they have one, and otherwise their WhatsApp profile photo. Photos are stored in Postgres (the `avatar` table, 256px WebP) and served only to signed-in clients at `/api/avatars/<thread id>?w=64|128|256&v=<version>`. The thread list carries the version (`avatar`), so a changed photo gets a new URL. Contacts are re-read hourly, iMessage group icons and WhatsApp photos are re-checked daily (WhatsApp also on photo-change events).

## Search

The search box in the sidebar (Ctrl+K) finds people and messages. Every word has to appear and words match as prefixes, so `pizz` finds "pizza". Put words in quotes to find them together (`"see you"`) and put a minus in front of a word to leave it out (`dinner -work`). The iMessage and WhatsApp filters also narrow the message results. Click a result to open the conversation at that message. Inside a conversation, **Search** in the header searches just that conversation.

Searches take Discord-style filters, with or without a space after the colon, and the box suggests them as you type (arrow keys pick, Enter or Tab completes):

| Filter | Meaning |
| --- | --- |
| `from: mom`, `from: "Cole Writer"`, `from: 3035550102`, `from: me` | Sender: a name, address or phone number, matched on every service. `me` (and any names in `SELF_NAMES`, e.g. `harrison,harri665`) means messages you sent. |
| `in: Ski Trip` | One conversation, by chat or person name (or its id, `p12`). |
| `has: image` / `video` / `audio` (`sound`) / `file` / `link` / `sticker` / `attachment` | Repeat to require several: `has: image has: link`. |
| `before: 2026-11-25`, `after: nov 25`, `during: 2026-11` | A day, a month, `yesterday`, `today`, `nov 25`, `11/25`. In the hub's `TIME_ZONE`. |
| `is: unread`, `is: reply`, `service: whatsapp` | Unread incoming messages, replies, one service (`imessage`, `sms`, `rcs`, `whatsapp`). |

Everything else is searched as words, and the words can be left out (`has: image in: Mom`). Unknown operators and values it can't read stay in the text. The MCP `search_messages` tool understands the same filters. There is no `mentions:` because mentions are not stored.

## Emoji shortcodes

In the composer (web and desktop), typing `:` and two letters (`:smi`) opens a list of matching emoji above the cursor. Arrow keys pick, Enter or Tab inserts, Esc closes, and a finished `:smile:` turns into the emoji straight away. It only starts at the beginning of the text or after a space, so `http://x:80` is left alone, and it does nothing inside backticks. The names are the ones GitHub, Discord and Slack use. The list comes from [emojibase-data](https://github.com/milesj/emojibase) (MIT, notice in `apps/web/src/emoji/LICENSE-emojibase.txt`), regenerated with `node tools/gen-emoji.mjs <path to node_modules/emojibase-data>` into both apps.

## Pinned messages

Right-click (desktop) or use **Pin** on a message (web) to pin it. Pins are private to the hub: nothing is sent to the phone, iMessage or WhatsApp, and other people never see them (iOS 26 message pins never reach the Mac VM, and pinning in WhatsApp would post a notice to the chat, so the hub keeps its own). A pin is a `pinned_at` timestamp on the message (migration 006). `POST /api/messages/:id/pin` and `/unpin` set it (signed-in sessions only) and send a live `message-updated` event, so other open clients update. `GET /api/threads/:tid` lists the thread's `pins`, newest pin first (`id`, `text` preview, `sender`, `sentAt`, `fromMe`, `hasAttachment`). Unsent messages drop out of the pins. A thread with pins shows a Pinned bar under the header: click it to step through the pins (older pages are loaded if needed, and the message is highlighted), or Unpin from it. Claude's `read_conversation` marks pinned messages with "(pinned)" and cannot change pins.

## Scheduled messages

Write a message, then choose **Schedule** (web: the button beside Send, or right-click Send; desktop: the clock button in the message box, or right-click the send arrow) to send it later, for example "tomorrow at 9:00". The picker has quick times (Later today 18:00, Tomorrow 9:00, Monday 9:00) and a date and time. It works for iMessage, SMS and WhatsApp. Only text can be scheduled (not files or voice messages), and a scheduled message can be a reply. Scheduled messages show at the bottom of the chat as dimmed bubbles with a clock and "Sends tomorrow at 9:00 AM", with a menu to edit the text or time, send now or cancel; a "n scheduled" count shows in the chat header. A failed one stays there with its error and a Retry button.

The hub sends them (`apps/hub/src/scheduled.ts`), so they go out when every app, the phone and your computer are off. It sends through the same path as the apps' Send button (`sendText` in `outbox.ts`), so the Mac or the WhatsApp link has to be up at that time. Guarantees:

- **At most once.** Every pass claims due rows with one `UPDATE ... FOR UPDATE SKIP LOCKED` that flips them to `sending`, so two passes (or two hubs) never send the same message. A row stuck in `sending` for over 5 minutes (the hub died mid-send) is marked failed instead of retried, because nobody can know whether it went out.
- **Survives restarts.** Messages live in Postgres (migration 010, table `scheduled_message`). The scheduler runs every 15 seconds and 10 seconds after start-up. A message that came due while the hub was down is sent when it comes back if it is less than 24 hours late; later than that it is marked failed ("Missed ...") and never sent.
- **Failures are shown, not retried forever.** A send that clearly never reached the service (connection refused, BlueBubbles or the WhatsApp connector unreachable) is retried twice, after 1 and 5 minutes. Anything else, including a timeout (the message may have gone out), fails at once with the error shown. Retry, Edit and Discard are available on a failed message.
- **Time zones.** The API takes an absolute time (`sendAt`, ISO 8601 with an offset or Z). The apps show the picker in the device's own time zone and, when the hub's `TIME_ZONE` differs (`GET /api/status` returns it as `timeZone`), also show the time in the hub's zone.
- Up to 200 messages can wait at once, up to a year ahead and at most 4000 characters each.

API (all need a signed-in session; each change sends a live `scheduled` event with the thread id):

| Request | What it does |
|---|---|
| `POST /api/threads/:tid/scheduled` `{text, sendAt, conversationId?, replyTo?}` | Schedule a message (201). `sendAt` must be 5 seconds to a year ahead. `replyTo` is a message id in that conversation. |
| `GET /api/threads/:tid/scheduled` | Waiting, sending and failed messages of a thread, soonest first. |
| `GET /api/scheduled` | The same for every thread, with `threadTitle`. |
| `PATCH /api/scheduled/:id` `{text?, sendAt?}` | Change a message that is still scheduled (a failed one that gets a new `sendAt` is scheduled again). 409 if it was already sent or cancelled. |
| `DELETE /api/scheduled/:id` | Cancel a scheduled message, or dismiss a failed one. |
| `POST /api/scheduled/:id/send-now` | Send it now (also the retry for a failed one). |

Each item has `id, tid, threadTitle, conversationId, service, text, replyToId, sendAt, status` (`scheduled`, `sending`, `sent`, `failed`, `cancelled`), `error, attempts, retryAt, createdAt, sentAt, messageId`. There is deliberately no MCP tool for this: Claude can only ask to send through the approval queue (`request_send_message`), so it cannot queue messages that go out later without you. BlueBubbles has its own scheduled messages feature, but the hub does not use it, so scheduling works for WhatsApp too and does not depend on the Mac.

## Archived chats

**Archive** (web: the header button or right-click a chat; desktop: right-click a chat) moves a chat out of the list into an **Archived (n)** row at the top of the list, which opens the archived chats with a way back. `POST /api/threads/:tid/archive` and `/unarchive` apply to every chat merged into the thread (a person's iMessage and WhatsApp chats together). A thread counts as archived only when all its chats are, and a new message does not un-archive it (like WhatsApp's "keep chats archived"). `GET /api/threads?archived=1` lists archived threads; the normal list is unchanged apart from an `archived` flag, and its `x-archived-count` / `x-archived-unread` headers (also `GET /api/threads/archived-summary` as `archivedCount` and `archivedUnread`) feed the Archived row. Archived threads add nothing to unread counts and badges and never notify (the live `message` preview carries `archived`, like `muted`). Search still finds messages in archived chats. A live `conversation-updated` event refreshes other clients. No migration was needed: it uses the `conversation.archived` column.

WhatsApp: archive state is private to the account and syncs both ways, like mute. Archiving in the hub sends an archive change to the account through the connector (`POST /archive` builds `appstate.BuildArchive` with the chat's last message, then `SendAppState`), so the phone matches; if WhatsApp refuses, nothing changes and the app shows the error. Archiving or unarchiving on the phone reaches the hub as a whatsmeow `events.Archive` (the connector turns it into a hub event, including the ones from the full app-state sync after linking), and the hub also re-reads whatsmeow's stored archive flags every minute as a safety net. Chats WhatsApp has no stored setting for keep the hub's state. iMessage has no archive the Mac can read or change, so those chats are archived in Message Hub only (BlueBubbles' own `isArchived` is ignored).

## Claude (MCP)

The hub is also an MCP server, so Claude can search and read your messages. Claude can also ask to send a message, but it can never send one itself: every request waits in Message Hub until you choose **Send** or **Don't send**, and the hub only sends after that click. Requests expire after 24 hours, and at most 10 can wait at once.

1. In the web app, open **Settings**, then **Claude**, and click **Create access token**.
2. Copy the Claude Code command it shows and run it. It looks like:
   `claude mcp add --transport http --scope user messages https://<your-address>/mcp --header "Authorization: Bearer mh_..."`
3. For a claude.ai custom connector, use the connector URL instead (`https://<your-address>/mcp/mh_...`). The hub has to be reachable over HTTPS for that.

Tools: `search_messages`, `list_conversations` and `read_conversation` read your messages. `request_send_message` queues a message for your approval (nothing is sent yet), and `get_send_request` and `list_send_requests` show what you decided. Approving is only possible from the signed-in web app, never with an MCP token. Set `TIME_ZONE` in `.env` so Claude sees message times in your time zone. Revoke a token in Settings at any time.

Runs as a Portainer stack on TrueNAS and redeploys on every push to `main`.

- [SETUP.md](SETUP.md): getting the Mac VM, the stack and WhatsApp running
- [PLAN.md](PLAN.md): design and roadmap
