#!/usr/bin/env bash
# Dune demo layout for macOS: four shells in a grid on the left half of the
# screen, the `dune observe` dashboard on the right half.
#
#   scripts/dune-demo.sh         build if needed, start and arrange everything
#   scripts/dune-demo.sh stop    close the shells and stop the dashboard
#
# The shells are tmux panes on a private tmux server, so nothing here touches
# your own tmux sessions. Each pane starts in its own scratch project folder
# under ~/dune-demo (override with DUNE_DEMO_DIR) with this checkout's `dune`
# first on PATH.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo="${DUNE_DEMO_DIR:-$HOME/dune-demo}"
demo="${demo%/}"
tm() { tmux -L dune-demo "$@"; }

if [[ "${1:-}" == "stop" ]]; then
  tm kill-server 2>/dev/null && echo "Dune demo stopped." || echo "Dune demo was not running."
  exit 0
fi
[[ "$(uname)" == "Darwin" ]] || { echo "This demo arranges windows with AppleScript and needs macOS." >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is required: brew install tmux" >&2; exit 1; }
[[ -f "$repo/dist/dune.js" ]] || (cd "$repo" && npm run build)

# This checkout's dune, whatever is installed globally.
mkdir -p "$demo/bin"
printf '#!/bin/sh\nexec %q %q "$@"\n' "$(command -v node)" "$repo/dist/dune.js" > "$demo/bin/dune"
chmod +x "$demo/bin/dune"

if ! tm has-session -t demo 2>/dev/null; then
  names=(agent-one agent-two agent-three agent-four)
  hints=(
    "dune claude"
    "dune --log-urls curl -s https://example.com/hello"
    "dune opper launch pi"
    "dune --strict curl -sS https://example.com"
  )
  for name in "${names[@]}"; do mkdir -p "$demo/$name"; done
  tm new-session -d -s demo -n shells -x 200 -y 60 -c "$demo/${names[0]}" -e "PATH=$demo/bin:$PATH"
  tm split-window -t demo:shells -h -c "$demo/${names[1]}" -e "PATH=$demo/bin:$PATH"
  tm split-window -t demo:shells.0 -v -c "$demo/${names[2]}" -e "PATH=$demo/bin:$PATH"
  tm split-window -t demo:shells.2 -v -c "$demo/${names[3]}" -e "PATH=$demo/bin:$PATH"
  tm select-layout -t demo:shells tiled
  # Label each pane by the folder it started in, wherever tiling put it.
  while read -r pane path; do
    for i in 0 1 2 3; do
      [[ "$(basename "$path")" == "${names[$i]}" ]] &&
        tm set-option -p -t "$pane" @hint "${names[$i]}   try: ${hints[$i]}"
    done
  done < <(tm list-panes -t demo:shells -F '#{pane_id} #{pane_start_path}')
  tm set-option -t demo mouse on
  tm set-option -t demo status off
  tm set-option -w -t demo:shells pane-border-status top
  tm set-option -w -t demo:shells pane-border-format " #{@hint} "
  tm select-pane -t demo:shells.0
  # The dashboard runs in a second, hidden window so `stop` ends it too.
  tm new-window -d -t demo -n observer -c "$repo" "$demo/bin/dune observe"
fi

url=""
for _ in $(seq 1 50); do
  url="$(tm capture-pane -p -J -t demo:observer 2>/dev/null | grep -o 'http://127\.0\.0\.1:[0-9]*/#[0-9a-f]*' | tail -1 || true)"
  [[ -n "$url" ]] && break
  sleep 0.2
done
[[ -n "$url" ]] || { echo "The dashboard did not start. Look at it with: tmux -L dune-demo attach -t demo:observer" >&2; exit 1; }

# iTerm runs the command without your shell PATH, so name tmux in full.
attach="$(command -v tmux) -L dune-demo attach -t demo:shells"
arranged=yes
osascript - "$attach" "$url" <<'APPLESCRIPT' || arranged=no
on run {attachCommand, dashboardUrl}
  tell application "Finder" to set {x0, y0, x1, y1} to bounds of window of desktop
  set top to y0 + 25
  set mid to (x0 + x1) div 2
  if application id "com.googlecode.iterm2" exists then
    tell application "iTerm"
      activate
      set shells to (create window with default profile command attachCommand)
      set bounds of shells to {x0, top, mid, y1}
    end tell
  else
    tell application "Terminal"
      activate
      do script attachCommand
      set bounds of front window to {x0, top, mid, y1}
    end tell
  end if
  if application id "com.google.Chrome" exists then
    tell application "Google Chrome"
      set dashboard to make new window
      set URL of active tab of dashboard to dashboardUrl
      set bounds of dashboard to {mid, top, x1, y1}
      activate
    end tell
  else
    tell application "Safari"
      make new document with properties {URL:dashboardUrl}
      set bounds of front window to {mid, top, x1, y1}
      activate
    end tell
  end if
end run
APPLESCRIPT

if [[ "$arranged" == no ]]; then
  cat <<EOF
Could not arrange the windows (macOS may have asked to let this terminal
control iTerm or Chrome; allow it and run this again). Everything is running,
so you can also open the two halves yourself:
  Shells:     $attach
  Dashboard:  $url
EOF
  exit 1
fi
cat <<EOF
Dune demo is up.
  Left:  four shells, each in its own folder under $demo
  Right: dashboard at $url
Click a pane and run the command in its title bar. Stop everything with:
  scripts/dune-demo.sh stop
EOF
