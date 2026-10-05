# Contributing to Layerwright

Thanks for helping! Bug reports, fixes, fixtures and docs are all welcome.

## Setup

```bash
git clone https://github.com/shayan-m81/layerwright && cd layerwright
npm install
npx playwright install chromium   # only if Google Chrome isn't installed (HTML import tests)
npm run typecheck && npm test && npm run build
```

To try your checkout in Figma, run `npx tsx apps/mcp-server/src/cli.ts init` in a test project. Then import `~/.layerwright/figma-plugin/manifest.json` in Figma desktop (Plugins → Development → Import plugin from manifest…). After a rebuild, `npx tsx apps/mcp-server/src/cli.ts plugin` refreshes that copy. Don't run `apps/figma-plugin/manifest.json` directly: it isn't paired with your computer, and the hub refuses it.

## Ground rules

- **The model never writes Figma code.** New capabilities are new DSL fields (validated in `packages/core/src/dsl.ts`), compiled in `resolver.ts`, and executed with fixed Plugin API calls in `apps/figma-plugin/src/execute.ts`.
- **Check every Plugin API you use** against `@figma/plugin-typings`, and add it to the strict mock (`apps/figma-plugin/test/figma-mock.ts`) with the real rule it enforces, for example "needs an Auto Layout parent".
- **Deterministic importer.** `packages/html-import/src/convert.ts` is pure. Add a fixture under `test/fixtures` for a new CSS case and update the snapshots with `UPDATE_SNAPSHOTS=1 npm test`. Review the diff.
- **No network from the plugin** beyond `ws://localhost`, and no API keys, analytics or backend.
- Keep PRs small and focused, include tests, and add a line to `CHANGELOG.md` under "Unreleased".

## Commit and PR

- `npm run typecheck && npm test && npm run build` must pass. CI runs the same.
- Describe *what* changed and *why*, and how you tested it in real Figma if it touches the plugin.

By contributing you agree that your contributions are licensed under the MIT License and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
