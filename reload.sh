#!/usr/bin/env bash
# Request an OpenCode plugin reload after editing this repository.
#
# OpenCode watches the plugins directory, but WSL does not deliver inotify
# events for files under a Windows drive (/mnt/c, drvfs/9p), so editing this
# repository does not trigger the automatic reload. Creating a real file in
# the plugins directory does, and that rescan re-reads this plugin through its
# symlink.
set -euo pipefail

plugins="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"
probe="$plugins/.reload-probe"

if [ ! -d "$plugins" ]; then
  echo "plugins directory not found: $plugins" >&2
  exit 1
fi

touch "$probe"
sleep 0.3
rm -f "$probe"
echo "reload requested"
