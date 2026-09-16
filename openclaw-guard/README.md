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

Upload must use exactly `resumePath` and `inputRef` for a visible file input. The trusted runner must stage the resume in OpenClaw's allowed upload directory. Arbitrary paths, click-to-upload arming and selectors are denied.

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
