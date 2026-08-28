#!/usr/bin/env sh
# shellcheck shell=sh
#
# Find node, and run this repo's tools with it.
#
# Why not pnpm: GitHub Desktop inherits the PATH of the desktop session, not your
# shell's. Node is on that PATH — you can see it in the failure, `/c/Program
# Files/nodejs` — but pnpm is not, because pnpm's shim lives under AppData or is
# provisioned by corepack, and neither is on a GUI's PATH. Every commit from the app
# therefore died with:
#
#   husky - command not found in PATH=node_modules/.bin:/mingw64/libexec/git-core:…
#
# An earlier attempt at this tried pnpm, then `corepack pnpm`, then a list of likely
# install directories. It still failed, and the reason is worth writing down: corepack
# provisions pnpm on first use, which wants to download, and a git hook is not a place
# where that can be relied on to work.
#
# So the hooks no longer use a package manager at all. Every tool they need is already
# in node_modules, and node can run it directly. That removes the whole class of
# problem rather than adding another fallback to it.
#
# Sets NODE_BIN. Empty means node could not be found, and the calling hook decides
# what to do about that.

NODE_BIN=""

if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  # Where Windows installers and nvm-windows put it. Harmless elsewhere — a directory
  # that does not exist contributes nothing.
  for d in \
    "/c/Program Files/nodejs" \
    "/c/Program Files (x86)/nodejs" \
    "$APPDATA/nvm" \
    "$HOME/.nvm/versions/node"/*/bin \
    "/usr/local/bin" \
    "/opt/homebrew/bin"
  do
    if [ -x "$d/node" ]; then
      NODE_BIN="$d/node"
      break
    fi
    if [ -x "$d/node.exe" ]; then
      NODE_BIN="$d/node.exe"
      break
    fi
  done
fi

export NODE_BIN

# Run one of this repo's CLIs. Reports and skips when the package is not installed,
# rather than failing: a hook is not the place to discover that node_modules is stale.
#
#   run_tool <path under node_modules> [args...]
run_tool() {
  tool="$1"
  shift
  if [ ! -f "node_modules/$tool" ]; then
    echo "hooks: node_modules/$tool is missing — run 'pnpm install'. Skipping this check."
    return 0
  fi
  "$NODE_BIN" "node_modules/$tool" "$@"
}