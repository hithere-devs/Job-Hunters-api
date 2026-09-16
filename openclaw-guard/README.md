# Huntly OpenClaw application guard

Native `before_tool_call` plugin for OpenClaw **2026.9.3**. It is a policy hook, not another reasoning loop.

## Install and enable

Deploy this directory read-only under `/opt/huntly/openclaw-guard`. Use a root-owned plugin directory that tenants cannot edit. Every tenant gateway must explicitly load and enable `huntly-application-guard`. Restart gateways after plugin code changes.

```json
{
  "plugins": {
    "load": { "paths": ["/opt/huntly/openclaw-guard"] },
    "entries": { "huntly-application-guard": { "enabled": true } }
  },
  "browser": { "evaluateEnabled": false },
  "tools": { "allow": ["browser"] }
}
```

Merge with the installed browser plugin's allow list. Do not enable shell, filesystem, web-fetch, scheduling, session-spawning, or arbitrary-JavaScript tools. Do not load another plugin that rewrites browser arguments after this guard. The guard registers late, at priority -1000000, and denies nonbrowser tools regardless of the model prompt. No conversation-access hook permission is needed.

Use the browser `tenant` profile, attached via normal Playwright/raw CDP to `http://127.0.0.1:9200+N`. Do not use the `existing-session`/Chrome-MCP driver. Its reference store is different and this guard cannot validate its actions.

Set tenant service environment:

```text
HUNTLY_TENANT_INDEX=N
HUNTLY_POLICY_PATH=/run/huntly-openclaw/tenant-N.json
HUNTLY_OPENCLAW_ROOT=/opt/huntly/openclaw-runtime/node_modules/openclaw
```

## Run policy

Before starting each run, the VM agent atomically writes its tenant's file with mode 0640, owned by root with the tenant primary group. The parent directory must be root-owned mode 0711. The tenant can read but cannot modify policy. The agent owns creation/deletion, not OpenClaw. Remove it when a run ends or is cancelled.

```json
{
  "attemptId": "UUID",
  "targetId": "RAW_CHROME_TARGET_ID",
  "allowedHosts": ["jobs.ashbyhq.com"],
  "approvedFields": [{ "label": "Will you require sponsorship in the United States?", "type": "select", "value": "Yes" }],
  "resumePath": "/tmp/openclaw/uploads/resume.pdf",
  "deadlineEpoch": 1800000000000
}
```

The gateway session key must equal `agent:main:huntly-apply-${attemptId}`. Missing or different session context is denied.

Deadlines are epoch milliseconds, at most eleven minutes into the future. Files without valid policy, restrictive permissions, exact tenant path, approved host or bound tab fail closed. `approvedFields` contains only existing explicit, country-scoped user answers. It is not a permission to infer a sensitive answer from residence or a resume. Field labels and types must match the actual DOM, not model-supplied claims.

Upload must use exactly `resumePath` and `inputRef` for a verified enabled file input. Hidden inputs are accepted for direct file attachment; no click-to-upload or arbitrary selector permission is added. The trusted runner must stage the resume in OpenClaw's allowed upload directory. Arbitrary paths, click-to-upload arming and selectors are denied.

The trusted application runner must navigate to the application page before invoking OpenClaw. `navigate` and `open` are denied because OpenClaw returns an inline snapshot before a post-navigation hook could inspect a login page.

## What is enforced

- Exact tenant/profile/tab, HTTPS host allowlist, every frame checked.
- Password, OTP, CAPTCHA or login controls stop inspection before snapshot/screenshot.
- No input values are read during DOM classification.
- Sensitive writes require exact approved label, type and value. Credential and legal declarations remain blocked even if accidentally placed in the approval list.
- Ordinary named form fields can be filled. Checkbox/radio/option choices are allowed subject to the same policy.
- Only a Next/Continue button with a visible intermediate `Step X of Y` counter is permitted. Final-submit buttons, Enter/keyboard actions, coordinate clicks and unknown controls are blocked.
- Reads of cookies, storage, network logs, page JavaScript and filesystem are denied.

## Boundaries and acceptance

The native ref resolver is private OpenClaw code. The adapter pins both package version and `pw-session-CQV8ZkDn.mjs` export identities. An upgrade fails closed until the adapter is reviewed. The hook uses the same cached Playwright page and ref store as the browser tool.

This is **not** a network firewall or a proof that arbitrary third-party JavaScript cannot submit a form on field change. DOM state can also change between a before-tool check and execution. Keep the existing application submission guard and provider-specific network checks. Do not describe this plugin alone as a complete sandbox or final-submit guarantee.

Unsupported custom controls, unlabelled fields, external iframes and wizard pages with no positive step counter stop the driver. Report these as guard blocks; do not bypass them with evaluate or shell.

Run `npm test` in this directory. Before production use, additionally prove plugin loading and actual native ref resolution against a tenant 9 fixture. Unit tests alone do not establish that the installed gateway invoked the hook. No real provider login or real application submission belongs in that fixture gate.

### Verified fixture, 2026-09-16

`sudo node verify-tenant9.mjs` ran through the real tenant 9 gateway and Claude Sonnet 5. The backend created an artificial form with `page.setContent()` under `https://example.com`; no employer form or user account was used.

First run failed because the model called `fill` without its required fields array. The guard denied it, the ordinary name stayed empty, and the DOM assertion failed. Sponsorship was filled and final submit was denied. The fixture prompt was corrected to specify OpenClaw's documented `act:type` request. No policy was relaxed.

Second run, `e86df806-73cb-4dba-ae34-25832f26a739`, passed:

```text
PASS tenant9 gateway plugin: native browser filled Fixture Ada and approved sponsorship Yes; fixture final submit stayed unexecuted.
```

The native final click returned `huntly_guard:final_submit_or_unproven_click`. Post-run DOM assertions proved both filled values and no submit event. Cleanup removed policy and fixture page, then stopped Chrome through VM agent. Follow-up status was `mode=idle`, `pid=null`; gateway remained active.

This gate proves actual hook invocation, native reference resolution, permitted writes and refusal of the final control on the fixture. It does not certify all ATS widgets or turn the before-tool hook into a network firewall.

### Authentication affordances versus actual challenges

A hidden `g-recaptcha-response` textarea or optional header Sign in button does not stop inspection. Visible password, OTP, CAPTCHA, "not a robot" and human-verification controls still do. Login routes remain blocked. Sign in controls cannot be clicked by the driver.

Only hidden iframes are excluded from inspection, checking the iframe element and every ancestor frame. Their contents are not read. Visible off-host frames remain denied; there is no broad Google-domain exception. Opacity alone is not treated as hidden, because a transparent element can remain in the accessibility tree.

`verify-isolation.mjs` is a root-only backend fixture for tenants 9 and 10. It writes only a newly generated synthetic localStorage marker on example.com and never reads existing keys or cookie values. It also checks native Chrome visibility policy and rejects tenant 9's gateway token at tenant 10. `--guard-only` runs the independent tenant 9 visibility and gateway-token checks if the second Chrome is unavailable.

### Isolation and upload gates, 2026-09-16

The first two-browser fixture failed with `VM tenant10 apply HTTP 500`. Investigation found Chrome Remote Desktop already using display `:20`; tenant 10 Xvfb had been crash-looping. With explicit authorization, tenant 10 moved to free display `:30`. The human desktop and tenants 1–9 were preserved. The VM-agent and Xvfb/x11vnc wrappers must agree on that exception.

After the correction, the full fixture passed:

```text
PASS tenant9/10 isolation: distinct CDP profiles retain independent synthetic markers on the same example.com origin.
PASS native Chrome guard: hidden reCAPTCHA and optional Sign in do not block snapshots; visible human-verification challenge does.
PASS tenant9 token rejected by tenant10 gateway: INVALID_REQUEST.
```

The wrong-token fixture initially used protocol 3 and correctly failed its own assertion on `protocol mismatch`; it now uses installed protocol 4 and asserts an unauthorized/token-mismatch response rather than accepting any rejection.

The upload solution uses the documented managed inbound-media root, not the private `/tmp` mount:

```text
/home/huntly-uN/.openclaw-huntly-uN/media/inbound/<attemptId>-resume.pdf
```

Stage an ordinary direct-child file, mode 0600, readable by its tenant. Do not use symlinks, hardlinks or nested paths. The policy must contain the same absolute path. `CONFIG_DIR` resolves from `OPENCLAW_STATE_DIR`, and native `resolveStrictExistingUploadPaths()` permits that inbound root. Delete the file on attempt cleanup.

`sudo node verify-native-upload.mjs` proved the real native resolver, actual policy hook and native `setInputFiles` path:

```text
PASS native OpenClaw upload: guarded hidden file input received synthetic PDF from tenant managed inbound-media path.
```

The fixture obtained a real snapshot ref while the input was visible, hid it, and then attached a synthetic PDF. The guard no longer requires upload-input visibility, but still requires exact approved path, input ref, enabled input, and DOM type `file`. Inputs hidden before every snapshot may expose no usable ref; the deterministic uploader remains responsible for those cases. No general CSS-selector or file-chooser permission was added.

Both fixtures removed their own synthetic state, closed their pages and stopped test Chrome processes through the VM agent.

### Ashby Yes/No controls

The observed Ashby DOM uses plain native buttons with no role or explicit type. Its Yes/No container is `.ashby-application-form-input-yesno`, inside `.ashby-application-form-field-entry` with a single question label. The guard recognizes only that bounded structure: exactly one group, exactly two Yes/No buttons, one local label, at most one direct backing checkbox and no other competing input/link, no form-action override and no submission-bearing question.

That known control is represented as the application's logical `checkbox` field. Yes proposes exactly `true`, No proposes exactly `false`. It does not toggle an unchecked boolean when the chosen button is No. Sensitive choices still require the exact approved label, type and value; a `No` string is not silently substituted for stored `false`.

Native fixture gate:

```text
PASS native Ashby boolean guard: exact approved false clicked No; unapproved Yes and final submit denied; no submit event fired.
```

`verify-ashby-choices.mjs` uses a synthetic field with the observed wrapper structure in tenant 9. It calls the actual hook and native OpenClaw click after obtaining native snapshot refs. It does not inspect or change a real applicant's page.


### Real markup correction and full context

Read-only inspection of the authorized public Mercor form showed a third child in every Yes/No container: Ashby's backing native checkbox. The original fixture omitted it and the guard rejected those groups. The matcher now permits at most one direct `input[type=checkbox]` in the proven Yes/No container. Other inputs and multiple backing controls still fail. The synthetic fixture now includes that actual structure.

All four Yes buttons and the New York location checkbox passed hypothetical guard classification against fresh native refs on the public form, without clicking or filling anything. The location checkbox already resolved correctly as an input with checkbox type; no extra click permission was added for it. Old-run ref failures should not be treated as proof of a missing permission.

Snapshots now preserve static question labels with `interactive:false` and `compact:false`, retaining the 18,000-character cap. The full native public-form snapshot contained the work-authorization question. This avoids handing the model four indistinguishable Yes/No pairs without their questions. The tool permissions and exact sensitive-answer policy did not change.

### Portaled location suggestions

The observed Ashby location suggestion is a `role=option` inside a portaled listbox. Its owning combobox references the listbox ID through `aria-controls` while `aria-expanded=true`. The guard now follows that exact relationship to the sole local Ashby field-entry label instead of treating the location text itself as a question.

Only the observed Ashby autocomplete classes qualify. There must be one visible, enabled, expanded input controller and one question label. Wrong IDs, duplicate controllers, collapsed owners and sensitive questions remain denied. No stored input value is read to establish this relationship.

```text
PASS native portaled autocomplete: option bound to sole expanded nonsensitive field selected; collapsed controller denied.
```

`verify-autocomplete.mjs` proves the actual hook and native click using a synthetic portaled suggestion in tenant 9, then verifies that collapsing its controller removes permission.

### Optional extension adapter, not activated

The default remains `HUNTLY_BROWSER_PROFILE=tenant`. An explicitly configured service may opt in to `HUNTLY_BROWSER_PROFILE=extension-test` and must supply its exact `HUNTLY_EXTENSION_CDP_PORT`, such as `27801` for the tenant 9 experiment. Do not infer the port or reuse another tenant's relay.

The adapter loads the pinned runtime's own `getBrowserControlState()` and `resolveProfile()` module instances. It obtains the already-owned relay's process-only internal authentication URL without logging it. The separate resolver validates profile, driver, loopback port, ownership and authentication consistency. Credentials are never constructed from a gateway token or persisted by this adapter.

Every tool still proves the policy target exists in the tenant's raw Chrome on `9200+N`. Active extension actions use only extension-native refs, and `Target.getTargetInfo` must return the exact same physical Chrome target ID. A different target or unsupported target-ID translation fails closed, even if the URL happens to match. Raw CDP is used only for guard observations, not as a fallback action transport.

A genuinely unstarted relay may bootstrap with the first read-only snapshot after raw tenant/host/authentication checks. Mutations, uploads and screenshots require the active verified extension runtime. Wrong ports, borrowed relays, stale credentials or malformed configuration cannot use that bootstrap path.

Local unit tests cover both routes, exact target mismatch, port mismatch, startup behavior and unchanged submit refusal. This adapter has **not** been deployed, selected or validated against a live extension connection. Native compatibility and Chrome extension approval remain separate gates. Deploy the complete plugin directory, including `extension-profile.mjs`, if enabling it later.
