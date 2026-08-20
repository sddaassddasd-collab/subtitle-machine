#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TARGET="${TARGET:-https://subtitle-machine.onrender.com}"

mkdir -p "$SCRIPT_DIR/reports"
readonly STARTED_AT="$(date '+%Y%m%d-%H%M%S')"
readonly LOG_FILE="$SCRIPT_DIR/reports/health-${STARTED_AT}.log"

echo "每秒監測 $TARGET/healthz"
echo "結果：$LOG_FILE"
echo "按 Control + C 停止。"

while true; do
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  result="$(
    curl --silent --show-error --output /dev/null --max-time 5 \
      --write-out 'status=%{http_code} seconds=%{time_total}' \
      "$TARGET/healthz" 2>&1 || true
  )"
  printf '%s %s\n' "$timestamp" "$result" | tee -a "$LOG_FILE"
  sleep 1
done
