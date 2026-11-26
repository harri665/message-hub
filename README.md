# message-hub

Self-hosted web app that syncs iMessage, SMS and WhatsApp from my iPhone into one continuous inbox I can read and reply to from any browser.

- **iMessage / SMS** come through the macOS VM on Proxmox running Messages.app and BlueBubbles Server.
- **WhatsApp** comes through `services/wa-connector`, a linked-device client built on whatsmeow.
- **`apps/hub`** stores everything in Postgres, merges each person's iMessage and WhatsApp chats into one timeline, and serves the web app.
- **`apps/web`** is the React PWA: inbox, merged conversations, search, attachments, replies, WhatsApp pairing.

## Search

The search box in the sidebar (Ctrl+K) finds people and messages. Every word has to appear and words match as prefixes, so `pizz` finds "pizza". Put words in quotes to find them together (`"see you"`) and put a minus in front of a word to leave it out (`dinner -work`). The iMessage and WhatsApp filters also narrow the message results. Click a result to open the conversation at that message. Inside a conversation, **Search** in the header searches just that conversation.

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
