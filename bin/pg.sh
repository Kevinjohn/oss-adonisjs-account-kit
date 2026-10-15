#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA="$ROOT/tmp/pg16"
LOG="$ROOT/tmp/pg16.log"
LOCK="$ROOT/tmp/pg16.lock"
PORT="${DB_PORT:-55432}"
COMMAND="${1:-}"
[ "$#" -eq 0 ] || shift
fail() { echo "$*" >&2; exit 1; }
case "$COMMAND" in
  start|stop|status|reset) [ "$#" -eq 0 ] || fail 'usage: pg.sh {start|stop|status|reset|test [arguments]}';;
  test) ;;
  *) fail 'usage: pg.sh {start|stop|status|reset|test [arguments]}';;
esac
case "$PORT" in ''|*[!0-9]*) fail 'DB_PORT must be an integer from 1 to 65535';; esac
for path in "$ROOT/tmp" "$DATA" "$LOG"; do
  [ ! -L "$path" ] || fail "refusing symlinked managed path: $path"
done
for path in "$ROOT/tmp" "$DATA"; do
  if [ -e "$path" ]; then
    [ -d "$path" ] && [ -r "$path" ] && [ -x "$path" ] || fail "inaccessible managed directory: $path"
    [ "$(cd "$path" && pwd -P)" = "$path" ] || fail "ambiguous managed directory: $path"
  fi
done
missing() { fail 'PostgreSQL 16 not found: brew install postgresql@16, or run DB_CLIENT=pg pnpm quick:test against your own PostgreSQL 16 (see docs/verification.md)'; }
if prefix="$(brew --prefix --installed postgresql@16 2>/dev/null)"; then
  BIN="$prefix/bin"
elif ctl="$(command -v pg_ctl)"; then
  BIN="$(dirname "$ctl")"
else missing; fi
[ -d "$BIN" ] || missing
BIN="$(cd "$BIN" && pwd -P)"
for utility in pg_ctl postgres initdb pg_isready psql createdb; do [ -x "$BIN/$utility" ] || missing; done
if version="$(env -i PATH="$PATH" LC_ALL=C "$BIN/pg_ctl" --version)"; then
  case "$version" in 'pg_ctl (PostgreSQL) 16.'*|'pg_ctl (PostgreSQL) 16') ;; *) missing;; esac
else missing; fi
if node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)' 2>/dev/null; then :; else fail 'Use Node 24: nvm use'; fi
node -e 'process.exit(["darwin", "linux"].includes(process.platform) ? 0 : 1)' || fail 'Managed process inspection requires macOS or Linux'
node -e 'const p=Number(process.argv[1]);process.exit(Number.isInteger(p)&&p>=1&&p<=65535?0:1)' "$PORT" || fail 'DB_PORT must be an integer from 1 to 65535'
PORT="$(node -e 'console.log(String(Number(process.argv[1])))' "$PORT")"
POSTGRES="$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$BIN/postgres")"
export LC_ALL=C
pg() { local utility="$1"; shift; env -i PATH="$PATH" LC_ALL=C "$BIN/$utility" "$@"; }
client() { local utility="$1"; shift; pg "$utility" -h 127.0.0.1 -p "$PORT" -U account_kit "$@"; }
identity() {
  local pid directory started actual comm args expected
  [ -r "$DATA/postmaster.pid" ] || { echo 'cannot read postmaster identity' >&2; return 1; }
  { IFS= read -r pid; IFS= read -r directory; IFS= read -r started; IFS= read -r actual; } < "$DATA/postmaster.pid" || return 1
  case "$pid" in ''|*[!0-9]*) echo 'invalid postmaster PID' >&2; return 1;; esac
  [ "$pid" -gt 1 ] && [ "$directory" = "$DATA" ] || { echo 'foreign postmaster identity' >&2; return 1; }
  if comm="$(ps -ww -p "$pid" -o comm=)" && args="$(ps -ww -p "$pid" -o args=)"; then :; else echo 'cannot inspect postmaster process' >&2; return 1; fi
  expected="$POSTGRES -D $DATA -p $actual -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c fsync=off"
  [ "$args" = "$expected" ] || { echo 'foreign postmaster arguments' >&2; return 1; }
  # ps flattens argument boundaries. Independently verify the physical cwd:
  # PostgreSQL switches to its data directory before creating postmaster.pid.
  if node - "$pid" "$DATA" "$actual" "$POSTGRES" "$comm" <<'PROCESS_DIRECTORY'
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const [pid, data, port, postgres, comm] = process.argv.slice(2)
try {
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('invalid actual port')
  let directory
  if (process.platform === 'linux') {
    if (comm !== 'postgres' && comm !== postgres) throw new Error('foreign process name')
    if (fs.realpathSync(`/proc/${pid}/exe`) !== postgres) throw new Error('foreign process executable')
    directory = fs.realpathSync(`/proc/${pid}/cwd`)
  } else if (process.platform === 'darwin') {
    if (comm !== postgres) throw new Error('foreign process executable')
    const fields = execFileSync('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn0'], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 65536,
    }).split('\0').map((field) => field.startsWith('\n') ? field.slice(1) : field)
    const processes = fields.filter((field) => field.startsWith('p'))
    const names = fields.filter((field) => field.startsWith('n'))
    if (processes.length !== 1 || processes[0] !== `p${pid}` || names.length !== 1 || fields.filter((field) => field === 'fcwd').length !== 1) {
      throw new Error('ambiguous process directory')
    }
    directory = fs.realpathSync(names[0].slice(1))
  } else {
    throw new Error('unsupported process directory inspection')
  }
  if (directory !== data) throw new Error('foreign process directory')
} catch (error) {
  console.error(`cannot verify postmaster directory: ${error.message}`)
  process.exitCode = 1
}
PROCESS_DIRECTORY
  then :; else return 1; fi
}
state() {
  local result
  if pg pg_ctl -D "$DATA" status; then identity || return 1; return 0; else result=$?; fi
  case "$result" in
    3) [ ! -e "$DATA/postmaster.pid" ] || { echo 'uncertain postmaster identity' >&2; return 1; }; return 3;;
    4) if [ ! -e "$DATA" ]; then return 3; fi
       [ -d "$DATA" ] && [ -r "$DATA" ] && [ -x "$DATA" ] && [ ! -e "$DATA/postmaster.pid" ] && [ ! -e "$DATA/PG_VERSION" ] && return 3;;
  esac
  echo "unexpected PostgreSQL status: $result" >&2; return 1
}
stop_cluster() {
  local result
  if state; then
    identity || return 1
    pg pg_ctl -D "$DATA" -w -t 10 -m fast stop
  else result=$?; [ "$result" -eq 3 ]; fi
}
owns_started_cluster=0
child_group=''
locked=0
terminate_children() {
  [ -n "$child_group" ] || return 0
  if kill -0 -- "-$child_group" 2>/dev/null; then
    kill -TERM -- "-$child_group" 2>/dev/null || :
    local count=0
    while kill -0 -- "-$child_group" 2>/dev/null && [ "$count" -lt 50 ]; do sleep 0.1; count=$((count + 1)); done
    if kill -0 -- "-$child_group" 2>/dev/null; then kill -KILL -- "-$child_group" 2>/dev/null || :; fi
  fi
  wait "$child_group" 2>/dev/null || :
}
cleanup() {
  local result="$?" cleanup_result=0
  trap - EXIT
  trap '' INT TERM
  terminate_children
  if [ "$owns_started_cluster" -eq 1 ]; then
    if stop_cluster; then :; else echo 'cleanup failed: owned PostgreSQL shutdown' >&2; cleanup_result=1; fi
  fi
  if [ "$locked" -eq 1 ]; then
    if rm "$LOCK/owner" && rmdir "$LOCK"; then :; else echo "cleanup failed: release $LOCK" >&2; cleanup_result=1; fi
  fi
  if [ "$result" -eq 0 ] && [ "$cleanup_result" -ne 0 ]; then result=1; fi
  exit "$result"
}
if [ "$COMMAND" != status ]; then
  mkdir -p "$ROOT/tmp"
  if mkdir "$LOCK"; then locked=1; else fail "cluster lock busy: $LOCK"; fi
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  echo "$$" > "$LOCK/owner"
fi
start_cluster() {
  local result actual existing
  if state; then
    actual="$(sed -n '4p' "$DATA/postmaster.pid")"
    [ "$actual" = "$PORT" ] || { echo "cluster already running on port $actual" >&2; return 1; }
    echo "already running on port $actual"; return 0
  else result=$?; [ "$result" -eq 3 ] || return "$result"; fi
  if [ -f "$DATA/PG_VERSION" ]; then
    [ "$(cat "$DATA/PG_VERSION")" = 16 ] || { echo 'wrong PostgreSQL version: use bash bin/pg.sh reset' >&2; return 1; }
  elif [ -d "$DATA" ] && [ -n "$(ls -A "$DATA")" ]; then
    echo 'incomplete data directory: use bash bin/pg.sh reset' >&2; return 1
  fi
  if node - "$PORT" <<'NODE'
const net = require('node:net')
const server = net.createServer()
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `port ${process.argv[2]} is used by another server; set DB_PORT` : error.message)
  process.exitCode = 1
})
server.listen({ host: '127.0.0.1', port: Number(process.argv[2]), exclusive: true }, () => server.close())
NODE
  then :; else return $?; fi
  if [ ! -f "$DATA/PG_VERSION" ]; then pg initdb -D "$DATA" -U account_kit --auth=trust --no-locale -E UTF8 || return $?; fi
  owns_started_cluster=1
  pg pg_ctl -D "$DATA" -w -t 10 -l "$LOG" -o "-p $PORT -c unix_socket_directories='' -c listen_addresses=127.0.0.1 -c fsync=off" start || return $?
  if existing="$(client psql -X -w -d postgres -tAc "select 1 from pg_database where datname='account_kit_test'")"; then :; else return $?; fi
  if [ -z "$existing" ]; then client createdb account_kit_test || return $?; fi
}
case "$COMMAND" in
  status)
    if state; then
      echo "owned cluster running on port $(sed -n '4p' "$DATA/postmaster.pid")"
      client pg_isready || :
      exit 0
    else result=$?; [ "$result" -ne 3 ] || echo 'owned cluster stopped'; exit "$result"; fi;;
  stop) stop_cluster;;
  start) start_cluster; owns_started_cluster=0;;
  reset)
    stop_cluster
    if state; then fail 'cluster still running'; else result=$?; [ "$result" -eq 3 ] || exit "$result"; fi
    rm -rf "${DATA:?}"
    start_cluster
    owns_started_cluster=0;;
  test)
    if state; then fail 'cluster already running: use pnpm pg:stop, or run DB_CLIENT=pg pnpm quick:test directly'; else result=$?; [ "$result" -eq 3 ] || exit "$result"; fi
    start_cluster
    set -m
    (
      for variable in $(compgen -v PG); do unset "$variable"; done
      export DB_CLIENT=pg DB_HOST=127.0.0.1 DB_PORT="$PORT" DB_USER=account_kit DB_PASSWORD= DB_DATABASE=account_kit_test
      cd "$ROOT"
      exec pnpm quick:test "$@"
    ) &
    child_group=$!
    if wait "$child_group"; then exit 0; else exit "$?"; fi;;
esac
