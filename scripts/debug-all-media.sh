#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${WHATTY_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/whatty}"
DEST="/tmp/whatty-media-$$"
mkdir -p "$DEST"

shopt -s nullglob
count=0

for media_file in "$DATA_DIR"/accounts/*/media/*; do
  [ -f "$media_file" ] || continue

  # Extract path components:
  #   $DATA_DIR/accounts/<account>/media/<filename>
  rel="${media_file#"$DATA_DIR/accounts/"}"
  account="${rel%%/*}"
  filename="${media_file##*/}"

  link_name="${account}__${filename}"
  ln -s "$media_file" "$DEST/$link_name"
  count=$((count + 1))
done

echo "Linked $count file(s) → $DEST"
