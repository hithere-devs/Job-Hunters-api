# OpenClaw gateway contract

Verified against `@openclaw/gateway-protocol@2026.8.1` and the official
`openclaw@2026.8.1` npm distribution on 2026-09-16. The deployed gateway version
must also pass a live compatibility check before enabling the driver.

## Package and wire version

The pinned package exists. `npm view @openclaw/gateway-protocol@2026.8.1 version dist.tarball --json` returned:

```json
{
  "version": "2026.8.1",
  "dist.tarball": "https://registry.npmjs.org/@openclaw/gateway-protocol/-/gateway-protocol-2026.8.1.tgz"
}
```

It supplies schemas, runtime parameter validators, envelope guards and protocol
constants. It does **not** supply `startRun`, `waitForRun`, `streamEvents` or
`cancelRun`. Those are Huntly wrapper functions in
`src/browser/openclaw-client.ts`. Wire protocol is v4, not the package version.

Authoritative references:

- https://docs.openclaw.ai/gateway/protocol
- Package `README.md`, `protocol.schema.json`, `dist/frame-guards.d.mts`
- OpenClaw distribution `dist/client-BBWFfmhX.js` and
  `dist/device-auth-na9vtJo1.js` for connect/device authentication
- `dist/agent-DaMqhk43.js` and `dist/principal-CA42B2iA.js` for
  `agent` and `agent.wait`
- `dist/chat-abort-handler-C1ik1IBY.js` and
  `dist/chat-send-handler-VKdsT8Lk.js` for cancellation and steering

## Authentication and isolation

The socket waits for `connect.challenge` with nonce and timestamp. Its first
request is `connect`, using v4, `client.id=gateway-client`, `mode=backend`, role
`operator`, scopes `operator.read` and `operator.write`, and `auth.token`.

Optional persistent Ed25519 identity comes from
`OPENCLAW_GATEWAY_DEVICE_FILE_<tenant>`. This file contains `privateKeyPem` and
`publicKeyPem` and must be readable only by the runner user. The v3 signature
covers the nonce, timestamp, token, device ID, client ID, mode, role, scopes and
platform. Device ID is SHA-256 of the raw 32-byte Ed25519 public key. Do not
turn off device verification globally to avoid pairing a runner device.

Tokens come from `OPENCLAW_GATEWAY_TOKENS`, a JSON object keyed by tenant number,
or `OPENCLAW_GATEWAY_TOKEN_<tenant>`. No token is logged. No browser login
password is involved. The caller must resolve a tenant from the authenticated
user's session; this low-level module accepts a validated tenant number, not a
user-supplied gateway URL.

Defaults are `ws://127.0.0.1:18789`, stride 1000, tenants 1 through 10. Operators
may set `OPENCLAW_BASE_PORT` and `OPENCLAW_PORT_STRIDE` to avoid existing services.
Stride below 120, invalid tenant numbers, public hosts and port overflow are
rejected. Tests may override the endpoint only to another `127.0.0.1` socket.

## RPC mapping

`startRun` sends `agent` with `message`, `sessionKey`, `idempotencyKey`,
`timeout` in seconds, and `deliver=false`. The idempotency key is the application
attempt ID. Each attempt uses its own logical session. Concurrent calls for the
same tenant and attempt share the same pending promise. A lost acceptance frame
does not trigger an automatic second agent request.

Files are **already-staged tenant-local paths**, listed in the task message.
They are not fictitious `files` RPC fields. The schema has `attachments`, but no
general arbitrary-local-file attachment contract. The résumé must be staged
under `/home/huntly-u<N>/` by the caller, with correct tenant permissions, before
starting. The gateway browser upload tool reads that path on the VM.

`waitForRun` monitors `agent.wait` using `runId` and `timeoutMs`. A wait reply
with `status=timeout` or `pending` does not prove the agent stopped. Terminal
status plus `endedAt` is required. Assistant events and `terminalReply.text`
provide the output. Output is not application submission evidence.

`streamEvents` routes gateway `agent` events by run ID and tenant. Consumers
receive step data and assistant output. Exceptions in an event subscriber do
not disable the deadline timer. Callers must redact tool details before
publishing them to users or persistent application logs.

`cancelRun` sends `chat.abort` with the logical `sessionKey` and exact `runId`,
then waits for a terminal `agent.wait` result. An abort acknowledgement alone
is insufficient. Unconfirmed cancellation throws `OpenClawRunError` with
`quiescent=false`. Callers must not switch to another browser driver in that
case. Browser lifecycle remains the VM agent's responsibility.

`nudgeRun` sends `chat.send` with the same session key, `queueMode=steer`, a unique
idempotency key and a timeout no greater than the original deadline. It is
refused after local completion, cancellation or deadline. It does not extend
the attempt's budget. The server may create a follow-up run if the primary
run finishes during steering admission. The client tracks these side-run IDs
and cancels them before reporting the primary run quiescent. Eight nudges per
attempt is the limit. The action-policy guard must also expire when the primary
run ends, rather than relying on prompt steering for isolation.

## Deadline and failure semantics

A timer starts before the `agent` RPC. It cancels the run even if nobody calls
`waitForRun`, independently of BullMQ's lock or heartbeat. The gateway receives
its own timeout too. A shorter `waitForRun` timeout also triggers cancellation.

Cancellation has a bounded acknowledgement and terminal-wait window. Default
request timeout is 10 seconds, cancellation wait is 10 seconds. A broken socket
can reconnect for read/cancel RPCs, but never silently replays a side-effecting
agent request. Results expose `cancelConfirmed`; callers must honor it before
running a fallback. A typed start error similarly exposes `quiescent`.

A process crash still loses the client's in-memory registry. Gateway-side
idempotency and the database attempt record remain necessary. Attempt IDs
must not be recycled, and uncertain submissions must never be automatically
retried. Durable run reconciliation after runner restart remains a separate
requirement from socket reconnection.

## Verified fixture coverage

`npx tsx --test src/browser/openclaw-client.test.ts` covers port isolation,
challenge signature verification, real schema parameter validation, concurrent
start deduplication, event delivery, terminal output, unattended hard deadline,
shorter wait deadline, unconfirmed abort, same-session nudge, no replay after
acceptance loss, and cross-tenant file/public-host rejection.

A fake gateway does not establish deployed gateway compatibility or prove that
an in-flight browser tool releases on abort. Those need the live M3.2 gate and
must be reported separately.

## Live gateway compatibility, 2026-09-16

The unchanged client bundled with the pinned 2026.8.1 schemas connected to
the deployed OpenClaw 2026.9.3 tenant 10 gateway at `127.0.0.1:28789`. Both
fixtures prohibited tools and browser actions. Tokens were read inside the VM
from the root-owned registry and were never printed.

The no-tools reply fixture returned:

```json
{"gate":"actual-gateway10-no-tools","status":"ok","cancelConfirmed":true,"eventCount":9,"protocolReplyMatches":true,"error":null}
```

The client-owned short wait deadline returned:

```json
{"gate":"actual-gateway10-wait-deadline","status":"timeout","cancelConfirmed":true,"eventCount":2,"protocolReplyMatches":false,"error":"OpenClaw hard deadline exceeded"}
```

A separate 1-second run-deadline fixture initially returned terminal `error`
rather than `timeout`, revealing a race between the monitor and abort wait.
The monitor now lets the cancellation owner retain the timeout reason. A
regression test covers this race. No fixture opened a browser, so these results
prove gateway authentication, streaming and cancellation, not browser release
or a successful application.

## VM desktop watch transport

Active VM applications advertise `runtime.watchTransport="vnc"`. Live
Applications and Applications use noVNC with `viewOnly=true`,
`focusOnClick=false`, viewport scaling enabled, and remote resizing disabled.
The existing event socket still carries application state and field updates;
the existing CDP frame stream remains a user-selectable fallback. Takeover code
remains unchanged and is never enabled by the VNC watch.

`/live/:attemptId/vnc?token=...` is a `noServer` authenticated proxy. Before
opening the upstream it checks access-token expiry, authVersion, owned VM
session, the latest attempt on that VM profile, candidate/attempt status,
BullMQ active lock, and VM `mode=apply` with `vncReadOnly=true`. It repeats
these checks every five seconds and closes on session reassignment, attempt
replacement or mode change. Authorization is bounded to three seconds.

RFB protocol negotiation requires traffic in both directions. Consequently,
blocking DOM events or setting noVNC viewOnly is not the security boundary.
The VM must run x11vnc with `-viewonly -noclipboard`, restart VNC when changing
browser mode, and advertise the enforced state. The API refuses VNC watch
without that explicit status flag.

Tenant 9 was tested with an isolated local page and a raw RFB client that sent
keyboard and mouse events despite the UI restrictions. A CDP positive control
proved the page could receive ordinary typing and clicks. Exact gate:

```json
{"gate":"tenant9-server-viewonly","mode":"apply","vncReadOnly":true,"rfb":"RFB 003.008","positiveControl":true,"vncKeysIgnored":true,"vncClicksIgnored":true}
```

The fixture closed its own page and stopped tenant 9 through the VM agent.
No login or real application was involved. WS fixture tests additionally prove
unauthorized requests never accept or open upstream, binary RFB traffic is
relayed, and changed authorization/session identity severs a connection.
