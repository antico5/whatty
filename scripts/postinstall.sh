#!/usr/bin/env sh
# Apply the baileys patch if patch(1) is available and not already applied.
if ! command -v patch >/dev/null 2>&1; then
  echo "warning: 'patch' not found — skipping baileys patch (message edits may not decrypt)" >&2
  exit 0
fi
patch -N -p1 -d node_modules/baileys < patches/baileys@7.0.0-rc13.patch || true
