#!/usr/bin/env bash
set -euo pipefail

HAPI_HOME="${HAPI_HOME:-/data/hapi}"
HAPI_LISTEN_HOST="${HAPI_LISTEN_HOST:-0.0.0.0}"
HAPI_LISTEN_PORT="${HAPI_LISTEN_PORT:-13314}"
HAPI_RUNNER_WORKSPACE_ROOTS="${HAPI_RUNNER_WORKSPACE_ROOTS:-/workspace}"
TOKEN_FILE="${HAPI_HOME}/cli-api-token"

mkdir -p "${HAPI_HOME}"

if [[ -z "${CLI_API_TOKEN:-}" ]]; then
    if [[ -f "${TOKEN_FILE}" ]]; then
        CLI_API_TOKEN="$(<"${TOKEN_FILE}")"
    else
        CLI_API_TOKEN="$(bun -e "const { randomBytes } = await import('node:crypto'); console.log(randomBytes(24).toString('hex'))")"
        umask 077
        printf '%s' "${CLI_API_TOKEN}" > "${TOKEN_FILE}"
    fi
    export CLI_API_TOKEN
fi

export HAPI_HOME HAPI_LISTEN_HOST HAPI_LISTEN_PORT
export HAPI_API_URL="${HAPI_API_URL:-http://127.0.0.1:${HAPI_LISTEN_PORT}}"
export HAPI_PUBLIC_URL="${HAPI_PUBLIC_URL:-http://localhost:${HAPI_LISTEN_PORT}}"
export CORS_ORIGINS="${CORS_ORIGINS:-*}"

hub_pid=""
runner_pid=""

shutdown() {
    if [[ -n "${runner_pid}" ]] && kill -0 "${runner_pid}" 2>/dev/null; then
        kill "${runner_pid}" 2>/dev/null || true
    fi
    if [[ -n "${hub_pid}" ]] && kill -0 "${hub_pid}" 2>/dev/null; then
        kill "${hub_pid}" 2>/dev/null || true
        wait "${hub_pid}" 2>/dev/null || true
    fi
}
trap shutdown INT TERM EXIT

echo "[entrypoint] HAPI_HOME=${HAPI_HOME}"
echo "[entrypoint] HAPI_API_URL=${HAPI_API_URL}"
echo "[entrypoint] HAPI_PUBLIC_URL=${HAPI_PUBLIC_URL}"
echo "[entrypoint] HAPI_LISTEN=${HAPI_LISTEN_HOST}:${HAPI_LISTEN_PORT}"
echo "[entrypoint] OpenCode: $(opencode --version 2>/dev/null || echo unavailable)"
if [[ -f "${TOKEN_FILE}" ]]; then
    echo "[entrypoint] CLI_API_TOKEN_FILE=${TOKEN_FILE}"
else
    echo "[entrypoint] CLI_API_TOKEN=provided"
fi

cd /app/cli

bun ./src/index.ts hub --no-relay --host "${HAPI_LISTEN_HOST}" --port "${HAPI_LISTEN_PORT}" &
hub_pid="$!"

for _ in $(seq 1 120); do
    if bun -e "try { const r = await fetch('http://127.0.0.1:${HAPI_LISTEN_PORT}/health'); process.exit(r.ok ? 0 : 1) } catch { process.exit(1) }" >/dev/null 2>&1; then
        break
    fi
    if ! kill -0 "${hub_pid}" 2>/dev/null; then
        echo "[entrypoint] hub exited early" >&2
        wait "${hub_pid}"
        exit 1
    fi
    sleep 0.5
done

if ! bun -e "try { const r = await fetch('http://127.0.0.1:${HAPI_LISTEN_PORT}/health'); process.exit(r.ok ? 0 : 1) } catch { process.exit(1) }" >/dev/null 2>&1; then
    echo "[entrypoint] hub did not become healthy" >&2
    exit 1
fi

runner_args=(runner start-sync)
IFS=':' read -r -a roots <<< "${HAPI_RUNNER_WORKSPACE_ROOTS}"
for root in "${roots[@]}"; do
    if [[ -n "${root}" && -d "${root}" ]]; then
        runner_args+=(--workspace-root "${root}")
    else
        echo "[entrypoint] skip missing workspace root: ${root}" >&2
    fi
done

echo "[entrypoint] starting runner: hapi ${runner_args[*]}"
bun ./src/index.ts "${runner_args[@]}" &
runner_pid="$!"
wait "${runner_pid}"
