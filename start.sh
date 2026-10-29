#!/usr/bin/env bash
set -euo pipefail

if [[ "${1-}" == --help || "${1-}" == -h ]]; then
    printf '%s\n' \
        'Usage: ./start.sh [repository-parent] [VS Code options...]' \
        '' \
        'Installs missing dependencies, compiles, and opens Arranged Agents in VS Code.' \
        'The repository parent defaults to the source checkout parent, not the current directory.' \
        '' \
        'Examples:' \
        '  ./start.sh' \
        '  ./start.sh /path/to/repositories' \
        '  ./start.sh /path/to/repositories --wait'
    exit 0
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd -- "$ROOT/.." && pwd)"
if [[ $# -gt 0 && "$1" != --* ]]; then
    WORKSPACE="$(cd -- "$1" && pwd)"
    shift
fi
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
      ! -f node_modules/markdown-it/package.json ||
      ! -f node_modules/@vscode/markdown-it-katex/package.json ]]; then
    npm ci
fi
npm run compile

exec env -u VSCODE_IPC_HOOK_CLI "$CODE" \
    --new-window --disable-extensions --extensionDevelopmentPath="$ROOT" \
    "$@" "$WORKSPACE"
