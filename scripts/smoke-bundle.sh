#!/usr/bin/env bash
# Smoke-test one bundle tarball the way an installer would use it: extract it,
# run the launcher directly and through a symlink (as mise shims do), and check
# that it reports the version package.json carries and can list agents without
# any Node on PATH.
#
# Usage: scripts/smoke-bundle.sh dist-bundles/opper-linux-x64.tar.gz
set -euo pipefail

tarball=${1:?usage: smoke-bundle.sh <bundle.tar.gz>}
repo=$(cd "$(dirname "$0")/.." && pwd)
expected=$(node -p "require('$repo/package.json').version")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tar -xzf "$tarball" -C "$work"
root=$(find "$work" -mindepth 1 -maxdepth 1 -type d)
[[ -x $root/bin/opper && -x $root/lib/node ]] || { echo "bundle layout is wrong: $(ls -R "$root" | head -20)"; exit 1; }

# A PATH with no node, npm or npx: the bundle must be self-sufficient. The
# home is throwaway so nothing of the runner's own Opper state is read.
mkdir -p "$work/bin" "$work/home"
ln -s "$root/bin/opper" "$work/bin/opper"
export PATH="$work/bin:/usr/bin:/bin"
export HOME="$work/home" OPPER_HOME="$work/home/.opper" XDG_CONFIG_HOME="$work/home/.config" XDG_CACHE_HOME="$work/home/.cache"
export CI=1 NO_COLOR=1 NO_UPDATE_NOTIFIER=1

version=$("$root/bin/opper" --version)
[[ $version == "$expected" ]] || { echo "direct launch printed '$version', expected '$expected'"; exit 1; }

version=$(opper --version)
[[ $version == "$expected" ]] || { echo "symlinked launch printed '$version', expected '$expected'"; exit 1; }

opper --help >/dev/null
opper agents list | grep -q 'opper launch claude' || { echo "agents list did not mention claude"; exit 1; }

echo "ok: $(basename "$tarball") runs $expected with its bundled node"
