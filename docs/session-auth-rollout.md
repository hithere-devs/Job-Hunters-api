# Session and auth rollout notes

## Browser setup

`GET /me/browser-session` returns per-provider readiness, cookie evidence classification, verification time, and a capability catalogue derived from installed discovery connectors and application skills. Provider-cookie presence is evidence, not proof that a provider will accept the session. Application adapters must still stop on authentication challenges. CSRF-only evidence and screenshot-model assertions no longer establish readiness.

A complete setup is `ready` only when all three supported account providers have session-cookie evidence; partial/lost evidence is `stale`. Lost evidence clears ready portal rows in the same DB transaction. The account contact email is not extracted from Google or inferred from the login; users review their application contact email in My Kit.

`POST /me/browser-session/remove` with `{ "confirm": true }` disables use by Huntly and clears connection metadata, not the VM profile. Application history is retained. The tenant stays reserved to the same user: allocating it to someone else without cleaning credential stores would leak credentials. Tenant 3 is excluded from automatic allocation because it holds a protected profile. Operators need a separately approved tenant deprovisioning procedure before reclaiming slots; no profile is deleted by these changes.

Connect and disconnect reject active application mode. The VM agent must deploy the atomic `expectedMode: connect` disconnect guard before these API changes are released. All VM-profile automation routes to the VM regardless of the global hosted browser default, and validates profile owner, VM identity, index, and loopback CDP port.

YC's existing application skill requires a YC account. It appears in capability explanations, but automated cookie verification has not been validated. Do not invent session-cookie names or present it as a supported connection. LinkedIn remains excluded on this VM.

## Password recovery

Required settings: existing `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`, plus `AUTH_PASSWORD_RESET_URL=https://your-ui.example/reset-password`. SMTP requires TLS (465 implicit or STARTTLS otherwise). The reset URL must be HTTPS in production. Secrets stay in deployment configuration.

- `GET /auth/recovery`: reports configuration availability, not delivery certification.
- `POST /auth/forgot-password {email}`: generic response; does not disclose whether a password account exists. Google-linked users use Google sign-in.
- `POST /auth/reset-password {token,newPassword}`: consumes a SHA-256-hashed random token once, within 30 minutes, updates password, revokes refresh tokens, increments auth version, and invalidates other reset tokens in a transaction.
- Reset email puts its token in the URL fragment, not an HTTP query/access log.
- HTTP and WebSocket authentication must compare access-token authVersion with the current user row. Existing signed tokens default to version zero for migration compatibility.

A production SMTP end-to-end delivery/reset test has **not** been performed. Recovery cannot be claimed active on configuration alone. Rate limiting must use a shared store behind multiple API replicas; existing process-local limits are not sufficient for horizontal deployment. Reset-token retention/pruning also needs operational scheduling.

## Verification boundaries

No provider login was automated, no passwords or cookie values were inspected, no profile was reset or deleted, and no real application was submitted. Unit tests cover mode conflict/reconnect, strict tenant routing/ownership/CDP checks, CSRF rejection, readiness aggregation, supported catalogue, reset-token schema/link policy, and versioned JWTs. Full route/reset transaction integration requires applying the additive migration first.

## Transaction and multi-process hardening

Browser lifecycle operations use a shared PostgreSQL advisory try-lock; the callback and nested services reuse the same transaction connection. A competing operation returns a retryable conflict rather than waiting indefinitely. `runWithDatabase()` preserves that connection through asynchronous serializer/service calls, including password-session issuance. This avoids a pool-starvation deadlock at `DATABASE_POOL_MAX=1`.

Refresh rotation, password reset, and password changes serialize on the user row. A refresh token is consumed and its replacement persisted in one transaction; reset cannot race a replacement token into existence after revocation. Session issuance rechecks the authenticated user's password hash and auth version under the same lock. Logout-all also increments auth version.

Google OAuth states now live in shared Redis with a ten-minute TTL, hashed keys, and atomic one-time consumption. Dedicated bounded Redis commands return unavailable rather than hanging during a Redis outage. This requires Redis access from every API replica.

After the additive migration, run `DATABASE_POOL_MAX=1 node --env-file=.env --import tsx src/scripts/verify-auth-transactions.ts`. The fixture tests lifecycle nested queries, signup serializers, onboarding retry, refresh rotation, one-use reset, and revocation, then rolls back all fixture rows.
