# AxloPOS print agent

Prints AxloPOS kitchen tickets and bills on printers that live on the
**shop's own network**.

## Why it is needed

The app is served from Amplify and the API from EC2. Neither can open a
connection to a printer at `192.168.x.x` inside a restaurant, and a browser
cannot speak raw ESC/POS at all. This agent runs on any always-on machine in
the shop, connects **outward** to the API (no port forwarding, no static IP,
no inbound firewall rules), claims work, prints it on the LAN, and reports
what happened.

If you run the API itself inside the shop (a single-machine install), you do
not need this agent: the API prints directly, and everything else works the
same way.

## Install

1. In the app: **Settings → Printing → Agents → Pair agent**. Copy the token
   (it is shown once).
2. On the shop machine (Node 20+):

```bash
npm install --omit=dev        # or copy the built dist/ folder
cat > agent.json <<JSON
{
  "apiUrl": "https://api.axlopos.com",
  "token": "pat_…paste…",
  "name": "Front counter PC"
}
JSON
node dist/index.js
```

3. Confirm: the agent logs `discovery: N device(s)…` and the app shows it
   **online** in Settings → Printing.

Environment variables override the file: `AGENT_API_URL`, `AGENT_TOKEN`,
`AGENT_NAME`, `AGENT_POLL_SECONDS`, `AGENT_DISCOVERY_SECONDS`,
`AGENT_PRINTER_PORT`.

## Check one printer without placing an order

```bash
node dist/index.js --test 192.168.1.50:9100
```

Exit code 0 = the device answered.

## Run as a service

**Linux (systemd)** — `/etc/systemd/system/axlo-print-agent.service`:

```ini
[Unit]
Description=AxloPOS print agent
After=network-online.target

[Service]
WorkingDirectory=/opt/axlo-print-agent
ExecStart=/usr/bin/node /opt/axlo-print-agent/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Windows** — install with [NSSM](https://nssm.cc):
`nssm install AxloPrintAgent "C:\Program Files\nodejs\node.exe" "C:\axlo-print-agent\dist\index.js"`.

## What it does and does not do

- It never renders documents: the server sends ready ESC/POS bytes, so
  changing a receipt layout needs no agent update.
- It holds no state worth backing up. Everything queued lives in the API.
- A document it printed but could not acknowledge (power cut mid-print) is
  re-sent by the server after the lease expires: at least once, because a
  duplicate ticket is recoverable and a missing one is not.
