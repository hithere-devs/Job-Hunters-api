# Plan — user browser sessions on our own VM

**Thesis of this run:** a user connects their own logged-in browser session
through our UI, and we then drive an application inside that same session while
they watch. Nothing after the submit click is in scope.

**Out of scope, deliberately:** confirmation tracking, reply detection, emailing
the user after an application lands. All three need a working submit first, and
we do not have one yet. They are the next run.

**Repos:** `Job-Hunters-api` (this one) and `Job-Hunters-UI`.
**Target VM:** `openclaw-vm`, project `azhar-496213`, zone `asia-south1-c`.

---

## 0. Milestone 1 — Flow A, end to end, in the product

**Build this first.** It is a vertical slice across phases 1–5 that delivers one
usable thing: a user opens the Apply tab, clicks *Set up your browser session*,
and signs in to Google, Wellfound and Instahyre inside our UI.

The reordering matters. In the first attempt the human sign-in was a
prerequisite performed over SSH, which blocked everything behind it. Here it is
the **acceptance test** — doing it is how we know the milestone shipped.

### In scope

| Area | What | Section |
|---|---|---|
| VM | Port wrapper fix, services for tenants 1–10 | §4.2, §4.3 |
| VM agent | `/health`, `/status`, `/connect`, `/disconnect`, `/cookies` only | §7.1 |
| API | `user_browser_sessions`, slot allocation, 4 routes, WS proxy | §9.1–9.3 |
| UI | `BrowserSession.tsx`, Apply-tab card | §10.1, §10.2 |

### Deferred to Milestone 2 (all of Flow B)

`POST /tenants/:i/apply`, `vm-client.createBrowser`, `openVmSession()`, the
`BROWSER_PROVIDER='vm'` enum, apply routing, `LiveView` read-only mode,
`attempt_flags`, the Phase 6 verifier.

Flow A never opens a CDP connection, so none of it is on the critical path.

### Development topology

API and UI run on the laptop; the browser runs on the VM. Keep a tunnel up:

```bash
gcloud compute ssh openclaw-vm --zone=asia-south1-c -- -N \
  -L 6101:127.0.0.1:6101 \
  -L 18900:127.0.0.1:18900
```

`VM_AGENT_URL=http://127.0.0.1:18900` then works unchanged on the laptop,
nothing is publicly exposed, and the same code runs when the API moves onto the
VM. Add one `-L 610X:127.0.0.1:610X` per tenant under test.

### Done when

A human, signed in to the product as a normal user, completes Google →
Wellfound → Instahyre entirely inside the Apply tab, and
`GET /me/browser-session` returns all three cookie domains. No SSH, no
`vnc.html`, no terminal.

---

## 0.5 Milestone 2 — applying, both ways, with the mail loop closed

Milestone 1 proves a user can connect their accounts. This one makes those
accounts *do* something: apply, on platforms that need a login and platforms
that do not, and use the user's own Gmail — already signed in from Milestone 1 —
to read verification codes mid-application and confirm receipts afterwards.

**Out of scope:** payments. Set up separately.

### The two application paths

| Path | Example | Session | What is hard |
|---|---|---|---|
| **Anonymous** | Greenhouse, Lever, Ashby | none needed | May email a verification code mid-form |
| **Authenticated** | Wellfound, Instahyre | the user's VM profile | Platform-specific flows, but the résumé is often already on file |

Both run in the **same Chrome profile** on the same tenant slot, in Flow B
(CDP) mode. That is what makes the mail loop possible: Gmail is signed in *in
that profile*, so reading a code is opening a second tab, not an OAuth scope.

### Why this needs no Gmail API

`gmail.readonly` is a Google *restricted* scope needing an annual CASA
assessment. We need none of it. The user signed into Google in their own
browser in Milestone 1; that session lives in the profile; a second tab on
`mail.google.com` is already authenticated.

This is read-only, incidental, and invisible. **Do not surface it as a
feature** — the user connected their Google account for the platforms, and
nothing in the UI should imply we are monitoring their mail. It is an internal
confidence signal on an application record, nothing more.

### M2.1 — Move the runner onto the VM

The runner is the only process that touches a browser, and `docs/deployment.md`
already splits it out for exactly this reason.

It has to be co-located with Chrome because of file uploads. `applyApprovedCandidate`
downloads the résumé variant to a temp dir and calls `setInputFiles(resumePath)`.
Playwright resolves that path **on the machine running the code** — so a runner
on the laptop hands Chrome a path that does not exist on the VM. Co-locating
makes it a plain local file and the existing code works untouched.

Redis moves too: the runner needs the same queue the API writes to, and the
current `REDIS_URL` points at a container on the laptop. Run Redis on the VM;
the laptop API reaches it over the existing SSH tunnel (`-L 6379:127.0.0.1:6379`).

- [ ] Redis on the VM, bound to loopback
- [ ] Runner unit on the VM, `BROWSER_PROVIDER=vm`
- [ ] Extend the dev tunnel with the Redis port
- [ ] Gate: `npm run queue:smoke` from the laptop drives a job on the VM runner

### M2.2 — `POST /tenants/:i/apply`

The half of the agent contract Milestone 1 deliberately omitted. Same profile
directory, Chrome launched **with** `--remote-debugging-port=92XX`, returns the
CDP URL. Mode exclusivity already exists — `ensureTenantConnected` has the
reconnect-or-replace policy and `ensureTenantApplying` is its mirror.

- [ ] Agent endpoint returning `{ mode: 'apply', cdpUrl, expiresAt }`
- [ ] `ensureTenantApplying()` in `vm-client.ts`, symmetric with the connect one
- [ ] Gate: connect → apply returns 409, then closes and relaunches in CDP mode
      with the Google session still live

### M2.3 — The VM browser provider

- [ ] `openVmSession()` in `src/browser/session.ts` — `openLocal` with
      `connectOverCDP` in place of `launchAutomationBrowser`, and a `close()`
      that disconnects without killing a browser it does not own
- [ ] `'vm'` in the `BROWSER_PROVIDER` enum (`src/config/env.ts:107`)
- [ ] Route by `portal_accounts`: a user with a ready session applies through
      their VM profile; everyone else keeps the current provider
- [ ] `liveUrl` stays `null` so `apply.ts:210` takes the screencast branch

### M2.4 — Verification codes, mid-application

New: `src/hunt/apply/email-code.ts`.

Some forms email a code and wait. Today that is an `unknown_field` and the
application parks. With Gmail in the same profile it is a second tab.

```ts
readLatestCode({ session, since, from?, subjectHint? }): Promise<string | null>
```

- Opens a **new tab** — never navigates the application away from a half-filled
  form. Closes it after.
- Searches `newer_than:1h` plus the sender hint, and **only reads messages newer
  than `since`**, which is the moment the application started. A code from an
  earlier attempt is worse than no code.
- Extracts with a regex first (`\b\d{4,8}\b`), model second.
- Add a `email_code` rung to the field ladder that calls it instead of blocking.
- Hard timeout ~90 s, then fall back to blocking as today.

Gate: a unit test over captured Gmail HTML, plus one live run against a form
that actually mails a code.

### M2.5 — Confirmation receipts, after the application

New: `src/hunt/apply/confirm-email.ts`.

This closes the loop on `submitted_unconfirmed`, which Phase 0 introduced for
"we clicked, we could not verify". A confirmation email is exactly the missing
evidence.

- After a submit, open a Gmail tab and search `newer_than:1h` for the company
  and role.
- Classify: `confirmed` · `rejected` · `not_found`.
- Write `application_receipts` (applicationId, kind, subject, snippet, at).
- **Upgrade `submitted_unconfirmed` → `submitted` on a confirmation.** Never
  downgrade on `not_found` — plenty of employers send nothing.
- Run it on a delay (~3 min) as a queued job, not inline. Confirmation mail is
  not instant and the apply lane should not be held open waiting.
- Internal only. No UI surface.

### M2.6 — The watch view

Deferred from Milestone 1.

- [ ] `readOnly` prop on `LiveView.tsx`: no takeover controls, no input channel
- [ ] **Flag for review** → `POST /applications/:id/flag`, writes `attempt_flags`,
      pauses that user's apply queue via a Redis key the worker checks
- [ ] Admin list of open flags with last frame and event trail

### M2.7 — Prove it both ways

The acceptance test. Both run end to end, `APPLY_DRY_RUN=false`, one real
application each.

1. **Anonymous** — a live Greenhouse posting. Ladder fills it, submits,
   confirmation receipt lands within the delay window. If it mails a code, M2.4
   handles it without a human.
2. **Authenticated** — a live Wellfound posting through the user's session.
   Résumé uploaded from Huntly storage, profile fields from the kit, submitted,
   receipt recorded.

Capture the attempt event trail and the receipt row for both.

### What Milestone 2 does *not* finish

LinkedIn (needs per-user residential egress — see §13), the second VM for users
11–20, founder-email outreach, the session-decay verifier, and payments.

If a feature does not serve one of these, it is out of scope.

### Flow A — Connect (interactive, low latency)

The user signs in to their own accounts, themselves, in a real Chrome running on
our VM. They click, they type, they approve 2FA on their phone. We never see a
password and never store one.

Latency matters — a human is typing. Target under 150 ms round trip, 15+ fps.

### Flow B — Watch (read-only, latency irrelevant)

The user watches an application being filled in their session. **They cannot
click.** The only control is **Flag for review**, which opens an admin ticket
and pauses that user's apply queue.

Read-only is a deliberate narrowing. `awaitTakeover` in
`src/hunt/apply/screencast.ts` already forwards clicks and keystrokes; we keep
the code and stop routing to it. Two reasons:

1. A user half-completing a form mid-run leaves the attempt in a state the
   ladder did not produce and cannot reason about.
2. A read-only stream needs no input channel, so there is no input channel to
   secure.

2–5 fps is fine here.

---

## 0.7 Milestone 3 — OpenClaw drives the application

**Why.** The deterministic ladder works and holds its safety rules. The thing
that keeps failing is our own agent loop: on 2026-09-16 a tenant sat in `apply`
mode for 12.6 minutes with a live Chrome and zero events written, because there
is no watchdog above that loop — BullMQ's 15-minute lock eventually fails the
job having achieved nothing. Before that, `no_submit_control` on Ashby three
runs running. We are maintaining a bespoke agent runtime, badly, next to one
that is purpose-built, already installed on the VM, and already used by hand
successfully on these exact forms.

**What changes.** OpenClaw replaces `src/agent/` as the reasoning tier. It does
not replace the ladder, the answer store, the refusal list, or submit authority.

### What stays ours, and why

| Stays | Reason |
|---|---|
| The deterministic ladder | Free, fast, fills most of the form before any model runs |
| The answer store + derivation | OpenClaw *reads* it. This is what stops the re-asking. |
| The refusal list | Enforced on arguments, not asked for in a prompt |
| `APPLY_DRY_RUN`, `APPLY_KILL_SWITCH` | Checked immediately before the click |
| Submission confirmation | A run that says "submitted" is still not evidence |

### M3.1 — One OpenClaw per tenant

`openclaw --profile huntly-u<N>` auto-scopes `OPENCLAW_CONFIG_PATH` and
`OPENCLAW_STATE_DIR`, and suffixes the unit to `openclaw-gateway-huntly-u<N>`.
Run it as the tenant's OS user so config, state, memory and workspace are
isolated at the filesystem level as well as by config.

**Base ports must be at least 120 apart.** Each instance derives its
browser-control port at base+2 and a CDP range up to base+110. Adjacent base
ports silently share a CDP port — which is exactly the cross-user session
mixing this design exists to prevent.

```
huntly-u1 → 19789    huntly-u2 → 20789    huntly-u3 → 21789 …
```

The operator already owns gateway 18789, so tenant allocations start at 19789.
The tested 2026.9.3 guard uses native Playwright refs with raw-CDP `attachOnly`;
`driver: "existing-session"` uses a different reference backend.

Point each at the tenant's existing Chrome profile, the one Flow A already
populated with Google, Wellfound and Instahyre sessions:

```jsonc
// ~huntly-u2/.openclaw-huntly-u2/openclaw.json
{ "gateway": { "port": 20789, "bind": "loopback" },
  "browser": { "defaultProfile": "tenant",
    "attachOnly": true,
    "profiles": { "tenant": { "attachOnly": true,
                              "cdpUrl": "http://127.0.0.1:9202" } } } }
```

- [x] Provision script, tenants 1–10 (`deploy/provision-openclaw.mjs`)
- [ ] Gate: two gateways up at once, each run touching only its own profile.
      Verify by signing into a throwaway site on tenant 1 and confirming
      tenant 2 cannot see the cookie.

### M3.2 — Gateway client

`src/browser/openclaw-client.ts`, on `@openclaw/gateway-protocol` (pin
`2026.8.1`). WebSocket, connect frame first, `auth.token` from the per-tenant
`OPENCLAW_GATEWAY_TOKEN`.

```ts
startRun(tenant, { prompt, files }): Promise<{ runId }>
waitForRun(runId, { timeoutMs }): Promise<RunResult>   // agent.wait
streamEvents(runId, onEvent): Unsubscribe
cancelRun(runId): Promise<void>
```

Side-effecting methods need an idempotency key — use the attempt id, so a
reconnect cannot start a second application for the same attempt.

**Every run carries a hard deadline.** The 12.6-minute hang is the failure mode
to design against: `waitForRun` owns its own timeout and calls `cancelRun`,
independently of BullMQ's lock.

- [ ] Gate: a run started, streamed, and cancelled on deadline, browser released.

### M3.3 — The apply task

`src/hunt/apply/openclaw-apply.ts`. Runs *after* the ladder, on the leftovers —
the same position `src/agent/` holds today.

The prompt carries everything, so OpenClaw never has to ask what it can be told:

- the apply URL, and the job's title, company and **country**
- the candidate dossier from the kit and persona
- every stored answer for this host from `pending_application_questions` and
  `field_answers`, including the derived work-authorisation answer
- the never-answer list, as a refusal instruction *and* enforced on our side
- the résumé attached to the run (already on the VM at the tenant's path)

Two prompt rules that matter:

- **Do not ask. Decide.** Where a question cannot be answered from the dossier,
  choose the most reasonable answer for this candidate and record what was
  assumed. Parking for a human is what this milestone removes.
- **Stop before the final submit** and report what is filled. Our code presses
  submit, under the kill switch, and verifies. A run claiming "submitted" is
  never evidence — that was true of our agent and is true of this one.

- [ ] Gate: one live Ashby posting completed end to end with zero human input.

### M3.4 — Streaming and intervention

Reuse Flow A's noVNC path — built, proven, same tenant, same display. The user
watches the real browser rather than a second stream.

- [ ] Agent steps published to the existing attempt event channel, so the UI
      shows reasoning beside the browser
- [ ] **Nudge**: a prompt box that sends a follow-up into the same OpenClaw
      session when a run is visibly stuck. The "act as judge" case — available,
      never required.
- [ ] Flag for review still writes `attempt_flags` and pauses that user's queue

### M3.5 — Retire `src/agent/`

Only once M3.3's gate passes on three postings across two ATS families. Keep the
module until then: a failed OpenClaw run should fall back to it rather than
losing the ladder's work.

### Resource note

Ten Node gateways at roughly 200–400 MB is 2–4 GB on a 128 GB box — irrelevant.
OpenClaw assumes one installation per machine (one memory store, one cron);
`--profile` covers config, state and ports, and per-OS-user homes cover the
rest. Containers are cleaner past ~10 tenants, and are not needed yet.

---

## 2. Why two streaming mechanisms

The one non-obvious decision in the design, so it goes first.

**Flow A runs over interactive VNC. M3 Flow B runs over server-enforced view-only VNC, with the original CDP screencast retained as a fallback.** Not redundancy —
opposite requirements.

Google's sign-in detects CDP-driven Chrome server-side and refuses with *"This
browser or app may not be secure."* There is no flag that disables it; it is not
a Chrome setting. **Any design where Chrome has `--remote-debugging-port` open
while a human signs in to Google cannot work**, and no amount of stealth
patching changes that.

VNC sidesteps it entirely. Chrome launches with no debugging port at all, and
input arrives at the X11 layer — so from Chrome's point of view a human is
typing on a keyboard, because one is. VNC also handles what CDP screencast
handles badly: native file pickers, OS dialogs, Chrome's own password-manager
prompts, and tabbing out to an authenticator app.

Flow B requires programmatic control and a non-interactive watch view. M3
starts x11vnc with `-viewonly -noclipboard` and severs old sockets on mode
switches. `src/hunt/apply/screencast.ts` remains available as a fallback.

**One profile directory, two launch modes, never both at once.**

---

## 3. VM preparation

### 3.1 Fix the disk first

Measured state:

```
openclaw-vm   e2-highmem-16   16 vCPU / 128 GB   200 GB pd-standard
```

`pd-standard` is HDD-backed: roughly 0.75 read and 1.5 write IOPS per GB, so
200 GB gives about **150 read / 300 write IOPS total**, shared across every
profile on the box.

A Chrome profile is close to the worst case for that. Cookies, localStorage and
IndexedDB are LevelDB stores; the HTTP cache is thousands of small files. It is
small random I/O — exactly what HDD-backed PD is worst at. Ten profiles will
thrash this disk long before RAM or CPU is near saturation, and it will present
as "everything is mysteriously slow", not as a disk error.

`pd-balanced` gives 6 IOPS/GB — about 1,200 IOPS on the same volume, roughly 8×
— for around +$15/month. **Highest-value change in this document.**

```bash
gcloud compute instances stop openclaw-vm --zone=asia-south1-c
gcloud compute disks update openclaw-vm --zone=asia-south1-c --type=pd-balanced
gcloud compute instances start openclaw-vm --zone=asia-south1-c
```

### 3.2 Right-size the shape

Ten active users measure roughly 16–20 GB and 12–16 vCPU at absolute peak (all
ten applying *and* all ten watched at once). RAM is ~5× oversubscribed; 16 vCPU
is about right. So: **less memory, same cores.**

| | Now | Recommended |
|---|---|---|
| Type | `e2-highmem-16` | `e2-standard-16` |
| Shape | 16 vCPU / 128 GB | 16 vCPU / 64 GB |
| List (us-central1) | $527.93/mo | $391.35/mo |
| Mumbai ≈ +20–25% | ~$650/mo | ~$485/mo |

~$165/month saved, no performance cost, in-place resize within E2.

```bash
gcloud compute instances stop openclaw-vm --zone=asia-south1-c
gcloud compute instances set-machine-type openclaw-vm \
  --zone=asia-south1-c --machine-type=e2-standard-16
gcloud compute instances start openclaw-vm --zone=asia-south1-c
```

**Measure before committing.** `ps` and `top` report RSS, which counts shared
libraries once per process and over-counts Chrome badly. PSS is additive:

```bash
sudo apt-get install -y smem
smem -t -P chrome -k
```

Run three concurrent profiles under load, read PSS, multiply by 10/3. Under
40 GB means `e2-standard-16` has room to spare.

Caveat on staying with E2: mixed host CPUs, no sustained-use discount. If ten
concurrent Chromes contend, step across to `n2d-standard-16` (same 16/64, AMD,
predictable). Try E2 first — it is one command to change again.

### 3.3 Base packages

```bash
sudo apt-get update
sudo apt-get install -y \
  xvfb x11vnc websockify novnc \
  fonts-liberation fonts-noto-color-emoji \
  sqlite3 smem jq \
  dbus-x11
```

Chrome itself:

```bash
wget -q -O /tmp/chrome.deb \
  https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y /tmp/chrome.deb
google-chrome --version   # record this; profile format is tied to it
```

---

## 4. VM layout

### 4.1 One Linux user per tenant

`huntly-u1` … `huntly-u10`. Each gets its own home, Xvfb display, dbus session,
and `0700` profile directory.

This is not over-engineering. With `dbus-x11` deprecated, most modern distros
can no longer run multiple graphical sessions for the *same* Linux user without
dbus cross-talk that is very hard to trace. Separate OS users is the supported
way.

It also means user A's Chrome cannot read user B's cookies at the filesystem
level — which matters when those cookies are Google sessions.

```bash
for i in $(seq 1 10); do
  sudo useradd -m -s /usr/sbin/nologin "huntly-u$i"
  sudo mkdir -p "/home/huntly-u$i/profile" "/home/huntly-u$i/run"
  sudo chown -R "huntly-u$i:huntly-u$i" "/home/huntly-u$i"
  sudo chmod 700 "/home/huntly-u$i" "/home/huntly-u$i/profile"
done
```

### 4.2 Port map

Tenant index `i` (1–10):

| Resource | Value | Exposure |
|---|---|---|
| X display | `:$((10+i))` → `:11`…`:19` for tenants 1–9; tenant 10 uses `:30` | none |
| x11vnc | `$((5900+i))` → `5901`…`5910` | loopback only |
| websockify/noVNC | `$((6100+i))` → `6101`…`6110` | loopback only |
| Chrome CDP | `$((9200+i))` → `9201`…`9210` | loopback only, **Flow B only** |
| VM agent | `18900` | loopback only |

Nothing here is ever exposed publicly. The original `10+i` display scheme was
incorrect for tenant 10 on this VM: Chrome Remote Desktop already owns `:20`
under the human operator's account. Preserve that desktop. Tenant 10 uses `:30`
in the Xvfb/x11vnc wrappers and VM-agent display function. Its VNC, noVNC and
CDP ports remain 5910, 6110 and 9210. Tenants 1–9 are unchanged.

### 4.3 systemd units

`/usr/local/bin/huntly-xvfb` (called by `/etc/systemd/system/huntly-xvfb@.service`)

```ini
[Unit]
Description=Xvfb for huntly tenant %i
After=network.target

[Service]
User=huntly-u%i
Environment=DISPLAY=:%i
ExecStart=/usr/local/bin/huntly-xvfb %i
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/usr/local/bin/huntly-x11vnc` (called by `/etc/systemd/system/huntly-x11vnc@.service`)

```ini
[Unit]
Description=x11vnc for huntly tenant %i
After=huntly-xvfb@%i.service
Requires=huntly-xvfb@%i.service

[Service]
User=huntly-u%i
Environment=DISPLAY=:%i
ExecStart=/usr/local/bin/huntly-x11vnc %i
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`-wait 20 -defer 20` targets ~20 ms polling, which is where the 15+ fps for
Flow A comes from. `-localhost` is load-bearing: never bind VNC publicly.

`/usr/local/bin/huntly-novnc` (called by `/etc/systemd/system/huntly-novnc@.service`)

```ini
[Unit]
Description=websockify for huntly tenant %i
After=huntly-x11vnc@%i.service
Requires=huntly-x11vnc@%i.service

[Service]
User=huntly-u%i
ExecStart=/usr/local/bin/huntly-novnc %i
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
for i in $(seq 1 10); do
  sudo systemctl enable --now "huntly-xvfb@$i" "huntly-x11vnc@$i" "huntly-novnc@$i"
done
```

Xvfb, x11vnc and websockify are long-running. **Chrome is not** — it starts when
a flow starts and stops when it ends, because stopping it is what flushes
cookies to disk.

### 4.4 The two Chrome launch modes

```bash
# Flow A — connect. NO debugging port. This is what makes Google login work.
DISPLAY=:13 google-chrome \
  --user-data-dir=/home/huntly-u3/profile \
  --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-features=TranslateUI \
  --window-size=1440,900 --window-position=0,0 \
  --start-maximized \
  about:blank

# Flow B — apply. Same directory, debugging port added.
DISPLAY=:13 google-chrome \
  --user-data-dir=/home/huntly-u3/profile \
  --remote-debugging-port=9203 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check \
  --disable-dev-shm-usage \
  --window-size=1440,900 --window-position=0,0 \
  about:blank
```

`--disable-dev-shm-usage` is not optional. Chrome leans on `/dev/shm`, the
default is often 64 MB, and Chrome crashes outright when it fills.

**Do not** add `--no-sandbox`, `--disable-blink-features=AutomationControlled`
or any stealth flag in Flow A. They are detection surface, and the whole point
of Flow A is that Chrome is genuinely unautomated.

Chrome locks a `user-data-dir`, so the OS enforces "one browser per user at a
time" for free. We take a Redis lock on top anyway — a clear error beats a
Chrome crash log.

### 4.5 Reading cookie domains without CDP

Flow A has no CDP, so verification cannot use it. Chrome's cookie store is
SQLite, and `host_key` is plaintext even though values are encrypted:

```bash
# Probe both. Chrome moved the store under Default/Network/ around v96, but the
# build installed here still writes Default/Cookies, and which one you get
# varies by build and by how the profile was first created.
for candidate in Default/Cookies Default/Network/Cookies; do
  db="/home/huntly-u3/profile/$candidate"
  [ -f "$db" ] && sqlite3 -readonly "$db" "select distinct host_key from cookies;" && break
done
```

**Hardcoding one path is a trap.** The first agent assumed
`Default/Network/Cookies`, found nothing, and returned an empty list — which is
indistinguishable from "this user never signed in". Verification failed silently
for a fully signed-in profile, and the connect page just reopened at Google
forever. Probe both, and **log loudly when neither exists**.

Must be run with **Chrome stopped** — it holds a write lock. This is why
`completeInteractiveLogin` stops the browser before verifying, which the
existing code already does for the right reason.

We read domains only. We never read, decrypt, or store a cookie value.

---

## 5. Phase 0 — Unblock applications (2 days, do first)

None of the VM work moves us off zero submitted applications. These do. Build
the VM on top of a broken submit and you get beautifully streamed browsers that
submit nothing, and it will look like the VM failed.

### 5.1 Stop queueing aggregator URLs

**Where:** `src/hunt/discovery/canonicalise.ts`, and the `applyUrl` selection at
`src/hunt/apply.ts:93`.

**Evidence:** 27 of 38 historical attempts targeted `jooble.org`,
`adzuna.co.uk`, `weworkremotely.com`, `jobicy.com`, `arbeitnow.*` — pages with
no application form on them. The agent tier logged `no_form_found` 18 times.

**Change:** when merging duplicates, an ATS-hosted URL always wins over an
aggregator URL regardless of description length. If a candidate's only apply URL
is on an aggregator host, do not queue it — mark the candidate
`needs_review` with reason `no_applyable_url`. An unapplyable job should never
consume a slot in the daily budget.

**Verify:** `select count(*) from hunt_candidates where status='queued'` and
confirm every `applyUrl` host is in the ATS set.

### 5.2 Narrow the refusal list

**Where:** `sensitiveReason()` in `src/hunt/apply/fields.ts`.

**Evidence:** these were classified `unknown_field` and blocked real
applications — `Candidate Privacy Policy*`, `By checking this box, I agree to
allow Starburst to store and process my data…*`, `How did you hear about us?*`,
`Current/Most Recent Company Name`.

**Change:** consent and privacy-policy acknowledgements are answerable — the
user asked us to apply, that is the consent. Add a `consent` rung that checks
the box. Add `How did you hear about us` → a safe default. Map
`Current/Most Recent Company Name` from the résumé.

Keep refusing: demographics, salary expectations, visa status, criminal history,
references' contact details, legal questions about existing obligations. Those
stay exactly as they are.

**Verify:** existing tests in `src/hunt/apply/fields` must still pass; add cases
for each label above.

### 5.3 Submit verification

**Where:** `submitForm()` in `src/hunt/apply/fill.ts:219-249`.

**Evidence:** three `blocked/needs_input` events carry `heldBack: null`, meaning
the button was pressed and the success regex did not match. Greenhouse, Lever
and Ashby submit over XHR — `waitForLoadState('domcontentloaded')` resolves
instantly on a page that never navigates, so the body is read before the
confirmation renders. A false negative gets retried into a duplicate
application.

**Change:** race four signals after the click, first to fire wins —
URL change; the form element detaching from the DOM; a network response from the
ATS submit endpoint; confirmation text. Add an explicit
`submitted_unconfirmed` outcome for "clicked, could not verify", and **never**
treat that as "not submitted".

Also add a `submission_receipts` row: post-click URL, screenshot, response
status.

### 5.4 Mark successful attempts complete

**Where:** `src/hunt/apply.ts:445-450`.

The success path sets `submittedFields`, `unresolvedFields`,
`evidenceStoragePath`, `updatedAt` — but never `status: 'submitted'` or
`completedAt`. Compare the takeover path at `:369-374`, which does both. One
line each.

### 5.5 Field-answer cache dedupe

**Where:** `field_answers_scope_idx`, and `resolveField` in
`src/hunt/apply/fields.ts:260`.

**Evidence:** seven byte-identical rows for
`(job-boards.greenhouse.io, 'Website', user_id=NULL)`. In Postgres `NULL !=
NULL` in a unique index, so `onConflictDoNothing` never fires for the shared
layer.

**Change:** migration to `UNIQUE NULLS NOT DISTINCT (user_id, host,
field_signature)`. And when a cached mapping resolves to an empty profile field,
**do not call the model** — surface it as a profile gap instead. Today that path
burns a model call per field per application and writes a duplicate row.

---

## 6. Phase 1 — VM provisioning

Pure infra. No application code.

- [ ] §3.1 disk → `pd-balanced`
- [ ] §3.2 measure PSS, then resize to `e2-standard-16`
- [ ] §3.3 base packages + Chrome
- [ ] §4.1 ten OS users
- [ ] §4.3 three templated units, enabled for 1–10

**Gate — do not proceed past this:**

```bash
# 1. Services up for tenant 3
systemctl is-active huntly-xvfb@3 huntly-x11vnc@3 huntly-novnc@3

# 2. Chrome in Flow A mode
sudo -u huntly-u3 env DISPLAY=:13 google-chrome \
  --user-data-dir=/home/huntly-u3/profile \
  --no-first-run --disable-dev-shm-usage --window-size=1440,900 about:blank &

# 3. From your laptop
gcloud compute ssh openclaw-vm --zone=asia-south1-c -- -L 6113:127.0.0.1:613
# open http://localhost:6113/vnc.html
```

**A human then signs in to Google by hand in that window.** Not an agent — a
person with the account and the 2FA device.

```bash
# 4. Stop Chrome (SIGTERM — the graceful exit is what flushes cookies), verify
sqlite3 -readonly /home/huntly-u3/profile/Default/Cookies \
  "select distinct host_key from cookies;" | grep google
```

**If Google sign-in fails here, stop.** Nothing downstream works, and every
later phase is wasted effort until it does.

---

## 7. Phase 2 — The VM agent

A small Node/TypeScript HTTP service on the VM. Loopback bind, bearer token,
systemd-managed. Lives in a new `vm-agent/` directory in this repo and deploys
to the VM.

### 7.1 Contract

All requests: `Authorization: Bearer $VM_AGENT_TOKEN`. Bind `127.0.0.1:18900`.

```
POST /tenants/:index/connect
  → 200 { mode: "connect", display: ":13", vncPort: 613, pid: 4821,
          expiresAt: "2026-09-16T10:20:00Z" }
  → 409 { error: "busy", mode: "apply" }

POST /tenants/:index/disconnect
  → 200 { stopped: true, cookieDomains: [".google.com", ".wellfound.com"] }

POST /tenants/:index/apply
  → 200 { mode: "apply", cdpUrl: "http://127.0.0.1:923",
          expiresAt: "2026-09-16T10:35:00Z" }
  → 409 { error: "busy", mode: "connect" }

POST /tenants/:index/stop
  → 200 { stopped: true }

GET  /tenants/:index/status
  → 200 { mode: "connect"|"apply"|"idle", pid: 4821|null,
          uptimeMs: 91000, profileBytes: 412000000 }

GET  /tenants/:index/cookies
  → 200 { domains: [".google.com"] }        # Chrome must be stopped
  → 409 { error: "browser_running" }

GET  /health
  → 200 { ok: true, tenants: 10, chromeVersion: "141.0.7390.54" }
```

### 7.2 Implementation notes

- **Mode is exclusive.** Keep an in-memory map `index → {mode, pid}`, and refuse
  a mode switch while a browser is live. Return 409 with the current mode so the
  caller can render something useful.
- **Spawn as the tenant user.** `spawn('sudo', ['-u', `huntly-u${i}`, 'env',
  `DISPLAY=:1${i}`, 'google-chrome', ...])`, or run the agent as root and use
  `setuid`. A sudoers rule scoped to exactly the Chrome binary is preferable to
  running the agent as root.
- **Stop means SIGTERM, then wait.** Chrome flushes cookies on graceful exit.
  `SIGKILL` loses the session — which is the whole asset. Wait up to 10 s, then
  escalate, and log loudly if you had to.
- **Idle timeout.** A connect session with nobody attached for 20 minutes stops
  itself. Track via websockify connection count or a heartbeat from the API.
- **`profileBytes`** is `du -sb` on the profile dir — feeds the eviction job in
  Phase 6.

### 7.3 systemd unit

`/etc/systemd/system/huntly-vm-agent.service` — `Restart=always`,
`Environment=VM_AGENT_TOKEN=…`, `EnvironmentFile=/etc/huntly/vm-agent.env`
(`0600`, root-owned).

### 7.4 Gate

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:18900/health | jq
curl -s -XPOST -H "Authorization: Bearer $TOKEN" localhost:18900/tenants/3/connect | jq
curl -s -XPOST -H "Authorization: Bearer $TOKEN" localhost:18900/tenants/3/apply   # expect 409
curl -s -XPOST -H "Authorization: Bearer $TOKEN" localhost:18900/tenants/3/disconnect | jq
# cookieDomains must still contain .google.com from Phase 1
```

---

## 8. Phase 3 — API browser provider

### 8.1 `src/browser/vm-client.ts` (new)

Mirrors the surface of `src/browser/client.ts` so nothing upstream changes:

```ts
export async function createProfile(p: { name: string; userId: string }): Promise<{ id: string }>
export async function getProfile(id: string): Promise<{ cookieDomains: string[] }>
export async function createBrowser(p: { profileId: string; mode: 'connect' | 'apply' }): Promise<BrowserSessionInfo>
export async function stopBrowser(id: string): Promise<void>
```

`profileId` encodes the slot: `vm:openclaw-vm:3`. `createProfile` allocates a
free `(vm_id, tenant_index)` from `user_browser_sessions`; it does not touch the
VM, because the profile directory already exists from Phase 1.

### 8.2 `src/browser/session.ts`

Add `openVmSession()` beside `openHosted` / `openLocal`. It is `openLocal` with
`chromium.connectOverCDP(cdpUrl)` in place of `launchAutomationBrowser()`, and a
`close()` that disconnects **without** killing a browser we do not own — the VM
agent owns lifecycle.

```ts
async function openVmSession(options: SessionOptions, slot: Slot): Promise<AgentSession> {
  const info = await createBrowser({ profileId: options.profileId!, mode: 'apply' })
  const browser = await chromium.connectOverCDP(info.cdpUrl!, { timeout: 60_000 })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = context.pages()[0] ?? (await context.newPage())
  // liveUrl stays null on purpose: that makes apply.ts:210 take the
  // screencast branch, which is the read-only Flow B view.
  return { browser, context, page, provider: 'vm', liveUrl: null, sessionId: info.id, close }
}
```

### 8.3 `src/config/env.ts`

- Line 107: `z.enum(['browser-use', 'local'])` → add `'vm'`
- Add `VM_AGENT_URL` (default `http://127.0.0.1:18900`), `VM_AGENT_TOKEN`,
  `VM_ID` (default `openclaw-vm`)
- Extend the `browserProvider` computed export
- Add `hasVmAgent = Boolean(env.VM_AGENT_TOKEN)`

### 8.4 Routing

Skills with `authMode === 'profile'` prefer the VM provider. Everything else
keeps its current provider. `src/hunt/apply.ts:171-173` already resolves the
skill and calls `profileFor()` — this is a one-line branch there.

### 8.5 What does not change

`src/hunt/portal-accounts.ts` needs **no edits**. `beginInteractiveLogin`
already drops the CDP connection before the human signs in (line 134) — exactly
the Google workaround — and `completeInteractiveLogin` already verifies against
real cookie domains rather than trusting the page. It was built correctly,
pointed at the wrong substrate.

---

## 9. Phase 4 — Schema and API routes

### 9.1 Migration

```sql
create table user_browser_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  vm_id            text not null,
  tenant_index     smallint not null check (tenant_index between 1 and 10),
  status           text not null default 'absent',
                   -- absent | connecting | ready | stale | failed
  cookie_domains   jsonb not null default '[]'::jsonb,
  last_verified_at timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index user_browser_sessions_user_idx on user_browser_sessions(user_id);
create unique index user_browser_sessions_slot_idx on user_browser_sessions(vm_id, tenant_index);

-- Phase 0.5
drop index if exists field_answers_scope_idx;
create unique index field_answers_scope_idx
  on field_answers (user_id, host, field_signature) nulls not distinct;

-- Phase 6 flagging
create table attempt_flags (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references apply_attempts(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  note          text,
  status        text not null default 'open',   -- open | acknowledged | resolved
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index attempt_flags_status_idx on attempt_flags(status, created_at);
```

`portal_accounts` keeps its shape. One change in *meaning*: every row for a user
now points at that user's single `browserProfileId`, because Wellfound's "Sign
in with Google" only works if Google's cookies are in the same profile.

### 9.2 Routes — `src/modules/me/routes.ts`

```
POST   /me/browser-session/connect
       → { streamUrl, tenantIndex, expiresAt }
       Allocates a slot if absent, starts Flow A, returns the proxied stream URL.

POST   /me/browser-session/disconnect
       → { connected, cookieDomains }
       Stops Chrome, reads domains, updates portal_accounts per provider.

GET    /me/browser-session
       → { status, cookieDomains, lastVerifiedAt, providers: [...] }

WS     /me/browser-session/stream?token=…
       Authenticated WebSocket proxy to the VM's websockify.
```

### 9.3 The stream proxy

The user's browser must not reach the VM directly. The API terminates the
WebSocket, authenticates, then proxies to `127.0.0.1:61X`.

Reuse the pattern in `src/live/gateway.ts`: `noServer` so an unauthenticated
client never reaches an open socket, and verify the session belongs to the
calling user before accepting. Token rides as a query parameter because a
browser WebSocket cannot set an `Authorization` header.

If the API runs off-VM, this proxy needs a tunnel to the VM. **Simplest
deployment: run the API on the VM too for this run.** One less moving part.

### 9.4 Routes — flagging

```
POST /applications/:id/flag   { note? }  → { flagged: true }
GET  /admin/flags                        → open flags with last frame + events
POST /admin/flags/:id/resolve
```

Flagging pauses that user's apply queue — set a Redis key the application worker
checks before `withPortalLock`.

---

## 10. Phase 5 — UI

Stack: React 19, Vite, Tailwind 4, react-router-dom 7.

### 10.1 Connect page — `src/pages/BrowserSession.tsx` (new)

Full-page layout: noVNC canvas left, provider checklist right.

- Embed noVNC. Either `<iframe src="/vnc.html?autoconnect=1&path=…">` pointed at
  the proxied path, or the `@novnc/novnc` RFB module directly against the
  proxied WebSocket. The module is cleaner — no nested document, and you control
  reconnect.
- **Sequential provider walkthrough, in this order:**
  1. **Google** — first, always. Wellfound and Instahyre both offer "Sign in with
     Google", and that only works if the Google session is already in this
     profile.
  2. **Wellfound**
  3. **Instahyre**
- Each step: *Open this site* → user signs in → *I'm done* → API verifies the
  expected cookie domain appeared → advance. A step that fails verification says
  so and offers a retry rather than advancing.
- Copy on the page: **"Use a job-search Google account, not your main one."**
  Onboarding copy, not a help page.

### 10.2 Apply tab entry point — `src/pages/Hunt.tsx`

A card at the top:

- No session → **Set up your browser session** → `/browser-session`
- Session ready → domains as chips, `lastVerifiedAt`, **Update session**
- Session stale → amber, **Reconnect**

### 10.3 Watch view — `src/components/LiveView.tsx`

The component already renders `frame`, `state` and `field` events and has
takeover controls.

- Add a `readOnly` prop. When set: hide the takeover controls, do not open the
  input channel, show a **Flag for review** button.
- Flow B always passes `readOnly`.
- Keep the existing takeover path intact and unreferenced — it stays correct for
  the local provider and we may want it back.

---

## 11. Phase 6 — Keeping sessions alive

- [ ] **Daily verifier job** (BullMQ, register beside the existing schedules).
      For each ready session: stop Chrome if idle, read cookie domains, flip
      `user_browser_sessions.status` to `stale` and
      `portal_accounts.actionRequired` when a domain has vanished.
- [ ] Surface "reconnect your session" in the Apply tab.
- [ ] **Profile cache eviction.** Profiles grow; disk does not. Weekly, for
      sessions over ~2 GB, delete `Default/Cache`, `Default/Code Cache`,
      `Default/Service Worker/CacheStorage`. Never touch
      `Default/Cookies` (or `Default/Network/Cookies`), `Default/Local Storage`,
      `Default/IndexedDB`.

---

## 12. Acceptance test

The whole run comes down to step 6.

1. New user → Apply tab → **Set up your browser session** → noVNC opens
2. **A human** signs in to Google → *I'm done* → `.google.com` in cookie domains
3. Wellfound **via Sign in with Google** → `.wellfound.com` appears
4. Instahyre → `.instahyre.com` appears
5. Disconnect. Chrome stops. Cookies flush.
6. **Queue one Wellfound application.** Chrome relaunches in Flow B mode against
   the same directory, already signed in, and never sees a Google login screen.
7. User watches it fill. No controls except **Flag for review**.
8. Stop before submit. Submit correctness belongs to Phase 0, not this run.

Step 6 is the thesis: **does the profile carry the session across a mode
switch?** If yes, the architecture works and everything else is detail.

### What an agent cannot do

Steps 2–4 require a real human with real accounts and a real 2FA device. Do not
let an automated agent attempt them — scripting a Google login is precisely what
this design exists to avoid, and an agent that tries will trip the detection we
built the whole VNC path to dodge.

Agents can and should verify: services up, ports bound, mode exclusivity, the
cookie-domain query, CDP reachable in apply mode, the profile surviving a
restart, and the full API/UI surface with a *pre-seeded* profile.

---

## 13. Risks

**Shared IP and fingerprint.** Separate `user-data-dir`s isolate cookies and
localStorage. They do **not** isolate canvas hash, WebGL renderer, fonts or
screen resolution — and all ten users share one GCP datacenter IP. Ten accounts,
one IP, identical fingerprints is a textbook multi-account signal, and LinkedIn
flags datacenter IPs aggressively for authenticated sessions.

**Decision for this run: LinkedIn stays off this VM.** Google, Wellfound and
Instahyre only. LinkedIn needs per-user residential egress, which is separate
work. Vary `-screen` resolution per tenant as cheap partial mitigation.

**Blast radius.** One VM holds ten people's authenticated Google sessions. A
compromise is ten people's Gmail and Drive, not ten job-board logins. Disk
encryption, no public ports, IAP or Tailscale for SSH, `0700` profile dirs, and
the agent token in a `0600` root-owned env file. Highest-leverage mitigation is
product-side: **tell users to connect a dedicated job-search Google account.**

**Session decay.** Cookies expire; providers challenge new devices and
locations. Without Phase 6 this degrades silently weeks after launch and looks
like a regression.

**Phase 0 is not optional.** Building the VM on a broken submit produces a
system that streams beautifully and applies to nothing.

---

## 14. Rollback

Every phase is independently revertible.

| Phase | Rollback |
|---|---|
| 0 | Normal git revert; covered by `npm test` |
| 1 | `systemctl disable --now 'huntly-*@*'`; machine type and disk are one command each |
| 2 | Stop `huntly-vm-agent`; nothing else depends on it until Phase 3 |
| 3 | `BROWSER_PROVIDER=browser-use` restores previous behaviour exactly |
| 4 | Migration is additive; drop the three objects |
| 5 | Feature-flag the Apply-tab card |
| 6 | Unregister the scheduled job |
