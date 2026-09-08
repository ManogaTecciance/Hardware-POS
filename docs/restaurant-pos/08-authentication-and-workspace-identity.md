# Authentication and workspace identity

**Status:** Accepted (Product Owner decision D19, 2026-08-04)
**Supersedes:** nothing
**Implemented by:** Slice 3.5 (backend resolution), Slice 7 (throttling),
Slice 8 (browser workspace-login UI)

---

## Context

`User` is `@@unique([tenantId, email])`, not `@@unique([email])`. The same email
address may therefore legitimately exist in more than one tenant — the same person
onboarded to a tile shop and to a restaurant, or an accountant serving several
AxloPOS customers.

Before Slice 3.5 the login lookup was `findFirst({ where: { email, isActive } })`
with no `tenantId` predicate and no `ORDER BY`. With one production tenant there
was always exactly one candidate, so the defect was latent. With two tenants
sharing an email it becomes a tenant-isolation breach: PostgreSQL returns an
arbitrary row, the password is compared against *that* row's hash, and the issued
JWT carries whichever `tenantId` came back. Every downstream query is scoped by
that claim, so a user could be served another tenant's data.

Slice 3.5 made resolution deterministic and fail-closed. That fixed the security
hole and created a product gap: with no way to state which tenant you mean, a
duplicate-email user cannot sign in from the browser at all. This document records
how that gap is closed.

## Decision

**`Tenant.slug` is the canonical public workspace identifier.**

It already exists, is already `@@unique`, is already human-readable, and is already
URL-safe. Nothing new needs to be minted, and no internal id is exposed.

### Login contract

```json
{
  "workspace": "restaurant-name",
  "email": "user@example.com",
  "password": "..."
}
```

`workspace` is supplied by either:

1. a workspace field on the login form, or
2. a tenant-specific URL such as `/login?workspace=<tenant-slug>`.

A tenant subdomain may be supported later. Both forms resolve to the same server
contract, so adding subdomains later is a routing change, not a protocol change.

### Resolution rules

| `workspace` | Matching active accounts | Outcome |
|---|---|---|
| supplied | — | Authenticate **only** inside that tenant |
| omitted | exactly one | Existing behaviour continues **temporarily** |
| omitted | more than one | Reject with a generic `WORKSPACE_REQUIRED` response |
| omitted | none | Generic invalid-credentials rejection |

The single-match fallback is a transitional compatibility affordance, not the
target state. It exists so that today's production tenant keeps working unchanged
while the UI catches up, and it should be removed once the workspace field ships.

### The workspace is a narrowing hint, never an authorisation

This is the load-bearing property. A supplied workspace only *narrows the lookup*
to `(tenantId, email)`; the password is still verified against that user's own
hash. A wrong, invented, or hostile workspace value can therefore only make a
login **fail** — never succeed against a tenant the credentials do not belong to.

Correspondingly, the server never trusts a client-supplied tenant identifier as an
authorisation input. On an authenticated route the tenant comes from the verified
session and nothing else; a verified session always beats anything the client
asserted.

### Prohibited — enumeration safety

- **No searchable tenant dropdown.** A list of workspaces is a list of customers.
- **Do not reveal tenant names from an email address.** "Which workspaces is this
  address in?" must not be an answerable question.
- **Do not return the matching tenant names** in a `WORKSPACE_REQUIRED` response.
- **Do not indicate how many tenants matched.**
- **Do not expose whether the email exists in another tenant.**
- Every rejection returns the same generic message, after an equal-cost bcrypt
  comparison, so response bodies and response *timing* both stay uninformative.

### PIN authentication

Unchanged in principle: PIN login remains explicitly scoped through the
appropriate tenant, branch, and register context. A PIN is a short shared secret
for a physical terminal, so it is only ever evaluated inside a tenant the terminal
has already established — never resolved globally.

## What Slice 3.5 actually implemented

The backend half, using `x-tenant-id` as the transitional carrier of the hint:

- `AuthRepository.findActiveByTenantAndEmail(tenantId, email)` — exact by
  construction, since `@@unique([tenantId, email])` permits at most one row.
- `AuthRepository.findActiveUsersByEmail(email)` — all candidates across tenants,
  deterministically ordered, so the ambiguity is *visible* rather than silently
  resolved.
- `AuthService.resolveLoginCandidate` — hint → exact lookup; no hint and exactly
  one candidate → proceed; no hint and several → **fail closed**.
- A decoy bcrypt comparison on every miss, so "unknown email", "ambiguous email",
  and "wrong password" cost the same.
- A refresh-token tenant invariant: `RefreshToken.tenantId` and
  `RefreshToken.userId` are independent foreign keys with no composite constraint
  tying them together, so a mismatch is treated as a token crossing a tenant
  boundary — refused, and every session for that user revoked.

## Remaining work

| Slice | Work |
|---|---|
| 7 | Throttling on `/auth/login` and `/auth/pin-login` (decision D20). The decoy bcrypt comparison closes a timing leak but makes every failed login cost a bcrypt round, so the endpoint went from cheap to spam to expensive to spam. Throttling must cover it. |
| 8 | The `workspace` field on the login form and `/login?workspace=<slug>`; rename the transitional `x-tenant-id` hint to a first-class `workspace` body field; remove the single-match fallback. |
| later | Optional tenant subdomains. |

## Consequences

**Good.** Tenant resolution is explicit and deterministic. Ambiguity fails closed
rather than guessing. No new identifier or table is needed. The eventual UI change
is additive.

**Accepted cost.** Until Slice 8 ships the workspace field, a duplicate-email user
cannot sign in through the browser. This is the correct default — refusing to
guess is strictly better than authenticating someone into an arbitrary tenant — and
it affects no existing user, because no production tenant currently shares an
email with another.

**Watch out for.** The single-match fallback is the one place where behaviour still
depends on how many tenants happen to hold an address. Onboarding a second tenant
with an overlapping email changes that user's login from "works" to
"`WORKSPACE_REQUIRED`" with no code change. Ship the workspace field before
onboarding overlapping accounts.
