# VM application rollout

## Runtime

- API/UI remain on the laptop at 46460/46461.
- Redis runs on openclaw-vm, loopback 127.0.0.1:6379 and ::1 only, AOF enabled, noeviction.
- Laptop Redis tunnel: 127.0.0.1:6382, supervised by `com.huntly.redis-tunnel` LaunchAgent.
- Existing VM-agent/VNC tunnels remain necessary for laptop API streaming. Production API hosting must provide durable equivalent connectivity or run alongside the VM.
- `huntly-runner.service` runs `/opt/huntly/api/dist/application-runner.js` as unprivileged `huntly-runner`. This replaces the browser runner on this VM, not a fourth permanent process. LinkedIn/outreach workers are not started here.
- VM credentials: `/etc/huntly/runner.env` and `/etc/huntly/vm-agent.env`, root-owned mode 0600.
- Browser provider: vm. Application model, OpenClaw reasoning, and answer resolver: DeepSeek V4.1 Flash (`deepseek-flash`) via `MODEL_PROVIDER=deepseek`.
- Live submission was explicitly authorized by the user during rollout. `APPLY_DRY_RUN=false`; global application queue is resumed.
- One saved VM profile is used sequentially. Renewed ownership leases prevent two applications driving it at once.

## Data migration

The existing paused queue was copied from laptop Redis 7.4 on port6381 to VM Redis7.0 using a portable per-type transfer rather than incompatible binary RDB restore. Fifteen keys were preserved. Gate showed 2 waiting + 2 delayed, 0 active. The old source remained paused. The delayed applications were promoted only after user authorization and successful runner connection.

Supabase session pooling on 5432 exhausted its 15-client limit during integration. Transaction pooling on6543 was probed with a transaction-scoped advisory lock before changing application configuration. API max pool3, runner2; idle connections release after30seconds. No unrelated database clients were terminated.

## Verified behavior

- Tenant9 connect starts; double connect and connect-to-apply conflict return409.
- Apply returns only after CDP readiness. Disconnect during apply returns409 and leaves the apply browser alone.
- VMagent stops Chrome by SIGTERM, waits up to10seconds, and logs escalation if necessary.
- FlowB stops its VNC services, physically closing interactive sessions. FlowA restarts them. x11vnc's documented SIGTERM exit2 is treated as a successful intentional stop by a systemd drop-in.
- Tenant3 services remained active; its profile was not reset or deleted.
- Ports checked remained loopback-only.
- Runner connected and queue gate showed1active+3waiting,0delayed,pausedfalse.
- Extension inspection showed real résumé upload, saved profile fields and 1200px read-only frames with no iframe/input controls.
- Four initial applications reached review/uncertain states. They were not falsely counted as submitted.
- User-provided answers were saved and automatically continued eligible applications. Valid replies were preserved across expired browser waits.

## Release limits

Do not call this a complete public-production certification. The architecture audit lists open issues including trusted database CA configuration, private-network browser egress controls, dirty-slot deletion invariants, broader provider acceptance, mail delivery and disaster recovery. Real provider sign-in was never automated. Gmail was not scraped. Existing uncertain submission fences require positive verification, not blind retry.

## Operations

Check service with `systemctl status huntly-runner`. Logs are in `journalctl -u huntly-runner`. Do not print environment files into logs or support messages. Deploy built artifacts, apply additive migrations first, and drain an active attempt gracefully before a runner restart. Never wipe a profile to repair a queue problem.

The browser-extension testing requirement is recorded in both repositories' AGENTS.md.
