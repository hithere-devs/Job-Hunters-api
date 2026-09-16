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

## Live questions and question inbox

Unanswered fields become structured, user-owned questions. A live browser waits up to ten minutes under the existing renewable application leases. Answers are applied only to the captured host and exact field identity, after re-reading current controls and validating the offered options. An answer is literal form data, never a browser instruction or model prompt. Radio groups use their question heading, not an opaque field ID or the first option. Checkbox false unchecks the control.

- `GET /applications/:id/questions` returns the current attempt's questions and waiting deadline.
- `POST /applications/:id/questions/:questionId/answer` accepts `answer`, explicit `remember`, or `skip` for an optional question.
- `GET /applications/questions` groups matching outstanding questions by host, field signature, options, and required/sensitive state. Employer-specific and non-reusable questions remain separate per application.
- `POST /applications/questions/answers` saves up to 500 answers atomically, bounded to 750 KB. An invalid option or cross-user question rejects the whole request. Live attempts continue; expired pre-submit attempts may be queued safely once required questions are answered. Unknown or submit-fenced attempts remain blocked.
- `POST /applications/:id/recover-questions` reopens only a provably pre-submit, inactive attempt to capture missing legacy labels/options.

No password, OTP, verification-code, or CAPTCHA question is accepted in chat. Optional demographics require an explicit answer or explicit skip. Remembering is opt-in and occurs only after the provider control accepted the value; legal/reference and employer-specific answers are not reused across applications. Question answer values are excluded from stream events and question DTOs. Driver errors during answer writes are sanitized so SQL parameters cannot leak answers to logs.

The inbox uses batch reads rather than one set of queries per application. A failed fixture exposed the shared Supabase session-pool connection limit, not a question validation failure. After the parent rollout switched to transaction pooling, the fixture passed with `DATABASE_POOL_MAX=1`:

```text
Known failed-fixture cleanup: 0 users, 0 referenced jobs
PASS radio group exposes readable question, not opaque UUID or option label
PASS cross-owner answers rejected; invalid option rolls back entire batch
PASS live answers applied to exact controls; false unchecked; literal text not executed; no submit
PASS expired answers autoqueue only proven pre-submit attempts; fenced unknown attempt stays blocked
Fixture browser and DB records removed; no provider login or application submission
```

This was an isolated browser/DB test using `fixture.invalid`, not a provider login or real application. Run it with `APPLICATION_QUEUE_NAME=hunt-apply-test-<unique> DATABASE_POOL_MAX=1 npx tsx src/scripts/verify-live-questions.ts`. The earlier failing gate reported `(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15`; cleanup verification found no residual users or referenced jobs from that failed attempt.

### Legacy question metadata correction

Older review summaries do not establish that a field was required, or even capture its true options. Incomplete summaries now use `required=false` and `blockedReason=legacy_metadata`. They are not presented as unconstrained sensitive questions. Known common profile fields can still be answered once, while provider-specific questions require a safe explicit recovery to read the real form.

The repair touches only unanswered, expired rows with no field name/options and a legacy immediate-expiry timestamp. It does not overwrite saved answers, current live questions, field IDs, or in-flight answer submissions. Previously saved answers remain attached to their original attempt. On recapture, they are checked against the actual field/options; a mismatch asks for clarification with a saved-answer note rather than discarding the earlier record.

LinkedIn URL/Profile/legacy “no fact provided” aliases share one profile question across applications. Explicit Remember writes the validated value into My Kit once, transactionally with the answer batch. Invalid profile values roll the batch back. Context-sensitive questions remain per application and are never grouped as general facts.

The isolated `verify-legacy-questions.ts` gate passed:

```text
PASS incomplete legacy demographics hidden; only unanswered legacy metadata repaired; saved/live rows unchanged
PASS three LinkedIn aliases across providers form one shared optional profile question
PASS explicit remember updates My Kit once; invalid profile value rolls back; no uncaptured application autoqueued
Fixture records and isolated queue removed; no live user answers changed
```

Conditional fields are also re-evaluated after each answer. The reader ignores controls in hidden sections, while keeping native radio/checkbox inputs that are merely visually hidden. During a live question wait, a field becomes inapplicable only when its control still exists inside the original connected, visible form, the URL has not changed, and its wrapper is now hidden. Its saved answer is retained with a “No longer required” note. The fixture verified that answering No to student status hides and removes the required start-date question without submitting.

```text
PASS answering No removes hidden conditional question in the same form without submitting
```

## LLM-led VM applications and semantic answer reuse

The VM queue now runs Muse reasoning for every application, after cheap profile filling and one grounded answer-resolution batch. It preserves the current page between at most three reasoning rounds, with at most 18 actions per round and a shared ten-minute reasoning budget. After new human answers, Muse reviews the page again. Missing model configuration blocks live submission rather than silently replacing the requested engine with a deterministic submit.

The profile resolver checks up to 30 questions per batch. Validated high-confidence facts and grounded, non-sensitive professional drafts can be applied automatically. Source quotes and provenance are stored as profile_ai, never as explicit_user. Previous AI answers are excluded as new human evidence. A source fingerprint prevents repeated automatic calls against unchanged information; sensitive/contextual cached answers remain application-scoped. A human answer arriving during resolution cannot be overwritten by the resolver.

POST /applications/questions/resolve accepts optional question IDs and explicit retry. includePreviousResponses:true records the signed-in user's authorization to reuse their previous human replies; it does not change another user's opt-out. Future human replies default to saved, while context-specific answers are still checked in context rather than blindly copied.

The question DTO distinguishes answerPresent, answerValid, and requiresNewAnswer. A valid boolean saved before a browser failure is known information, even when its question row expired. It is an automation recovery or submission-verification issue, not a reason to ask the user the same question again.

### Final-submit classification correction

A native type=submit alone is not proof of final submission. Accessible question choices with positive group semantics do not create an irreversible-submit fence. Explicit Next/Back/Save-and-continue steps require positive DOM progression evidence. Ambiguous Continue/Apply/Submit controls retain the final guard. Native form validity is checked before recording final-submit intent.

The isolated control fixture passed:

~~~text
PASS Ashby-style submit-typed radio choice is not a final-submit fence
PASS invalid native form does not create irreversible submission intent
PASS actual final submit invokes the durable fence exactly once
PASS explicit Next advances only with DOM step proof; ambiguous Continue has no exemption
Fixture browser closed; no login or real application submitted
~~~

Existing uncertain historical attempts were not retried and their fences were not cleared. The fix prevents new false classifications; it does not establish whether an older provider request reached an employer. Unlabelled custom widgets and ambiguous wizard controls can still require a reviewed adapter. The fixture is not proof of a real employer submission.
