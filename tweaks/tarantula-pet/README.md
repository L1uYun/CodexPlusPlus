# Tarantula Pet

Codex++ tweak plugin that adds a tarantula-like desktop pet overlay.

`package.json` sets `"type": "commonjs"` because Codex++ main-side tweaks are loaded with `require()`.

This tweak uses `scope: "both"`:

- Main process: owns the official Codex avatar overlay, desktop window motion, atlas sprite frame selection, and gait timing.
- Renderer process: registers settings and preserves the native Codex avatar overlay interaction/status layers while hiding only the original avatar art.
- Renderer process also keeps the official overlay sprite on a `data:` atlas loaded through the PlusPlus asset API. Do not replace this with a `file://` image URL; sandboxed avatar overlays can render the status bubble while dropping the pet image.

The motion model is intentionally intermittent:

- `freeze`: mostly still, with very small posture changes.
- `probe`: short sensing/orientation phase.
- `crawl`: slow correlated crawl segment.
- `home`: moves toward the screen that currently contains the cursor.

This is a b-nnett Codex++ tweak. Copy this folder to:

- Windows: `%APPDATA%/codex-plusplus/tweaks/com.l1uyun.tarantula-pet`
- macOS: `~/Library/Application Support/codex-plusplus/tweaks/com.l1uyun.tarantula-pet`
- Linux: `~/.local/share/codex-plusplus/tweaks/com.l1uyun.tarantula-pet`

Then reload Codex or restart Codex++.

Regression checks:

```sh
node --check tweaks/tarantula-pet/index.js
node --test tweaks/tarantula-pet/motion.test.js
node packages/installer/dist/cli.js validate-tweak tweaks/tarantula-pet
```
