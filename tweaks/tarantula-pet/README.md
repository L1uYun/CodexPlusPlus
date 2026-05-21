# Tarantula Pet

Renderer tweak for Codex++ that adds a tarantula-like desktop pet overlay.

The motion model is intentionally intermittent:

- `pause`: mostly still, with very small posture changes.
- `probe`: short sensing/orientation phase.
- `creep`: slow short crawl segment.
- `home`: moves toward the screen that currently contains the cursor.

This is a b-nnett Codex++ tweak. Copy this folder to:

- Windows: `%APPDATA%/codex-plusplus/tweaks/tarantula-pet`
- macOS: `~/Library/Application Support/codex-plusplus/tweaks/tarantula-pet`
- Linux: `~/.local/share/codex-plusplus/tweaks/tarantula-pet`

Then reload Codex or restart Codex++.
