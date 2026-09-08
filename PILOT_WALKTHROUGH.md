# Restaurant POS — Product Owner Pilot Walkthrough

Prepared for the Restaurant Validation & Pilot Readiness checkpoint on
**feature/restaurant-pos** (HEAD `f471d81`). All operational transactions in the
walkthrough are performed manually by the Product Owner — no fake orders have
been pre-created.

## Environment

Local stack (both must be running before the walkthrough):

- **API**: `http://localhost:4000/v1` (started via `pnpm --filter @hardware-pos/api start:dev`)
- **Web**: `http://localhost:3000` (started via `pnpm --filter @hardware-pos/web dev`)

## Login

| Field | Value |
|---|---|
| URL | http://localhost:3000/login |
| Workspace | `restaurant-demo` |
| Email | `restaurant.owner@axlopos.test` |
| Password | `Restaurant123!` |

Development credentials only — never place in production configuration.

Retail (Tile Shop) regression profile for comparison:

| Field | Value |
|---|---|
| Workspace | leave blank |
| Email | `owner@hardwarepos.test` |
| Password | `password123` |

## Pre-seeded setup data

Only the shape of the restaurant is seeded. All service transactions are created
manually.

| Object | Contents |
|---|---|
| Dining areas | Main Floor, Terrace |
| Tables | T1–T4 (Main Floor, 4 seats each), O1–O2 (Terrace, 2 seats each) |
| Kitchen station | Main Kitchen (KITCHEN category) |
| Printer | Main Kitchen Printer (MOCK — safe for pilot, no physical output) |
| Modifier groups | Size (Regular / Large +LKR 150), Extras (Cheese +200, Bacon +250, Mushrooms +150) |
| Menu | "All Day Menu" — Starters, Mains, Desserts |
| Items | Devilled cashews, Cheese toast, Chicken kottu, Vegetable fried rice, Beef curry with rice, Watalappan, Ice cream |

---

## Manual walkthrough — six personas

### 1. Restaurant Owner
Sign in with the owner credentials above, then visit each destination and
confirm it renders live data rather than a placeholder.

- **/dashboard** — restaurant service board with 4 tiles + 3 panels. Tiles show real numbers (may be 0 until you start a session).
- **/menu** — three-column browser (menu → section → item). Confirm all 3 sections and 7 items appear.
- **/tables** — floor plan with 2 areas and 6 tables, all AVAILABLE. Try creating a new area / new table to exercise write paths.
- **/settings/users** — user list; confirm the seeded owner is present.
- **/reports** — six report cards for Today. Cards should read "No sessions closed", etc. until service starts. Try the "Last 7 days" preset.
- **/settings** — branch and profile configuration.

### 2. Waiter (open + build + send)
Still signed in as owner (or use a Waiter role if you've created one).

1. **/tables** → click **Open table** on T1 → dialog asks guest count → enter `2` → confirm. Card should flip to "In service" with a live timer.
2. Card now shows **View order** — click it. Land on `/tables/session/[id]`.
3. Left column: tap **Chicken kottu**. A modifier picker appears (Size + Extras). Pick "Large" and "Extra cheese". Add to round. The line appears in the right-hand draft with the modifiers listed.
4. Add **Vegetable fried rice** (single modifier — Regular) and **Devilled cashews** (no modifiers).
5. Adjust quantities with the +/− buttons. Type a note into the "Special instructions" field of the kottu line ("no chilli").
6. Click **Send to kitchen**. The draft empties; **Previous rounds** now shows Round #1 with status "Sent".
7. Click **Back to floor** and open **T2**. Repeat steps 3–6 with 1–2 different items. Round #1 for T2 sent.
8. Return to T1 (**/tables** → View order). Confirm Round #1 is still visible, immutable, and shows the same items you sent.
9. Add another item to T1 and click **Send to kitchen** again — this becomes Round #2. Round #1 stays untouched.

### 3. Kitchen
- **/kitchen** — three tickets should appear (T1 R1, T2 R1, T1 R2) with modifiers and notes intact.
- Filter tabs at the top (All / Queued / Printed / Reprinted / Failed) — the count badges reflect the current split.
- Click **Reprint** on one ticket — status flips to "Reprinted"; a new print attempt appears in the ticket's history.
- Click **Mark printed** on another → dialog asks which printer → select "Main Kitchen Printer" → confirm.
- Click **Mark failed** on a third → dialog asks for a reason ("Paper jam") → confirm. The card shows the failure with an alert triangle.

### 4. Cashier (billing)
1. Return to **T1** order screen.
2. Click **Close & bill** in the session header. Confirmation dialog warns that no more rounds can be sent. Confirm.
3. Redirected to `/bills/[saleId]`. Bill summary shows subtotal + service charge (if configured) + total. Balance = total.
4. Click **Edit splits**. Add 2 rows, click **Even split**, save. Splits saved on the server; you'll see them listed with paid=0.
5. **Collect for split** on the first split → dialog: enter the split amount, method **Cash**, click **Record payment**. Payment appears in the Payments card on the right.
6. **Collect for split** on the second split → method **Card**, reference `AUTH123`. Bill status flips to **PAID**.
7. Try clicking **Collect for split** again on a paid split — the button is disabled (remaining is 0).
8. Test **Reopen bill** with a reason ("wrong tender") — bill balance re-appears; you can now correct the split or payment.

### 5. Takeaway
1. **/takeaway** — empty board.
2. Click **New takeaway**. Menu picker on the left, customer form on the right.
3. Fill Name = "Amara", Phone = `077 123 4567`, Pickup = ~30 min from now.
4. Add a Cheese toast, a Beef curry with rice, and a Watalappan to the order.
5. Click **Place order** — redirected to /takeaway. Row appears with status **Placed**.
6. Click **Advance to In kitchen**. Row updates. Repeat: In kitchen → Ready → Handed over. On Handed over the row moves to the "Closed" section.
7. Try **Cancel** on a fresh takeaway to exercise the alternate path.

### 6. Manager (permissions + boundaries)
- Voiding a sent item requires `ORDER_VOID_SENT`. Open T1's order, click **Void** next to an item on a sent round, provide a reason — the item shows as struck-through with "Voided" status. The item's contribution comes out of the running total.
- Multiple active tables: keep T1, T2 and a fresh T3 all open simultaneously. Bounce between them; each session keeps its own draft.
- Branch isolation: the seeded restaurant tenant sees only its own tables and menu. Attempting to reach `/quickbooks` (retail-only) shows "Not part of this workspace" (WS-501 covers this via Playwright — WS-701..704 verify tenant isolation on the server too).
- Concurrent updates: see the Concurrency Pilot section below.

---

## Concurrency pilot (two browser sessions)

Use two browser profiles or one normal + one private window, both signed in as
the restaurant owner.

### Case C1 — read simultaneously
- **Session A**: Open T1 (guest count 2). Do not send a round.
- **Session B**: Open the tables floor. T1 shows "In service" with the timer. Click **View order**.
- Both sessions see the same session with the same session number. **Expected**: no lost update — the second visitor sees whatever the first has drafted after a refresh (the draft is local to Session A; Session B sees an empty rounds list).

### Case C2 — concurrent round sends
- **Session A**: Build a round of 2 items but do not send.
- **Session B**: Build a different round of 3 items and click **Send to kitchen**.
- **Session A**: Click **Send to kitchen**.
- **Expected**: both rounds land. Two Round records exist. Neither is lost, neither is duplicated. Session A's round is Round #2. Both appear on `/kitchen`.

### Case C3 — double-tap Send
- **Session A**: Build a round. Rapidly click **Send to kitchen** twice.
- **Expected**: only one round is created (guarded by the `idempotencyKey` that resets only after success). The button is disabled while in-flight.

### Case C4 — double-tap payment
- **Session A**: Close & bill T1. Try to click **Collect payment** twice in quick succession.
- **Expected**: only one payment is recorded. The dialog closes on success and the balance updates once.

### Case C5 — close from two sessions
- **Session A** and **Session B**: both viewing the same open session.
- **Session A**: Close & bill.
- **Session B**: Tries to Close & bill.
- **Expected**: Session B's close fails with a server error (`TableSession.finalSaleId @unique`). The UI surfaces the error without corrupting the bill.

### Case C6 — kitchen updates while waiter is watching
- **Session A** (waiter): watching the session detail with rounds visible.
- **Session B** (kitchen): open `/kitchen`, mark a ticket printed.
- **Expected**: within ~8s, Session A's round status refreshes (polling interval). Session B's kitchen board refreshes within ~5s.

Record any UX confusion separately from backend correctness issues — the two
are different classes of finding.

---

## Device review

Load the app at each width, sign in as the restaurant owner, and step through
the waiter path (open T1, build a round, send to kitchen).

| Viewport | Target device | Watch for |
|----------|--------------|-----------|
| ≥ 1440px | Desktop / laptop | Comfortable spacing; kitchen and reports cards laid out in wide grid |
| 1280px | POS-class laptop | Two-column layouts still readable; no overlapping text |
| 1024×768 landscape | Restaurant tablet | Table cards ≥44px tap targets; category chips scrollable; modifier dialog reachable; primary actions (Send / Close & bill) at the bottom of thumb reach |

Also check:

- No page-level horizontal scrollbar at any of the three widths.
- Keyboard focus visibly highlights every button and dialog control.
- Tab order runs top-to-bottom, left-to-right.
- Status is never carried by colour alone — every StatusBadge has text plus its own tone class.
- Escape closes every dialog.

---

## Known limitations (Phase 2 pilot)

- **Realtime**: the abstraction ships (D39) but the transport is polling, not
  WebSockets. Kitchen refreshes every 5s, session detail every 8s. This is
  documented; a real-time transport is post-pilot work.
- **Delivery integrations** (Uber Eats, PickMe): out of scope for the pilot.
  The `DeliveryPlatformKind` enum defines them, but only the `MOCK` adapter is
  wired.
- **Restaurant Playwright suite**: the retail Playwright scenarios all pass;
  a dedicated Restaurant Playwright suite (R01–R35 style) is deferred to post-
  pilot. Coverage today is Vitest for the frontend + integration for the
  backend + manual walkthrough for the end-to-end flow.
- **Restaurant role templates**: the OWNER role holds every permission. Custom
  waiter / cashier / kitchen roles are backend-supported (per-tenant role
  assignments) but no seeded restaurant sub-roles ship — the PO can create
  them via `/settings/users` if desired.
- **Reports export**: on-screen only. CSV / PDF export deferred.
- **Table transfer / merge**: reserved permissions in the vocabulary
  (`TABLE_TRANSFER`, `TABLE_MERGE`), no UI yet. Documented in the reserved-
  permissions spec.

## Deferred functionality

- Uber Eats / PickMe / DoorDash live adapters
- WebSocket realtime transport
- Restaurant Playwright suite (R01–R35)
- CSV / PDF report export
- Restaurant sub-role templates as first-class seed
- Table transfer / merge UI

## Production blockers (before a live rollout)

- Add production-grade JWT/refresh-token secrets and rotate the current
  development ones. **None of the current dev credentials may go to production.**
- Add a real ESC/POS printer for the kitchen (the MOCK printer is for pilot only).
- Configure the accounting provider for the restaurant tenant if the operator
  wants it (currently `NONE`).
- Restaurant OAuth for QuickBooks is not wired (restaurant is `LOCAL` / `NONE`
  by design — do not enable QB for restaurant tenants without a decision record).
- Load-test the polling cadence with realistic KDS ticket counts (~50-100
  concurrent tickets) before choosing a real-time transport.

## Recommended pilot sequence

1. **Day 1 morning** — Owner + Manager walkthrough of every navigation
   destination (persona 1). Note any UI copy or spacing issues.
2. **Day 1 afternoon** — Waiter + Kitchen scripted service (personas 2 + 3)
   with all 6 tables cycled. Note round-history readability and kitchen
   attention flow.
3. **Day 2 morning** — Billing (persona 4) with mixed payment types, splits,
   and a reopen. Confirm the audit reason travels to the finance report.
4. **Day 2 afternoon** — Takeaway rush simulation (persona 5) with 5–10
   orders in flight simultaneously.
5. **Day 3** — Concurrency pilot (cases C1–C6) and device review.
6. **Day 3 close** — Manager persona (6) — permissions, voids, tenant
   isolation spot-checks.

---

_The full test surface: 570 API unit tests, 251 web unit tests, 649 integration
tests, 141 Playwright tests all green at HEAD `f471d81` on
`feature/restaurant-pos`._
