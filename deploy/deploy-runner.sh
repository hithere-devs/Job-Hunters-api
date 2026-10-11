#!/usr/bin/env bash
# Ship the application runner and VM agent to the GCP VM.
#
#   deploy/deploy-runner.sh            build, upload, migrate, restart (drains the active attempt)
#   deploy/deploy-runner.sh --no-migrate
#
# Replaces the hand-copied dist that left the runner on a different build from
# the API. The runner reports the build in its heartbeat; the API flags a
# mismatch in preflight. The previous dist is kept as dist.prev for rollback:
#   sudo rsync -a --delete /opt/huntly/api/dist.prev/ /opt/huntly/api/dist/ && sudo systemctl restart huntly-runner
set -euo pipefail

VM="${HUNTLY_VM:-openclaw-vm}"
ZONE="${HUNTLY_ZONE:-asia-south1-c}"
MIGRATE=1
[[ "${1:-}" == "--no-migrate" ]] && MIGRATE=0

cd "$(dirname "$0")/.."
npm run build
version="$(node -p "require('./dist/build-info.json').version")"
echo "Deploying runner build ${version} to ${VM}"

bundle="$(mktemp -t huntly-release.XXXXXX).tgz"
# COPYFILE_DISABLE stops macOS tar from adding ._ AppleDouble files.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$bundle" dist migrations apply-extension vm-agent/server.ts vm-agent/lifecycle-policy.ts vm-agent/openclaw-policy.ts deploy/huntly-runner.service package.json package-lock.json
gcloud compute scp "$bundle" "${VM}:/tmp/huntly-release.tgz" --zone "$ZONE"

gcloud compute ssh "$VM" --zone "$ZONE" --command "sudo MIGRATE=${MIGRATE} VERSION=${version} bash -s" <<'REMOTE'
set -euo pipefail
stage="$(mktemp -d /tmp/huntly-release.XXXXXX)"
tar xzf /tmp/huntly-release.tgz -C "$stage"

# Dependencies change only with the lockfile.
if ! cmp -s "$stage/package-lock.json" /opt/huntly/api/package-lock.json; then
  cp "$stage/package.json" "$stage/package-lock.json" /opt/huntly/api/
  (cd /opt/huntly/api && npm ci --omit=dev --no-audit --no-fund)
fi

rm -rf /opt/huntly/api/dist.prev
[[ -d /opt/huntly/api/dist ]] && cp -a /opt/huntly/api/dist /opt/huntly/api/dist.prev
rsync -a --delete "$stage/dist/" /opt/huntly/api/dist/
rsync -a --delete "$stage/migrations/" /opt/huntly/api/migrations/
# The VM agent loads the page script from here into tenant Chromes.
rsync -a --delete "$stage/apply-extension/" /opt/huntly/apply-extension/
rsync -a --delete "$stage/apply-extension/" /opt/huntly/api/apply-extension/
install -m 0644 "$stage"/vm-agent/*.ts /opt/huntly/vm-agent/
install -m 0644 "$stage/deploy/huntly-runner.service" /etc/systemd/system/huntly-runner.service
find /opt/huntly -name '._*' -delete
echo "RUNNER_VERSION=${VERSION}" > /etc/huntly/runner-version.env
systemctl daemon-reload

if [[ "$MIGRATE" == "1" ]]; then
  # runner.env is root-only (0600), as systemd reads it.
  bash -c 'set -a; . /etc/huntly/runner.env; set +a; cd /opt/huntly/api && node dist/db/migrate.js'
fi

# The agent now adopts running Chrome on restart; the runner drains its active
# attempt on SIGTERM (TimeoutStopSec covers the longest application).
systemctl restart huntly-vm-agent
systemctl restart huntly-runner
sleep 5
systemctl is-active huntly-vm-agent huntly-runner
journalctl -u huntly-runner -n 5 --no-pager
rm -rf "$stage" /tmp/huntly-release.tgz
REMOTE
rm -f "$bundle"
echo "Runner ${version} deployed."
