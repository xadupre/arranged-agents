#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$ROOT"

for tool in node npm code; do
    if ! command -v "$tool" > /dev/null 2>&1; then
        printf 'Required command not found: %s\n' "$tool" >&2
        exit 1
    fi
done

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
    console.error("Arranged Agents requires Node.js 22.13 or newer.");
    process.exit(1);
}
'

CODE=""
while IFS= read -r candidate; do
    if [[ "$candidate" != */remote-cli/* ]]; then
        CODE="$candidate"
        break
    fi
done < <(type -a -p code)

if [[ -z "$CODE" ]]; then
    printf '%s\n' \
        'The remote VS Code CLI cannot launch an extension development window.' \
        'Add the desktop VS Code bin directory to PATH, or run from a local terminal.' >&2
    exit 1
fi

if [[ ! -f node_modules/typescript/bin/tsc ||
      ! -f node_modules/@github/copilot-sdk/package.json ||
      ! -f node_modules/markdown-it/package.json ]]; then
    npm ci --omit=optional
fi
npm run compile

exec env -u VSCODE_IPC_HOOK_CLI "$CODE" \
    --new-window --disable-extensions --extensionDevelopmentPath="$ROOT" \
    "$@" "$ROOT"
