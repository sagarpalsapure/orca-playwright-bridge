#!/usr/bin/env bash
# install.sh — make orca-playwright-bridge available globally.
#   - installs npm deps into this package
#   - symlinks bin/orca-cdp into ~/.local/bin (must be on PATH)
#   - symlinks lib/*.js into ~/.local/lib
#   - copies Claude Code slash commands into ~/.claude/commands (optional)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> installing npm deps"
( cd "$HERE" && npm install )

echo "==> linking CLI + libs into ~/.local"
mkdir -p "$HOME/.local/bin" "$HOME/.local/lib"
ln -sf "$HERE/bin/orca-cdp"            "$HOME/.local/bin/orca-cdp"
ln -sf "$HERE/lib/orca-pw-bridge.js"   "$HOME/.local/lib/orca-pw-bridge.js"
ln -sf "$HERE/lib/orca-connect.js"     "$HOME/.local/lib/orca-connect.js"

if [ -d "$HOME/.claude" ]; then
  echo "==> installing Claude Code commands into ~/.claude/commands"
  mkdir -p "$HOME/.claude/commands"
  cp "$HERE/commands/"*.md "$HOME/.claude/commands/"
fi

case ":$PATH:" in
  *":$HOME/.local/bin:"*) : ;;
  *) echo "NOTE: add ~/.local/bin to your PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo "==> done. Open a tab in Orca, then test:  orca-cdp && node $HERE/lib/orca-pw-bridge.js"
