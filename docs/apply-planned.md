# The planned application driver

`APPLY_DRIVER=planned` (the default). Replaces the Jev step loop and the
OpenClaw/extension drivers, which remain only for rollback.

## Why

Production data from Sep 16–19 (one user, 91 applications): 20 applied, 71 in
review. Of ~250 real attempts, 8% were confirmed submitted. The causes, in
order:

| Cause | Attempts | Fixed by |
|---|---|---|
| Submitted with required fields known to be empty ("Submit control", `invalid_fields`) | 71 | Submit gate |
| Click recorded as `unknown`, non-retryable, after an unrecognised result | 23 | Multi-signal confirmation, fence before click |
| Required questions with no answer (EEO, office, sponsorship, consent, location) | ~120 labels | Schema-first planning, explicit Kit facts, question inbox before the browser opens |
| "Browser busy" deferrals recorded as failed attempts | 241 rows | Stale-browser reclaim, no row for a deferral |
| Single profile, one application at a time, cold Chrome per job | all | Throwaway browser contexts, fair queue |

Greenhouse and Ashby carried 92% of volume, so both publish-schema paths were
built first.

## Flow

```
queue ─► lanes ─► planned-apply
                    │
                    ├─ prepare (no browser)
                    │    published schema (Greenhouse questions API, Ashby ApiJobPosting)
                    │    deterministic answers (My Kit, résumé file, consent, work rights)
                    │    one planning call (Claude, cached dossier) for the rest
                    │    strict validation against the ATS's exact options
                    │    └─ required answer missing → question inbox, needs_answer, stop
                    │
                    ├─ browser: throwaway context, or the signed-in profile for account portals
                    ├─ open form (Ashby /application, Lever /apply, Apply button on listings)
                    ├─ résumé first, verified attached
                    ├─ match schema ↔ DOM (ATS ids/names, then labels)
                    ├─ fill + read back every field; conditional fields planned when they appear
                    ├─ final read-back, refill anything a re-render undid
                    ├─ submit gate: required fields verified, résumé attached, no errors, form valid
                    │
                    ├─ fence (durable) ─► click ─► classify
                    │    confirmed            → applied
                    │    rejected_validation  → repair, click again (×2)
                    │    verification_required→ read emailed code, enter, click again
                    │    provider_blocked     → provider_rejected
                    │    uncertain            → unknown; settled later by the receipt email
                    │
                    └─ error → failure class → transient & pre-click: requeue at 1, 5, 15 min
```

## Modules

| File | Role |
|---|---|
| `src/hunt/apply/planned/schema/` | Greenhouse and Ashby schema providers, DOM fallback |
| `src/hunt/apply/planned/answers.ts` | Deterministic answers, option matching, model-answer validation |
| `src/hunt/apply/planned/planner.ts` | The single planning call (Claude via Anthropic SDK, or the gateway) |
| `src/hunt/apply/planned/dossier.ts` | Candidate dossier: Kit, résumé text, education, the user's own past answers |
| `src/hunt/apply/planned/match.ts` | Schema field ↔ page element |
| `src/hunt/apply/planned/executor.ts` | Write and verify each field; résumé upload with confirmation |
| `src/hunt/apply/planned/gate.ts` | The submit gate |
| `src/hunt/apply/planned/driver.ts` | prepare / execute |
| `src/hunt/apply/planned-apply.ts` | Orchestration: attempt, browser, submit, outcome |
| `src/hunt/apply/confirmation.ts` | What a click did: URL, network, DOM, new text |
| `src/hunt/apply/attempt-store.ts` | One transaction for every terminal write; retry scheduling |
| `src/hunt/apply/failure.ts` | Failure taxonomy and retry policy |
| `src/hunt/apply/verification-code.ts` | Emailed codes: Gmail API, Gmail tab, borrowed profile |
| `src/browser/ephemeral.ts` | Shared Chrome, isolated context per application |

## Answers: what is and is not decided for the user

- **From My Kit:** name, email, phone, links, location, country, salary (only
  if set), notice period, non-compete (only if set), EEO answers (only if set).
- **Derived:** sponsorship and authorisation when My Kit states where
  sponsorship is needed and the job's country is known. Residence alone
  decides nothing.
- **Policy:** EEO with no Kit value → the form's own "decline" option if it
  has one, else ask. Required acknowledgements (privacy, arbitration, AI
  policy) are agreed to. Marketing/SMS consent is declined.
- **Planner:** free-text answers grounded in the résumé, office/relocation
  reasoning, "how did you hear", education from the résumé. Sensitive answers
  from the planner are accepted only when grounded in Kit or the user's own
  saved answers. Every choice must be an exact option.
- **Asked:** anything else required. Questions go to the inbox before a
  browser opens; answering them resumes the application automatically.

`src/hunt/apply/apply-preferences.ts` (legacy drivers) hardcodes personal
defaults (gender, ethnicity, "authorised to work: always yes") when the Kit is
empty. The planned driver does not use them. Set those Kit fields explicitly.

## Failure classes

| Class | Meaning | What happens |
|---|---|---|
| `transient` | Browser, network or model blip before any click | Requeued at 1, 5, 15 min, then review |
| `needs_answer` | A required answer is missing | Question inbox; resumes when answered |
| `posting_closed` | The ATS says the job is gone | Application closed |
| `unsupported` | Sign-in wall, no form, unreadable verification code | Manual |
| `uncertain_submit` | Clicked; result unknown | Upgraded to applied by the receipt email; retry needs an explicit employer check |
| `provider_rejected` | Spam flag | Terminal |
| `automation` | A field would not stay filled | Review the evidence; retry is allowed |
| `internal` | Credits, keys, configuration | Fix the deployment |

Retry policy: an attempt with a fence and no provable rejection can be retried
only with `providerChecked: true`. The UI asks the user to confirm with the
employer first.

## Browsers and concurrency

- Anonymous ATS forms: `APPLY_ANON_BROWSER=ephemeral`. One Chrome per runner,
  one incognito context per application, the page script as an init script.
  Per-user concurrency `APPLY_USER_CONCURRENCY` (2).
- Account portals (Wellfound, Instahyre, LinkedIn, Work at a Startup): the
  user's VM profile, one at a time, behind its lane. A stale apply-mode Chrome
  on that profile is reclaimed when the runner holds the lease.
- Queue fairness: `APPLY_DISPATCH_WINDOW_PER_USER` jobs per user in Redis,
  round-robin; the rest wait in `application_dispatches` (with `not_before` for
  retries).
- `RUNNER_APPLY_CONCURRENCY` (3 on the VM), `BROWSER_MAX_CONCURRENT_SESSIONS` (6).

## Operations

```bash
npm run apply:eval -- fixtures                      # Chrome against local Greenhouse/Ashby replicas
npm run apply:eval -- coverage --user <email>       # real forms, Kit-only coverage, no browser
npm run apply:eval -- coverage --user <email> --plan  # adds the planning call (model cost)
deploy/deploy-runner.sh                              # build, ship, migrate, restart (drains)
```

`GET /applications/metrics?days=30` — started→confirmed rate per application,
by ATS host, failure class and runner build, plus the top blocking questions.
`GET /applications/preflight` — runner heartbeat, build mismatch, Kit gaps.

Switching the VM: `deploy/runner-env-planned.sh --dry-run-first`, restart,
watch a few attempts end as `skipped` with complete forms, then set
`APPLY_DRY_RUN=false`.

Rollback: `APPLY_DRIVER=jev` in `/etc/huntly/runner.env` and restart; or
restore `dist.prev` (see `deploy/deploy-runner.sh`).
