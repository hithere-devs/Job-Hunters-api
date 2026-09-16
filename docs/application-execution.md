# Application queue execution

## Durable state and starts

Manual selections publish immediately. There is no eleven-hour batch spacing. The worker delays a job only when its user's lane, provider lane, VM profile, or review pause prevents a safe start. A single VM profile has effective concurrency 1 even when the user's configured concurrency is higher.

Approval uses a renewable, token-owned Redis lock without holding a database connection. The database transaction serializes the user's budget calculation, validates queueable candidates, and saves Applications, candidate state, queue events, and `application_dispatches` together. UTC daily usage is shared across hunts and uses `hunt_specs.daily_target`, capped at 100. Cancelling before execution returns its daily reservation. Retrying checks the remaining budget when it needs a new reservation.

`APPLICATION_QUEUE_NAME` defaults to `hunt-apply`. Dispatch rows carry the queue name so a smoke runner cannot consume production intents. Legacy rows without dispatches belong only to `hunt-apply`.

The application worker owns one serialized startup/15-second recovery sweep. It publishes pending intents using deterministic dispatch IDs, scans delivered intents with a pagination cursor, and restores missing Redis jobs only when no browser attempt has begun. Interrupted attempts need review, not automatic replay. There is no extra queue process.

## Cancellation, retry, and flags

- `POST /applications/:id/cancel`: waiting jobs only. A conditional database claim and Redis's atomic removal prevent cancellation from racing browser startup.
- `POST /applications/:id/retry`, body `{ "confirmedNotSubmitted": true }`: never retries submitted, unknown, in-flight, or submit-fenced attempts. A recorded dry run with no submit fence is safe to retry explicitly.
- `POST /applications/:id/flag`: persists an attempt flag and pauses future jobs. The durable submit checkpoint checks open flags before clicking. A click already in flight cannot be recalled.
- `GET /admin/flags` and `POST /admin/flags/:id/resolve`: administrator UUID allowlist only. `ADMIN_USER_IDS` is empty by default. Resolution requires a note and refuses an in-flight attempt.

The `submit_started_at` fence is saved before deterministic or agent submit actions. Missing telemetry cannot make a possibly submitted application retryable. A second submit in one application operation is refused. Agent-reported success is checked against provider confirmation text. Failure after a click preserves a confirmed or uncertain outcome rather than overwriting it with a retryable failure.

## Readiness and watch contracts

`GET /applications/preflight` returns execution mode, queue/runner health, configured/effective concurrency, daily usage/reset, application contact email, browser metadata, provider readiness, and actionable gaps. It requires an actual base resume with successful parsing. Provider verification older than 24 hours requires reconnecting.

`GET /applications/active` is independent of list filters/pagination. Application details include the phase timeline, `canCancel`, and `retryBlockedReason`. Watch authorization/input safety remains in the live gateway.

Resume uploads transfer bounded file payload bytes through Playwright. The Chrome OS user never needs access to the runner's private temporary directory. Agent observation excludes password and one-time-code inputs before reading values; tool writes re-check their current DOM type. An expired login is handed back for human connection.

## Verification

Run unit tests and typecheck normally. For an isolated integration check with a migrated database and Redis:

```sh
APPLICATION_QUEUE_NAME=hunt-apply-test-$(date +%s) DATABASE_POOL_MAX=1 npx tsx src/scripts/verify-application-queue.ts
```

The script refuses a production queue name, requires dry-run mode and zero consumers, creates disabled fixture accounts, and removes its exact fixtures and isolated queue. It never starts a browser or consumer.

An initial pool-size-one run exposed a cancellation helper acquiring another database connection while holding a transaction. That run failed with `Error: timeout exceeded when trying to connect`; its fixtures were removed. The helper now uses the existing transaction context. The rerun passed:

```text
PASS atomic daily budget shared across hunts; 2 allowed, third capped
PASS repeated enqueue and repeated dispatch do not duplicate jobs
PASS cross-user cancellation rejected; waiting cancel and explicit safe retry persist
PASS missing never-started Redis job restored from durable DB dispatch
PASS durable submit fence rejects retry even with no event telemetry; flag is durable
Fixture users, jobs, and isolated Redis queue removed; no consumer or browser started
```

## Remaining production boundaries

External submission is not a database transaction. Unexpected JavaScript buttons can submit through custom handlers; native form semantics and known submit controls are guarded, but each live provider still needs a reviewed acceptance run. Cookie evidence cannot guarantee the provider will accept the session. Model/runtime failures can still park a job. Event writes are best-effort, although the submit fence is not. Queue durability assumes Postgres and Redis backups and tested restore procedures. Live provider submissions, real sign-ins, load testing, disaster recovery, and monitoring rollout are separate release gates, not implied by passing these fixtures.
