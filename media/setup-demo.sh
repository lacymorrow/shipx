#!/usr/bin/env bash
# Sets up a throwaway project at /tmp/shipx-demo so the VHS tape can show
# shipx running end-to-end without publishing or pushing anything real.
#
# Usage: source media/setup-demo.sh   (sourced, so the `shipx` function persists)
#
# Note: This script is *sourced*, so it does NOT use `set -euo pipefail` at the
# top level — that would leak errexit into the caller's shell and break VHS
# (which exits the recording shell on any non-zero exit code). The setup
# work runs in a subshell where set -e is safe.

SHIPX_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
DEMO_DIR="/tmp/shipx-demo"

(
    set -euo pipefail

    rm -rf "$DEMO_DIR"
    mkdir -p "$DEMO_DIR"
    cd "$DEMO_DIR"

    cat > package.json <<'JSON'
{
  "name": "my-package",
  "version": "0.1.0",
  "description": "A delightful library",
  "license": "MIT"
}
JSON

    cat > shipx.config.ts <<'TS'
import type { ShipConfig } from "@lacymorrow/shipx";

export default {
    steps: {
        // Show the interactive flow without touching the network or the tap repo.
        push: false,
        githubRelease: false,
        npm: false,
        homebrew: false,
    },
} satisfies ShipConfig;
TS

    git init -q
    git config user.email "demo@example.com"
    git config user.name "Demo"
    git add -A
    git commit -q -m "feat: initial commit"
    git commit -q --allow-empty -m "feat: add new flag"
    git commit -q --allow-empty -m "fix: handle edge case"
    git commit -q --allow-empty -m "docs: polish README"
)

# Expose `shipx` as a shell function pointing at the local source.
# Functions are inherited from sourced scripts; aliases aren't reliably.
shipx() {
    ( cd "$DEMO_DIR" && bun run "$SHIPX_REPO/src/cli.ts" "$@" )
}

# Land the caller in the demo dir.
cd "$DEMO_DIR"

echo "Demo ready: $DEMO_DIR"
