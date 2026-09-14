# AxloPOS print agent â€” install on the counter PC

This small program lets AxloPOS print kitchen tickets and bills on the
printers in your restaurant. It runs on one Windows PC that is always on â€”
usually the counter PC with the bill printer plugged into it.

## Install (about 5 minutes)

1. Unzip this folder anywhere (for example on the Desktop).
2. In AxloPOS, as the owner: **Settings â†’ Printing â†’ Print agent â†’ Pair a
   new agent**. Give it a name like *Counter PC* and press **Pair agent**.
   Copy the token it shows â€” it starts with `pat_` and is shown **once**.
3. Double-click **`install.cmd`**. Say **Yes** when Windows asks for permission.
   It asks two things: the **API address** (shown in the app next to the
   token - press Enter to accept the default if it matches) and the **token**.
   Press Enter when it says *Done*. If it says *FAILED*, the reason is on
   screen - usually the API address.
4. When it says *Done*, open **Settings â†’ Printing** in AxloPOS: the agent
   shows **Online**.

That is all. The agent starts by itself every time the PC boots, even before
anyone logs in.

## Then add your printers

**Settings â†’ Printing â†’ Add printer.** Choose the connection and pick the
printer from the list â€” the agent has already found them:

| Printer | Connection to choose |
|---|---|
| Kitchen receipt printer with a LAN cable or on Wi-Fi | **Network â€” receipt printer with an IP address** |
| Bill printer plugged into this PC by USB | **USB â€” plugged into the PC** |
| An office / inkjet printer on the Wi-Fi | **Wi-Fi / office printer â€” installed on the PC** |

Press **Test print** on each one. Paper should come out.

## If something does not print

- **Agent shows Offline** â€” is the PC on and connected to the internet?
  Open `C:\axlo-print-agent\agent.log` for the reason.
- **Kitchen printer not in the list** â€” its cable must go into the **router**,
  not into a PC. Hold FEED while switching it on: the page it prints shows its
  IP address.
- **USB printer prints from Windows but not from AxloPOS** â€” an Xprinter
  XP-365B must be in *receipt* mode: switch it off, set DIP switch **1** on the
  back to **OFF**, switch it on.
- **Bills print but nothing else** â€” in Settings â†’ Printing, check *What
  prints by itself* and the default kitchen printer.

## Removing or moving the agent

- Remove: right-click `install.ps1` â†’ Run with PowerShell, but first rename
  nothing â€” run it from a PowerShell window as `.\install.ps1 -Uninstall`.
- New PC: install there with a **new** pairing token, then in AxloPOS press
  **Revoke** on the old agent.
