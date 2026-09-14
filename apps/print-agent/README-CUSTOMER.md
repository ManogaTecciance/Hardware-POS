# AxloPOS print agent — install on the counter PC

This small program lets AxloPOS print kitchen tickets and bills on the
printers in your restaurant. It runs on one Windows PC that is always on —
usually the counter PC with the bill printer plugged into it.

## Install (about 5 minutes)

1. Unzip this folder anywhere (for example on the Desktop).
2. In AxloPOS, as the owner: **Settings → Printing → Print agent → Pair a
   new agent**. Give it a name like *Counter PC* and press **Pair agent**.
   Copy the token it shows — it starts with `pat_` and is shown **once**.
3. Double-click **`install.cmd`**. Say **Yes** when Windows asks for permission.
   Paste the token when asked, and press Enter when it says *Done*.
4. When it says *Done*, open **Settings → Printing** in AxloPOS: the agent
   shows **Online**.

That is all. The agent starts by itself every time the PC boots, even before
anyone logs in.

## Then add your printers

**Settings → Printing → Add printer.** Choose the connection and pick the
printer from the list — the agent has already found them:

| Printer | Connection to choose |
|---|---|
| Kitchen receipt printer with a LAN cable or on Wi-Fi | **Network — receipt printer with an IP address** |
| Bill printer plugged into this PC by USB | **USB — plugged into the PC** |
| An office / inkjet printer on the Wi-Fi | **Wi-Fi / office printer — installed on the PC** |

Press **Test print** on each one. Paper should come out.

## If something does not print

- **Agent shows Offline** — is the PC on and connected to the internet?
  Open `C:\axlo-print-agent\agent.log` for the reason.
- **Kitchen printer not in the list** — its cable must go into the **router**,
  not into a PC. Hold FEED while switching it on: the page it prints shows its
  IP address.
- **USB printer prints from Windows but not from AxloPOS** — an Xprinter
  XP-365B must be in *receipt* mode: switch it off, set DIP switch **1** on the
  back to **OFF**, switch it on.
- **Bills print but nothing else** — in Settings → Printing, check *What
  prints by itself* and the default kitchen printer.

## Removing or moving the agent

- Remove: right-click `install.ps1` → Run with PowerShell, but first rename
  nothing — run it from a PowerShell window as `.\install.ps1 -Uninstall`.
- New PC: install there with a **new** pairing token, then in AxloPOS press
  **Revoke** on the old agent.
