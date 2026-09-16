# Job Hunters UX journey audit

Date: 2026-09-16. Visual design preserved. Payments and Gmail access excluded.

## Verification boundary

- Returning-user journey: inspected in the already signed-in Chrome extension session. Confirmed 705 jobs, 313 eligible, 100 checkboxes per page, top-100 selection persisted across pages, and four visible queued applications after recovery.
- New-user journey: used an isolated password-disabled post-signup fixture. Tested resume skip, role answer, next question, reload recovery, empty Applications, and mobile navigation. Signup service and completion/session connection were code-traced. This was not a real Google/provider login or a full production signup-to-submission acceptance test.
- Browser watch: used an isolated headless Chrome page and temporary application/user fixtures, then tested the actual LiveView component with that fixture frame. No real provider login or application submission. Temporary DB fixtures were removed.
- Operational state: no runner found on laptop or VM; queue reports no connected worker. Current browser provider is browser-use, while user sessions are VM profiles. APPLY_DRY_RUN remains true. Production end-to-end application execution is therefore NOT certified.
- Findings distinguish reproduced issues, code/configuration risks, and proposed improvements. This covers the primary paths and observed edge cases, not every hypothetical failure.

## Intended journeys

Returning user: open Scraped Jobs → filter/sort → select → preflight → queue confirmation → Applications → active read-only watch → review or final result.

New user: signup → resume → preferences → resumable setup checklist → human provider connection where required → readiness check → first scrape → select → queue → watch → result.

## Implemented in this pass

- Checkboxes on every scraped-job card, including explained disabled states; selection no longer writes candidate rows.
- Eligible 313 restored on the real user account; eligibility is stored separately from application progress.
- All-hunts browsing, global sorting, matching filter counts, query-wide top 100, clear selection, and cross-page persistence.
- Untouched candidates are no longer rejected when a subset is approved; ownership and duplicate checks run before queueing.
- Watershed and Render recovered into Applications without retrying. The live account now shows four queued jobs.
- Applications auto-refreshes, paginates, shows real queue/runner diagnostics, and no longer counts queued jobs as sent.
- Watch browser entry for active attempts, read-only frame rendering, late-viewer frames, stale-frame age, and authenticated reconnect.
- Server-enforced read-only WebSocket path; forged click/key/scroll/release messages were rejected in an isolated live Chrome test.

## Remaining findings, in priority order

### UX-01 · P0 · Returning · No application runner is connected

- Evidence: Observed on laptop, VM service inventory, and queue diagnostics. Four real applications are waiting.
- Verification: Operational blocker.
- Fix / acceptance target: Deploy and supervise the runner on the VM, share the correct Redis, then test one approved fixture before releasing pending work.
- Source: `src/runner.ts; docs/deployment.md`

### UX-02 · P0 · Returning · Connected VM profiles do not match the configured browser provider

- Evidence: Current configuration reads browser-use; openSession selects solely from BROWSER_PROVIDER while portal account references can be vm: IDs.
- Verification: Code and configuration.
- Fix / acceptance target: Validate provider/profile compatibility before queueing, route VM profiles to the VM runner, and show a deployment readiness check.
- Source: `src/browser/session.ts; src/hunt/apply.ts`

### UX-03 · P0 · Both · Readiness can claim a connection that is not verified

- Evidence: Disconnect always saves session ready; unverified portal rows are not cleared. Instahyre accepts csrftoken alone and verification can fall back to a screenshot model.
- Verification: Code risk, no provider login attempted.
- Fix / acceptance target: Use verified authenticated-session evidence, keep per-provider stale/unknown states, and never make the overall session ready solely because Chrome stopped.
- Source: `src/modules/me/routes.ts; src/browser/providers.ts`

### UX-04 · P0 · Returning · Opening account setup can interrupt an active application

- Evidence: ensureTenantConnected replaces a browser running in the other mode instead of preserving its active application.
- Verification: Code audit.
- Fix / acceptance target: Return a clear busy state and link to the active application; require explicit, safe stop before a mode switch.
- Source: `src/browser/vm-client.ts`

### UX-05 · P1 · Returning · Application preflight happens too late

- Evidence: Scraped Jobs can select and queue jobs before users see all provider/profile/resume prerequisites together. Missing fields return text errors; the Hunt page has a separate missing-field flow.
- Verification: Code audit.
- Fix / acceptance target: Add one shared readiness check before the bulk action with direct links or an inline form; preserve selection when resolving gaps.
- Source: `src/pages/ScrapedJobs.tsx; src/pages/Hunt.tsx; src/hunt/approval.ts`

### UX-06 · P1 · Returning · Immediate apply and paced daily apply are not distinguished

- Evidence: Queue spacing spreads a batch over an 11-hour window. Users clicking Apply expect sequential work to start promptly.
- Verification: Code audit.
- Fix / acceptance target: Offer explicit Apply now versus paced schedule, show the next start time and queue position, and explain why a job is delayed.
- Source: `src/hunt/application-queue.ts`

### UX-07 · P1 · Returning · Daily cap is not a remaining daily budget

- Evidence: The planner caps each batch at 100 without subtracting earlier batches from that day.
- Verification: Code audit.
- Fix / acceptance target: Enforce an atomic per-user daily budget across hunts and display remaining capacity and next reset time.
- Source: `src/hunt/application-queue.ts`

### UX-08 · P1 · Returning · Concurrency needs one authoritative user-facing limit

- Evidence: A DB setting allows parallel applications but one VM profile cannot be launched twice; current slot locks also have a fixed 15-minute expiry without renewal.
- Verification: Code audit.
- Fix / acceptance target: Use renewable ownership locks, serialize use of one VM profile, and show configured versus effective concurrency.
- Source: `src/hunt/application-queue.ts; src/browser/session.ts`

### UX-09 · P1 · Returning · Cancel and safe retry are missing from the application list

- Evidence: Applications offers review, manual completion, and close; it has no clear queued-job cancellation or idempotent retry workflow.
- Verification: Code audit.
- Fix / acceptance target: Cancel only waiting jobs, distinguish cancellation from closing history, and require a prior-submission check before retrying uncertain attempts.
- Source: `src/pages/Applications.tsx; src/modules/applications/routes.ts`

### UX-10 · P1 · Returning · Partial queue failure still needs durable recovery

- Evidence: DB state and BullMQ enqueue are separate operations; a failure can leave approved state or an application record without runnable queue work. Multiple-hunt batches can partially complete.
- Verification: Code audit.
- Fix / acceptance target: Introduce a durable enqueue/outbox state, return per-job results, and reconcile safely without automatic duplicate submission.
- Source: `src/hunt/approval.ts; src/hunt/application-queue.ts`

### UX-11 · P1 · Returning · A stuck watch needs an escalation action

- Evidence: The new watch is genuinely read-only, but there is no Flag for review workflow to record context and safely pause future jobs.
- Verification: Remaining feature.
- Fix / acceptance target: Add an authenticated flag record with attempt/time/reason, pause subsequent work, and display acknowledgement. Do not enable browser control.
- Source: `src/components/LiveView.tsx; plan.md section 10.3`

### UX-12 · P1 · Returning · Application history is fragmented

- Evidence: Attempt events are recorded, but the Applications detail timeline uses application_events; direct worker updates do not consistently populate that timeline.
- Verification: Code audit.
- Fix / acceptance target: Show one chronological history including queue, resume preparation, browser start, blocked reason, evidence, and final result.
- Source: `src/hunt/apply/state.ts; src/hunt/apply.ts; src/modules/applications/routes.ts`

### UX-13 · P1 · Both · Sidebar falsely reports a healthy robot and fixed schedule

- Evidence: The signed-in page says Robot is awake and Next scrape at 06:00 even when no runner is connected. Both strings are static.
- Verification: Live and code verified.
- Fix / acceptance target: Use actual worker health and the user schedule, with a visible offline or action-required state.
- Source: `src/components/Shell.tsx`

### UX-14 · P1 · New · Onboarding refresh loses the current screen

- Evidence: In an isolated post-signup fixture, selecting a role advanced to question 2; reloading /welcome returned to the initial greeting.
- Verification: Live fixture reproduced.
- Fix / acceptance target: Persist or derive the current step and rehydrate the saved resume and answers. Offer Continue setup from the last incomplete step.
- Source: `src/pages/Onboarding.tsx`

### UX-15 · P1 · New · Resume skipping hides later application requirements

- Evidence: Resume can be skipped and Next is enabled without a file. Upload parse failure can still leave a picked resume and allow moving on.
- Verification: Live skip and code audit.
- Fix / acceptance target: Keep skipping possible, but label applications as blocked until a usable resume exists; show parse state and a clear retry/replace action.
- Source: `src/pages/Onboarding.tsx`

### UX-16 · P1 · New · Finishing onboarding spans two separate saves

- Evidence: finish first completes intake, then sends /me/onboarding. A network failure between them can leave partially completed setup.
- Verification: Code audit.
- Fix / acceptance target: Make completion idempotent and resumable, or combine it transactionally; test retry after each failed save.
- Source: `src/pages/Onboarding.tsx; src/modules/me/routes.ts`

### UX-17 · P1 · New · Account setup starts a remote browser automatically

- Evidence: BrowserSession connects on mount. Continue later is only visible when no connection exists; leaving does not explicitly save/flush and close the session.
- Verification: Code audit, human sign-in not exercised.
- Fix / acceptance target: Provide a clear start/continue-later choice, persist progress, and define a graceful save-and-exit action that never interrupts an apply browser.
- Source: `src/pages/BrowserSession.tsx`

### UX-18 · P1 · Both · Source enabled, account connected, and apply supported are confused

- Evidence: Hunt uses connected for source toggles, browser session status, and portal account state, though anonymous ATS pages do not require accounts.
- Verification: Code audit.
- Fix / acceptance target: Show separate Source enabled, Account verified, and Apply supported labels backed by one capability catalogue.
- Source: `src/pages/Hunt.tsx; src/browser/providers.ts`

### UX-19 · P1 · Both · Application email and connected Google account may differ

- Evidence: The kit has its own email, account connection stores provider verification, and there is no visible check tying the intended application email to the signed-in browser.
- Verification: Design gap from code.
- Fix / acceptance target: Ask the user to confirm the application contact email and explain which account/session is used. Do not infer permission to inspect Gmail.
- Source: `src/pages/Kit.tsx; src/modules/me/routes.ts`

### UX-20 · P1 · Both · Session removal and recovery lack a complete product path

- Evidence: Setup copy mentions revocation, but there is no full remove/revoke session workflow with deletion scope and reconnect consequences.
- Verification: Code audit.
- Fix / acceptance target: Add explicit disconnect versus remove actions, explain retained application history, and preserve access to reconnect without deleting unrelated progress.
- Source: `src/pages/BrowserSession.tsx; src/modules/me/routes.ts`

### UX-21 · P1 · Both · Mobile navigation is overcrowded

- Evidence: At a 390px viewport, nine bottom navigation items are rendered. Measured targets include widths of 21px and 22.7px.
- Verification: Live mobile measurement.
- Fix / acceptance target: Keep the same styling but use a small primary navigation set plus More, with adequate touch targets and keyboard labels.
- Source: `src/components/Shell.tsx`

### UX-22 · P2 · New · Signup landing claims contradict the live product

- Evidence: The public landing page still says demo build, any email/password works, and no backend, while signup uses real auth.
- Verification: Live and code verified.
- Fix / acceptance target: Replace demo claims and mock activity claims with accurate product copy.
- Source: `src/pages/Landing.tsx; src/pages/AuthPage.tsx`

### UX-23 · P2 · New · Login loses the intended destination

- Evidence: The auth guard remembers the requested path, but AuthPage sends users to /app or /welcome instead of using it.
- Verification: Code audit.
- Fix / acceptance target: Restore a validated local return path after authentication and onboarding.
- Source: `src/auth/guards.tsx; src/pages/AuthPage.tsx`

### UX-24 · P2 · New · Account recovery is incomplete

- Evidence: The auth UI and routes expose login, signup and change password, but not a forgotten-password recovery flow.
- Verification: Code audit.
- Fix / acceptance target: Add secure reset/recovery and clear handling for Google-only accounts without weakening authentication.
- Source: `src/pages/AuthPage.tsx; src/modules/auth/routes.ts`

### UX-25 · P2 · Both · Eligible does not necessarily mean runnable now

- Evidence: Restored eligibility reflects the saved matching decision. It includes already-processed and unsupported-link jobs, correctly disabled for selection.
- Verification: Live and code verified.
- Fix / acceptance target: Explain the distinction and consider a separate Available to apply facet while retaining the green Eligible filter.
- Source: `src/modules/dashboard/job-policy.ts; src/pages/ScrapedJobs.tsx`

### UX-26 · P2 · Returning · Selection is lost on a full reload or navigation away

- Evidence: Selection now survives filters and pagination, but remains component state.
- Verification: Code audit.
- Fix / acceptance target: Persist a scoped draft selection with expiry, revalidate on return, and tell the user which jobs became unavailable.
- Source: `src/pages/ScrapedJobs.tsx`

### UX-27 · P2 · Both · Provider coverage is not reconciled with onboarding

- Evidence: The connection registry has Google, Wellfound and Instahyre only. The source catalogue is larger; account requirements vary by source.
- Verification: Code audit.
- Fix / acceptance target: Audit actual scraper/application support, include only supported account-based providers, and explain anonymous sources. Do not add popular sites without adapters.
- Source: `src/browser/providers.ts; src/db/portal-catalogue.ts`

### UX-28 · P2 · Returning · Watch reconnection and handoff could be smoother

- Evidence: Manual reconnect now refreshes product authentication and stale frames are labelled. The panel does not auto-follow the next queued application or provide a durable replay.
- Verification: Remaining improvement.
- Fix / acceptance target: Offer explicit Follow my queue, bounded auto-reconnect, and a persisted event summary after the browser closes.
- Source: `src/components/LiveView.tsx; src/pages/Applications.tsx`

### UX-29 · P2 · Both · Dry-run state is not obvious at selection time

- Evidence: Current APPLY_DRY_RUN is true. A user can queue preparation work without being clearly told that final submission will be held.
- Verification: Configuration verified.
- Fix / acceptance target: Expose the execution mode in preflight and result history. Only enable real submission through an explicitly approved operational rollout.
- Source: `src/config/env.ts; src/pages/ScrapedJobs.tsx`

## Gates

- API typecheck: passed.
- API tests: 258 passed, 0 failed.
- UI build: passed; existing large-bundle warning remains.
- UI selection tests: 6 passed, 0 failed.
- Read-only DB checks: ownership rejection, global pagination/deduplication, eligibility counts, top-100 availability and sort, filter counts passed.
- Live Chrome fixture: authenticated JPEG relay, late-state hydration, cross-user rejection, missing-token rejection, and zero forwarded input passed.
- LiveView fixture: image rendered at 1200px source width, zero iframes, zero takeover buttons/countdowns, pointer events disabled, zero forwarded input.
- Migration 0022: one additive nullable eligibility_status column; applied. Subsequent db:generate reports no schema changes.

## Recommended next implementation order

1. Fix runner deployment/provider/profile compatibility and perform a single isolated dry-run acceptance test on the VM. Do not release the pending queue blindly.
2. Correct provider readiness and protect active applications from connection-mode switches.
3. Add shared application preflight, accurate scheduling/budget/concurrency controls, and safe cancel/retry.
4. Make onboarding resumable and clarify source/account/application readiness.
5. Complete reporting/escalation, mobile navigation, account recovery, and draft-selection recovery.
