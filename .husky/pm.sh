#!/usr/bin/env sh
# shellcheck shell=sh
#
# Find a working pnpm, whatever launched git.
#
# Sourced by the other hooks. It exists because a commit from GitHub Desktop was
# failing with:
#
#   husky - command not found in PATH=node_modules/.bin:/mingw64/libexec/git-core:…
#
# Node was on that PATH; pnpm was not. A GUI git client inherits the PATH of the
# desktop session it was started from, not the one your shell builds — so the pnpm
# shim (installed under AppData, or provisioned by corepack) is missing, and the hook
# dies before it runs a single check.
#
# Three ways out, tried in order:
#
#   1. pnpm already on PATH — the terminal case, and the common one.
#   2. `corepack pnpm` — corepack ships with Node and reads the `packageManager`
#      field in package.json, so it provisions the exact pinned version. This is what
#      rescues the GUI: it only needs node, which the GUI does have.
#   3. The usual Windows install locations, added to PATH by hand.
#
# If none of those produce a working pnpm, PM is left empty and the calling hook says
# so and lets the commit through. That is deliberate: a hook that cannot run its
# checks should not also stop you working. The checks still run on the next commit
# from a terminal, and the pre-push hook is the real gate before anything reaches
# main.

PM=""

# 1. Already there.
if command -v pnpm >/dev/null 2>&1; then
  PM="pnpm"
fi

# 2. Corepack. Needs only node, and honours the pinned version in package.json.
if [ -z "$PM" ] && command -v corepack >/dev/null 2>&1; then
  if corepack pnpm --version >/dev/null 2>&1; then
    PM="corepack pnpm"
  fi
fi

# 3. Where Windows installers and nvm-windows put things. Harmless on macOS and
#    Linux — a directory that does not exist adds nothing.
if [ -z "$PM" ]; then
  for dir in \
    "/c/Program Files/nodejs" \
    "$APPDATA/npm" \
    "$LOCALAPPDATA/pnpm" \
    "$HOME/AppData/Roaming/npm" \
    "$HOME/AppData/Local/pnpm" \
    "$HOME/.nvm/versions/node/*/bin" \
    "/usr/local/bin" \
    "/opt/homebrew/bin"
  do
    # The glob in the nvm path needs expanding, hence the unquoted use here.
    for d in $dir; do
      [ -d "$d" ] && PATH="$PATH:$d"
    done
  done
  export PATH

  if command -v pnpm >/dev/null 2>&1; then
    PM="pnpm"
  elif command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then
    PM="corepack pnpm"
  fi
fi

export PM

# Say which one, once, so a hook that behaves differently in the GUI is not a
# mystery next time.
if [ -n "$PM" ] && [ "$PM" != "pnpm" ]; then
  echo "hooks: using '$PM' (pnpm was not on PATH)"
fi
