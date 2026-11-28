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

## Pinned messages

Right-click (desktop) or use **Pin** on a message (web) to pin it. Pins are private to the hub: nothing is sent to the phone, iMessage or WhatsApp, and other people never see them (iOS 26 message pins never reach the Mac VM, and pinning in WhatsApp would post a notice to the chat, so the hub keeps its own). A pin is a `pinned_at` timestamp on the message (migration 006). `POST /api/messages/:id/pin` and `/unpin` set it (signed-in sessions only) and send a live `message-updated` event, so other open clients update. `GET /api/threads/:tid` lists the thread's `pins`, newest pin first (`id`, `text` preview, `sender`, `sentAt`, `fromMe`, `hasAttachment`). Unsent messages drop out of the pins. A thread with pins shows a Pinned bar under the header: click it to step through the pins (older pages are loaded if needed, and the message is highlighted), or Unpin from it. Claude's `read_conversation` marks pinned messages with "(pinned)" and cannot change pins.

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
