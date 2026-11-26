# Message Hub: plan

One self-hosted web app that shows iMessage, SMS and WhatsApp conversations from my iPhone in a single, continuous inbox, and lets me reply from any PC browser. Installable as a PWA, hosted on my homelab like my other apps.

## The core constraint

An iPhone does not let any app read or export its messages. There are only two ways in:

- **iMessage and SMS**: a Mac signed into the same Apple ID. With *Messages in iCloud* turned on, the Mac's Messages.app holds the full history, and with *Text Message Forwarding* on the iPhone it also gets green-bubble SMS. The macOS VM on the Proxmox server is that Mac.
- **WhatsApp**: a *linked device* (the same mechanism WhatsApp Web uses). It works without the phone being online, and on first link the phone sends a history sync of recent chats.

So the app never talks to the phone directly. It talks to the Mac VM and to WhatsApp's servers.

## Architecture

```
iPhone ──iCloud / SMS forwarding──> macOS VM (Proxmox)
                                      Messages.app
                                      BlueBubbles Server  (REST + Socket.IO, LAN only)
                                              │
                                              ▼
WhatsApp servers <──linked device──> wa-connector (Go, whatsmeow)
                                              │
                                              ▼
                                   hub-api (Node/TypeScript)
                                   Postgres  +  attachment storage
                                              │  REST + WebSocket
                                              ▼
                                   web (React PWA) in any browser
```

Everything except the Mac piece runs as one Portainer stack on TrueNAS.

### Components

| Piece | Where | What it does |
|---|---|---|
| BlueBubbles Server | macOS VM | Existing open-source app. Reads `chat.db`, sends through Messages.app, pushes new-message events. Saves writing our own Mac agent. |
| `wa-connector` | Docker on TrueNAS | Small Go service around `whatsmeow` (the library the mautrix WhatsApp bridge uses, best maintained). Handles QR pairing, history sync, live messages, sending. Talks to hub-api over HTTP and a webhook/stream. |
| `hub-api` | Docker on TrueNAS | Node + Fastify + Drizzle. Normalizes both sources into one schema, stores everything in Postgres, serves the web app, pushes live updates over WebSocket, handles login. |
| `web` | Served by hub-api | React + Vite PWA. Conversation list, thread view, composer, search, attachments. "Install app" in Chrome/Edge so it opens like a desktop app. |
| Postgres | Docker on TrueNAS | Messages, conversations, contacts, full-text search. |
| Attachments | TrueNAS dataset | Photos, videos, voice notes copied out of both services. |

### Data model (first pass)

- `service`: imessage, sms, whatsapp
- `person`: a real contact, merged across services by normalized phone number (E.164) or email
- `handle`: one address on one service (+1555..., someone@icloud.com, WhatsApp JID), belongs to a person
- `conversation`: one chat on one service (1:1 or group), with a source id (BlueBubbles chat GUID, WhatsApp JID)
- `message`: conversation, sender handle, text, sent/delivered/read times, reply-to, edited/unsent flags, source id (for dedupe)
- `attachment`, `reaction`

"Continuous" means: the inbox is sorted by latest activity across all services, and a person's page can show their iMessage and WhatsApp threads merged into one timeline (with a small service badge per message). Replies go out on whichever service the last message came from, with a switch to pick the other.

Contacts come from the Mac's Contacts (iCloud synced, exposed by BlueBubbles) plus WhatsApp push names.

## Phases

### Phase 0: prepare the Mac VM (blocking, do first)
1. Confirm iMessage actually signs in on the VM. Apple blocks iMessage on VMs with generic hardware IDs; on Proxmox with OpenCore this needs a valid generated SMBIOS (serial, MLB, ROM matching the NIC MAC). If Messages already works there, skip this.
2. Note the macOS version. Sequoia (15) is the best tested with BlueBubbles; Tahoe (26) works but message editing is reported broken.
3. Turn on Messages in iCloud on both iPhone and Mac and let history download.
4. On the iPhone: Settings > Apps > Messages > Text Message Forwarding > enable the VM.
5. VM settings: auto-login, never sleep, start Messages and BlueBubbles at login.
6. Install BlueBubbles Server, grant Full Disk Access and Accessibility, set a strong server password, and turn off its built-in public proxy (ngrok/Cloudflare). It only needs to be reachable on the LAN.
7. Optional: enable the BlueBubbles Private API (needs SIP partly disabled) for typing indicators, tapbacks, replies, edit/unsend and read receipts. Plain sending works without it.
8. Add a small launchd job that pokes Messages.app every few minutes; Messages in a headless VM is known to go idle and stop emitting events.

### Phase 1: skeleton
- Monorepo: `apps/web`, `apps/hub-api`, `services/wa-connector`, `docker-compose.yml`.
- Postgres schema and migrations.
- Single-user login (password + session cookie, optional TOTP).
- CI: build images, push to GHCR, trigger the Portainer webhook on push to `main` (same pattern as the portfolio stack).

### Phase 2: iMessage read-only
- hub-api imports full history from BlueBubbles (paged), then subscribes to its socket for new messages, updates, and read receipts.
- Web: conversation list, thread view, images, contact names.

### Phase 3: WhatsApp read-only
- wa-connector pairing page (QR code shown in the web app's settings).
- Store history sync and live messages, download media.

### Phase 4: sending and the rest
- Send text and attachments on both services, reactions, replies, mark-as-read.
- Optimistic UI with delivery status.

### Phase 5: make it feel like one app
- Merged people and the unified per-person timeline.
- Full-text search across everything.
- Web push notifications for new messages.
- PWA install, keyboard shortcuts, dark mode.

## Security

This app holds every private message I have, so:

- Default to LAN / Tailscale only. If it goes on a public subdomain, it sits behind strong auth with TOTP, HTTPS only, and rate-limited login.
- BlueBubbles and wa-connector are never exposed outside the Docker network / LAN.
- Secrets live in Portainer stack env vars, never in the repo. The repo is private anyway.
- Postgres and attachment dataset are included in TrueNAS snapshots; any offsite backup is encrypted.

## Risks

- **Apple blocks iMessage on the VM.** Biggest unknown, which is why Phase 0 comes first. Fallback: a cheap used Mac mini running the same BlueBubbles setup; nothing else in the plan changes.
- **WhatsApp ToS.** Linked-device libraries are unofficial. Ban risk for normal personal use (no bulk or cold messaging) is low but not zero. The official Business API cannot read a personal account, so there is no sanctioned alternative.
- **WhatsApp history depth.** History sync only gives what the phone chooses to send (usually months, not years). Everything after linking is complete.
- **Protocol churn.** Both iMessage (via macOS updates) and WhatsApp change without notice. Keep connectors thin and isolated so a break only affects one source.

## Alternatives considered

- **BlueBubbles web client alone**: iMessage only, no WhatsApp.
- **Matrix (Synapse) + mautrix bridges + Element**: less custom code, but a heavy stack to run, and the result is a chat client rather than my own app. Still a useful reference for how the bridges handle edge cases.
- **Beeper**: hosted, does exactly this, but my messages pass through a third party.

## Open questions

1. Does iMessage already work in the macOS VM, and which macOS version is it?
2. LAN/Tailscale only, or a public subdomain like my other apps?
3. Is sending needed from day one, or is read-only fine for the first version?
