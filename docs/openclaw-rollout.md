# OpenClaw application rollout

## Runtime

- OpenClaw 2026.9.3, gateway protocol schemas pinned to 2026.8.1, protocol v4.
- `deploy/provision-openclaw.mjs` creates ten OS-user-scoped gateways. Run as root on the VM. It reads the existing root-owned runner environment and never prints secrets.
- Gateway base 19789, stride 1000. The operator's personal gateway remains on 18789. All gateway, browser-control, CDP, VNC and VM-agent listeners are loopback-only.
- Each gateway attaches to `http://127.0.0.1:9200+tenant`, which is Chrome's existing Flow B profile. Flow A still has no CDP.
- `APPLY_DRIVER=openclaw` selects the new reasoning tier after the deterministic ladder. Claude Sonnet 5 replaces Muse in both OpenClaw and the retained fallback.
- Root-owned per-attempt policies authorize one target, host list, deadline, explicit sensitive answers, and one resume. The plugin rejects shell tools, login/OTP/CAPTCHA, arbitrary navigation, unapproved choices and final submission.
- Resume staging uses the documented tenant `media/inbound` directory. Policy revocation removes the staged copy. The durable original resume remains in application storage.
- Final submit stays in Huntly's guarded code. A database submission fence prevents automatic duplicate submission after uncertain confirmation.
- `src/agent/` remains as a fallback only after confirmed OpenClaw quiescence. It is not retired until three postings across two ATS families pass.

## Watching

Flow B starts x11vnc with `-viewonly -noclipboard`. Switching modes stops both VNC services first, terminating old interactive clients. The API verifies identity, current owned attempt, active queue lease, VM mode and read-only state before accepting `/live/:attemptId/vnc`, then repeats the checks. The UI uses noVNC with input disabled and retains the frame-stream fallback. Nudges use an attempt-scoped Redis relay to the runner.

## Verified gates

```text
PASS tenant9/10 isolation: distinct CDP profiles retain independent synthetic markers on the same example.com origin.
PASS native Chrome guard: hidden reCAPTCHA and optional Sign in do not block snapshots; visible human-verification challenge does.
PASS tenant9 token rejected by tenant10 gateway: INVALID_REQUEST.
PASS native OpenClaw upload: guarded hidden file input received synthetic PDF from tenant managed inbound-media path.
PASS native Ashby boolean guard: exact approved false clicked No; unapproved Yes and final submit denied; no submit event fired.
```

```json
{"gate":"actual-gateway10-no-tools","status":"ok","cancelConfirmed":true,"eventCount":9,"protocolReplyMatches":true,"error":null}
{"gate":"actual-gateway10-wait-deadline","status":"timeout","cancelConfirmed":true,"eventCount":2,"protocolReplyMatches":false,"error":"OpenClaw hard deadline exceeded"}
{"gate":"tenant9-server-viewonly","mode":"apply","vncReadOnly":true,"rfb":"RFB 003.008","positiveControl":true,"vncKeysIgnored":true,"vncClicksIgnored":true}
```

The actual Mercor desktop rendered in the signed-in Chrome extension session on Live Applications, using tenant 2 and noVNC. This proves watching, not submission.

## Live rollout failures retained for review

Mercor Fullstack Software Engineer, Agent Platform:

- Attempt `e4e5a03f-18c9-4eae-992d-0b1c3b81fdfe`: OpenClaw deadline, confirmed cancellation, fallback ended `needs_review`. No submission intent. Found missing native Ashby boolean recognition and previously saved answers excluded after failed DOM fills.
- Attempt `7f9e1003-868c-47d6-bd16-fa372945ab69`: also ended `needs_review`, no submission intent. Tool-result diagnostics showed unsupported actions and legitimate choice refs rejected as unproven clicks. Do not count either as a completed application.

- Attempt `8917cb98-cd18-4e3b-bb7f-b62460dfd13e`: ended `needs_review`, no submission intent. The portaled location suggestion could not be associated with its owning question. Native fixture now verifies the corrected association. At the user's request, the next experiment uses the official browser extension instead of another direct-driver retry.

An older, different Mercor application has an uncertain submission fence. It was not retried or cleared.

## Plan corrections

- The gateway protocol package supplies schemas, not a ready-made client.
- `existing-session` uses a different reference driver. The tested guard uses the pinned native Playwright reference resolver and a raw-CDP attach-only profile.
- Tenant 10 display :20 was occupied by Chrome Remote Desktop. Tenant 10 uses :30; no human desktop was stopped.
- OpenClaw's managed inbound directory supports resume uploads without breaking systemd PrivateTmp.
- Only `tools.loopDetection.enabled` is configurable in this pinned version. Custom threshold fields fail schema validation.
- Work authorization cannot be derived from residence alone. Explicit country-matched user answers are reused; missing legal facts are not invented.
- Operational logs contain lifecycle/action summaries, not private model reasoning.

## Production work still required

- Complete the live multi-ATS acceptance gate before deleting the fallback.
- Pin and revalidate the guard's private OpenClaw runtime adapter on every upgrade.
- Account for OpenClaw token usage in the existing user model budget. Runtime deadlines do not replace spend limits.
- Review tenant model-key isolation before serving untrusted users. A process running as a tenant should not hold an unrestricted shared provider key; use a restricted model relay or independently scoped keys.
- Set transcript retention/deletion for the tenant SQLite state, which contains application dossiers and tool results. Session state is not "no data stored".
- Fix database TLS certificate-chain verification before public production deployment.
- Keep login and provider challenges human-driven. Do not read inboxes or credentials.

## Final code gates before extension experiment

```text
ℹ tests 379
ℹ suites 61
ℹ pass 379
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

API typecheck and UI build passed. UI retains the existing >500 kB bundle warning. `db:generate` reported no schema changes.

The VM resume upload symlink test passed: a root-owned sentinel remained unchanged, and the replaced destination was a regular 0600 file owned by tenant 9. This verifies the privilege fix, not only its source code.

## Extension experiment status

At the user's explicit request, installed the official bundled OpenClaw 2.3.0 extension assets and native messaging host for tenants 2 and 9. The browser itself still requires Chrome's Load unpacked selection. This is not a successful loaded-extension or native-relay gate.

- Tenant 2 bundle: `/home/huntly-u2/.openclaw-huntly-u2/browser/chrome-extension`.
- Tenant 2 extension ID: `jokcobodfhaacmclpfhefkmjigchihkj`; experimental relay 127.0.0.1:20801.
- Tenant 9 bundle: `/home/huntly-u9/.openclaw-huntly-u9/browser/chrome-extension`.
- Tenant 9 extension ID: `nnjejldhmknpmnilfgjgpgemabpcodal`; experimental relay 127.0.0.1:27801.
- Permissions: debugger, tabs, tabGroups, storage, alarms, nativeMessaging.
- Installer native-host issues: empty. Manual setup is still required. Custom Chrome user-data-dir bootstrap discovery must be checked after loading.
- The extension uses an alternate CDP transport. Native target-ID/ref-cache compatibility still requires a real fixture; it is not assumed to improve parsing.
- Optional per-tenant API routing and an authenticated in-process relay guard are committed locally, not activated on the VM. Default driver routing remains unchanged.
- API final gate: 380 tests passed, zero failed; typecheck passed. Guard extension helper/routing gate: 34 tests passed.
- Earlier full-suite handshake failures under local resource pressure exposed 100ms fixture deadlines. Fixture handshake headroom was increased without changing production deadlines or test assertions; the final full suite passed.
- Browser extension control became unavailable while opening the VM Chrome Load unpacked chooser. Installation confirmation and the live extension test are parked until browser control reconnects. The application queue is paused with no active jobs, preserving all records.
