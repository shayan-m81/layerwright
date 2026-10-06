# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Layerwright (npm package `layerwright`, repo formerly "claude-design-engineer"): an MCP server plus a Figma plugin that turns HTML or Claude Design exports into editable Figma layers, builds screens from a file's Design System, and maps Figma frames back to code. Everything runs locally; the plugin only talks to `ws://localhost` (ports 7331–7340).

## Commands

npm workspaces monorepo, Node 20+, TypeScript run directly via `tsx` (no compile step for dev).

```bash
npm install
npx playwright install chromium   # only if Google Chrome isn't installed (HTML import tests need a Chromium)
npm run typecheck                 # tsc --noEmit for all four workspaces
npm test                          # node:test over every workspace's test/*.test.ts
npm run build                     # sync skill → build figma-plugin → bundle mcp-server (order matters)
npm run mcp                       # run the CLI/MCP server from source (tsx apps/mcp-server/src/cli.ts)
```

CI (and the PR checklist) runs `npm run typecheck && npm run build && npm test`.

Single test file / single test:
```bash
LAYERWRIGHT_NO_UPDATE_CHECK=1 node --import tsx --test --test-timeout=120000 packages/core/test/resolve.test.ts
LAYERWRIGHT_NO_UPDATE_CHECK=1 node --import tsx --test --test-name-pattern="server.json" apps/mcp-server/test/registry.test.ts
```

HTML importer snapshots (`packages/html-import/test/__snapshots__`): regenerate with `UPDATE_SNAPSHOTS=1 npm test` and review the diff.

Plugin dev loop: `npm run build` (or `npm run watch -w @cde/figma-plugin`), then `npx tsx apps/mcp-server/src/cli.ts plugin` to copy the build into `~/.layerwright/figma-plugin` with this computer's pairing key, and run that copy in Figma desktop (import its `manifest.json` once). Don't run `apps/figma-plugin/manifest.json` directly: that copy has no key, and the hub refuses unpaired windows. After changing server code, reconnect the MCP server (`/mcp`) so the session stops running the code it loaded at start.

## Architecture

```
Agent ──stdio/MCP──▶ MCP server (one per session) ──ws──▶ hub (one per machine, owns the port) ──ws──▶ Figma plugin UI relay ──▶ plugin main thread ──▶ Plugin API
```

- `packages/core` (`@cde/core`): pure TS, no I/O, bundled into both the server and the plugin. The Design DSL (Zod schemas in `dsl.ts`), resolver/compiler (`resolver.ts`, resolves component/variant/variable/text-style names against a cached DS scan and returns structured errors with suggestions), semantic inference, retrieval, analyzer/critique, plan export, and the shared types including the bridge protocol.
- `packages/html-import` (`@cde/html-import`): renders HTML in headless Chromium via `playwright-core` (`browser.ts`), reads computed styles/boxes (`dom.ts`), converts DOM → DSL in `convert.ts` (**pure and deterministic**), maps buttons/inputs/links to DS components (`design-system.ts`), and the pixel-faithful layer tree (`tree.ts`).
- `apps/mcp-server` (published as `layerwright`): `cli.ts` is the entry for both the MCP server and the CLI subcommands (`init`, `doctor`, `import`, `hub`, `agents`, `report`, `inbox-watch`, `hook-event`, …). `server.ts` registers the MCP tools. Bridge layers: `bridge.ts` (`WsBridge`, direct single-session mode, `LAYERWRIGHT_DIRECT=1`), `hub.ts` (shared per-machine router; tags plugin request ids as `<session>~<id>`, idles out after 60s with no sessions), `relay.ts` (`RelayBridge`: the session's client to the hub; spawns the hub detached if the port is free). `prompts.ts` builds MCP prompts at runtime by slicing `skills/figma-design/SKILL.md` by `## ` heading, so renaming skill headings can break prompts. `meta.ts` decides `FROM_SOURCE` (running from a checkout vs the `dist/` bundle) and resolves where the plugin, skill, skills library and agent plugin live in each case.
- `apps/figma-plugin` (`@cde/figma-plugin`): esbuild IIFE bundle. `code.ts` is the main thread entry, `ui.html` the relay/plugin window, `execute.ts` the fixed executor for resolved plans, `edit.ts` for `figma_edit` ops, `scan.ts` DS scan/inspect, `import.ts` the faithful importer, plus cursor/notes/sessions/undo UX.

Flow of a plan: Claude or the HTML importer produces a Design Plan → server validates (Zod) and `compilePlan` resolves it against the DS scan → `planId` → `figma_execute_plan` sends it over the bridge → plugin executes it as one undo step with full rollback on failure → server re-inspects and verifies against the plan (and, for HTML, against rendered boxes).

Bridge protocol is `{ id, method, params }` → `{ id, ok, result | error }`; the plugin announces `{ type: "hello", fileName, fileKey, page, pluginBuild, protocol }` and its window adds `window` (its id) and `key`. The hub keeps one window per Figma file and routes each session to one (`Hub.windowFor`). `HUB_PROTOCOL` in `hub.ts` must be bumped on incompatible hub ⇄ client changes; features a hub may lack are announced in its welcome (`multiFile`), and messages added after 0.2.2 go only to plugin windows whose `protocol` knows them.

Who may connect (keep this when touching `hub.ts`/`bridge.ts`): `originAllowed()` refuses any upgrade with a browser Origin (the plugin iframe sends `null`; Node clients send none), sessions and the plugin window must present `pluginKey()` (`~/.layerwright/key`), and only whitelisted `notify` message types are passed to the window.

Undo and the AI cursor (`apps/figma-plugin/src/undo.ts`, `cursor.ts`, `own.ts`): every document-changing request is `holdUndo()` → work → erase cursor → `releaseUndo()`, i.e. exactly one undo step, and cursor nodes never exist outside a request. Read-only methods draw nothing. Plugin writes outside a request (note replies) go through `ownStep()`. `own.ts` remembers what Layerwright itself selected, wrote or moved, since Figma reports the plugin's and the user's changes alike as LOCAL.

## Ground rules (from CONTRIBUTING.md)

- **The model never writes Figma code.** A new capability = new DSL field validated in `packages/core/src/dsl.ts`, compiled in `resolver.ts`, executed with fixed Plugin API calls in `apps/figma-plugin/src/execute.ts`. No `eval`.
- **Every Plugin API used must be checked against `@figma/plugin-typings` and added to the strict mock** `apps/figma-plugin/test/figma-mock.ts` with the real rule it enforces (e.g. FILL/ABSOLUTE need an Auto Layout parent, fonts must be loaded before text writes). These rules came from real Figma failures; don't loosen the mock to make a test pass.
- New CSS cases for the importer get a fixture under `packages/html-import/test/fixtures` plus a snapshot.
- No network from the plugin beyond `ws://localhost`; no API keys, analytics or backend.
- Add a line to `CHANGELOG.md` under `## [Unreleased]` for user-facing changes.

## Things that must stay in sync

- `skills/figma-design/SKILL.md` is the source of truth for the skill. `npm run build` copies it to `plugins/layer/skills/figma-design/SKILL.md`; the mcp-server build also ships it, `skills/library`, and `plugins/layer` into `dist/`. `.claude/skills/figma-design/SKILL.md` is this repo's own project copy. Edit the source, not the copies.
- Version bumps: `apps/mcp-server/package.json`, `server.json` (description ≤ 100 chars), `plugins/layer/.claude-plugin/plugin.json`, `plugins/layer/.codex-plugin/plugin.json` (version and its pinned `layerwright@<version>` arg), `plugins/layer/.mcp.json`, `plugins/layer/hooks/hooks.json`, `plugins/layer/monitors/monitors.json` (all pinned `npx -y --prefer-offline layerwright@<version>`, never `@latest`), `.claude-plugin/marketplace.json`. `apps/mcp-server/test/registry.test.ts` fails when these disagree. Releases are cut by pushing a `v*` tag matching the mcp-server package version; release notes are extracted from the matching CHANGELOG section.

## Runtime state and env vars

- `~/.layerwright/` (override with `LAYERWRIGHT_HOME`): installed Figma plugin, pairing key, prefs, user skills, `hub.log`.
- `.layerwright/` in a project (gitignored here): `memory.json`, `mapping.json`, `exports/`. `.design-engineer/` is the legacy name.
- Other env vars: `LAYERWRIGHT_PORT`, `LAYERWRIGHT_DIRECT`, `LAYERWRIGHT_WORKDIR`, `LAYERWRIGHT_CHROMIUM_PATH`, `LAYERWRIGHT_PLUGIN_SRC`, `LAYERWRIGHT_NO_UPDATE_CHECK`.

More detail: `docs/architecture.md`, `docs/dsl.md` (the Design DSL), `docs/troubleshooting.md`.
