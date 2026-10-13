#!/usr/bin/env bash
# Smoke-test one bundle tarball the way an installer would use it: extract it,
# run the launcher directly and through a symlink (as mise shims do), and check
# that it reports the version package.json carries and can list agents without
# any Node on PATH, including when installed in a path containing spaces.
#
# Usage: scripts/smoke-bundle.sh dist-bundles/opper-linux-x64.tar.gz
set -euo pipefail

tarball=${1:?usage: smoke-bundle.sh <bundle.tar.gz>}
repo=$(cd "$(dirname "$0")/.." && pwd)
expected=$(node -p "require('$repo/package.json').version")

work=$(mktemp -d "${TMPDIR:-/tmp}/opper bundle smoke.XXXXXX")
trap '/bin/rm -rf "$work"' EXIT

tar -xzf "$tarball" -C "$work"
root=$(find "$work" -mindepth 1 -maxdepth 1 -type d)
[[ -x $root/bin/opper && -x $root/lib/node ]] || { echo "bundle layout is wrong: $(ls -R "$root" | head -20)"; exit 1; }

# Only expose the system helpers the launcher and agent discovery use. Merely
# using /usr/bin:/bin would leave Ubuntu runners' system Node on PATH.
mkdir -p "$work/bin" "$work/home"
ln -s "$root/bin/opper" "$work/bin/opper"
for helper in dirname readlink which; do
  ln -s "$(command -v "$helper")" "$work/bin/$helper"
done
export PATH="$work/bin"
for command in node npm npx; do
  if command -v "$command" >/dev/null 2>&1; then
    echo "unexpected $command on smoke-test PATH" >&2
    exit 1
  fi
done

# Start each CLI invocation with a clean environment so developer credentials,
# NODE_OPTIONS, and agent home overrides cannot affect the test.
invoke() {
  /usr/bin/env -i PATH="$PATH" HOME="$work/home" \
    OPPER_HOME="$work/home/.opper" OPPER_EDITOR_HOME="$work/home" \
    CODEX_HOME="$work/home/.codex" HERMES_HOME="$work/home/.hermes" \
    XDG_CONFIG_HOME="$work/home/.config" XDG_CACHE_HOME="$work/home/.cache" \
    CI=1 NO_COLOR=1 NO_UPDATE_NOTIFIER=1 "$@"
}

version=$(invoke "$root/bin/opper" --version)
[[ $version == "$expected" ]] || { echo "direct launch printed '$version', expected '$expected'"; exit 1; }

version=$(invoke opper --version)
[[ $version == "$expected" ]] || { echo "symlinked launch printed '$version', expected '$expected'"; exit 1; }

invoke opper --help >/dev/null
agents=$(invoke opper agents list)
[[ $agents == *'opper launch claude'* ]] || { echo "agents list did not mention claude"; exit 1; }

# The slot argument contains spaces; preserve it as one argument and propagate
# the CLI's auth-required exit code through the launcher.
rc=0
failure=$(invoke opper --key 'bundle smoke missing' whoami 2>&1) || rc=$?
[[ $rc == 2 && $failure == *'No API key stored for slot "bundle smoke missing"'* ]] || {
  echo "launcher did not preserve arguments or failure code: exit $rc: $failure" >&2
  exit 1
}

echo "ok: ${tarball##*/} runs $expected with its bundled node"
