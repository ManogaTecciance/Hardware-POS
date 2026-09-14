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

Exit code 0 = the device answered. For the full path (server → queue → this
agent → paper) use **Test print** on the printer in Settings → Printing: with
this agent online the page is queued for it, and the screen shows the outcome.

## The cashier's USB printer on Windows

A USB thermal printer on Windows belongs to the spooler; there is no device
path to write to. Add it as kind **ESC_POS_USB** with the printer's **Windows
name** as the address (exactly as it appears in *Printers & scanners*, e.g.
`POS-80`). The agent hands the spooler a RAW document through `winspool.drv`
(`scripts/windows-raw-printer.ps1`, run with `-ExecutionPolicy Bypass` so no
machine policy needs changing), which passes ESC/POS through untouched. The
vendor driver or *Generic / Text Only* both accept RAW.

On Linux the address is the device path (`/dev/usb/lp0`) and the bytes are
written to it directly.

Network printers (kind **ESC_POS_NETWORK**, address `host:port`, port
defaults to 9100) work the same on every platform — and are the better choice
for the kitchen: a cable to a static-IP printer is the most reliable thing in
this whole chain.

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

**Windows** — install as a SERVICE with [NSSM](https://nssm.cc), not as a
startup shortcut: a startup task dies when the cashier signs out, a service
does not.
`nssm install AxloPrintAgent "C:\Program Files\nodejs\node.exe" "C:\axlo-print-agent\dist\index.js"`,
then `nssm set AxloPrintAgent AppDirectory C:\axlo-print-agent` so `agent.json`
is found. Set the machine's power plan so it never sleeps — a sleeping
cashier PC is a silent kitchen printer.

## What it does and does not do

- It never renders documents: the server sends ready ESC/POS bytes, so
  changing a receipt layout needs no agent update.
- It holds no state worth backing up. Everything queued lives in the API.
- A document it printed but could not acknowledge (power cut mid-print) is
  re-sent by the server after the lease expires: at least once, because a
  duplicate ticket is recoverable and a missing one is not.
