#!/usr/bin/env bash
set -euo pipefail
image="${1:-vision-api:ci}"
docker run --rm --entrypoint sh "$image" -eu -c '
  test ! -e /workspace/apps/mobile
  test ! -e /workspace/node_modules/@autonomagent/mobile
  for package in expo metro vitest typescript tsx; do
    if find /workspace/node_modules -type d -name "$package" -print -quit | grep -q .; then
      echo "Forbidden build-time package found in runtime image: $package" >&2
      exit 1
    fi
  done
  test -f /workspace/dist/services/api/src/server.js
  test -f /workspace/dist/services/api/src/agent-task-worker.js
  test -f /workspace/packages/trading-core/dist/index.js
  test -d /workspace/services/api/prisma/migrations
  test -d /workspace/node_modules/@prisma/client
  test "$(id -u)" -ne 0
'
echo "Runtime image contains compiled API/worker, Prisma assets, and no mobile/build tooling."
