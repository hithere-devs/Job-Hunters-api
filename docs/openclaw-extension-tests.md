# OpenClaw extension setup and verification

Verified runtime: OpenClaw 2026.9.3, bundled OpenClaw Chrome extension 2.3.0,
Manifest V3. These are maintenance operations on the VM, not signup actions.
Do not run while applications are active. Tenant 3 is protected and these
scripts refuse it. The current authorized test tenants are 2 and 9.

## Stage the official extension

Deploy the four `scripts/*openclaw*.mjs` files together under the API deployment's
`scripts/` directory. They resolve runtime dependencies from `/opt/huntly/api`.
Then, on the VM:

```sh
sudo env HUNTLY_EXTENSION_INSTALL_APPROVED=tenant-2 \
  node /opt/huntly/api/scripts/install-tenant-openclaw-extension.mjs 2
```

The script refuses an active policy, an unpaused application queue, or active
BullMQ jobs. It does not pause queues itself. It:

1. Uses the official CLI to add `extension-test` without replacing an existing
   different profile. The relay port is the tenant gateway port plus 12.
2. Disables legacy relay authentication.
3. Runs `browser extension install --no-store` and checks its report.
4. Copies the exact official native-host registration into the custom Chrome
   profile's `NativeMessagingHosts` directory. Foreign files are never replaced.

The installer originally rejected group-writable runtime files. Root corrected
package permissions, then the official checks passed. Do not disable those
checks or install a modified native host to work around them.

The official CLI stages the extension; it does not approve Chrome's installation
UI on Linux. With the browser in **Flow A**, open `chrome://extensions`, enable
Developer mode if needed, choose **Load unpacked**, and select:

- Tenant 2: `/home/huntly-u2/.openclaw-huntly-u2/browser/chrome-extension`
- Tenant 9: `/home/huntly-u9/.openclaw-huntly-u9/browser/chrome-extension`

Expected unpacked IDs are respectively
`jokcobodfhaacmclpfhefkmjigchihkj` and
`nnjejldhmknpmnilfgjgpgemabpcodal`. The permissions are debugger, tabs,
tabGroups, storage, alarms and nativeMessaging. Approval remains a human step.
Do not load the extension into another person's local Chrome profile.

The native host lives at both the standard Chromium registration location and
our custom profile location:

```text
/home/huntly-u2/.config/google-chrome/NativeMessagingHosts/ai.openclaw.browser_bootstrap.json
/home/huntly-u2/profile/NativeMessagingHosts/ai.openclaw.browser_bootstrap.json
```

A graceful browser restart is required after correcting a missing native host,
because Chrome caches that failure. Use the VM agent to stop and restart; never
kill Chrome or alter cookie files. The custom-profile manifest copy plus restart
produced automatic pairing. No pairing secret was printed or entered manually.

## Enable only the experimental tenant

The tenant's root-owned gateway env file must explicitly contain:

```dotenv
HUNTLY_BROWSER_PROFILE=extension-test
HUNTLY_EXTENSION_CDP_PORT=20801
```

Tenant 9 uses 27801. Restart only the affected idle gateway after configuration.
The default `tenant` raw-CDP profile remains intact. Application routing switches
only when `OPENCLAW_BROWSER_PROFILES` explicitly maps the tenant to
`extension-test`; do not enable it before the gates pass.

Flow A must stop the tenant gateway **before** launching Chrome. Flow B starts
it only after Chrome's CDP endpoint is ready. Otherwise a retained Playwright
relay client can automatically attach to a newly opened login browser.

## Guarded DOM fixture

Pause the application queue and wait for zero active jobs. Start the authorized
tenant in Flow B through the VM agent, then run:

```sh
sudo env HUNTLY_FIXTURE_AUTHORIZED=tenant-2 \
  node /opt/huntly/api/scripts/verify-openclaw-extension.mjs 2
```

The fixture creates its own `https://example.com` tab and replaces that tab's
content locally with a synthetic form. No real application is submitted. Its
submit handler prevents network submission even if a guard regresses.

It exercises OpenClaw through the extension and the same application guard:
name entry, an explicitly approved boolean, portaled location autocomplete, a
synthetic résumé upload, and a deliberately denied final-submit attempt. It
checks the relay's target ID against the physical Chrome target and verifies
that tenant 9's token cannot authenticate to tenant 2's gateway.

Only the ephemeral staged résumé is temporarily replaced. Its original bytes
are retained privately and restored afterward, without replacing a newer file
written by somebody else. Database résumé assets are untouched. The script
revokes its own policy, closes its own tab, and stops Chrome through the VM
agent. It never inspects passwords or cookie values.

Observed gate:

```json
{"gate":"extension-guarded-dom-fixture","tenant":2,"attemptId":"7ecdf33c-5ea2-4c03-b42a-5793dfcb4230","transport":"extension","physicalTargetMatch":true,"wrongTenantRejected":true,"syntheticResumeUploaded":true,"finalSubmitDenied":true,"status":"ok","quiescent":true,"stepEvents":77,"nameFilled":true,"authorizationExplicitFalse":true,"locationCommitted":true,"finalSubmitUntouched":true}
```

A read-only projection of that fixture's tool result and preceding snapshot
also confirmed the denial targeted the actual final button, not another blocked
control:

```json
{"gate":"fixture-final-control-proof","seq":34,"ref":"e12","refIsSubmitApplication":true}
```

The committed script adds explicit authorization and paused-queue preflight
checks around the successful fixture body. Its syntax was checked; do not rerun
it against a resumed production queue merely to exercise those preflight checks.

## Flow A negative gate

With tenant 2 idle and the queue paused:

```sh
sudo env HUNTLY_FIXTURE_AUTHORIZED=tenant-2 \
  node /opt/huntly/api/scripts/verify-openclaw-flow-a.mjs
```

This opens a connect browser without logging in, checks that the gateway,
relay and CDP ports are closed, and then stops Chrome. Observed output:

```json
{"gate":"extension-flow-a-no-debugger","tenant":2,"previousGatewayListening":true,"mode":"connect","gatewayUnit":"inactive","gatewayPortClosed":true,"cdpPortClosed":true,"relayPortClosed":true,"chromeHasNoDebuggingFlag":true}
{"gate":"extension-flow-a-cleanup","mode":"idle","gatewayPortClosed":true,"relayPortClosed":true}
```

The extension transport itself does not provide richer DOM access than our
existing Playwright/CDP driver. These gates establish that it works safely with
our guard and existing Chrome profile. A real provider application and its
submission receipt remain a separate acceptance test.

## Gemini model switch and tool gate

The first real extension attempt reached an Anthropic credit error before any
browser tool. Driver changes would not fix that. A funded OpenRouter key was
configured privately, never printed or committed.

Native OpenClaw settings that were validated:

```json
{
  "models": {"providers": {"openrouter": {"apiKey": "${OPENROUTER_API_KEY}"}}},
  "agents": {"defaults": {
    "model": {"primary": "openrouter/google/gemini-3.1-flash-lite", "fallbacks": []},
    "thinkingDefault": "low",
    "models": {"openrouter/google/gemini-3.1-flash-lite": {"params": {"maxTokens": 2048}}}
  }},
  "plugins": {
    "allow": ["browser", "huntly-application-guard", "openrouter"],
    "entries": {"openrouter": {"enabled": true}, "perplexity": {"enabled": false}}
  },
  "tools": {"web": {"search": {"enabled": false}, "fetch": {"enabled": false}}}
}
```

Merge these into existing configuration; do not discard other safety settings.
The key belongs in the root-owned gateway env file. Enabling the OpenRouter key
without explicitly disabling unneeded Perplexity caused OpenClaw to attempt an
unwanted plugin installation and refuse gateway startup. Disabling that plugin
fixed startup without weakening filesystem permissions.

Gemini 3.5 Flash's native default requested 65,536 output tokens and failed
OpenRouter's credit preauthorization. Output caps and the cheaper 3.1 Flash Lite
model avoid that excessive reservation. Never purchase credits automatically.

The no-tools native Lite gate returned:

```json
{"gate":"native-openclaw-gemini9","tenant":9,"attemptId":"1b5d7dcb-22ff-44fd-af59-212ce9029e54","status":"ok","quiescent":true,"replyMatches":true,"actualProvider":"openrouter","actualModel":"google/gemini-3.1-flash-lite","stopReason":"stop","toolResultCount":0,"errorCategories":[]}
```

The first Lite extension fixture failed résumé upload. It supplied the correct
path and inputRef but combined them with `action:act, kind:type`. The fixture's
final syntax instruction had listed only snapshot and act, contradicting its
upload instruction. The corrected prompt spells out the separate upload action
and forbids adding kind, submit, ref, or element. The application guard was not
relaxed. The file input is now required in the fixture.

The corrected full native Lite extension gate passed:

```json
{"gate":"extension-guarded-dom-fixture","tenant":2,"attemptId":"073a7fa9-5900-4aa2-8128-789891782258","transport":"extension","physicalTargetMatch":true,"wrongTenantRejected":true,"syntheticResumeUploaded":true,"finalSubmitDenied":true,"status":"ok","quiescent":true,"stepEvents":57,"nameFilled":true,"authorizationExplicitFalse":true,"locationCommitted":true,"finalSubmitUntouched":true}
```

This verifies real multi-turn Gemini tool handling through the extension,
including upload and guarded sensitive choices. It is still a synthetic form,
not evidence that a real employer accepted an application.
