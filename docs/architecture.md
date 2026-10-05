# Architecture

```
Claude Code / Codex / Cursor ──stdio/MCP──▶ layerwright server ──ws──▶ hub ──ws://127.0.0.1:7331──▶ Figma plugin (UI relay → main thread) ──▶ Plugin API
   (one server per session)                   │                     (one per computer)
                                              │  validate (Zod) · resolve · retrieve · analyze · verify   (packages/core, pure TS)
HTML file/folder ──Chromium──────────────────▶│  DOM → Design DSL                                          (packages/html-import)
                                              └─ code_scan_components · code_mapping · code_verify_usage
```

## Principles

1. **The model plans; code executes.** Claude writes a Design Plan (JSON). The executor is a fixed set of Plugin API calls. There is no `eval` and no model-written plugin code.
2. **Nothing unresolved reaches Figma.** Components, variants, properties, variables and text styles are resolved against a cached scan of the open file. Failures come back as structured errors with suggestions.
3. **Non-destructive.** A new plan creates new frames. Writing into existing nodes, or applying Mode B fixes, requires `approved: true`. Replaced originals are hidden and renamed, never deleted.
4. **One undo step, full rollback.** Each run ends with `figma.commitUndo()`. If a run fails partway, it removes only the nodes it created.
5. **Local only.** There are no API keys and no backend. The plugin's only network access is `ws://localhost`. Remote images are fetched by the Node server and passed on as bytes.

## Packages

| Path | Role |
|---|---|
| `packages/core` | Types, the Design DSL (Zod), semantic role inference, retrieval, resolver/compiler, analyzer, verifier. Pure TypeScript with no I/O, so it can be bundled into the plugin |
| `packages/html-import` | Headless Chromium rendering (Playwright), DOM → Design DSL conversion, DS component mapping, and the pixel-faithful layer importer |
| `apps/mcp-server` | MCP tools, the WebSocket bridge, image inlining, code scanning, and the `layerwright` CLI (`init`, `doctor`, `import`). Published to npm as a single esbuild bundle |
| `apps/figma-plugin` | Scanner/inspector (`scan.ts`), executor (`execute.ts`), importer (`import.ts`) and the relay UI (`ui.html`) |
| `skills/figma-design` | The Claude Code skill: when to use which tool, and how to plan, approve and verify |

## HTML → Design DSL

1. **Render.** The file or folder is served on an ephemeral localhost port (prototype runtimes fetch their own files) and opened at each viewport (default 1440 and 390), with reduced motion.
2. **Read** (`dom.ts`): computed styles and boxes for every element; text runs with their boxes; inline SVG with computed fills and strokes; images as data URLs (local) or https URLs.
3. **Convert** (`convert.ts`, pure and deterministic):
   - flex containers → Auto Layout (direction, gap, padding including borders, justify → `align`, align-items → `crossAlign`, wrap)
   - one-child containers → Auto Layout whose padding reproduces the child's exact position
   - evenly spaced block stacks → vertical Auto Layout
   - everything else → a frame with absolutely positioned children
   - RTL rows: children are sorted by painted position and emitted in logical order with `direction: "rtl"`
   - plain wrappers are removed; text-only elements become text with the element's box, so alignment survives
4. **Map to the DS** (`design-system.ts`): buttons, inputs and links, recorded as hints during conversion, are replaced by real components when the resolver finds a match. Cards stay frames, so their content is kept.
5. The plan goes through the same `compilePlan` → `planId` → `figma_execute_plan` path as a hand-written plan.

## Bridge protocol

The request is `{ id, method, params }` and the response is `{ id, ok, result | error }`. Methods:
`ping`, `scanDesignSystem`, `inspect`, `executePlan`, `applyTransformations`, `editNodes`, `importTree`,
`ensurePages`, `foundations`, `exportImage`, `cleanup`, `select`. The plugin announces itself with
`{ type: "hello", fileName, page, pluginBuild }`; the build stamp lets `doctor` and `figma_status` spot a
plugin window that still runs older code. `doctor` connects to `/doctor` and gets a status reply
without displacing the plugin connection (browsers can't). The manifest allows localhost ports 7331–7340 only.

## Shared hub

Every session's server is a client of one small process per computer, the hub (`apps/mcp-server/src/hub.ts`),
which owns the bridge port. The first session that finds the port free starts it detached (`relay.ts`), the
plugin connects to it once, and it exits by itself a minute after the last session leaves. Sessions don't
affect each other: closing one leaves the rest connected, and if the hub goes away a session starts a new one
and the plugin reconnects. `LAYERWRIGHT_DIRECT=1` keeps the old one-session bridge (`bridge.ts`).

- **Routing.** A session's request goes to the plugin as `<session id>~<request id>` with the session's name and
  colour; the answer goes back to that session only. Sessions keep their id across a reconnect.
- **Who may connect.** The hub listens on `127.0.0.1`. Connections from a browser (any upgrade with an
  `Origin` header other than the plugin iframe's `null`) are refused, sessions present the per-computer key
  (`~/.layerwright/key`, mode 0600), and a plugin window must be paired with the same key: `init` and
  `layerwright plugin` write it into the installed plugin.
- **Requests from Figma.** The window and canvas notes send requests to a session through the hub; the session
  gets them in its next tool result, with `figma_inbox`, or woken by the Claude Code plugin's monitor
  (`layerwright inbox-watch`). Only notes the local user types count.
- **Versions.** `HUB_PROTOCOL` is bumped on incompatible hub ⇄ session changes. A session with an older protocol
  is refused with a message to update; a newer one asks the old hub to retire once it is idle. Messages added
  after 0.2.2 are sent only to plugin windows that announce a protocol that knows them.

## Verification

After every plan run the created nodes are inspected (instances expanded) and compared with the plan:
node types, names, variants, properties, text and text overrides, layout, token bindings, fixed sizes,
prototype interactions and their destinations, and, for HTML imports, each frame's size against the
box the browser rendered. `figma_export_image` adds the visual check: the node as an image, optionally
diffed against a Chromium screenshot of the source or another node (24px cells, 1px shift tolerance,
changed regions listed). Created roots carry plugin data `{ session, run }` for `figma_cleanup`.

## Testing

- `packages/core/test`: DSL, resolver, analyzer.
- `apps/figma-plugin/test`: executor, edits, prototypes and UI, against a **strict Figma mock** that enforces real Plugin API rules: fonts loaded before text writes, FILL/ABSOLUTE/minWidth need an Auto Layout parent, layout sizing only on Auto Layout frames and their children, turning Auto Layout on moves children, `setProperties` rejects unknown keys, only installed fonts load, `createImage` accepts only PNG, JPEG and GIF, flow starting points reject duplicate frames, and the first interaction on a page creates "Flow 1". Each of these rules was found in real Figma.
- `packages/html-import/test`: snapshot tests for a landing page, a login form and an RTL Persian page (with a bundled font, so metrics match on every OS), plus DS mapping and end to end HTML → execute.
- `apps/mcp-server/test`: the real MCP protocol and WebSocket bridge with a fake plugin; `init`, `doctor` and the CLI.
