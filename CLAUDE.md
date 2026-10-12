# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Layerwright (npm package `layerwright`, repo formerly "claude-design-engineer"): an MCP server plus a Figma plugin that turns HTML or Claude Design exports into editable Figma layers, builds screens from a file's Design System, and maps Figma frames back to code. Everything runs locally; the plugin only talks to `ws://localhost` (ports 7331–7340).

## Commands

npm workspaces monorepo, Node 20+, TypeScript run directly via `tsx` (no compile step for dev).

```bash
npm install
npx playwright-core install chromium   # only if Google Chrome isn't installed (HTML import tests need a Chromium); Linux: --with-deps
npm run typecheck                 # tsc --noEmit for all four workspaces
npm test                          # node:test over every workspace's test/*.test.ts (scripts/test.mjs: same on Windows)
npm run build                     # sync skill → build figma-plugin → bundle mcp-server (order matters)
npm run mcp                       # run the CLI/MCP server from source (tsx apps/mcp-server/src/cli.ts)
```

CI (and the PR checklist) runs `npm run typecheck && npm run build && npm test` on Linux (Node 20 and 22), Windows and macOS.

Single test file / single test (works in any shell; flags pass to node's test runner):
```bash
npm test -- packages/core/test/resolve.test.ts
npm test -- --test-name-pattern="server.json" apps/mcp-server/test/registry.test.ts
```

HTML importer snapshots (`packages/html-import/test/__snapshots__`): regenerate with `npm test -- --update-snapshots` and review the diff.

Windows and Linux: keep commands shell-neutral. Claude Code starts the plugin's server, hooks and monitor through `plugins/layer/scripts/run.mjs` (`node "${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs" <npx arguments>`): npx is a `.cmd`/`.ps1` on Windows, which hooks and MCP servers can't start. Spawn `npm`/`npx`/`claude` with a shell on Windows (`agents.ts` `run`), compare paths with `path.relative`, write LF (`.gitattributes`), and remember Windows refuses a localhost connection only after a second or two (`relay.ts` `tcpProbe`).

Plugin dev loop: `npm run build` (or `npm run watch -w @cde/figma-plugin`), then `npx tsx apps/mcp-server/src/cli.ts plugin` to copy the build into `~/.layerwright/figma-plugin` with this computer's pairing key, and run that copy in Figma desktop (import its `manifest.json` once). Don't run `apps/figma-plugin/manifest.json` directly: that copy has no key, and the hub refuses unpaired windows. After changing server code, reconnect the MCP server (`/mcp`) so the session stops running the code it loaded at start.

## Architecture

```
Agent ──stdio/MCP──▶ MCP server (one per session) ──ws──▶ hub (one per machine, owns the port) ──ws──▶ Figma plugin UI relay ──▶ plugin main thread ──▶ Plugin API
```

- `packages/core` (`@cde/core`): pure TS, no I/O, bundled into both the server and the plugin. The Design DSL (Zod schemas in `dsl.ts`), resolver/compiler (`resolver.ts`, resolves component/variant/variable/text-style names against a cached DS scan and returns structured errors with suggestions), semantic inference, retrieval, analyzer/critique, plan export, and the shared types including the bridge protocol.
- `packages/html-import` (`@cde/html-import`): renders HTML in headless Chromium via `playwright-core` (`browser.ts`), reads computed styles/boxes (`dom.ts`), converts DOM → DSL in `convert.ts` (**pure and deterministic**), maps buttons/inputs/links to DS components (`design-system.ts`), and the pixel-faithful layer tree (`tree.ts`). Both serializers share the in-page helpers in `page.ts` (inline SVG, `<use>` sprites, icon fonts, where each picture comes from); `assets.ts` then loads the pictures in Node through the page's context and hands Figma only SVG markup or PNG/JPEG/GIF data (WebP/AVIF decoded by the browser), so the plugin never fetches anything.
- `apps/mcp-server` (published as `layerwright`): `cli.ts` is the entry for both the MCP server and the CLI subcommands (`init`, `doctor`, `import`, `hub`, `agents`, `report`, `inbox-watch`, `hook-event`, …). `server.ts` registers the MCP tools. Bridge layers: `bridge.ts` (`WsBridge`, direct single-session mode, `LAYERWRIGHT_DIRECT=1`), `hub.ts` (shared per-machine router; tags plugin request ids as `<session>~<id>`, idles out after 60s with no sessions), `relay.ts` (`RelayBridge`: the session's client to the hub; spawns the hub detached if the port is free). `prompts.ts` builds MCP prompts at runtime by slicing `skills/figma-design/SKILL.md` by `## ` heading, so renaming skill headings can break prompts. `meta.ts` decides `FROM_SOURCE` (running from a checkout vs the `dist/` bundle) and resolves where the plugin, skill, skills library and agent plugin live in each case.
- `apps/figma-plugin` (`@cde/figma-plugin`): esbuild IIFE bundle. `code.ts` is the main thread entry, `ui.html` the relay/plugin window, `execute.ts` the fixed executor for resolved plans, `edit.ts` for `figma_edit` ops, `scan.ts` DS scan/inspect, `import.ts` the faithful importer, plus cursor/notes/sessions/undo UX.

Flow of a plan: Claude or the HTML importer produces a Design Plan → server validates (Zod) and `compilePlan` resolves it against the DS scan → `planId` → `figma_execute_plan` sends it over the bridge → plugin executes it as one undo step with full rollback on failure → server re-inspects and verifies against the plan (and, for HTML, against rendered boxes).

Bridge protocol is `{ id, method, params }` → `{ id, ok, result | error }`; the plugin announces `{ type: "hello", fileName, fileKey, page, pluginBuild, protocol }` and its window adds `window` (its id) and `key`. The hub keeps one window per Figma file and routes each session to one (`Hub.windowFor`). `HUB_PROTOCOL` in `hub.ts` must be bumped on incompatible hub ⇄ client changes; features a hub may lack are announced in its welcome (`multiFile`), and messages added after 0.2.2 go only to plugin windows whose `protocol` knows them.

Who may connect (keep this when touching `hub.ts`/`bridge.ts`): `originAllowed()` refuses any upgrade with a browser Origin (the plugin iframe sends `null`; Node clients send none), sessions and the plugin window must present `pluginKey()` (`~/.layerwright/key`), and only whitelisted `notify` message types are passed to the window.

Undo and the AI cursor (`apps/figma-plugin/src/undo.ts`, `cursor.ts`, `own.ts`, `working.ts`): every document-changing request is `holdUndo()` → work → `cursorWorkEnd()` → `releaseUndo()`, i.e. exactly one undo step. The cursor lives for a session's whole task (reads too, and "thinking" between steps) and goes when the session is done (`session-state` `kind: "done"`, a finished request from the window) or quiet, so every commit goes through undo.ts's `commit()`: `cursorsStash()` takes all cursor nodes off, `figma.commitUndo()`, and they are drawn again in the same moment. Never call `figma.commitUndo()` directly. Figma takes what a plugin drew since its last commit as the newest undo step (tested in Figma), so the user's first ⌘Z after a step may only take the cursor away: it then comes back with its session's next step (drawing it at once would be a new change on top of the user's undo and drop their redo), and a redo that brings the old one back has it removed again (`ghosts`). Its tag is one line: the session's name and a short line of what it's doing. The cursor stays on while the user works: their selection, edits and page changes never take it away or move it (it stays on the page its session works on; a page a request opens takes it along, `cursorsFollowPage`), and every commit draws it again at once. Between steps, still on its task, it keeps working on the layer it worked on (moves only: it never draws clicks while it keeps busy, so the layers panel doesn't change); while its session waits for the user's answer it waits just above that layer, still; it goes when the session is done (sessions whose hooks report turn ends are remembered in `clientStorage` "turnReports", so a reloaded window keeps waiting for "done"). A step on a layer of another page draws the cursor on that page. Its tag text layer has a fixed name. Nothing selects or zooms for the user after a build or import (`zoom.ts` shows a result only when they aren't busy). Status checks and links (`ping`, `refs`) draw nothing. Plugin writes outside a request (note replies) go through `ownStep()`. `own.ts` remembers what Layerwright itself selected, wrote or moved, since Figma reports the plugin's and the user's changes alike as LOCAL.

Session lifetime (`server.ts`, `relay.ts`, `cli.ts` `inbox-watch`): after `IDLE_MS` (30 min) without a Figma call or a request from a window, a session leaves the hub (`RelayBridge.leave`) and its watcher stops by itself (it reads `~/.layerwright/inbox/<session>.active`); the next Figma call joins again and hands the watcher back as `doFirst`.

Updates (`setup.ts` `update`, `update.ts`): `npx -y layerwright@latest update` updates the Figma plugin, the agent plugin and pinned project entries; `layerwright_update` checks npm now (`fresh`), the SessionStart hook shows a once-a-day `systemMessage` (`updateNotice`), and a hub hands the port to a newer version with the same `HUB_PROTOCOL` once it's idle. User-written skills go through `SkillStore.write` (the window's `skills-write`, paired only; `layerwright_skills` action `write`).

## Ground rules (from CONTRIBUTING.md)

- **The model never writes Figma code.** A new capability = new DSL field validated in `packages/core/src/dsl.ts`, compiled in `resolver.ts`, executed with fixed Plugin API calls in `apps/figma-plugin/src/execute.ts`. No `eval`.
- **Every Plugin API used must be checked against `@figma/plugin-typings` and added to the strict mock** `apps/figma-plugin/test/figma-mock.ts` with the real rule it enforces (e.g. FILL/ABSOLUTE need an Auto Layout parent, fonts must be loaded before text writes). These rules came from real Figma failures; don't loosen the mock to make a test pass.
- New CSS cases for the importer get a fixture under `packages/html-import/test/fixtures` plus a snapshot.
- No network from the plugin beyond `ws://localhost`; no API keys, analytics or backend.
- Add a line to `CHANGELOG.md` under `## [Unreleased]` for user-facing changes.

## Things that must stay in sync

- `skills/figma-design/SKILL.md` is the source of truth for the skill. `npm run build` copies it to `plugins/layer/skills/figma-design/SKILL.md`; the mcp-server build also ships it, `skills/library`, and `plugins/layer` into `dist/`. `.claude/skills/figma-design/SKILL.md` is this repo's own project copy. Edit the source, not the copies.
- Version bumps: `apps/mcp-server/package.json`, `server.json` (description ≤ 100 chars), `plugins/layer/.claude-plugin/plugin.json`, `plugins/layer/.codex-plugin/plugin.json` (version and its pinned `layerwright@<version>` arg), `plugins/layer/.mcp.json`, `plugins/layer/hooks/hooks.json`, `plugins/layer/monitors/monitors.json` (all pinned `-y --prefer-offline layerwright@<version>`, never `@latest`; Claude Code's run it through the launcher, Codex's through `npx`), `.claude-plugin/marketplace.json`. `apps/mcp-server/test/registry.test.ts` fails when these disagree. Releases are cut by pushing a `v*` tag matching the mcp-server package version; release notes are extracted from the matching CHANGELOG section.

## Runtime state and env vars

- `~/.layerwright/` (override with `LAYERWRIGHT_HOME`): installed Figma plugin, pairing key, prefs, user skills, `hub.log`.
- `.layerwright/` in a project (gitignored here): `memory.json`, `mapping.json`, `exports/`. `.design-engineer/` is the legacy name.
- Other env vars: `LAYERWRIGHT_PORT`, `LAYERWRIGHT_DIRECT`, `LAYERWRIGHT_WORKDIR`, `LAYERWRIGHT_CHROMIUM_PATH`, `LAYERWRIGHT_PLUGIN_SRC`, `LAYERWRIGHT_NO_UPDATE_CHECK`.

More detail: `docs/architecture.md`, `docs/dsl.md` (the Design DSL), `docs/troubleshooting.md`.
