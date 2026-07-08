#!/bin/zsh
# Keep the PolicyPool Agent Coverage endpoint warm and leave an uptime trail.
set -u

ENDPOINT="${POLICYPOOL_AGENT_ENDPOINT:-https://policypool.vercel.app/api/covered-job-receipt}"
LOG="${POLICYPOOL_KEEPWARM_LOG:-/Users/qdee/.okx-agent-task/logs/policypool-keepwarm.log}"

mkdir -p "$(dirname "$LOG")"
result=$(curl -sS -o /dev/null -I --max-time 20 \
  -w '%{http_code} %{time_total}s' "$ENDPOINT" 2>&1) || result="FAIL $result"
printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$result" >> "$LOG"

if [ "$(wc -l < "$LOG")" -gt 2500 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
