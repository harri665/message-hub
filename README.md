# message-hub

Self-hosted web app that syncs iMessage, SMS and WhatsApp from my iPhone into one continuous inbox I can read and reply to from any browser.

- **iMessage / SMS** come through the macOS VM on Proxmox running Messages.app and BlueBubbles Server.
- **WhatsApp** comes through `services/wa-connector`, a linked-device client built on whatsmeow.
- **`apps/hub`** stores everything in Postgres, merges each person's iMessage and WhatsApp chats into one timeline, and serves the web app.
- **`apps/web`** is the React PWA: inbox, merged conversations, search, attachments, replies, WhatsApp pairing.

Runs as a Portainer stack on TrueNAS and redeploys on every push to `main`.

- [SETUP.md](SETUP.md): getting the Mac VM, the stack and WhatsApp running
- [PLAN.md](PLAN.md): design and roadmap
