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

## Executed gates (2026-09-16)

- `npm run typecheck`: exit 0.
- `npm test`: 280 tests, 53 suites, 280 pass, 0 fail, 0 skipped.
- After migration 0023, `DATABASE_POOL_MAX=1 node --env-file=.env --import tsx src/scripts/verify-auth-transactions.ts`: exit 0.

```
PASS poolMax=1: signup/serializer, lifecycle nested queries, onboarding retry, refresh one-use, reset one-use, refresh revocation, access authVersion
PASS fixture transaction rolled back; no user retained
```

- Shared Redis OAuth-state fixture: exit 0.

```
PASS shared Redis OAuth state: one-time consume, replay rejected, malformed state rejected; no provider login performed
```

These gates do not certify SMTP delivery, provider authentication, live application submission, or tenant-profile deletion.

## Application questions and profile answers

`GET /me/apply-fields` and `PUT /me/apply-fields` share the existing `/intake/apply-fields` service. The catalogue contains 17 contact, location, profile, and work-preference fields. Signup can still complete without these; only the three required contact facts and a usable resume gate application execution. Existing kit values win over parsed resume contact facts. Optional salary and work-authorisation values must come from the user, never from inferred demographics or job descriptions.

New writes record `field_answers.provenance = explicit_user`; existing rows retain `legacy`. The field ladder can reuse a sensitive answer only for its owner, host, exact field signature and available option, after an explicit save-for-reuse. It never trusts legacy/model literal answers as user permission. Common salary/work-authorisation profile answers only match the identical free-text question: they cannot become country-specific yes/no statements or another currency's salary.

Passwords, OTPs, CAPTCHA answers, verification/recovery codes, legal commitments, criminal/background answers, and reference contact details cannot be cached for replay. Demographic answers remain optional and require the user's explicit answer/save decision when an employer asks. Company/role motivation and cover letters are application-specific, not reusable across companies.

`POST /applications/questions/:questionId/draft` checks both question and application ownership and returns `{draft, needsInfo, reason?}` without persisting an answer or restarting work. Drafts use saved kit/employment/job-skill facts, never a model-generated achievement or motivation, and are limited to 60 words. Where a motivation or example is missing, `needsInfo` asks the user to supply it. Sensitive and credential questions never receive generated drafts. The user must review and approve a draft before it becomes an application answer.

VM apply sessions now heartbeat the agent every 30 seconds until close. Heartbeats stop on mode loss and never launch or replace a browser themselves.

## Evidence-checked AI answer resolution

`src/persona/answer-resolver.ts` uses a real, metered `muse-spark-1.3-contributor` call through the existing model gateway. This alias is explicit; it does not silently fall back to a cheaper model or another provider. The resolver reads only the current user's kit, structured/parsed resume facts, employment records, explicit saved field answers, and eligible previous human answers. It never reads Gmail or browser credentials.

The caller can resolve at most 30 questions. Prompts contain bounded, topic-specific source selections and exact source IDs. Demographic, salary, and authorisation records are excluded from professional-essay source sets. No model tools or browser actions are available. Unknown source IDs, fabricated quotes, unavailable options, low confidence, country mismatches, and salary currency/pay-period mismatches produce `ask`, not a guessed answer. Total years cannot become skill-specific experience. Country-conditioned statements such as “India no; USA yes” can answer a US sponsorship question, but not UK sponsorship or citizenship.

Known answers require confidence ≥0.95 plus evidence/field/context validation. Professional drafts are assembled only from exact verified quotations, limited to 60 words; unsupported motivations, promises, achievements and personal stories are not invented. Both known and validated draft results carry `autoApply`; persistence/execution belongs to the question workflow. Generated output is recorded as `profile_ai`, never `explicit_user`, and never becomes evidence for another AI answer until a human explicitly accepts it.

Historical `remember=false` answers are usable only within the same application by default. A user-authorised `includePreviousResponses` action can opt that user's earlier human answers into cross-application reuse. Other users' opt-outs are not changed. All credential/authentication fields and application-specific legal commitments stay outside model resolution.

Actual model fixture executed successfully (synthetic facts only):

```
PASS actual muse-spark-1.3-contributor: LinkedIn wording resolved, conditional US sponsorship resolved, unknown UK sponsorship not inferred; successful metered calls=2
```

The resolver deadline stops using late results; the current shared model gateway does not expose cancellation for an already-issued provider request. Large historical answer stores also need indexed semantic retrieval before their growth makes loading all owned records expensive. These are production scaling/operational limits, not a claim that an unverified answer was filled.
