#!/usr/bin/env bash
# Switch the VM runner to the planned driver. Run ON the VM as root:
#   sudo bash runner-env-planned.sh [--dry-run-first]
#
# Idempotent: sets each key, keeping every other line of /etc/huntly/runner.env.
# A backup is written next to it. Restart the runner afterwards.
set -euo pipefail
file=/etc/huntly/runner.env
cp -a "$file" "${file}.bak.$(date +%Y%m%d%H%M%S)"

set_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$file"; then sed -i "s#^${key}=.*#${key}=${value}#" "$file"; else echo "${key}=${value}" >> "$file"; fi
}

set_key APPLY_DRIVER planned
set_key APPLY_ANON_BROWSER ephemeral
set_key EPHEMERAL_BROWSER_HEADLESS true
set_key APPLY_PLAN_PROVIDER anthropic
set_key APPLY_PLAN_MODEL claude-opus-5-5
set_key APPLY_PLAN_EFFORT medium
set_key RUNNER_APPLY_CONCURRENCY 3
set_key APPLY_USER_CONCURRENCY 2
set_key APPLY_DISPATCH_WINDOW_PER_USER 3
set_key APPLY_AUTO_RETRY true
set_key BROWSER_MAX_CONCURRENT_SESSIONS 6
set_key CHROMIUM_EXECUTABLE_PATH /usr/bin/google-chrome
if [[ "${1:-}" == "--dry-run-first" ]]; then
  set_key APPLY_DRY_RUN true
  echo "APPLY_DRY_RUN=true: forms are filled and verified, nothing is submitted."
fi
chmod 0600 "$file"
echo "Updated ${file}. Restart with: systemctl restart huntly-runner"
