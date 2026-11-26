#!/usr/bin/env python3
"""Create the message-hub stack in Portainer as a git-backed stack with a redeploy webhook.

Run it on the TrueNAS host, interactively:   python3 portainer-create-stack.py
Secrets are typed at hidden prompts and only sent to the local Portainer API; nothing is
written to disk. Internal secrets (database password, hub<->connector secret) are generated.
"""
import getpass
import json
import secrets
import ssl
import sys
import urllib.error
import urllib.request
import uuid

PORTAINER = "https://localhost:31015"
PUBLIC_PORTAINER = "https://portainer.harrison-martin.com"
STACK_NAME = "message-hub"
REPO = "https://github.com/harri665/message-hub"
BLUEBUBBLES_URL = "http://192.168.1.179:1234"
HUB_PORT = "8095"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE  # Portainer on localhost uses a self-signed certificate


def api(method, path, token, body=None):
    req = urllib.request.Request(
        PORTAINER + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-API-Key": token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=900) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        sys.exit(f"Portainer API {method} {path} failed: HTTP {e.code} {detail}")


def ask_secret(prompt, confirm=False):
    while True:
        v = getpass.getpass(prompt)
        if not v:
            print("  (required)")
            continue
        if confirm and getpass.getpass("  again: ") != v:
            print("  (did not match, try again)")
            continue
        return v


print("Message Hub: create Portainer stack\n")
print("You'll need:")
print("  1. A Portainer access token (Portainer > My account > Access tokens > Add access token)")
print("  2. The password you want for signing in to the web app")
print("  3. The BlueBubbles server password you set on the Mac\n")

token = ask_secret("Portainer access token: ")
me = api("GET", "/api/users/me", token)
print(f"  ok, signed in to Portainer as {me.get('Username')}")

existing = [s for s in api("GET", "/api/stacks", token) if s.get("Name") == STACK_NAME]
if existing:
    sys.exit(f"A stack named {STACK_NAME} already exists (id {existing[0]['Id']}). Nothing changed.")

endpoints = [e for e in api("GET", "/api/endpoints", token) if e.get("Type") in (1, 2)]
if not endpoints:
    sys.exit("No Docker environment found in Portainer.")
endpoint = endpoints[0]
if len(endpoints) > 1:
    print("Docker environments:")
    for i, e in enumerate(endpoints):
        print(f"  {i + 1}. {e['Name']} (id {e['Id']})")
    endpoint = endpoints[int(input("Use which one? [1] ") or "1") - 1]
print(f"  using environment {endpoint['Name']} (id {endpoint['Id']})")

app_password = ask_secret("Web app password (new): ", confirm=True)
bb_password = ask_secret("BlueBubbles server password: ")

webhook = str(uuid.uuid4())
env = {
    "DB_PASSWORD": secrets.token_hex(24),
    "INTERNAL_SECRET": secrets.token_hex(32),
    "APP_PASSWORD": app_password,
    "BLUEBUBBLES_URL": BLUEBUBBLES_URL,
    "BLUEBUBBLES_PASSWORD": bb_password,
    "HUB_PORT": HUB_PORT,
    "SECURE_COOKIES": "false",
    "DEFAULT_COUNTRY_CODE": "1",
    "WA_DEVICE_NAME": "Message Hub",
}

print("\nCreating the stack. Portainer clones the repo and builds the images; this takes a few minutes...")
stack = api(
    "POST",
    f"/api/stacks/create/standalone/repository?endpointId={endpoint['Id']}",
    token,
    {
        "name": STACK_NAME,
        "repositoryURL": REPO,
        "repositoryReferenceName": "refs/heads/main",
        "composeFile": "docker-compose.yml",
        "repositoryAuthentication": False,  # the repo is public
        "env": [{"name": k, "value": v} for k, v in env.items()],
        "autoUpdate": {"webhook": webhook, "forceUpdate": False, "forcePullImage": False},
        "tlsskipVerify": False,
    },
)

print(f"\nDone. Stack '{STACK_NAME}' created (id {stack.get('Id')}).")
print(f"Web app:  http://truenas:{HUB_PORT}  (or the TrueNAS Tailscale address, port {HUB_PORT})")
print("\nRedeploy webhook (keep private; add it to GitHub as the PORTAINER_WEBHOOK_URL secret):")
print(f"  {PUBLIC_PORTAINER}/api/stacks/webhooks/{webhook}")
