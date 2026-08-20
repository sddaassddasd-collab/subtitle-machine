#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROFILE="${1:-smoke}"

export TARGET="${TARGET:-https://subtitle-machine.onrender.com}"
export VIEWER_TOKEN="${VIEWER_TOKEN:-Xh_eF4Gg_0h_MJvsXPdFOrFW}"

case "$PROFILE" in
  smoke)
    export ARRIVAL_COUNT=10
    export RAMP_SECONDS=10
    export HOLD_SECONDS=120
    readonly TEST_FILE="$SCRIPT_DIR/viewers.yml"
    ;;
  100)
    export ARRIVAL_COUNT=100
    export RAMP_SECONDS=30
    export HOLD_SECONDS=600
    readonly TEST_FILE="$SCRIPT_DIR/viewers.yml"
    ;;
  200)
    export ARRIVAL_COUNT=200
    export RAMP_SECONDS=45
    export HOLD_SECONDS=600
    readonly TEST_FILE="$SCRIPT_DIR/viewers.yml"
    ;;
  300)
    export ARRIVAL_COUNT=300
    export RAMP_SECONDS=60
    export HOLD_SECONDS=1800
    readonly TEST_FILE="$SCRIPT_DIR/viewers.yml"
    ;;
  reconnect)
    export TEST_SECONDS=1800
    export RECONNECTS_PER_SECOND=1
    export RECONNECT_HOLD_SECONDS=10
    readonly TEST_FILE="$SCRIPT_DIR/reconnect.yml"
    ;;
  *)
    echo "未知測試：$PROFILE" >&2
    echo "可用項目：smoke、100、200、300、reconnect" >&2
    exit 2
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js，請先安裝 Node.js 22 或更新版本。" >&2
  exit 1
fi

echo "先確認正式站與觀眾連結可以讀取……"
curl --fail --silent --show-error --max-time 10 "$TARGET/healthz" >/dev/null
curl --fail --silent --show-error --max-time 10 \
  "$TARGET/api/viewer/$VIEWER_TOKEN" >/dev/null

mkdir -p "$SCRIPT_DIR/reports"
readonly STARTED_AT="$(date '+%Y%m%d-%H%M%S')"
readonly REPORT_FILE="$SCRIPT_DIR/reports/${PROFILE}-${STARTED_AT}.json"

echo "開始 $PROFILE 測試"
echo "目標：$TARGET"
echo "報告：$REPORT_FILE"

npx --yes artillery@latest run "$TEST_FILE" --output "$REPORT_FILE"
