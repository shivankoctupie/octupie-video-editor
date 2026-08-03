# Security model

This document describes the trust boundary of the local product server (`src/server/`) and the browser app (`public/`). The design is default-deny: nothing that reaches beyond the local, offline, plan-to-master boundary happens without an explicit, operator-supplied grant. A language-model reply is data and is never executed and never becomes a grant.

## Authentication

- Bearer tokens come only from the environment or an explicit config, never from the database and never from a request body (`src/server/auth.ts`).
- The registry stores only the SHA-256 digest of each token. Authentication compares digests with `timingSafeEqual` over every entry with no early return, so a token is not revealed by timing or by which tenant matched.
- Tokens shorter than 16 characters, or duplicate tokens, are refused at construction. Raw tokens are never stored on a principal, returned, or logged.

## Authorization (RBAC)

- Five roles: viewer, editor, approver, publisher, admin (`src/workflow/rbac.ts`). The role-to-action map is fixed data; no config or model reply can widen it.
- `authorize` is pure and default-deny: an unknown role or action returns false. The HTTP router authorizes every non-public route before its handler runs (`src/server/http.ts`), so authorization is not left to individual handlers.
- The browser app disables controls a role may not use rather than hiding them, so the boundary is visible.

## Tenant and project isolation

Every repository read and write is scoped by the authenticated principal's tenant, enforced in parameterized SQL (`src/server/db/repository.ts`). A project or version id outside the caller's tenant is a 404, never a cross-tenant read. All SQL is parameterized, so no caller string can inject.

## Permission grants (boundary crossings)

Four operation classes are gated, default-deny (`src/permissions/policy.ts`): `network`, `media-upload`, `publishing`, `code-change`. A grant is operator-supplied data with an optional expiry; an unparseable or past expiry is treated as absent. The engine never mints a grant for itself.

- Materialization (web and Drive) requires both a `network` and a `media-upload` grant before any byte is requested.
- Publishing requires a `publishing` grant in addition to an approved version, a publisher or admin role, confirmed rights, a passed QA gate, an enabled adapter, and an unused idempotency key.

## SSRF and DNS-rebinding defenses

Any outbound fetch that could be pointed at an attacker-controlled URL passes `src/util/ssrf.ts` first: only http(s) with https required by default; IP literals that are private, loopback, link-local, CGNAT, benchmark, documentation, multicast, or reserved are blocked; a hostname is resolved and every resolved address must be public, so a name that resolves partly to a private address is refused. The web materializer re-validates the scheme and re-resolves the host on every redirect hop; the Drive path is given no resolver and therefore refuses redirects outright. The webhook adapter runs these checks before a byte is sent and returns a blocked result rather than throwing.

Validation alone does not stop DNS rebinding, where a name is rebound to a private address between the check and the connect. The production transport (`src/util/pinnedFetch.ts`) closes that gap: it pins each connection to the exact address validation approved and performs no second, unvetted DNS lookup, while TLS SNI and the Host header keep the hostname. The web materializer and the webhook adapter pass the vetted address to the transport and re-validate then re-pin on every redirect hop, so a rebinding record can never move a socket onto a private host. `image/svg+xml` is excluded from the materialization MIME allowlist: a fetched SVG is an active document that, opened same-origin, could run script and read the session token (stored XSS).

## Safe uploads and path containment

Uploads stream into a fresh server-controlled temp file, hashing as they go under a hard byte cap; on overflow the stream is destroyed and the partial file removed (`src/server/upload.ts`). Content type and filename are checked against a media allowlist, and a filename with a separator, traversal, or unsafe character is refused. Destinations are content-addressed by SHA-256, so a client filename never influences where bytes land and source media is never overwritten. Every storage key, plan path, generated-asset path, and static file path is checked for containment under its root before any IO.

Stored media is served back only as a sandboxed attachment (`src/server/http.ts`): the content endpoint sets `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`, so a stored blob can never render or execute as a same-origin document; the browser app downloads active content rather than opening it in a tab.

A per-tenant storage quota bounds durable usage across uploads, generated assets, and materialized imports (`maxTenantBytes`, default 2 GiB, `OVE_SERVER_MAX_TENANT_BYTES`). It is enforced before a media row is registered; an over-quota request is refused with a 413 and any partial artifact (temp file or just-written asset and sidecars) is removed. The quota is per tenant, so one tenant cannot consume another's.

## Immutability and idempotency

Versions, review decisions, and publish receipts are insert-only and never mutated. Jobs and receipts carry unique idempotency constraints; the FIFO job claim runs inside a write transaction with a guarded update, so a job is claimed exactly once even under concurrent workers. Rendering runs off the request path in a separate worker process.

A review decision is single-winner: the decision insert is guarded inside a write transaction and by a unique index on (tenant, project, source version), so a second decision on the same in-review version, sequential or concurrent, is refused with a 409 rather than creating a duplicate approved/rejected version. Failed jobs are retried with bounded attempts: below `max_attempts` the job is requeued (keeping its FIFO position and idempotency key), and only at the cap is the failure terminal, with one attempt row recorded per try.

## Secret handling

Secrets are read from the environment only at call time and travel only in an Authorization header. The webhook secret and the Drive access token are never placed in a URL, a CLI argument, a log line, an error, a stored record, a sidecar, or a blocked reason; Drive transport errors are scrubbed of the token before they surface (`src/materialize/drive.ts`, `src/workflow/webhookPublishing.ts`). The `/api/status` panel exposes grant action names, who granted, and expiry only, never a token value.

## No shell interpolation

FFmpeg and FFprobe are always invoked with argument arrays, never a shell string built from user input (`src/ffmpeg/spawn.ts`). The server and the materialization and publishing paths spawn nothing.

## Reporting

This repository is proprietary and private. Report a suspected issue to jay@octupie.com. Do not open a public issue for a security report.
