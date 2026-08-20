# Handover — testing waiter dine-in + auto-printing on the machine with the printer

**For:** the agent/operator on the machine that has the POS stack **and a real
printer** on its network.
**From:** the implementation session, 2026-08-20 (branch
`feature/restaurant-pos-reshin`).
**Ships:** D67 — waiter-driven dine-in, kitchen tickets printing the instant
items are sent, bills printing on the cashier printer, workspace printers with
network discovery, per-user printer defaults, and the on-site print agent for
the hosted deployment.

Everything below was verified **here** against a TCP listener standing in for a
printer (real sockets, real ESC/POS bytes, captured to disk). What could not be
verified here is **actual hardware**: cutting, paper width, character set,
paper-out behaviour. That is what this document asks you to establish.

---

## 0. TL;DR

1. Pull the branch, migrate, start the stack — §3.
2. Add printers in **Settings → Printing**, hit **Test print** — §4.
3. Run scenarios **S1–S7** — §6.
4. Fill in the report in §10 and send it back. Attach a byte capture (§8) for
   anything that prints wrong.

---

## 1. Every requirement you raised, and how it was implemented

This section exists because the requirements arrived over several messages.
Each row is a thing you asked for, what was built, and where to verify it.

| # | What you asked for | What was built | Verify in |
|---|---|---|---|
| 1 | *Dine-in is NOT a counter flow — the waiter takes the order at the table* | `/pos → Dine In` now always opens the **table picker → order entry**, never the counter cart. The order-type card's wording changed to match. | S1 |
| 2 | *Each item confirmed onto the order is pushed to the kitchen and the ticket prints automatically* | Sending a round commits the items and **kicks the printer immediately** (~1 s), no tap on the KDS. | S1, S2 |
| 3 | *The waiter can close/complete the order and the finalised bill prints on the cashier printer* | **Close & bill** settles the order into a Sale and queues the bill in the same transaction; it prints right after commit. | S3 |
| 4 | *The owner adds printers to the workspace in settings; users then select their defaults from that list* | **Settings → Printing**: owner-only "Workspace printers" (add/scan/role/test) + "Branch defaults"; **"My printers"** visible to every user (waiter included). | S4 |
| 5 | *Printers must be discovered on the network, not typed blindly* | **Scan network** button. On an on-prem API the server scans its own LAN; on the hosted API the **agent** scans the shop LAN and reports what it sees. Manual entry by IP remains for devices that ignore probes. | S4 |
| 6 | *The waiter's tablet is on the same network as the printer but not attached to it* | Nothing prints from the tablet. The tablet only calls the API; whichever process can see the LAN (API or agent) does the printing. Any number of tablets work with zero per-tablet setup. | S1–S3 |
| 7 | *The app is deployed on Amplify — printing must reach the CLIENT's network, not the frontend server's* | The **on-site print agent** (`apps/print-agent`): a small daemon in the shop that dials OUT over HTTPS, leases work, prints on the LAN, and reports back. Transport switches automatically when an agent is live. | §7, S6 |
| 8 | *Can't the browser just print to the printers it can see?* | **No — and §2 explains exactly why**, with the one thing browsers *can* do and why it does not cover two printers. | §2 |
| 9 | *Takeaway is taken by the cashier — the bill AND the kitchen ticket must print immediately when the order is placed* | Placing a takeaway queues **both**. The bill is priced from the order (no Sale exists yet) with the **same calculator** the close uses, and the later handover deliberately does **not** print a second bill. | S5 |

---

## 2. "Can't the browser just print to the printers it sees?" — the honest answer

Short answer: **no, not to two different printers, and not silently.** This is
a browser sandbox limit, not a design preference. Worth reading before you test,
because it explains why the agent exists.

**What a web page fundamentally cannot do**

- **Open a raw TCP socket.** Thermal printers speak raw ESC/POS on port 9100.
  JavaScript in a page has `fetch`/XHR (HTTP only), WebSocket (HTTP upgrade
  only) and WebRTC (peer/UDP). There is no API that opens `tcp://192.168.1.50:9100`
  and writes bytes. Not "blocked" — absent.
- **Talk HTTP to the printer instead.** Three separate walls:
  1. **Mixed content** — the app is served over HTTPS (Amplify). A page on
     HTTPS may not make requests to `http://192.168.x.x`. A private IP cannot
     have a publicly-trusted TLS certificate, so there is no way around it.
  2. **CORS** — the printer sends no `Access-Control-Allow-Origin`, so the
     request fails.
  3. **Private Network Access** — Chrome specifically restricts public pages
     from reaching private-IP devices; this scenario is the exact thing that
     rule was written to stop.
- **WebUSB / Web Bluetooth** work only for a printer physically attached to
  *that* device — which is the case you told me does not apply (the tablet is
  on the network, not wired to the printer).

**What a browser *can* do:** `window.print()` — print the rendered page through
the OS to a printer **installed on that device**. With Chrome in kiosk-printing
mode this happens without a dialog. Its limits, which are why it cannot satisfy
your requirement:

- **One OS default printer per device.** A page cannot choose a printer. So a
  single tablet cannot send a KOT to the kitchen printer *and* a bill to the
  cashier printer — the whole point of the feature.
- Every tablet needs the printer installed at the OS level (drivers, queues).
  On Android/iPad tablets, raw thermal printers usually cannot be installed at
  all.
- It prints HTML through a driver, not ESC/POS: slower, no reliable cut, no
  drawer kick, layout at the mercy of the driver.

**Therefore:** one small agent **per shop** (not per tablet) on any always-on
machine — the cashier PC, a mini PC, a Raspberry Pi. Every tablet keeps using
the browser exactly as now, with nothing installed. And if you ever run the API
inside the shop, you don't even need the agent — the API prints directly, which
is the setup you're testing first.

---

## 3. Get the branch running

```bash
git fetch origin && git checkout feature/restaurant-pos-reshin && git pull
pnpm install

pnpm --filter @hardware-pos/database db:deploy      # 6 new migrations
pnpm --filter @hardware-pos/database db:generate
pnpm --filter @hardware-pos/database db:seed        # optional, clean data

pnpm --filter @hardware-pos/api dev                 # terminal 1
pnpm --filter @hardware-pos/web dev                 # terminal 2
```

Checks before touching printers:

```bash
curl -s localhost:4000/v1/health            # → ok
```

The API log must contain **`Print worker started (interval 5000ms)`**. If it
says *disabled*, remove `PRINT_WORKER_ENABLED=false` from `apps/api/.env`.

Log in as the **restaurant owner** (`restaurant.owner@axlopos.test` /
`Restaurant123!` on seeded data). Only an owner can add printers; a waiter can
still choose their own defaults from the list.

---

## 4. Configure printers — Settings → Printing

Four blocks on the page:

1. **My printers** — *every* user. Pick your default kitchen and cashier
   printer, or leave "Use branch default".
2. **Workspace printers** — owner only. **Scan network**, then *Add as
   kitchen* / *Add as cashier*; or add manually (`192.168.1.50:9100`). Each row
   has **Test print** and a role selector.
3. **Branch defaults** — owner. Default kitchen/cashier printer, the two
   auto-print switches, bill copies.
4. **On-site print agent** — owner. Pair / status / revoke (used in §7).

**Routing precedence** — worth knowing when a printout lands somewhere odd:

- **Kitchen ticket:** your own default → the station's linked printers → the
  branch default kitchen printer → (nothing: ticket stays queued on the KDS).
- **Bill:** your own default → the branch default cashier printer → (nothing:
  the browser print path still works as before).

---

## 5. If tickets do not appear at all: station routing

Kitchen tickets route by **station**. If a product has no station link and the
branch has exactly one active station, we route there automatically. Otherwise
the item is left unrouted and the API log names it:

```
Round <id>: N item(s) reached no kitchen station and will not print — link them to a station …
```

Simplest fix while testing: set **Branch defaults → Default kitchen printer**.

---

## 6. Scenarios to run

### S1 — Dine-in: ticket prints when items are sent ✅ requirement 1, 2, 6

1. `/pos` → **Dine In** → pick a free table → order entry opens.
2. Add 2–3 items (ideally one with a variant, one with a modifier) and a
   special instruction such as `no onions`.
3. Tap **Send to kitchen**.

**Expect:** the kitchen printer prints in ~1–2 s: station name in double
height, KOT + order numbers, table, `2x Item` lines with `[VARIANT]`,
`+ Modifier`, `! no onions`, then a cut. The waiter's screen shows the round as
sent, with no wait on the printer.

### S2 — Second round on the same table

Add another item → Send.
**Expect:** a second ticket marked `Round 2`, containing **only** the new items.

### S3 — Dine-in: bill prints when the waiter closes ✅ requirement 3

Tap **Close & bill**, confirm.
**Expect:** the cashier printer prints the settled bill — shop name, sale
number, table, each line, subtotal, service charge/tax if configured, `TOTAL`
in double height. Compare every number with the on-screen bill (§10 Q3).

### S4 — Owner adds printers; a waiter picks their own ✅ requirements 4, 5

1. As owner: **Scan network** → add your printer(s) → **Test print** each.
2. Sign in as the **waiter** (`waiter@axlopos.test`, password as seeded) →
   Settings → **Printing**. The waiter must see **My printers** (and must NOT
   see the owner blocks).
3. Set the waiter's kitchen printer explicitly, place a dine-in order as the
   waiter, and confirm it prints on **that** printer.

### S5 — Takeaway: both print at placement ✅ requirement 9

Take a takeaway order at the counter (`/pos` → **Takeaway** → items → customer →
pay).
**Expect:** the kitchen ticket **and** the bill print immediately at placement.
The bill is priced by the same engine as a settled bill and shows `BALANCE DUE`
if payment has not been recorded yet (payment lands a moment later in that
flow — tell us in §10 Q5 whether you want that line suppressed or the print
deferred by a second to include the payment).
**Also expect:** completing/handing over the order does **not** print a second
bill.

### S6 — The agent path (what production will use) ✅ requirement 7

Follow §7, then re-run S1 and S3.

### S7 — A dead printer must never break an order ✅ safety invariant

1. Power the kitchen printer off (or unplug it).
2. Place a dine-in order and Send.

**Expect:** the order commits normally and appears on the KDS; the waiter sees
no error and no delay; after ~15 s the ticket shows **FAILED** in Settings →
Printing and on the kitchen board; powering the printer back on and pressing
**Reprint** prints it.

---

## 7. Installing the on-site agent

```bash
# 1. In the app (owner): Settings → Printing → On-site print agent →
#    name it → Pair agent → copy the token (shown once).

pnpm --filter @hardware-pos/print-agent build
cd apps/print-agent
cat > agent.json <<JSON
{ "apiUrl": "http://localhost:4000", "token": "pat_…paste…", "name": "Shop PC" }
JSON
node dist/index.js
```

For the hosted API use `"apiUrl": "https://api.axlopos.com"`. Check one printer
without placing an order:

```bash
node dist/index.js --test 192.168.1.50:9100     # exit 0 = it answered
```

**Expect:** the agent logs `discovery: N device(s) answering on :9100`, the
settings page shows it **online** within seconds, and the server stops printing
directly for that branch (automatic — no setting).

Then re-run S1/S3 and watch the agent log `printed KOT-… on Kitchen printer`.

**Also test:** kill the agent (Ctrl-C) mid-service, place an order, restart it.
Queued work must print when it returns. A duplicate of a ticket that was
mid-print when you killed it is expected and acceptable (we chose
at-least-once: a duplicate is recoverable, a missing kitchen ticket is not) —
but please report if you see one.

---

## 8. Capturing the raw bytes (when paper looks wrong)

```bash
python3 - <<'PY'
import socket
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('0.0.0.0', 9100)); srv.listen(4)
print('capturing → /tmp/printer-capture.bin')
with open('/tmp/printer-capture.bin','wb') as f:
    while True:
        c,_ = srv.accept()
        while True:
            b = c.recv(65536)
            if not b: break
            f.write(b); f.flush()
        c.close(); print('captured one document')
PY
```

Point the printer row at that listener, repeat the scenario, send us the file
(or `xxd /tmp/printer-capture.bin | head -60`). Especially useful for 58 mm
paper, missing cuts, and character-set problems.

---

## 9. What I could not verify from here — the honest list

1. **Real hardware.** All verification used a socket listener. Cut, density,
   paper-out and code page are unproven on a device.
2. **58 mm paper.** The renderer supports 32 columns; the default is 48 (80 mm).
   If yours is 58 mm, say so — the column setting exists on the printer record
   but has no control in the settings UI yet.
3. **USB printers.** The driver writes raw bytes to a device path
   (`/dev/usb/lp0`, a Windows share). Untested — tell us your OS and we will
   confirm the address format.
4. **Non-Latin item names.** Sinhala/Tamil print as `?`. Fixing it needs
   raster-mode rendering (`docs/auto-printing-plan.md` §8.5) — a known gap.
5. **A4 network printers** are refused with a clear message; auto-printing is
   thermal/ESC-POS only.
6. **Cash-drawer kick** is implemented in the encoder but not wired to a
   setting yet — tell us if you need it.
7. **One pre-existing, unrelated test failure** in this environment:
   `auth-hardening.spec.ts → "the QuickBooks OAuth callback stays reachable"`
   fails with `fetch failed`, and fails **identically with all of this work
   stashed** (it needs outbound internet). Not printing-related.

---

## 10. Report template — fill in and send back

```markdown
## Environment
- Printer make/model(s):
- Connection: network (IP:port) / USB / other:
- Paper width: 80 mm / 58 mm
- Where the API ran: same machine as printer / another machine on the LAN / hosted
- Tablet(s) used for the waiter flow:

## Q1 — Discovery & setup (S4)
- Did "Scan network" list the printer?              YES / NO
- If NO, did manual entry by IP work?               YES / NO
- Test print result (paste the message if it failed):
- Could the WAITER see "My printers" and set their own? YES / NO
- Did the waiter's own printer choice take effect?  YES / NO

## Q2 — S1/S2 kitchen tickets on Send
- Printed?                                          YES / NO
- Time from tapping Send to paper:                  ___ seconds
- Cut worked?                                       YES / NO
- Variant / modifier / special instruction correct? YES / NO
- Round 2 ticket contained ONLY the new items?      YES / NO
- Anything wrong (describe / attach photo):

## Q3 — S3 bill on Close
- Printed?                                          YES / NO
- Do ALL numbers match the screen (subtotal / service / tax / total / paid / balance)? YES / NO
- Shop name, address, currency correct?             YES / NO
- Anything wrong:

## Q4 — S7 printer switched off
- Order still committed?                            YES / NO
- Waiter saw an error or a delay?                   YES / NO — describe
- Ticket showed as FAILED in Settings → Printing?   YES / NO
- Reprint worked after power-on?                    YES / NO

## Q5 — S5 takeaway (both at placement)
- Did the kitchen ticket print at placement?        YES / NO
- Did the bill print at placement?                  YES / NO
- Did handover print a SECOND bill? (should be NO)  YES / NO
- The placement bill shows "BALANCE DUE" because payment lands a moment later.
  Preference: (a) keep as-is  (b) hide the balance line  (c) delay the bill ~2s so it shows as paid
- Anything wrong:

## Q6 — S6 agent
- Paired and showed "online"?                       YES / NO
- S1 and S3 printed through the agent?              YES / NO
- Agent console output for one print (2–3 lines):
- Agent discovery found the printer?                YES / NO
- Kill/restart: anything lost? any duplicate?       describe

## Q7 — Anything else
- API log lines containing "print" / "Print" / "reached no kitchen station":
- Anything slow, confusing or wrong in the waiter flow:
```

---

## 11. Triage table

| Symptom | Likely cause | Check |
|---|---|---|
| Nothing prints, no error | No printer resolved | Settings → Printing: branch default set, or your own? |
| Ticket never prints, bill does | Items route to no station | API log `reached no kitchen station`; set a branch default kitchen printer |
| Test print fails instantly | Wrong IP/port, or device not on 9100 | `nc -vz <ip> 9100` |
| Prints twice | Two printers on one station, or an agent AND the server both printing | station links; agent status ("online"?) |
| Everything queues, nothing prints | Worker off, or an offline agent owns the branch | log for `Print worker started`; agent last-seen |
| Waiter cannot see Printing in the sidebar | Their role lacks `platform:profile:read`, or the KITCHEN module is off for the tenant | Platform console → modules |

Inspect the queue directly:

```bash
curl -s "localhost:4000/v1/printing/queue?branchId=<branchId>" \
  -H "authorization: Bearer <token>" -H "x-tenant-id: <tenantId>"

curl -s -X POST localhost:4000/v1/printing/drain \
  -H "authorization: Bearer <token>" -H "x-tenant-id: <tenantId>"   # print now
```

---

## 12. What was verified here (so you know the baseline)

- **Live, against a TCP listener on 9100:** owner adds a kitchen + cashier
  printer → **Test print OK** → branch defaults saved → waiter opens a table →
  sends 2× Beef Steak → **KOT printed** (`GRILL`, `KOT-000008`, `RO-000007`,
  table `PRN-1 · Main Hall`, `2x Beef Steak`) → closes the order → **bill
  printed** (`S-000004`, `LKR 6400.00`).
- **Automated:** 801 API unit tests, 732 integration tests (10 new
  auto-printing cases: queueing, printing, per-user override, auto-print
  switches, retries + FAILED state, agent-owns-branch, stale-agent fallback,
  takeaway prints both at placement, no duplicate bill at handover), 364 web
  tests, lint and typecheck clean across all 8 workspaces.
