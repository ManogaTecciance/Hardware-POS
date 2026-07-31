# AxloPOS — Security Analysis & Tracking

Living security record for the Hardware POS system (Next.js web + NestJS API +
PostgreSQL + QuickBooks Online integration, deployed on EC2 behind Caddy).

- **Audit date:** 2026-07-28 · **Scope:** `apps/api`, `apps/web`, `packages/database`, deployment compose/Dockerfile, dependency tree
- **Method:** white-box source review of auth/authorization/crypto/input-handling paths, dependency audit (`pnpm audit`), configuration and container review. Findings are evidence-backed with `file:line` references.
- **Severity:** `Critical` (exploitable now, severe impact) · `High` · `Medium` · `Low` · `Info`
- **Status values:** `Open` · `In Progress` · `Fixed` · `Accepted Risk` · `Won't Fix` · `Verified`

> Related: functional security test cases live in [`testcases.md`](./testcases.md) (SEC-001…SEC-012). This file tracks *findings and posture*; that file tracks *test execution*.

---

## 1. Executive summary

| # | Severity | Finding | Status |
|---|---|---|---|
| V-001 | **Critical** | No rate limiting or lockout on any authentication endpoint; 4-digit PINs are brute-forceable | Open |
| V-002 | **High** | Next.js pinned to a range resolving to a version with 2× SSRF + 1× DoS advisories | Open |
| V-003 | **High** | `JWT_SECRET` has no minimum length/entropy validation | Open |
| V-004 | **High** | API container runs as **root** | Open |
| V-005 | **High** | No HTTP security headers (no Helmet/CSP/HSTS/frame-options) | Open |
| V-006 | **Medium** | Session tokens stored in `localStorage` (XSS-exfiltratable), no CSP as compensating control | Open |
| V-007 | **Medium** | 12-hour access tokens with no server-side revocation | Open |
| V-008 | **Medium** | `TOKEN_ENCRYPTION_KEY` optional, unvalidated length; key derived with bare SHA-256 (no KDF) | Open |
| V-009 | **Medium** | No password/PIN complexity policy; `POST /users` has no password field and no PIN format rules | Open |
| V-010 | **Medium** | PIN uniqueness not enforced; PIN lookup bcrypt-compares against every PIN user in the tenant | Open |
| V-011 | **Medium** | Unauthenticated `x-tenant-id` fallback lets PIN brute-force target any tenant | Open |
| V-012 | **Low** | QuickBooks query built by string interpolation with backslash escaping | Open |
| V-013 | **Low** | `/uploads/*` served without authentication (capability-URL model) | Open |
| V-014 | **Low** | 23 dependency advisories (1 critical dev-only, 12 high) beyond V-002 | Open |
| V-015 | **Low** | No MFA for Owner/Admin accounts | Open |
| V-016 | **Info** | Provisioning script prints generated passwords to stdout/shell history | Open |

**Overall posture:** the application's *core* security engineering is solid — parameterized data access, real authorization checks, sound refresh-token design, authenticated encryption for third-party tokens, tenant scoping derived from the token rather than client input. The weaknesses are concentrated in **perimeter hardening** (rate limiting, headers, container user, dependency currency) rather than in application logic. V-001 is the one to fix first: it is remotely exploitable, needs no credentials, and yields a working POS session.

---

## 2. Detailed findings

### V-001 — No rate limiting or account lockout on authentication `Critical`

**Location:** `apps/api/src/main.ts` (no throttler registered), `apps/api/src/modules/auth/auth.controller.ts:17-45`

**Evidence:** No `@nestjs/throttler`, `express-rate-limit`, or equivalent exists anywhere in the codebase. Four authentication endpoints are `@Public()`: `POST /auth/login`, `POST /auth/pin-login`, `POST /auth/refresh`, `POST /auth/logout`. There is no failed-attempt counter, backoff, or lockout in `auth.service.ts`.

**Impact:** `pin-login` accepts a **4-digit PIN** — a 10,000-value keyspace. An unauthenticated attacker who knows or guesses a tenant id (see V-011) can exhaust it in minutes and obtain a **fully valid cashier or manager session**. A manager PIN additionally authorises discount and return approvals (`POST /discounts/approve`, `POST /returns/approve`), i.e. direct financial impact. The same absence permits unlimited password spraying against `/auth/login` and refresh-token guessing.

**Remediation:**
1. Add `@nestjs/throttler` globally (e.g. 100 req/min/IP) with a **much stricter per-route limit on auth endpoints** (e.g. 5 attempts / 15 min, keyed on IP **and** tenant+PIN-prefix).
2. Add progressive lockout: after N failed PIN attempts for a tenant, disable PIN login for a cooldown window and raise an audit-log event.
3. Increase PIN length to 6 digits minimum (see V-009) — 4 digits is inadequate even with throttling.
4. Ensure the limiter reads the real client IP (`app.set('trust proxy', 1)`) since Caddy fronts the API, otherwise every request appears to come from the proxy.

---

### V-002 — Next.js version carries SSRF and DoS advisories `High`

**Location:** `apps/web/package.json` — `"next": "^15.1.3"` (lockfile resolves to 15.5.20)

**Evidence (`pnpm audit`):**
- `Next.js: Server-Side Request Forgery in Server Actions` — patched `>=15.5.21`
- `Next.js: Server-Side Request Forgery in rewrites via attacker-controlled input` — patched `>=15.5.21`
- `Next.js: Denial of Service in App Router using Server Actions` — patched `>=15.5.21`

**Impact:** SSRF from a public-facing frontend is significant on EC2 — a successful SSRF can reach the instance metadata service (IMDS) and, if IMDSv1 is enabled, steal the instance role's credentials. DoS affects availability of the storefront.

**Remediation:** Upgrade to `next@>=15.5.21`, redeploy the Amplify build, and re-run `pnpm audit`. **Independently**, enforce **IMDSv2 (token-required)** on the EC2 instance so any future SSRF cannot mint role credentials — this is a one-line instance-metadata setting and is worth doing regardless.

---

### V-003 — `JWT_SECRET` accepted without length or entropy validation `High`

**Location:** `apps/api/src/config/env.validation.ts:40-41`, `apps/api/src/modules/auth/auth.module.ts:11-18`

**Evidence:** the variable is validated only as `@IsString()`. A one-character secret boots successfully. Tokens are signed with the default `HS256`.

**Impact:** a weak or guessable secret allows an attacker to **forge access tokens offline** — arbitrary `sub`, `tenantId`, and `role` (including `OWNER`), defeating every authorization check and every tenant boundary at once.

**Remediation:** add `@MinLength(32)` to `JWT_SECRET` (and refuse to boot without it in production), document generating it with `openssl rand -base64 48`, and rotate the current production secret if its provenance is uncertain. Rotation invalidates live sessions — schedule it.

---

### V-004 — API container runs as root `High`

**Location:** `apps/api/Dockerfile` — no `USER` directive; final stage runs as root

**Impact:** any RCE in the Node process (e.g. via a dependency, or the bundled Chromium used for PDF generation) executes as uid 0 inside the container, materially easing container escape and giving full write access to the mounted `uploads_data` volume.

**Remediation:** create and switch to a non-root user before `CMD`:
```dockerfile
RUN useradd --system --uid 10001 --create-home appuser \
 && chown -R appuser:appuser /app /data
USER appuser
```
Also consider `read_only: true` plus a `tmpfs` for scratch, and `cap_drop: [ALL]` in `docker-compose.prod.yml`. Note the Chromium sandbox interacts with this — verify PDF generation after the change.

---

### V-005 — No HTTP security headers `High`

**Location:** `apps/api/src/main.ts` (no `helmet`), `apps/web` (no header config in `next.config.mjs`), `Caddyfile`

**Impact:** missing `Content-Security-Policy` (no XSS containment — see V-006), `Strict-Transport-Security` (TLS-stripping window), `X-Frame-Options`/`frame-ancestors` (clickjacking against POS/approval dialogs), `X-Content-Type-Options`, and `Referrer-Policy`.

**Remediation:** add `helmet()` to the API bootstrap; set headers for the web app either in `next.config.mjs` (`async headers()`) or centrally in the `Caddyfile`. Start CSP in report-only mode — the theme bootstrap uses an inline `<script>` (`apps/web/src/app/layout.tsx:22`), so it needs a nonce or hash before enforcing `script-src`.

---

### V-006 — Session tokens in `localStorage` `Medium`

**Location:** `apps/web/src/lib/session-store.ts:30-59` (key `hpos.session`)

**Impact:** any successful XSS reads the access **and** refresh token and exfiltrates a durable session. `httpOnly` cookies would make tokens unreadable to script. The risk is currently *unmitigated* because there is no CSP (V-005).

**Mitigating factors:** React escapes by default and the single `dangerouslySetInnerHTML` (`layout.tsx:22`) injects a static, non-user-derived theme script — no injection sink was found.

**Remediation (in order of value):** ship a CSP first (cheap, large payoff); then consider migrating the refresh token to an `httpOnly; Secure; SameSite=Strict` cookie while keeping the short-lived access token in memory. Full cookie migration requires CSRF protection — see the CSRF row in §4.

---

### V-007 — 12-hour access tokens with no revocation `Medium`

**Location:** `apps/api/src/config/env.validation.ts` (`JWT_EXPIRES_IN = '12h'`), `apps/api/src/common/guards/jwt-auth.guard.ts:38-46`

**Evidence:** the guard verifies signature and expiry only — no denylist, no per-user token-version check. `logout` revokes the *refresh* token (`auth.service.ts:89-92`) but a stolen access token remains valid until natural expiry.

**Impact:** stolen token = up to 12 hours of authenticated access, surviving logout, password change, and role downgrade.

**Remediation:** shorten access tokens to 15–30 minutes (refresh rotation already exists and works well), and/or add a `tokenVersion` claim checked against the user row so logout/role-change invalidates immediately.

---

### V-008 — Encryption key handling for QuickBooks tokens `Medium`

**Location:** `apps/api/src/common/crypto.ts:6-8`, `apps/api/src/config/env.validation.ts:183-186`

**Evidence:** `TOKEN_ENCRYPTION_KEY` is `@IsOptional()` with no length validation; the key is derived by a single unsalted `SHA-256` pass (`deriveKey`) rather than a password-based KDF.

**Impact:** a short/low-entropy passphrase is brute-forceable offline against the stored ciphertext, exposing QuickBooks OAuth tokens — which grant access to the customer's **accounting system**. If the variable is absent while QBO is configured, encryption behaviour is unspecified at config level.

**Positive:** the primitive itself is correct — AES-256-GCM, fresh 12-byte IV per encryption, authentication tag verified on decrypt (tamper-evident).

**Remediation:** require the key when QuickBooks is enabled, enforce `@MinLength(32)`, and derive with `scrypt`/PBKDF2 + a stored salt (or mandate a raw 32-byte base64 key and skip derivation). Plan a re-encryption path for existing rows if you change derivation.

---

### V-009 — No credential complexity policy `Medium`

**Location:** `apps/api/src/modules/users/dto/create-user.dto.ts`, `apps/api/src/modules/auth/dto/login.dto.ts` (`@MinLength(6)` on login only), `pin-login.dto.ts` (`@IsString()` only)

**Evidence:** `CreateUserDto` requires `pin` as a bare `@IsString()` — **no length, no digit-format, no weak-value rejection** — and contains **no password field at all**. `PinLoginDto.pin` has no format constraint. The `MinLength(6)` on login validates only what the client *sends*, not what a stored password must be.

**Impact:** users creatable through the API can hold trivially guessable PINs (`0000`, `1111`) and no password; the seeded demo PINs (`1111`, `2222`) are exactly this shape. Compounded by V-001.

**Remediation:** enforce PIN `@Matches(/^\d{6}$/)` (6 digits) with a denylist of sequential/repeated values; add a password field with a real policy (length ≥ 12, breach-list check e.g. HIBP k-anonymity) for accounts that use email login. The provisioning script (`provision-tenant.ts`) already validates 4–6 digits — align both on 6.

---

### V-010 — PIN uniqueness unenforced; lookup compares against every PIN holder `Medium`

**Location:** `apps/api/src/modules/auth/auth.service.ts:117-124`, `apps/api/src/modules/auth/auth.repository.ts` (`findActivePinUsers`)

**Evidence:** `findByPin` loads **all** active PIN users for the tenant and bcrypt-compares in a loop, returning the *first* match. The `User` model has no uniqueness constraint on `pinHash`.

**Impact:** two users may share a PIN — the first row silently wins, so **approvals and PIN logins can be attributed to the wrong person**, undermining the audit trail for discount/return approvals. The loop also makes response time scale with the number of PIN holders, a weak timing oracle for "how many staff have PINs".

**Remediation:** enforce PIN uniqueness per tenant at creation time (the provisioning script already rejects duplicates — extend it to `POST /users`), and consider a constant-work lookup (always compare a fixed number of hashes) to flatten timing.

---

### V-011 — `x-tenant-id` fallback on public routes `Medium`

**Location:** `apps/api/src/common/decorators/tenant-id.decorator.ts:14-25`

**Evidence:** the decorator correctly prefers `request.user.tenantId` for authenticated requests — **cross-tenant spoofing by an authenticated user is not possible**, which is the important guarantee. However, when no session exists (i.e. `@Public()` routes such as `pin-login`), it accepts the client-supplied `x-tenant-id` header verbatim.

**Impact:** an unauthenticated attacker can aim PIN brute-force at **any tenant id** they can guess or discover, turning V-001 into a multi-tenant attack. Tenant ids are cuids (not enumerable), but the dev tenant is the literal `tnt_dev`, and ids may leak via logs, support tickets, or URLs.

**Remediation:** rate-limit and lock out per tenant id (not just per IP); avoid predictable tenant ids in production; consider binding POS terminals to a registered device credential rather than a free-text header.

---

### V-012 — QuickBooks query built by string interpolation `Low`

**Location:** `apps/api/src/modules/quickbooks/quickbooks.api.ts:178-179` (and `:144`, `:224`)

**Evidence:**
```ts
const safe = term.replace(/'/g, "\\'");
const where = safe ? ` where DisplayName like '%${safe}%'` : '';
```
The search term originates from user input (`GET /quickbooks/vendors?search=`). Backslash escaping is assumed to be the correct escape mechanism for the QuickBooks query language; the by-id variants strip quotes entirely (`replace(/'/g, '')`), which is safer.

**Impact:** limited — the query is read-only and scoped to the tenant's own connected company, so worst case is malformed queries or minor data disclosure within data the caller already owns. Not SQL, so no database exposure.

**Remediation:** whitelist the search term (`[A-Za-z0-9 .&'-]`, capped length) and reject rather than escape unexpected characters; prefer QBO's parameterised search API where available.

---

### V-013 — `/uploads/*` served without authentication `Low`

**Location:** `apps/api/src/main.ts:22` (`app.use(UPLOAD_URL_PREFIX, uploadsHandler(...))` — mounted as middleware, before/outside the global guard), `apps/api/src/common/storage/uploads.handler.ts`

**Impact:** product images are readable by anyone with the URL. Keys are `randomUUID()`-based (`local-disk-storage.provider.ts:20`, `s3-storage.provider.ts:89`), so URLs are unguessable — this is a *capability URL* model, acceptable for non-sensitive product photos but not for anything confidential. Note the roadmap includes **supplier documents** (agreements, price lists, tax documents), which must **not** use this path.

**Remediation:** keep product images public if desired, but require authentication + ownership checks for any future document storage; keep S3 objects private with short-lived presigned redirects (already the case, TTL 300s).

---

### V-014 — Dependency advisories beyond V-002 `Low`

**Evidence (`pnpm audit`): 23 findings — 1 critical, 12 high, 10 moderate.** Beyond Next.js:

| Package | Severity | Note |
|---|---|---|
| `vitest` | Critical | Arbitrary file read when Vitest **UI server** is listening — dev-only, UI not used in CI |
| `vite` | High | `server.fs.deny` bypass (Windows paths) — dev-only |
| `sharp` (via `next`) | High | libvips CVEs; `apps/api` already uses patched `^0.35.3` |
| `postcss` | High | Path traversal / arbitrary file read via source maps — build-time |
| `fast-uri`, `brace-expansion` | High | Transitive under `@nestjs/cli` — dev toolchain, not runtime |

**Impact:** most are build/dev-time and not reachable from the deployed runtime, but they still execute on developer machines and in CI, which are credential-bearing environments.

**Remediation:** run `pnpm update` for the transitive fixes, upgrade Next.js (V-002), and add `pnpm audit --audit-level high` as a **CI gate** so new advisories surface on PRs rather than during an audit.

---

### V-015 — No multi-factor authentication `Low`

**Impact:** an Owner account is a single password away from full control of a tenant's catalogue, pricing, customer data, and the QuickBooks connection. Given the app manages accounting-linked financial data, single-factor auth for privileged roles is below current expectations.

**Remediation:** offer TOTP for `OWNER`/`ADMIN` (cashier PIN flow can remain for shop-floor speed). Prioritise after V-001/V-003.

---

### V-016 — Provisioning script prints credentials to stdout `Info`

**Location:** `packages/database/prisma/provision-tenant.ts` (final summary block)

**Impact:** generated passwords and PINs land in terminal scrollback, shell history (if passed as arguments), CI logs, and — because provisioning is run via `docker compose exec` — potentially container logs.

**Remediation:** acceptable for a controlled one-off run by an operator, but prefer writing to a `chmod 600` file or piping to the operator's password manager; instruct operators to rotate the initial password at first login (which requires building a password-change flow — currently absent).

---

## 3. Controls verified as effective

These were tested and found sound — record them so future refactors don't silently regress them.

| ID | Control | Evidence | Status |
|---|---|---|---|
| C-001 | SQL injection not possible via ORM layer | All raw queries use Prisma tagged templates (`Prisma.sql`); **no** `$queryRawUnsafe`/`$executeRawUnsafe` anywhere | Verified |
| C-002 | Refresh-token design | 48-byte CSPRNG token, SHA-256 hashed at rest (`RefreshToken.tokenHash`), single-use rotation, **reuse detection revokes all sessions** (`auth.service.ts:70-84`) | Verified |
| C-003 | Tenant isolation for authenticated requests | Tenant derived from JWT claim, never the client header, when a session exists (`tenant-id.decorator.ts:16-18`) | Verified |
| C-004 | Mass-assignment protection | Global `ValidationPipe` with `whitelist: true` + `forbidNonWhitelisted: true` (`main.ts:24-30`) | Verified |
| C-005 | Authenticated encryption for QBO tokens | AES-256-GCM, per-encryption random IV, auth tag verified on decrypt (`crypto.ts`) | Verified |
| C-006 | Password/PIN storage | bcrypt with salt rounds 10 — no plaintext or reversible storage anywhere | Verified |
| C-007 | CORS restricted | Origin allow-list from `WEB_ORIGIN`, not wildcard (`main.ts:32-39`) | Verified |
| C-008 | No user enumeration | Wrong password and unknown email return the identical 401 (`auth.service.ts:43-50`) | Verified |
| C-009 | Upload hardening | Client MIME whitelisted, **content re-encoded through sharp to WebP** (strips EXIF/polyglot payloads), `randomUUID()` storage keys (no path traversal), 5–10 MB limits | Verified |
| C-010 | Approval tokens are scoped and short-lived | JWT-signed, bound to tenant + product + discount type/value, 15-minute TTL, re-validated at sale completion (`discounts.service.ts:62-107`) | Verified |
| C-011 | Authorization enforced server-side | `@RequirePermissions` on every mutating route; verified by automated tests that cashier/accountant/manager receive 403s (`apps/e2e/tests/permissions.spec.ts`) | Verified |
| C-012 | Secrets not in version control | Only `.env.prod.example` tracked; `.env`, `.env.prod`, `.env.local` gitignored | Verified |
| C-013 | Database not internet-exposed | `docker-compose.prod.yml` publishes **no** port for `db`; reachable only on the private compose network | Verified |
| C-014 | TLS termination + auto-renewal | Caddy fronts the API; only 80/443 exposed | Verified |
| C-015 | Public share links unguessable | Quotation share token = `randomBytes(18)` → 144 bits of entropy (`quotations.service.ts:787`) | Verified |
| C-016 | Financial guardrails enforced server-side | Credit limits, stock availability, discount ceilings, and return approval all re-validated on the server — not trusted from the client | Verified |

---

## 4. Ongoing security test tracker

Recurring checks to run each release. Execute manually or automate into the e2e suite.

| ID | Area | Check | Frequency | Status |
|---|---|---|---|---|
| T-001 | Auth | Brute-force PIN endpoint 200× — expect throttling/lockout | Each release | Not Run |
| T-002 | Auth | Forged JWT (wrong secret / `alg:none` / modified `role`) is rejected | Each release | Not Run |
| T-003 | Auth | Access token still works after logout (should fail once V-007 fixed) | Each release | Not Run |
| T-004 | AuthZ | Full role × endpoint matrix returns expected 200/403 | Each release | Automated (e2e) |
| T-005 | Tenancy | Tenant-A token + `x-tenant-id: tenant-B` returns only A's data | Each release | Not Run |
| T-006 | Tenancy | Direct-object access to another tenant's record id → 404, never data | Each release | Not Run |
| T-007 | Input | XSS payloads in product/customer/vendor names render inert in list, POS, and printed documents | Each release | Not Run |
| T-008 | Input | SQL metacharacters in search/filters behave as literal data | Each release | Not Run |
| T-009 | Upload | Polyglot/oversized/non-image uploads rejected; traversal filenames neutralised | Each release | Not Run |
| T-010 | Crypto | QBO tokens unreadable in DB; tampered ciphertext fails to decrypt | Quarterly | Not Run |
| T-011 | Deps | `pnpm audit --audit-level high` clean (CI gate) | Every PR | Not Run |
| T-012 | Headers | Security headers present on web + API responses | Each release | Not Run |
| T-013 | Secrets | No secrets in git history, client bundle, or logs | Quarterly | Not Run |
| T-014 | Backup | Restore a `pg_dump` into a scratch DB and verify integrity | Monthly | Not Run |
| T-015 | Access | Review AWS IAM, SSH keys, and app user list; revoke departed staff | Quarterly | Not Run |
| T-016 | Infra | Confirm 5432 not reachable from the internet; SG rules minimal | Quarterly | Not Run |
| T-017 | Logs | Verify no passwords/PINs/tokens/PII in application or sync logs | Each release | Not Run |

---

## 5. Infrastructure & deployment hardening

| Item | Current state | Recommendation | Status |
|---|---|---|---|
| EC2 IMDS | Unverified | **Enforce IMDSv2 (token required)** — blocks credential theft via SSRF (see V-002) | Open |
| Security groups | 22/80/443 open | Restrict **SSH (22) to known IPs or SSM Session Manager**; never open 5432 | Open |
| Container user | root | Non-root `USER` (V-004) | Open |
| Container capabilities | default | `cap_drop: [ALL]`, `read_only: true` + tmpfs where feasible | Open |
| `.env.prod` on host | present | `chmod 600`, owned by deploy user; consider AWS Secrets Manager/SSM Parameter Store | Open |
| Database backups | manual `pg_dump` | Automate nightly dump → S3 with lifecycle + **restore drills** (T-014) | Open |
| Patch cadence | ad hoc | Monthly `pnpm update` + `docker compose pull` + host `apt upgrade` | Open |
| Log retention | unmanaged | Cap container log size (`json-file` `max-size`/`max-file`) to prevent disk exhaustion | Open |
| Monitoring/alerting | none observed | Alert on auth-failure spikes, 5xx rate, sync failures, disk usage | Open |
| Incident response | none documented | Write a one-page runbook: revoke sessions (rotate `JWT_SECRET`), rotate QBO tokens, restore from backup | Open |

---

## 6. Data protection notes

- **Data classes handled:** customer and vendor PII (names, emails, phones, addresses, tax/resale numbers), sales and payment records, credit limits/balances, staff accounts, and QuickBooks OAuth tokens (which grant access to the client's accounting system — treat as the crown jewels).
- **No cardholder data** is stored: card payments are recorded as a method + reference only, so PCI-DSS scope is minimal. Keep it that way — never persist PANs.
- **Customer `notes` were dropped** in the QuickBooks-mirror migration; confirm no regulated data was lost from production before that deploy (data-retention obligation).
- **Right-to-erasure:** deleting a `Customer` cascades cleanly only when there is no sales history; there is currently no anonymisation path for a customer with transactions. Consider one if operating under GDPR-like regimes.
- **Audit trail:** `AuditLog` records sensitive actions (approvals, returns) with actor and timestamp — preserve it, and ensure V-010 is fixed so approver attribution is trustworthy.

---

## 7. Recommended remediation order

1. **V-001** rate limiting + lockout (remote, unauthenticated, financially impactful)
2. **V-003** enforce `JWT_SECRET` strength (single point of total compromise)
3. **V-002** upgrade Next.js **+ enforce IMDSv2** (SSRF → credential theft chain)
4. **V-005 / V-006** security headers, then CSP (contains XSS and protects `localStorage` tokens)
5. **V-004** non-root container
6. **V-009 / V-010** credential policy and PIN uniqueness (also fixes audit attribution)
7. **V-007 / V-008** token lifetime + KDF hardening
8. **V-011 → V-016** as capacity allows; add **T-011** as a CI gate immediately (it is nearly free)

---

*Findings are point-in-time as of the audit date. Re-run this analysis after major dependency upgrades, before onboarding tenants with regulated data, and at least quarterly.*
