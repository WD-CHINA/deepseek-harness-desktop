#!/usr/bin/env bash

set -euo pipefail

app_path="$(find release -maxdepth 3 -type d -name 'DeepSeek Harness Desktop.app' -print -quit)"

if [[ -z "$app_path" ]]; then
  echo 'Packaged macOS application was not found.' >&2
  exit 1
fi

executable="$app_path/Contents/MacOS/DeepSeek Harness Desktop"

if [[ ! -x "$executable" ]]; then
  echo "Packaged macOS executable is missing or not executable: $executable" >&2
  exit 1
fi

smoke_log="$(mktemp -t deepseek-harness-desktop-smoke.XXXXXX)"
smoke_data="$(mktemp -d -t deepseek-harness-desktop-smoke-data.XXXXXX)"
desktop_pid=''
harness_pid=''

cleanup() {
  if [[ -n "$desktop_pid" ]] && kill -0 "$desktop_pid" 2>/dev/null; then
    kill "$desktop_pid" 2>/dev/null || true
    sleep 1
    kill -9 "$desktop_pid" 2>/dev/null || true
  fi

  if [[ -n "$harness_pid" ]] && kill -0 "$harness_pid" 2>/dev/null; then
    kill -9 "$harness_pid" 2>/dev/null || true
  fi

  rm -f "$smoke_log"
  rm -rf "$smoke_data"
}

fail() {
  echo "$1" >&2
  echo '--- packaged application output ---' >&2
  cat "$smoke_log" >&2 || true
  exit 1
}

trap cleanup EXIT

"$executable" \
  --workspace "$PWD" \
  --user-data-dir="$smoke_data" \
  --smoke-test-exit-after-ready \
  >"$smoke_log" 2>&1 &
desktop_pid=$!

ready_url=''

for _ in $(seq 1 180); do
  if ! kill -0 "$desktop_pid" 2>/dev/null; then
    desktop_exit=0
    wait "$desktop_pid" || desktop_exit=$?
    desktop_pid=''
    fail "Desktop process exited before Harness was ready with code $desktop_exit."
  fi

  ready_url="$(
    sed -nE 's|.*dsh web: (http://127\.0\.0\.1:[0-9]+).*|\1|p' "$smoke_log" |
      tail -n 1
  )"
  harness_pid="$(
    ps -Ao pid=,ppid=,command= |
      awk -v parent="$desktop_pid" '
        $2 == parent && index($0, "--expose-internals") && !found {
          print $1
          found = 1
        }
      '
  )"

  if [[ -n "$ready_url" && -n "$harness_pid" ]]; then
    break
  fi

  sleep 0.5
done

if [[ -z "$ready_url" || -z "$harness_pid" ]]; then
  fail 'Harness did not expose a loopback URL within 90 seconds.'
fi

curl --fail --silent --show-error --max-time 15 "$ready_url/" >/dev/null ||
  fail "Harness health request failed: $ready_url/"

desktop_exited=false

for _ in $(seq 1 60); do
  if ! kill -0 "$desktop_pid" 2>/dev/null; then
    desktop_exited=true
    break
  fi
  sleep 0.5
done

if [[ "$desktop_exited" != true ]]; then
  fail 'Desktop process did not complete its graceful smoke-test shutdown within 30 seconds.'
fi

desktop_exit=0
wait "$desktop_pid" || desktop_exit=$?
desktop_pid=''

if [[ "$desktop_exit" -ne 0 ]]; then
  fail "Desktop process exited with code $desktop_exit."
fi

for _ in $(seq 1 20); do
  if ! kill -0 "$harness_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if kill -0 "$harness_pid" 2>/dev/null; then
  fail "Harness child process $harness_pid survived desktop shutdown."
fi

port="${ready_url##*:}"

if lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep LISTEN >/dev/null; then
  fail "Harness listener on port $port survived desktop shutdown."
fi

echo "macOS packaged smoke test passed on $ready_url."
