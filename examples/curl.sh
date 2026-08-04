#!/usr/bin/env bash
# Requires: agy-oauth running (default http://127.0.0.1:10551)
set -euo pipefail
BASE="${AGY_OAUTH_BASE:-http://127.0.0.1:10551/v1}"

echo "== models =="
curl -sS "$BASE/models" | python3 -m json.tool

echo
echo "== chat/completions =="
curl -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Reply with exactly: PONG"}],
    "stream": false
  }' | python3 -m json.tool

echo
echo "== responses =="
curl -sS "$BASE/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "input": "Reply with exactly: PONG",
    "stream": false
  }' | python3 -m json.tool
