# Backend architecture audit

Draft reviewed against the working tree on 2026-09-16, based on commit `8b7778e` plus the application, gateway and VM changes being finalized in this run. Line references identify that review snapshot and may move before the final commit. This is a code and failure-path audit, not a production certification or a penetration test.

## Verified implementation update

Since the first audit snapshot, the coordinator deployed Redis and an application-only runner on the VM. The API uses a loopback SSH tunnel to the same Redis. Four user-authorized applications ran through saved VM profiles; résumé attachment and live read-only frames were observed through the browser extension. Those attempts reached review/uncertain outcomes, not a certified successful submission count.

The user explicitly enabled live mode. `APPLY_DRY_RUN=false` is now configured, the application queue is not paused, and the runner is supervised by systemd. Existing uncertain submit fences have not been cleared or blindly retried.

A real capacity incident exposed the Supabase session pooler's 15-client limit. This application's connections were moved to transaction pooling on port 6543, with API/runner pool budgets of 3/2 and bounded query timeouts. Pool-size-1 transactional regression fixtures then passed. PostgreSQL certificate verification was separately tested and FAILED with `self-signed certificate in certificate chain`; A-04 remains open pending a trusted CA configuration.

Saved-answer and live-question fixes now include common-answer deduplication, explicit source provenance, default saving, context-aware Muse 1.3 Contributor resolution, a unified question inbox, automatic safe continuation, and no repeat request for a valid stored answer merely because its browser expired. Actual model fixtures verified LinkedIn wording reuse and `For India no, for USA yes`, without inferring a UK answer.

## Boundaries and decision

The intended application path is API approval, a PostgreSQL dispatch record, BullMQ, the VM application-only runner, the same user's VM browser profile, and a read-only watch stream. PostgreSQL is the durable intent and result store; Redis is execution coordination, not the only copy of pending work.

No provider login, password value, Gmail contents, or real application submission was used during this audit. Payments were excluded. Provider acceptance, SMTP delivery, recovery from host loss, and sustained multi-user load have not all been demonstrated. The user subsequently explicitly authorized a limited live rollout. Live mode is now enabled; that authorization is not a production certification and does not waive the open risks below.

The earlier critical issues involving credential observation, unfenced submit actions, interactive VNC access during Flow B, and revoked JWTs reaching application streams have code fixes in this run. They must not be reported as unchanged defects. Those fixes still require the exact deployed-version gates. No statement that all possible defects have been found is justified.

## Critical findings addressed during this review

### R-01. Password inputs could enter model observations

`src/agent/observe.ts` previously included password inputs and read their `.value`. A provider that challenged an expired session could expose a Chrome-autofilled password to the model. Current code excludes password and credential-autocomplete controls before reading values, and `src/agent/tools.ts` rejects credential writes by current DOM type. This is a code mitigation, not permission to automate a login.

Acceptance: a synthetic form with a sentinel password, current/new-password autocomplete, and one-time-code fields must not include those values in observations or model requests. Changing a text input to password after observation must also prevent a write. Use synthetic secrets only.

### R-02. Submit uncertainty could become a retryable failure

The former agent submit could click before the orchestrator wrote a submitting event. An agent exception could then enter deterministic fallback and click again. Best-effort event insertion and later status downgrades also made a database error capable of erasing submit evidence.

Current code adds `apply_attempts.submit_started_at`, `src/hunt/apply/submission-guard.ts`, a durable fence before submit-capable tools and deterministic clicks, no fallback after that fence, and retry rejection based on the fence rather than telemetry alone. `src/hunt/apply.ts:313-318, 494-503` also checks provider confirmation rather than trusting the agent's report. This reduces the duplicate risk; it does not make an external employer submission transactional.

Acceptance: fail the DB write before the fence and prove zero clicks; fail telemetry, screenshot storage, and final result persistence after the click and prove no second click or retry; crash immediately after the provider receives the request and preserve an uncertain, non-retryable result. Also test the arbitrary-JavaScript controls described in A-01.

### R-03. The interactive stream bypassed read-only watch

The VNC route used to check ownership without checking browser mode. An owner could open interactive VNC during Flow B even though the watch route itself rejected input.

Current `src/live/gateway.ts:62-81` requires a connecting session and VM connect mode and periodically revalidates it. `vm-agent/server.ts:139-156` stops both tenant VNC services before launching Flow B and starts them only for connect mode. Stopping services also disconnects already-open interactive sockets. This physical isolation closes the mode-check/upgrade race that a periodic check alone would leave.

Acceptance on the deployed tenant-9 fixture: hold a VNC socket open, transition to apply, prove it closes, and prove a new VNC connection is refused while CDP watch still streams and cannot forward input. The protected tenant-3 profile must not be changed.

### R-04. Revoked access tokens could open browser streams

HTTP auth now checks `users.auth_version`; the older stream routes only validated the JWT signature. `src/live/gateway.ts:42-44,62,111,134,166-170` now checks the user row and revalidates application watch connections. VNC checks at 15 seconds and watch checks at 20 seconds mean revocation is bounded, not instantaneous. The legacy playground socket still needs the established-connection review in A-11.

### R-05. Approval and lifecycle locks could exhaust their own DB pool

Holding one pool connection for a session advisory lock while the callback acquired another could deadlock at pool capacity. Lifecycle callbacks now share the transaction through `src/browser/lifecycle.ts:8-12` and `runWithDatabase`. Approval uses a token-owned Redis lease while the authoritative budget/candidate transaction remains in PostgreSQL. The old session-lock and nested-pool implementation is no longer the reviewed design.

Acceptance: pool size one for lifecycle operations, and parallel approvals from at least pool-size distinct users, must complete or return a bounded conflict rather than wait indefinitely.

### R-06. Cancellation could race a late outbox publish

Current worker claim is a conditional database update that checks the dispatch has not been cancelled. Cancellation first claims the candidate row in its transaction, then removes the Redis job; an active removal conflict rolls the cancellation back. See `src/hunt/application-queue.ts:450-460` and `src/modules/applications/actions.ts`. A late publish alone therefore cannot start the cancelled candidate. This needs a concurrent DB/Redis test, not only policy-function tests.

### R-07. Agent authentication, disconnect and shutdown were unsafe by default

`vm-agent/server.ts` now refuses an empty token, serializes tenant mutations, rejects connect-mode disconnect during apply, limits resume upload size while receiving it, uses numeric file ownership, and performs process-group SIGTERM followed by a ten-second wait before a logged escalation. The previous empty-token bypass and one-shot idle timer have been removed. Deployment and crash behavior remain explicit gates.

## Remaining findings

### A-01. P1. Generic JavaScript controls cannot be proven safe by DOM labels

Evidence: `src/agent/tools.ts:263-281`; `src/agent/observe.ts:210-218`; `src/hunt/apply/submission-guard.ts:8-13`.

Native submit controls now get a fence, including default submit buttons and form-associated inputs. A `type=button` or role=button can still issue the final application XHR through arbitrary JavaScript while having no recognized submit label. A stale or incomplete classification can allow that click without a durable fence. A generic DOM observer cannot prove the absence of this side effect.

Remediation: require reviewed provider step/action rules for live submission, or enforce a provider-specific network commit boundary. Treat unknown final-action controls as needs-review. Do not add a broad “Next is safe” label exception. A form step can submit through JavaScript despite its label.

Coverage gap: add fixture controls with unlabeled XHR commits, default form submit, external `form=` association, DOM mutation after observation, and intermediate submit-type Next controls. Keep arbitrary-site live submissions disabled until this boundary is explicit.

### A-02. P1. Browser navigation lacks a demonstrated private-network egress boundary

Evidence: `src/hunt/apply/urls.ts:6-23` normalizes HTTP URLs but does not reject private destinations; `src/hunt/apply.ts` navigates the stored apply URL; agent link host validation happens after the click at `src/agent/tools.ts:273-279`.

A poisoned job URL, redirect, subresource, or link can make the VM browser request a private or link-local service before the agent decides that it went off-site. No cloud metadata request was attempted in this audit. The risk depends on VM egress and service-account configuration, which must be inspected separately.

Remediation: a browser-network egress policy denying loopback, private, link-local and cloud metadata destinations except narrowly necessary control-plane traffic outside web-page access. Validate URL resolution and every redirect, not just the original hostname. Keep localhost fixture exceptions test-only.

Coverage gap: fake metadata/private endpoints, redirect chains, IPv6, rebinding behavior, and subresource requests. Prove isolation with no real credentials.

### A-03. P1. Deleting a user can free a tenant whose credential profile remains

Evidence: `src/db/schema.ts:638-653` cascades deletion of `user_browser_sessions` with its user. `src/modules/me/routes.ts:59-65` allocates from absence of that reservation. The remove-connection route deliberately retains the profile and slot.

There is no current public delete-user route in the reviewed flow. However, an admin SQL deletion or a future erasure endpoint can remove the reservation while leaving `/home/huntly-uN/profile`. The next account allocated that slot could inherit the previous account's sessions. A cascade must not be treated as safe deprovisioning.

Remediation: retain a tenant inventory/tombstone independent of user lifetime. Reassignment requires an explicitly authorized profile-erasure and verification workflow. Until then, prohibit freeing tenant reservations through account deletion and document that constraint in operational tooling.

Coverage gap: delete/deprovision fixture user A, allocate user B, and prove B cannot receive A's profile or cookies. Never run this against tenant 3.

### A-04. P1. PostgreSQL TLS does not authenticate the server

Evidence: `src/db/client.ts:30-33` sets `rejectUnauthorized: false` when database SSL is enabled.

Traffic is encrypted, but an active network attacker with a presented certificate is not rejected by certificate-chain validation. The comment calling this standard setup is not a security guarantee.

Remediation: configure the provider CA and hostname verification, with a development-only explicit exception if genuinely necessary. Production startup should reject insecure TLS settings.

Coverage gap: correct CA connects; wrong CA/hostname and untrusted certificates fail. Do not print connection strings in gate output.

### A-05. P1. Non-application resource locks ignore lost ownership

Evidence: `src/lib/locks.ts:91-102`; discovery, inbox and outreach use this helper through `src/queues/discover.ts`, `src/worker.ts`, and `src/runner.ts`.

The generic heartbeat discards both renewal failures and a zero result. After a lease expires, a second worker can acquire the resource while the first continues executing. Token-checked release avoids deleting the second lease, but does not prevent concurrent side effects. The newly fenced application lanes do not fix these other queues.

Remediation: propagate an ownership-loss abort to the running task and guard side effects with a fence or operation identifier. Give renewal commands a deadline. Outreach requires particular care because a duplicate message cannot be rolled back.

Coverage gap: Redis interruption longer than TTL while two workers contend; prove the first stops before the second can perform the protected side effect.

### A-06. P1. A healthy worker connection is not a healthy application runner

Evidence: `src/hunt/application-queue.ts:127-133` reports worker presence from BullMQ connection count. `src/modules/applications/preflight.ts` uses that and API-process configuration to determine readiness.

A worker can be connected but unable to reach the VM agent, use the expected profile, write a temporary resume, or load the compatible deployed schema. API and runner can also have different dry-run/provider settings. The UI can consequently say ready while every queued job fails on first execution.

Remediation: publish a runner heartbeat containing deployment version, provider, execution mode, VM identity and capability checks. Match it with the queue the API writes. Separate connected, ready, degraded and draining states. Never use a health check to launch a user browser.

Coverage gap: connected runner with wrong VM token, wrong provider, migration mismatch, and unwritable scratch directory must be visibly degraded before enqueue.

### A-07. P1. Dependency outages can leave requests or application lanes waiting indefinitely

Evidence: `src/lib/redis.ts` and `src/hunt/application-queue.ts` use `maxRetriesPerRequest: null`; queue health and lease release await Redis calls without a request deadline. `src/lib/storage.ts:76-85` has no caller cancellation. `src/agent/loop.ts:90-101` races a timeout but does not cancel the underlying work.

BullMQ workers need reconnect behavior, but API health/approval requests need bounded responses. A Redis command queued during outage can prevent the catch-based health fallback from ever running. A storage request can hold an application lane while lease renewals continue. A timed-out browser/model operation can finish after fallback has started.

Remediation: separate worker Redis settings from bounded producer/health calls; propagate AbortSignal through storage/model/browser operations; enforce an overall application deadline and close the browser on expiration. Make cleanup bounded without losing uncertainty records.

Coverage gap: black-hole Redis, storage and model traffic, not just immediate connection-refused errors. Assert response deadline, lane release, no overlapping late actions and an honest final state.

### A-08. P1. Session-cookie presence is not proof of current authentication

Evidence: `src/browser/providers.ts:43-85,124-137`; `vm-agent/server.ts` cookie query reads host/name, not expiry; `src/modules/applications/preflight.ts:35-38` uses saved evidence age.

A cookie can be expired, invalidated server-side, or an anonymous session under the same name. The strict CSRF rejection is an improvement, not a full provider acceptance test. An account can pass setup and be challenged as soon as a real application opens. The frontend must retain the evidence wording and the worker must park a login challenge rather than trying to sign in.

Remediation: exclude expired cookies using metadata only; validate provider-specific authenticated evidence using permitted non-login checks, and test revocation. Preserve cookie values inside the profile. Connect a daily verifier to existing schedules when appropriate, rather than assuming evidence stays valid.

Coverage gap: anonymous visit, real human login, sign-out, provider-side revocation, expired cookie, and wrong-account challenge for each supported provider. YC remains unavailable until its account evidence is validated.

### A-09. P1. VM lifecycle still needs crash and long-application acceptance tests

Evidence: `vm-agent/server.ts:13-30,139-170,207-217`; `src/browser/session.ts:201-208`.

The VM agent's ownership map is in memory. Graceful shutdown is implemented, but a SIGKILL or service-manager failure can bypass it. Startup has no persisted process adoption proof. The final VM agent now waits for a successful bounded CDP /json/version probe before returning apply mode, and openVm sends an apply heartbeat every 30 seconds. Cold-start and mode-conflict checks passed on tenant 9. Crash adoption and a long-duration soak remain unproven.

Remediation: make systemd cgroup ownership and crash cleanup part of the tested contract; use a bounded Chrome-ready probe; keep an explicit apply heartbeat while a valid lease exists and separate it from connect-viewer activity. A failed start must not report a usable browser.

Coverage gap: cold start under disk pressure, agent SIGKILL/restart, runner SIGKILL, and an application exceeding idle duration. Demonstrate no orphan and no loss of the profile.

### A-10. P2. Slow watchers and past watchers can consume unbounded resources

Evidence: `src/live/gateway.ts:70-71,158-164` sends without a `bufferedAmount` threshold. `src/hunt/apply/events.ts:85-105` adds a Redis listener/subscription per observed user but unsubscribe removes only the local listener.

A slow client accumulates JPEGs rather than receiving the latest frame. Users who watched once remain Redis subscribers and message listeners for the process lifetime. Frame fan-out cost and memory therefore grow with historical viewers, not just active viewers.

Remediation: discard old frames when buffered bytes exceed a small limit, cap connections per user/IP, and ref-count subscriptions with a single Redis message dispatcher. Remove the channel when its last viewer leaves.

Coverage gap: throttled client plus repeated connect/disconnect across thousands of fixture users. Assert bounded memory, listener count and end-to-end frame age.

### A-11. P2. Established playground sockets do not revalidate revocation

Evidence: `src/live/gateway.ts:109-129` checks the identity at acceptance, but calls `acceptPlayground` without a token. Application watch and VNC received periodic token/auth-version checks; this legacy path did not.

A password reset blocks a new playground connection but can leave an existing one usable. The dedicated application runner avoids running the playground on the VM, so this is not an unfixed VNC-to-Flow-B bypass. It remains inconsistent account-revocation behavior.

Remediation: reuse the periodic expiry/auth-version check for every authenticated socket and close it on account deletion or revocation.

Coverage gap: reset/revoke a synthetic user's session while each socket type is already connected; assert closure within the documented interval.

### A-12. P2. Application list refresh does N+1 execution diagnostics

Evidence: `src/modules/applications/runtime.ts:42-65`; `applicationJobInfo` in `src/hunt/application-queue.ts`.

Every displayed application independently reads its dispatch and Redis job, worker count, state and possibly lock TTL. A 100-row page refreshed by several users creates repeated DB/Redis work even when most rows are completed history. The API competes with queue processing for those same resources.

Remediation: fetch current dispatches in one query, fetch worker health once per refresh, pipeline job lookups for non-terminal rows, and cache short-lived health separately from exact job state.

Coverage gap: concurrent 100-row refreshes while applications run; measure p95 response time, DB pool wait, Redis operations and worker start latency.

### A-13. P1. Durable submit safety does not yet make the result projection atomic

Evidence: `src/hunt/apply.ts:477-501`; `src/hunt/apply/state.ts:67-102`.

The new submit fence protects against unsafe retry after a partial failure. However, final attempt, candidate, application, run counters and event history still write separately. A DB failure can leave an applied attempt with an old run count, or omit the timeline event. The fallback preserves submission uncertainty, but does not rebuild every projection/counter. Operators may see conflicting facts across pages.

Remediation: commit the terminal database projection and durable event in a transaction keyed by attempt, with idempotent counter accounting. Keep streaming best-effort. Add a reconciler that rebuilds application/run summaries from authoritative attempts without resubmitting.

Coverage gap: fail after each terminal write, repeat the handler, and assert one final transition and one counter increment while the submit fence remains intact.

### A-14. P2. Recovery throttling and email dispatch are not replica-safe

Evidence: `src/middleware/rateLimit.ts:1-63`; `src/modules/auth/recovery.ts:25-40`.

Rate limits are process-local. Multiple API replicas multiply the allowed recovery attempts. The response waits for SMTP only for existing password accounts, making timing differ even though response text is generic. SMTP failures are logged and the token is consumed, but there is no durable email-send retry record. A user can receive a success message without a delivered link.

Remediation: shared throttling with IP and account-independent abuse ceilings; durable asynchronous reset-mail dispatch with generic bounded response latency; delivery monitoring that never logs the token. Keep one-time consumption and auth-version invalidation transactional.

Coverage gap: two API replicas, SMTP timeout/failure, token replay and simultaneous reset requests. SMTP end-to-end delivery is not certified by the unit tests.

### A-15. P2. Profile maintenance, retention and disaster recovery need an operational contract

Evidence: `src/queues/schedule.ts:120-133` registers discovery, learning and user schedules; it does not register the plan's browser-cache eviction/session verification jobs. VM profiles and evidence objects persist separately from application metadata. `docs/session-auth-rollout.md` explicitly defers safe tenant deprovisioning and reset-token pruning.

Browser caches can consume shared VM disk until every tenant fails together. Disabling a connection is not deletion of its authenticated profile. Restoring DB reservations without matching VM profiles can associate metadata with the wrong on-disk state unless the restore procedure reconciles them. No restore test was performed by this audit.

Remediation: document retention for resumes, application screenshots, attempts, reset tokens and browser profiles; implement only approved cache-path deletion; alert on disk/inode pressure and backup age; keep slot inventory and profile backup identity consistent. Prove an isolated restore before claiming recovery support.

Coverage gap: near-full disk, cache eviction preserving credentials, user removal/tombstones, and DB/Redis/profile restore into an isolated environment.

## Queue/outbox fixes rechecked in the final code pass

The following were raised during review and are now present in the working tree. They are code fixes, with concurrent failure-injection acceptance still required:

- `dispatchPendingApplications` now scans fresh, undelivered intents separately from a cursor-based delivered-record recovery scan. It no longer repeatedly selects the same first 200 already-published rows. Queue-name scoping prevents an isolated fixture runner from consuming the production dispatches.
- The periodic worker recovery sweep dispatches never-started durable intents before classifying missing Redis work as interrupted. Active jobs with missing BullMQ locks no longer count as live. The application-only runner uses this worker setup too.
- Interrupted `vm:N` sessions now use VM cleanup, with a user-owned reservation lookup, lifecycle lock, profile-lease absence check, and apply-mode check before stopping. Hosted sessions retain the hosted cleanup path. This must not stop a human's connect-mode browser.
- Cross-hunt partial approval retains already-queued job IDs and per-group failures instead of discarding successful results when a later group fails.
- Preflight and enqueue read the same user daily target. Cancellation frees a reservation; retry checks the current-day budget when a new reservation is needed. Known intentional dry runs can be retried only with explicit no-submit evidence and no durable submit fence. Portal caps remain per-batch caps unless separately documented and enforced as daily caps.

## Required rollout evidence

1. Apply and inspect the additive migration, including submit fence, dispatches and auth version, before starting the corresponding runner binary.
2. Record API and runner deployment identity and execution mode. Prove they share the intended Redis and database. Keep the real pending queue paused until the isolated fixture passes.
3. Run concurrent approval/cancellation/dispatch tests against real isolated PostgreSQL and Redis. Include more than 200 rows, queue-loss recovery, lease loss, and DB failures at every submit boundary.
4. Prove tenant-9 VNC connect, same-profile apply mode, physical VNC shutdown, read-only authenticated watch, expiry/revocation, resume attachment, graceful browser stop and no cookie values in responses.
5. Have a human perform provider sign-in and verify a login-required and an anonymous provider flow without submitting a real application during this gate. Public-provider fixtures do not prove a private logged-in profile works.
6. Run production SMTP delivery/reset and a restore rehearsal separately. Configuration presence is not successful delivery or recovery.
7. Approve and observe a limited live-submission rollout only after the remaining P1 items are fixed or explicitly accepted with a documented control. This audit does not authorize changing dry-run mode.

## Test evidence available to this audit

Existing tests exercise application order/caps, selection ownership and duplicate policy, provider cookie matching, profile owner/VM/CDP checks, read-only message policy, resume payload transfer, submit confirmation policy, and recovery token/JWT rules. New submit-guard tests exercise the fence callback and second-submit rejection. Session/auth transaction integration has its own report in `docs/session-auth-rollout.md`.

This audit did not itself execute the final aggregate suite or the real VM acceptance sequence. The coordinating implementation report must attach exact outputs and distinguish static unit coverage, DB/Redis fixture coverage, VM fixtures, human-provider acceptance and SMTP tests. Passing one category must not be used as evidence for another.
