#!/usr/bin/env bash
# One-command installer for orca-playwright-bridge (no npm needed).
#
#   curl -fsSL https://raw.githubusercontent.com/sagarpalsapure/orca-playwright-bridge/main/get.sh | bash
#
# Clones the repo into ~/.orca-playwright-bridge (override with ORCA_PW_DIR) and
# runs install.sh — which symlinks the CLI + libs into ~/.local and installs the
# /orca Claude Code command. Re-run any time to update.
set -euo pipefail

REPO="https://github.com/sagarpalsapure/orca-playwright-bridge"
DEST="${ORCA_PW_DIR:-$HOME/.orca-playwright-bridge}"

command -v git  >/dev/null 2>&1 || { echo "orca-playwright-bridge: git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "orca-playwright-bridge: Node >= 18 is required" >&2; exit 1; }

if [ -d "$DEST/.git" ]; then
  echo "==> updating $DEST"
  git -C "$DEST" pull --ff-only
else
  echo "==> cloning into $DEST"
  git clone --depth 1 "$REPO" "$DEST"
fi

cd "$DEST"
./install.sh
