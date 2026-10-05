---
name: doctor
description: Find out why Layerwright can't reach Figma (plugin not connected, wrong port, old plugin window, another server on the port) and fix it with the user. Use for /layer:doctor or when figma_* tools fail with PLUGIN_DISCONNECTED or TIMEOUT.
disable-model-invocation: true
---

# Connection doctor

1. `figma_status`. Connected → say so (file, page, sessions) and stop.
2. Run `npx layerwright doctor` in the project and read it top to bottom; each ✗ line has its fix.
3. The usual causes: the plugin window isn't open (Figma desktop → Plugins → Development → Layerwright); the plugin was never imported (`npx layerwright init`, then import `~/.layerwright/figma-plugin/manifest.json`); an old plugin window (close and reopen it); the browser version of Figma (it must be the desktop app); a different port (`LAYERWRIGHT_PORT`).
4. After a fix, `figma_status` again and confirm.
