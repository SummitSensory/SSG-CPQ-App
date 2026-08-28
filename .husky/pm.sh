#!/usr/bin/env sh
# shellcheck shell=sh
#
# Find node, and run this repo's tools with it.
#
# The problem this solves: GitHub Desktop inherits the PATH of the desktop session it
# was launched from, not the one your shell builds. Commits and pushes from the app
# therefore failed with:
#
#   husky - command not found in PATH=node_modules/.bin:/mingw64/libexec/git-core:…
#
# Two earlier attempts guessed their way around it — first trying pnpm, then corepack,
# then a list of install directories. Both failed, for the same underlying reason: what
# is on a GUI's PATH is a property of that machine and that session, and no amount of
# guessing from inside a hook settles it.
#
# So there are three sources now, in order:
#
#   1. .husky/node-path — a file holding the directory that contains node. Machine
#      specific and gitignored. One line, written once, and after that this is not a
#      guess. Create it with:
#
#          node -e "console.log(process.execPath)"        # in a working terminal
#          # then put the DIRECTORY part in .husky/node-path
#
#   2. node already on PATH — the terminal case.
#   3. The usual install directories.
#
# Sets NODE_BIN. Empty means node was not found; the calling hook decides what to do.

NODE_BIN=""

# 1. The explicit answer, if this machine has given one.
if [ -f ".husky/node-path" ]; then
  configured=$(tr -d '\r\n' < .husky/node-path)
  # Accept a Windows path as it comes out of PowerShell — "C:\nvm4w\nodejs" — and
  # convert it to the form this shell understands. Asking a person to translate
  # backslashes is the sort of instruction that gets followed once and then forgotten,
  # and the failure it produces is silent.
  case "$configured" in
    [A-Za-z]:\\* | [A-Za-z]:/*)
      drive=$(printf '%s' "$configured" | cut -c1 | tr 'A-Z' 'a-z')
      rest=$(printf '%s' "$configured" | cut -c3- | sed 's|\\|/|g')
      configured="/$drive$rest"
      ;;
  esac
  if [ -n "$configured" ]; then
    if [ -x "$configured/node.exe" ]; then
      NODE_BIN="$configured/node.exe"
    elif [ -x "$configured/node" ]; then
      NODE_BIN="$configured/node"
    elif [ -x "$configured" ]; then
      # The file may name the executable itself rather than its directory.
      NODE_BIN="$configured"
    else
      echo "hooks: .husky/node-path points at '$configured', which has no node in it."
    fi
  fi
fi

# 2. Already on PATH.
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
fi

# 3. Where installers and nvm-windows put it.
if [ -z "$NODE_BIN" ]; then
  for d in \
    "/c/Program Files/nodejs" \
    "/c/Program Files (x86)/nodejs" \
    "$LOCALAPPDATA/Programs/nodejs" \
    "$APPDATA/nvm" \
    "$HOME/.nvm/versions/node"/*/bin \
    "/usr/local/bin" \
    "/opt/homebrew/bin"
  do
    if [ -x "$d/node.exe" ]; then NODE_BIN="$d/node.exe"; break; fi
    if [ -x "$d/node" ]; then NODE_BIN="$d/node"; break; fi
  done
fi

export NODE_BIN

# Run one of this repo's CLIs. Reports and skips when the package is missing rather
# than failing: a hook is not the place to discover that node_modules is stale.
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
