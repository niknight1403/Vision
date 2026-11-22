#!/usr/bin/env bash
# Local PostgreSQL bootstrap for the AutonomAgent API integration suite.
#
# Prepares a throwaway PostgreSQL instance and the database the API expects, so
# `npm run test:db --workspace @autonomagent/api` can run against a real server
# instead of skipping. It never touches a cluster that is already running with a
# different data directory, and it never prints a credential from the environment.
#
# Tested on Debian 12 / Ubuntu 24.04 with PostgreSQL 15 and 16.
#
# Usage:
#   scripts/local-postgres.sh            # start (or reuse) the cluster and print the DATABASE_URL
#   scripts/local-postgres.sh stop       # stop the cluster this script started
#   scripts/local-postgres.sh status     # print the cluster state
#
# Environment overrides:
#   PG_VERSION   PostgreSQL major version to use        (default: autodetected, else 15)
#   PG_DATA      data directory                         (default: /tmp/autonomagent-pg/data)
#   PG_PORT      TCP port                               (default: 5432)
#   PG_DB        database name                          (default: autonomagent_test)
#   PG_USER      superuser role                         (default: postgres)
#   PG_PASSWORD  superuser password for TCP logins      (default: postgres; local only)
set -euo pipefail

PG_DATA="${PG_DATA:-/tmp/autonomagent-pg/data}"
PG_PORT="${PG_PORT:-5432}"
PG_DB="${PG_DB:-autonomagent_test}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-postgres}"
LOG_FILE="${PG_DATA%/data}/postgres.log"

fail() { printf 'local-postgres: %s\n' "$1" >&2; exit 1; }

detect_bindir() {
  if [ -n "${PG_VERSION:-}" ]; then
    printf '/usr/lib/postgresql/%s/bin' "$PG_VERSION"
    return
  fi
  local newest
  newest="$(ls -1 /usr/lib/postgresql 2>/dev/null | sort -n | tail -1 || true)"
  [ -n "$newest" ] || fail "no PostgreSQL installation found under /usr/lib/postgresql (apt-get install postgresql)"
  printf '/usr/lib/postgresql/%s/bin' "$newest"
}

# PostgreSQL refuses to run as root, so every server command runs as the cluster
# owner. Root is required only for the initial data directory handover.
pg_owner() { printf '%s' "${PG_OWNER:-postgres}"; }

run_as_owner() {
  local owner; owner="$(pg_owner)"
  if [ "$(id -un)" = "$owner" ]; then
    "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    su "$owner" -c "$(printf '%q ' "$@")"
  else
    sudo -u "$owner" "$@"
  fi
}

server_running() {
  run_as_owner "$BINDIR/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1
}

case "${1:-start}" in
  status)
    BINDIR="$(detect_bindir)"
    if server_running; then
      echo "local-postgres: running (data=$PG_DATA port=$PG_PORT)"
    else
      echo "local-postgres: not running (data=$PG_DATA)"
    fi
    exit 0
    ;;
  stop)
    BINDIR="$(detect_bindir)"
    if server_running; then
      run_as_owner "$BINDIR/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null
      echo "local-postgres: stopped"
    else
      echo "local-postgres: was not running"
    fi
    exit 0
    ;;
  start) ;;
  *) fail "unknown command: $1 (expected start, stop or status)" ;;
esac

BINDIR="$(detect_bindir)"
OWNER="$(pg_owner)"

if ! id -u "$OWNER" >/dev/null 2>&1; then
  fail "role $OWNER does not exist; install the postgresql package or set PG_OWNER"
fi

if [ ! -s "$PG_DATA/PG_VERSION" ]; then
  mkdir -p "$PG_DATA"
  if [ "$(id -u)" -eq 0 ]; then
    chown -R "$OWNER" "$(dirname "$PG_DATA")"
  fi
  run_as_owner "$BINDIR/initdb" -D "$PG_DATA" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
  echo "local-postgres: initialised cluster in $PG_DATA"
fi

if ! server_running; then
  run_as_owner "$BINDIR/pg_ctl" -D "$PG_DATA" -l "$LOG_FILE" \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" start >/dev/null
  for _ in $(seq 1 30); do
    if run_as_owner "$BINDIR/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q; then break; fi
    sleep 1
  done
  run_as_owner "$BINDIR/pg_isready" -h 127.0.0.1 -p "$PG_PORT" -q \
    || fail "server did not become ready; see $LOG_FILE"
  echo "local-postgres: started on 127.0.0.1:$PG_PORT"
fi

# The password is applied through a local socket connection, so it never appears
# in a process argument list.
run_as_owner "$BINDIR/psql" -h /tmp -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE $PG_USER WITH PASSWORD '$PG_PASSWORD';" >/dev/null

if [ "$(run_as_owner "$BINDIR/psql" -h /tmp -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'")" != "1" ]; then
  run_as_owner "$BINDIR/createdb" -h /tmp -p "$PG_PORT" -U "$PG_USER" "$PG_DB"
  echo "local-postgres: created database $PG_DB"
fi

echo "local-postgres: ready"
echo "DATABASE_URL=postgresql://$PG_USER:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DB?schema=public"
echo "Next: npx prisma migrate deploy --schema services/api/prisma/schema.prisma"
echo "      npm run test:db --workspace @autonomagent/api"
