# Setup

Three pieces need setting up once: the macOS VM, the Portainer stack on TrueNAS, and linking WhatsApp.

## 1. macOS VM (Proxmox VM 100, `macos-sequoia`, 192.168.1.179)

Open it from the Proxmox web UI (VM 100 > Console). Sleep is already turned off.

1. Finish the Setup Assistant: create a local admin account and sign in with your Apple ID.
2. Open Messages and sign in. In Messages > Settings > iMessage, turn on **Enable Messages in iCloud** and leave the Mac running while history downloads.
3. On the iPhone: Settings > Apps > Messages > **Text Message Forwarding**, turn on this Mac (this brings in green-bubble SMS).
4. System Settings > Users & Groups: turn on automatic login for your account, so Messages and BlueBubbles come back after a reboot.
5. System Settings > General > Sharing: turn on **Remote Login** (lets Claude manage the VM over SSH).
6. Install **BlueBubbles Server** from https://bluebubbles.app/install and open it:
   - Grant the permissions it asks for (Full Disk Access, Accessibility, Contacts).
   - Set a server password (this becomes `BLUEBUBBLES_PASSWORD`).
   - Keep the port at 1234. Set the proxy service to **None / LAN only**; the hub reaches it on the home network.
   - Turn on **Launch on startup**.
7. Optional, for typing indicators, tapbacks, replies and read receipts: enable the BlueBubbles **Private API**. System Integrity Protection on this VM is already partly disabled, which the Private API needs.

Check it works: from another machine on the LAN, `http://192.168.1.179:1234/api/v1/ping?password=<password>` should return `pong`.

## 2. Portainer stack on TrueNAS

Either run `ssh -t truenas python3 ~/portainer-create-stack.py` (copy of `deploy/portainer-create-stack.py`; it asks for a Portainer access token and the two passwords, generates the rest, and prints the webhook URL), or do it by hand:

1. Portainer > Stacks > Add stack > **Repository**.
   - Repository URL: `https://github.com/harri665/message-hub`, reference `refs/heads/main`, compose path `docker-compose.yml`.
   - The repo is public, so leave authentication off.
2. Environment variables (see `.env.example`):
   - `DB_PASSWORD`, `INTERNAL_SECRET`: long random strings.
   - `APP_PASSWORD`: the password you'll sign in with.
   - `BLUEBUBBLES_URL=http://192.168.1.179:1234`, `BLUEBUBBLES_PASSWORD`: from step 1.
   - `HUB_PORT=8095` (free on TrueNAS).
3. Turn on the stack **webhook** and copy its URL. Add it to the GitHub repo as the secret `PORTAINER_WEBHOOK_URL` so every push to `main` redeploys.
4. Deploy. The app is then at `http://truenas:8095` (or the Tailscale address of TrueNAS, port 8095).
5. Optional: put it behind Nginx Proxy Manager on a subdomain with HTTPS, then set `SECURE_COOKIES=true`.

## 3. Link WhatsApp

Sign in to the web app, open **Settings**, and scan the code with WhatsApp on the phone (Settings > Linked devices > Link a device). Recent history arrives over the next few minutes.

## 4. Install it like an app

In Chrome or Edge, open the site and use **Install app** in the address bar. It opens in its own window like your other web apps.

## Local development

```sh
cp .env.example .env            # fill in values; DATABASE_URL must point at a Postgres
cd apps/hub && npm i && npm run dev
cd apps/web && npm i && npm run dev   # http://localhost:5173, proxies /api to the hub
cd services/wa-connector && go run .   # needs DATABASE_URL, INTERNAL_SECRET
```

Or run the whole stack: `docker compose --env-file .env up --build`.
