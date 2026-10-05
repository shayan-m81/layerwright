# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Removing a session in the plugin window: the ✕ shared a style with Activity's 18 px ×, so "Remove?" overflowed the row and the window edge. It is a real button now, sized to its label, and once pressed it reads **Remove** in place of the session's state. A double-click no longer removes a session (the confirming press must come a moment after the first), and the session list no longer redraws under the pointer while it's pressed, which lost clicks while a session was working.
- The plugin window said "Connected to Claude Code" while no session was connected (only the hub was), so requests had nowhere to go. It now says **Connected · no session** with what to do, and names the session's own app (Claude Code, Codex, Cursor) when there is one.

### Added
- Sessions removed in the plugin window stay listed there, faded, as **Removed**, with how they come back, until they join again or close. A removed session that joins again (its agent's next `figma_status`) tells the user so.
- `doctor` and `figma_status` name any session on this computer still running Layerwright 0.x, which can't share Figma with 1.x, with its folder and the fix.
- `~/.layerwright/hub.log` lines carry the local time, and each hub start logs its version and pid.

### Changed
- The request watcher (Monitor) is no longer started silently: the agent tells the user in one line that it's watching the Layerwright window for their requests.

## [1.0.0] - 2026-10-05

### Added
- Listed metadata for MCP directories: `mcpName` in the npm package and a `server.json` for the official MCP Registry (a test keeps their name and version in step), and `glama.json` for claiming the Glama listing.
- Importing the Figma plugin no longer means hunting for a hidden folder: `init` copies the manifest path to the clipboard and shows the folder in Finder / Explorer, and the steps say to paste it in the file dialog (⌘⇧G on a Mac). `layerwright plugin` reinstalls the plugin files and shows the same steps again.
- Any number of Claude Code and Cursor sessions use Figma at once. The first one starts a small shared process (the hub) that owns the bridge port; every session joins it, and the plugin connects to it once. Closing a session doesn't touch the others; if the hub goes away, a session starts a new one and the plugin reconnects by itself. The hub stops when no session has been connected for a minute. `layerwright hub status` / `hub stop` show and stop it; `LAYERWRIGHT_DIRECT=1` keeps the old one-session bridge.
- The plugin window lists the connected sessions (colour, project, client, what each is doing) and tags activity and errors with the session they belong to.
- Selection hand-off: with several sessions connected, the user's selection belongs to the session they give it to (a chip under "Your selection"), the session whose own work selected it, or the one they approve when it asks in the window. Another session that asks for "the selection" waits for the user instead of acting on layers meant for someone else, and `figma_status` doesn't hand it the ids.
- Conflict check: an edit to a layer that another session changed after this one last read it is refused with `CONFLICT` (nothing changes) instead of overwriting that work. Edits from different sessions run one after another.
- `figma_export_image` takes `save`: `true` writes the picture to `.layerwright/exports/<layer>.png`, a string to that file or folder, and the result gives the path. The picture the agent sees is visible only to the agent; now it can hand the user the file.
- Session titles: `figma_status({ title })` names the session after its task ("Checkout redesign") instead of its folder, so the plugin window tells sessions apart. Titles stay unique and survive a reconnect.
- The plugin window shows a picture of the current selection (name, type, size), also with one session.
- The Layerwright plugin for Claude Code and Codex: `/layer:help`, `/layer:import`, `/layer:design`, `/layer:edit`, `/layer:code`, `/layer:check`, `/layer:components`, `/layer:prototype`, `/layer:shot`, `/layer:inbox`, `/layer:doctor`, `/layer:report`, with the MCP server and the figma-design skill inside. `init` asks which agents get it (the installed ones preselected; `--agents`, `--no-agents`) and installs it through `claude plugin` / `codex plugin`; `layerwright agents` refreshes it. The repository is also a marketplace for both (`plugins/layer`).
- Requests from the Figma window: select layers, pick a session and send *Build in code*, *Polish design*, *Make component*, *Mobile version* or your own words. In Claude Code the plugin's monitor (`layerwright inbox-watch`) wakes the session, so it starts on the request by itself; `layerwright claude` also pushes them through Claude Code channels where an organization allows them. Every client finds them in its next tool result or with `figma_inbox` (`/layer:inbox`). `figma_reply` sends progress and the outcome back to the window.
- Tasks written on the canvas: a text layer that starts with "@<session> what to do" (a note, on or inside the frame it's about: "@Checkout make this responsive"), or the same in an annotation you write on a selected layer. `@layerwright` or `@claude` work when one session is connected. That session gets it like a request from the window, about the layer under the note, and Activity follows it. It goes once the text stops changing for two seconds (six while the note is still selected), only once (remembered on the layer), and again when you edit it; the session's one-line answer is added under it, as an undo step of its own. Only what you type counts: a collaborator's edits, text Layerwright wrote and text inside components never start a task, and the session reads it as text on the canvas, not as your approval for anything beyond those layers. When the name after @ isn't a session's, a quiet card waits in the window for 45 seconds with a button for each session; the layer stays untouched and Figma shows nothing. Plugins can't read Figma comments, so notes are the way in.
- Pairing: `init` (and `layerwright plugin`) writes a per-computer key (`~/.layerwright/key`, readable only by you) into the installed plugin window. Only the paired window can connect to the hub, and sessions present the same key when they join. Connections from web pages in your browser are refused outright.
- The AI cursor: while a session changes the canvas, a cursor in its colour with its name outlines the layer it changes, glides along a soft curve and clicks where the work lands. It exists only during that change: it is drawn after the change's undo step opens and erased before it closes, so every request is exactly one undo step and undo never brings a cursor back. Reading, exporting and selecting draw nothing and don't touch the file. "Thinking", "on your request" and "asks you in the chat" show in the plugin window. The work never waits for the cursor. Settings → AI cursor turns it off.
- The plugin window is reorganised into tabs (Home, Activity, Skills, Settings, Sessions), with the Star on GitHub button in the header and at the top of Settings. In a narrow window the other tabs show only their icon.
- `/layer:connect`: connects the session to Figma and keeps it listening for requests from the window (`figma_status({ listen: true })` hands back the watcher even after the first time).
- The language Layerwright explains things in: `/layer:help` asks once, `layerwright_memory({ action: "language" })` keeps it in `~/.layerwright/prefs.json`, and every session's `figma_status` returns it.
- Compact window: the button next to Star shrinks the plugin to the selection (click its picture to zoom), who gets it, the four actions, the chat box and the last request; the window sizes itself to fit, and the choice is remembered.
- Click the picture of the selection to zoom Figma to that layer.
- Cursor crews: work on several layers at once (edits, design-system fixes) brings helper cursors in nearby shades, one per layer, each saying what it does there; step by step the crew moves to the layer each step works on.
- Lively cursors: a working cursor keeps moving and clicking over its layer; moves follow a hand's minimum-jerk path with a slight overshoot, and it keeps its size on screen when you zoom.
- Zoom to the result: when a build lands, a change lands off screen, or a request from the window is done, the view glides (centre and zoom together) to what was made or changed. Settings → Zoom to the result.
- Asking in the chat: when a session asks the user something (a question, `AskUserQuestion`, a permission prompt, or it stops with a request from the window still open), the Figma window says so ("Checkout asked you something · Answer in Claude Code", with the question) and Figma shows a notice. The plugin's chat hooks (`layerwright hook-event`, on PreToolUse/PostToolUse of AskUserQuestion, Notification and Stop) tell the session's server, which tells the window.
- Multitasking: several requests from the window run at once. Every Figma tool takes `requestId`; a session works on extra requests in background subagents, and each request gets its own cursor ("Checkout · Mobile", in a nearby shade). The window shows how many requests a session is on, and "Show the result" zooms to each one's result.
- The AI cursor shows what really happens: the text it types ("typing “Pay now”"), the frame it builds and how far along it is ("building “Hero” · 2/5") and the request from the window it works on. It drag-selects the layer it changes, shows Figma's corner handles, leans into its moves with its name tag trailing, presses with a double ripple, and types its tag out.
- `figma_edit` `set` restyles existing layers: `weight` (a name or 100–900; the closest style the font has, named in the result), `fontSize`, `fontFamily` and `italic` on a text, and `fill: "#hex"` for a text's colour or a frame's or shape's background. "Make it bolder" and "make the background pale green" no longer need a text or colour style. Fonts are loaded first, and a missing family says so.
- A guide in the plugin window: the ? in the header explains what each tab does (Home, Activity, Skills, Settings, Sessions), the four actions, notes on the canvas, compact mode, `/layer:help` and `doctor`, with a link to the full README. It opens by itself the first time.

### Security
- The shared Figma connection accepts only Layerwright's own processes and your paired plugin window: browser connections are refused before they open, sessions present the per-computer key, and an unpaired window is told to run `npx layerwright plugin` instead of receiving your sessions' requests. `doctor` and `hub status` no longer give out the pairing key, and only known message types reach the plugin window.
- The Claude Code and Codex plugin runs a pinned Layerwright version from npx's cache (`npx -y --prefer-offline layerwright@1.0.0`) instead of `@latest` on every hook, so a newly published version never runs unasked, and hooks start in about 0.9 s instead of 2.7 s. A test keeps these commands at the package version.
- `figma_export_image` saves only inside the project. Adding a skill from a link never reaches your computer or local network (every address checked when it's looked up, redirects followed by hand, downloads capped while they arrive).
- `init` asks before it removes a project's `layerwright` entry from `.mcp.json` or its copy of the skill, and the installed plugin window that holds the key is readable only by you.

### Fixed
- The hub starts from a source checkout (it couldn't find `tsx`), opens no console window on Windows, and `claude plugin` commands work with paths that contain spaces on Windows.
- Tool calls no longer hang when the plugin window is reopened mid-request or a request times out; `hub stop` and newer sessions no longer wait forever for them. Sessions keep their id, name, colour and requests across a reconnect.
- The MCP handshake no longer waits for the Figma connection (it could pass Claude Code's 30 s limit), and a port held by another program is reported instead of fought over.
- A plugin window from 0.2.x no longer shows "undefined failed" banners from messages it doesn't know.
- An empty "Page 1" is reused again for the first new page, and `figma_cleanup` also removes AI cursors a closed plugin window left behind (opening the plugin no longer removes another user's live cursor).
- The ✕ that removes a session is no longer inside the button that gives it the selection, where a second click removed the session.
- The picture of the selection no longer blinks every second while a request waits (the window rewrote it on every redraw).

### Changed
- The cursors work beside the user: when the user selects, edits or moves the view, they carry on, and the view never zooms by itself meanwhile (the window offers "Show the result" instead). A selection or an edit you make while a session works stays yours: it isn't credited to that session and never causes a false CONFLICT for another one. Outlines are thin edges, so a click on the layer under them reaches it, and the cursors' own drawing isn't counted as changes to the design.
- The SessionStart hook also starts the request watcher when the Figma window isn't open yet but was used on this computer in the last two weeks, so a session opened before the window still starts on requests by itself.
- Content scrolling under the plugin's tabs fades out instead of being cut off (the fade shows only once the panel is scrolled, so it never covers the first card).
- With several sessions, a new selection goes to the session that connected last until the user gives it to another one, instead of to nobody.
- When the Claude Code plugin is installed, `init` no longer writes the project `.mcp.json` entry and skill (and removes the ones it wrote before, plus, if you agree, a user-level `layerwright` server), so a session doesn't start two servers. The server takes its project from `LAYERWRIGHT_WORKDIR` (set by the plugin) or the folder it starts in.
- An older single-session server holding the port is reported plainly ("held by an older Layerwright"), and the session takes over by itself once it's gone.

## [0.2.2] - 2026-09-30

### Fixed
- Verification after an HTML import reports a size change where it starts, not on every container that grew or shrank with it: a text that wrapped (a stand-in font) or a taller Design System component no longer turns into dozens of "size far from the source's rendered box" mismatches ([#1](https://github.com/shayan-m81/layerwright/issues/1)).
- Library text styles failed with "its library isn't enabled for this file" even when it was: the plugin threw away Figma's real error and guessed. The lookup now tries every route (the style by id, the font from the scan, the font of a layer that uses the style, an import from the library with 30s instead of 10s), looks each style up once per run instead of once per text, and when it still fails says what actually happened (e.g. the id from the scan is gone after a library update, or the import's own error).
- A text style that can't be applied no longer rolls back the whole build: its texts keep their own font and the style's size, with one warning per style giving the reason.
- Plans take CSS weights (`weight: 600`, `"700"`, `"Semi Bold"`) and a text style by `{ id }`; a field that takes several forms says what each form wanted instead of "Invalid input".
- `layerwright report` no longer treats apostrophes as quotes ("can't be applied: its library isn't enabled" was cut to `can"…"t enabled`), and recorded plan errors keep their path (e.g. `screens.0.children.3.weight`).

## [0.2.1] - 2026-09-30

### Changed
- README and npm description present Figma → code as a main capability: reading a frame, mapping Figma components to your React components (`.layerwright/mapping.json`), implementing with them and checking the result (`code_scan_components`, `code_mapping`, `code_verify_usage`).

## [0.2.0] - 2026-09-30

### Added
- Long operations don't time out while Figma works: the plugin reports progress (scans, builds, imports, edits, Design System sync), the plugin window forwards it, and each update gives the request its full time again (up to 30 minutes). A real timeout names the last thing Figma was doing.
- Accessibility and critique: `figma_analyze_design({ mode: "a11y" })` checks text contrast against its real (blended) background (WCAG 1.4.3), touch targets (2.5.8; 44px recommended) and tiny text; `mode: "critique"` adds consistency signals (spacing off the scale or the 4px rhythm, font-size count, raw colours, near-miss alignment). The skill runs a critique loop (picture + numbers → scores for hierarchy, spacing, alignment, contrast, consistency, density → fix → up to 3 rounds) after building from a prompt.
- `figma_edit` `swap` (an instance to another component or variant, keeping its overrides) and `annotate` (native Figma annotations: markdown, live measured properties, a category created if needed). Plans take `annotations` on any node, `figma_inspect` shows them, and the plan export keeps them.
- `figma_foundations` also creates colour styles (hex, gradient, or bound to a colour variable), effect styles (shadows, layer and background blur) and grid styles (columns, rows, square grid); colour variables keep their alpha. `figma_edit` has `bind` (a variable to fills, strokes, gap, padding, radius, size, opacity) and `style` (a fill, stroke, text or effect style).
- Gradients can be linear, radial, angular (CSS conic) or diamond, in plans, colour styles and HTML imports; frames take `blur` (layer blur) and `backgroundBlur`, and imports keep CSS `filter: blur()` and `backdrop-filter: blur()`.
- Shapes: plans take `shape` nodes (ellipse with an optional arc for rings and progress, line, polygon, star), and the plan export turns Figma ellipses, lines, polygons and stars back into them. `figma_edit` has `group`, `ungroup` and `boolean` (union, subtract, intersect, exclude, flatten; the result keeps the base layer's paint).
- MCP prompts for clients without skills: `figma_design` (the whole guide), `html_to_figma`, `build_in_figma`, `change_figma`, `figma_to_code`. They are cut from the skill at run time (no second copy to drift), and the server sends short instructions that point at them.
- The skill has a text-replacement strategy (find with `format: "text"`, prefer instance TEXT properties over layer overrides, one batch, mixed-style texts, longer copy and other scripts).
- The plan export (`figma_inspect({ format: "plan" })`) keeps gradients (type, angle, stops), shadows, layer and background blur, effect styles, and turns vectors and boolean shapes into SVG icons; rebuilt, the copy matches the original pixel for pixel. Shapes take effects too (`effect`, `shadows`, `blur`, `backgroundBlur`).
- `figma_migrate`: moves every instance of one component set to another (old → new set, one library → another), matching variants and mapping renamed properties or values; a dry run first, then one undo step.
- Copies of one published library component (the same key under several node ids) count as one component, so they no longer make a name ambiguous.
- Cursor: `layerwright init --cursor` (automatic when the project has a `.cursor` folder) registers the server in `.cursor/mcp.json` and installs the skill as a Cursor rule; `doctor` checks it.
- **Design System sync after an import:** `figma_analyze_design({ mode: "sync" })` matches a fresh import to the DS like a designer: buttons and pills become DS components with the closest-looking variant (size by height, hierarchy and colour by fill, text colour and border; resting state), text gets the style with the same size and weight in the same script (even when the import used a stand-in font), colours get variables or colour styles.
- **Scan works on big library files:** main components are looked up in parallel (a real file went from over 5 minutes to about 12 seconds), library text/colour/effect styles and variables used in the file are found through the layers that use them, each variant's look and each set's usage are recorded, and copies of one library set resolve to the one the file uses most. Progress shows in the plugin window.
- **Plugin window:** status with file, page and selection; progress bar; an activity list in plain words; errors explained in plain words with the technical line below; update banner; version and build; connection settings folded away.
- **Update notice:** the server checks npm once a day (off with `LAYERWRIGHT_NO_UPDATE_CHECK=1`, never in CI) and shows a newer version in the plugin window, in `figma_status` (so Claude tells you) and in `doctor`.
- **Project memory** (`.layerwright/memory.json`): font substitutions and component mappings are reused by later imports, a choice between same-named components is remembered, the user's corrections are kept as notes (`layerwright_memory`), and recurring problems appear in `figma_status` with a hint.
- `layerwright report` drafts a redacted GitHub issue from the recurring problems for you to review and send; nothing is uploaded.
- `layerwright fonts <folder> [--install] [--only <name>]` lists the fonts an export ships and installs its TTF/OTF files for the current user.
- HTML import: text mixed with inline elements (`<b>`, `<span>`, `<a>`, `<br>`) is one text layer with styled ranges (weight, colour, size, links), in logical order for RTL, instead of many positioned layers. The DSL's `text` takes `runs`.
- HTML import: `mappings: [{ selector, component, variant?, props? }]` turns chosen elements into a component (`"$text"` = the element's text), ahead of automatic matching. `fontMap` replaces font families (also in `figma_import_html`).
- A font that's missing because the page only ships it as `.woff`/`.woff2` now says so and suggests installing a TTF/OTF or using `fontMap`. Missing-font warnings come once per family.
- `layerwright import <file> --to-figma` builds an HTML file in the open Figma file without Claude or any MCP client: it starts the bridge, waits for the plugin, builds, verifies and prints a report (`--page`, `--faithful`, `--section`, `--scan`, `--port`). `import_html_to_plan` takes `page` too.
- **Prototypes.** Any plan node takes an `id` and `interactions: [{ trigger, action, to, transition }]`: click, hover, press, drag, mouse enter/leave and after-delay triggers; navigate, overlay, swap, scroll-to, change-to, back, close and url actions; instant, dissolve, smart animate, move, push and slide transitions with easing and duration. `to` is a plan id, a screen name or a Figma node id. Screens take `scroll` and `fixedChildren`; plans take `prototype.flows`. `figma_edit` has `prototype` and `flow` ops for existing frames and interactive components. Interactions are verified, shown by `figma_inspect`, and kept in the plan export. (Overlay position can't be set through the Plugin API; overlays open centred.)
- `figma_inspect({ format })`: `summary` (counts, instances per component, top-level children), `text` and `instances` (flat lists with `offset`/`limit`), and `plan`: the subtree as a Design Plan (layout, tokens, text styles or fonts, instances by set id with variants, props and overridden text) to clone, refactor or implement. Very large trees return a hint instead of a huge answer.
- `figma_export_image({ compareWith: { nodeId } })` diffs two Figma nodes (before/after, original/rebuild).
- Plans take `inserts: [{ parentId, index?, nodes }]` to fill several existing parents in one run and undo step (needs approval).
- `figma_scan_design_system`: `reload` re-reads the cache file, `maxInstances` sets how many instances are checked for library components, and the summary lists `duplicateNames` (sets that share a name, with ids and pages). The plugin watches component and style changes, and `figma_status` says when the scan is stale.
- `figma_edit`: rename, move (to a parent, section or page), duplicate, set (visibility, position, size, opacity, text, instance properties), delete, resizeToFit and componentize, in one undo step. Ops can refer to earlier results (`"$0"`). Changing existing nodes needs `approved: true`; without it, delete only hides the node and prefixes 🗑.
- Componentize turns existing frames into a component, several components, or one component set (`variants: [{ State: "Expanded" }, …]`). It works on copies by default, placed next to the originals, can expose text layers as TEXT properties (`exposeText`), and gives cleanly stacked layers Auto Layout so the component adapts to new text.
- `target.page` in plans (name or id): the plan builds there, never silently on whatever page is open. `figma_select` switches to the page of the nodes; `figma_status` warns when Figma shows a different page than the last build.
- A top-level `section` in a plan is a real Figma Section sized to its content, and sections grow when a later plan adds to them.
- The plugin reports its build stamp (`pluginBuild` in `figma_status`), so a stale plugin window is visible.
- `figma_cleanup`: lists what Layerwright made in this session (or a run, or all), and removes it with `approved: true`. Every created root is tagged with its session and run.
- `figma_export_image`: a PNG/JPG of any node, returned as an image. With `compareWith: { html }` it also screenshots the source in headless Chrome and returns a diff heatmap plus the changed regions.
- Verification checks sizes against the plan and against the source's rendered boxes (HTML imports), text overrides inside instances, and layers hidden by overrides. `figma_import_html` now verifies screen sizes too.
- `figma_inspect({ expandInstances: true })`: the layers inside instances (text, hidden layers) and which ones are overridden.

### Fixed
- HTML import: a gradient that fades to `transparent` (glows, scrims) keeps its clear stop, in the neighbour's colour as CSS draws it, instead of losing the whole gradient; only a hard-edged transparent→colour radial is still read as a corner fillet.
- A stale layer id in `figma_edit` (deleted, undone, ungrouped) now says to fetch current ids with `figma_inspect`, instead of suggesting a Design System rescan.
- Problems say what to do: changes that didn't apply come back grouped by cause with the fix (e.g. "20 × library not enabled for this file → Assets panel → Libraries…", "font not installed: Gilroy → your export ships it: `npx layerwright fonts … --install --only Gilroy`"), once instead of once per layer, in Claude and in the plugin window. The scan says when library styles can't be applied and why.
- HTML import, found on a real Claude Design export:
  - Colours written as `oklch()`, `lab()`, `hsl()`, `color-mix()` and the like (Claude Design's default) were dropped; any CSS colour is now converted to sRGB.
  - An absolutely positioned overlay on a one-child box was imported twice (once in the flow).
  - Progress rings (SVG `stroke-dasharray` + `stroke-dashoffset`, rotated with CSS) became full circles; they are now real arcs, and a CSS transform on an `<svg>` is kept.
  - An empty frame stretched in a hugging row came out 100px tall; a frame whose width was just its content now hugs (so a wider fallback font widens it instead of wrapping); a single line of text in a column hugs unless the column's width is fixed.
  - One line of text in two fonts counted as two lines, which fixed its width and made it wrap in Figma.
  - Absolutely positioned layers that come before the flow in the HTML (a stepper's connector line) stay behind it.
- `import_html_to_plan` takes `targets` (several elements, each its own screen, e.g. the cards of a review board) and `target` (build inside a section or node, with approval).
- `figma_inspect` failed on a whole frame when one instance's component set has errors ("Component set for node has existing errors"); such instances now report their variant from the component name.
- Componentize kept DS instances linked but wrapped them in an Auto Layout frame, which in real Figma threw right-aligned text out of the box; the wrapper is now a plain frame of the instance's size.
- `figma_preview_plan` no longer needs a Design System scan for plans that use only raw values; plans that reference components or tokens say so. The scan timeout is 10 minutes for very large files.
- Text that should hug inside a frame without Auto Layout made Figma throw ("node must be an auto-layout frame or a child of an auto-layout frame") and rolled the whole import back.
- Another port than 7331 could never work: the plugin manifest only allowed `ws://localhost:7331`. It now allows 7331–7340, and the plugin window, `init --port` and the server refuse ports outside that range with a clear message. `doctor` also flags a plugin window that still runs an older build than the installed one.
- Text: explicit `fontSize`/`fontFamily`/`weight` are no longer replaced by an inferred text style, and a style is only inferred from a `role`. HTML imports used to get the body style on every text once a Design System was scanned. `style: null` opts out.
- Components with the same name are no longer picked silently: the one that has the requested variant wins, otherwise the new `AMBIGUOUS_COMPONENT` error lists the candidates. `component` also takes `{ id }` or `{ key }`; a key that isn't in the scan (a library component) is imported by key.
- `figma_import_html` swaps: layers are never hidden and fills never copied unless asked (`overrides: "none" | "text" | "match"`, default `"text"`; `fills`). An unknown variant is an error instead of a fallback to the default. Swaps take `id` or `key`.
- HTML import: `display: contents` wrappers no longer become frames with page-sized padding, and boxes whose CSS size is bigger than their content stay fixed instead of hugging.
- A plan root with `position: absolute` inside `target.parentId` keeps its x/y.

- Mode B analyzer: suggestions come in groups (`g1`, `g2`, …) that `figma_apply_transformations` can include (`groups`) or leave out (`excludeGroups`), and a one-off odd spacing variable (e.g. `item spacing/9`) is no longer suggested on an even spacing scale.
- HTML import mapped buttons to any component that merely looked like one (one text layer, 28–64px tall), e.g. an accordion. Automatic Design System mapping now needs a real role match from the name or description, skips private components (`_…`, `.…`), needs a text slot for the label and a similar height; skipped candidates are listed in the warnings. The Mode B analyzer uses the same check.
- HTML import: text with `line-height: normal` gets the rendered line height, so Figma's taller AUTO line height no longer shifts the layout.

- Sections created by Layerwright are white instead of the API's default dark grey.
- Componentize: padding is measured before Auto Layout is switched on (Figma moves the children at that moment), so a column's right padding mirrors its left one and text fills the card.
- A plan resolved against a stale scan no longer builds instances of a component that was deleted in the meantime.

## [0.1.4] - 2026-09-28

### Added
- `init` and the README now also show the Figma → code workflow ("Implement the selected Figma frame in code").
- docs/claude-prompt.md: a ready-to-paste prompt for CLAUDE.md, plus example requests.

## [0.1.3] - 2026-09-28

### Fixed
- HTML import: single-line labels (buttons, links, chips) no longer wrap in Figma. The label and its container now hug their text, so small differences between Figma's and Chrome's font metrics can't break the line.

### Added
- Demo GIF in the README.

## [0.1.2] - 2026-09-28

### Fixed
- README on npmjs.com: removed the demo GIF placeholder (it pointed at a file that doesn't exist yet), and links now work there too.

## [0.1.1] - 2026-09-28

### Fixed
- `npx layerwright …` did nothing. The CLI didn't recognise itself when started through npm's `.bin` symlink.
- The MCP server now exits and frees its port when Claude Code closes the connection, so a later session no longer fails with "port already in use".

## [0.1.0] - 2026-09-28

### Added
- **HTML to Figma import** (`import_html_to_plan`, `layerwright import`):
  - Playwright renders a file or folder (for example a Claude Design standalone HTML export) at 1440 and 390.
  - The rendered page is converted into an editable Design Plan: flexbox → Auto Layout, plus colours, borders, radii, shadows, gradients, fonts, RTL text, images and SVG icons.
  - Buttons, inputs and links map to scanned Design System components.
- Pixel-faithful importer (`figma_import_html`) with component variant sets, instance swaps and click actions; `figma_pages`; `figma_foundations` (variables and text styles).
- Design DSL: `fontFamily`, full weight scale, `italic`, `lineHeight`, `letterSpacing`, `direction: "rtl"`, `shadows`, `gradient`, `strokeWeights`, `opacity`, absolute `position`, `minWidth`/`maxWidth`, image `src` + `fit`, inline SVG icons.
- Font resolution against installed fonts ("Semi Bold" ≈ "SemiBold"), with an Inter fallback and a warning.
- `layerwright init` (one-command project setup) and `layerwright doctor` (diagnostics with fixes).
- Plugin UI states (connected, running, disconnected, last error), a remembered port, and setup help.
- An MCP server for Claude Code: Design System scan, task-scoped context, plan preview/execute/verify, Mode B audit and fixes, and design-to-code mapping and verification.

### Fixed
- The plugin no longer opens a duplicate connection after the port is changed.

[Unreleased]: https://github.com/shayan-m81/layerwright/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/shayan-m81/layerwright/compare/v0.2.2...v1.0.0
[0.2.2]: https://github.com/shayan-m81/layerwright/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/shayan-m81/layerwright/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/shayan-m81/layerwright/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/shayan-m81/layerwright/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/shayan-m81/layerwright/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/shayan-m81/layerwright/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shayan-m81/layerwright/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shayan-m81/layerwright/releases/tag/v0.1.0
