#!/usr/bin/env bash
set -euo pipefail

# macOS smoke test: launch packaged app, verify Harness listener, test shutdown.

APP_PATH=$(find release -maxdepth 2 -name 'DeepSeek Harness Desktop.app' -print -quit)

if [[ -z "$APP_PATH" ]]; then
  echo "ERROR: Packaged macOS application was not found." >&2
  exit 1
fi

echo "Found app: $APP_PATH"

# Launch with smoke test flag
"$APP_PATH/Contents/MacOS/DeepSeek Harness Desktop" \
  --workspace "$(pwd)" \
  --smoke-test-exit-after-ready &
DESKTOP_PID=$!

echo "Desktop PID: $DESKTOP_PID"

cleanup() {
  if kill -0 "$DESKTOP_PID" 2>/dev/null; then
    kill -TERM "$DESKTOP_PID" 2>/dev/null || true
    sleep 2
    kill -KILL "$DESKTOP_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

DEADLINE=$((SECONDS + 120))
HARNESS_PID=""
LISTENER_PORT=""

while (( SECONDS < DEADLINE )); do
  # Check if desktop process is still running
  if ! kill -0 "$DESKTOP_PID" 2>/dev/null; then
    echo "ERROR: Desktop process exited before Harness was ready." >&2
    exit 1
  fi

  # Find the Harness child process (dsh web --port 0)
  if [[ -z "$HARNESS_PID" ]]; then
    HARNESS_PID=$(pgrep -P "$DESKTOP_PID" -f 'dsh.*web.*--port' 2>/dev/null || true)
  fi

  if [[ -n "$HARNESS_PID" ]]; then
    # Check for loopback listener
    if [[ -z "$LISTENER_PORT" ]]; then
      LISTENER_PORT=$(lsof -nP -iTCP -sTCP:LISTEN -a -p "$HARNESS_PID" 2>/dev/null \
        | awk '/127\.0\.0\.1:/ { split($9, a, ":"); print a[2]; exit }' || true)
    fi

    if [[ -n "$LISTENER_PORT" ]]; then
      echo "Found Harness listener on port $LISTENER_PORT (PID $HARNESS_PID)"
      break
    fi
  fi

  sleep 1
done

if [[ -z "$HARNESS_PID" || -z "$LISTENER_PORT" ]]; then
  echo "ERROR: Harness did not expose a loopback listener within 120 seconds." >&2
  exit 1
fi

# Test HTTP response
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:$LISTENER_PORT/")
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: Harness returned HTTP $HTTP_CODE." >&2
  exit 1
fi

echo "HTTP check passed (200 OK)"

# Wait for desktop to complete its graceful smoke-test shutdown
TIMEOUT=30
ELAPSED=0
while kill -0 "$DESKTOP_PID" 2>/dev/null && (( ELAPSED < TIMEOUT )); do
  sleep 1
  ((ELAPSED++))
done

if kill -0 "$DESKTOP_PID" 2>/dev/null; then
  echo "ERROR: Desktop process did not complete its graceful smoke-test shutdown within ${TIMEOUT}s." >&2
  exit 1
fi

sleep 1

# Check that Harness child process is gone
if kill -0 "$HARNESS_PID" 2>/dev/null; then
  echo "ERROR: Harness child process $HARNESS_PID survived desktop shutdown." >&2
  exit 1
fi

# Check that listener port is released
REMAINING=$(lsof -nP -iTCP:"$LISTENER_PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$REMAINING" ]]; then
  echo "ERROR: Harness listener on port $LISTENER_PORT survived desktop shutdown." >&2
  exit 1
fi

echo "macOS packaged smoke test passed on port $LISTENER_PORT."
