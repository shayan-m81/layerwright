# Skills library

Design, UX, UI and design-to-code skills that ship with Layerwright. The agent sees the enabled ones in `figma_status` and reads one with `layerwright_skills` before a job it fits; the user turns them on and off, and adds their own, in the Skills tab of the Figma window (or with `/layer:skills`, or `/skill <link>` in the window's chat box). The user's own skills live in `~/.layerwright/skills`, outside the package, so updates never remove them.

Each skill here is copied unchanged (Markdown files only) from its source at the commit in the link, under its own license; the license texts are in [LICENSES/](LICENSES). `catalog.json` adds what each one is for in Layerwright's jobs. Picked from [aiuxplayground.com/skills](https://aiuxplayground.com/skills) and the repositories behind it.

| Skill | Category | Author | License | Source |
|---|---|---|---|---|
| Design Critique | UX | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/knowledge-work-plugins/tree/8444efcd48f7012f09797778a36a33e73d0861f4/design/skills/design-critique) |
| UX Copy | UX | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/knowledge-work-plugins/tree/8444efcd48f7012f09797778a36a33e73d0861f4/design/skills/ux-copy) |
| User Research | UX | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/knowledge-work-plugins/tree/8444efcd48f7012f09797778a36a33e73d0861f4/design/skills/user-research) |
| Research Synthesis | UX | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/knowledge-work-plugins/tree/8444efcd48f7012f09797778a36a33e73d0861f4/design/skills/research-synthesis) |
| Frontend Design | UI & visual | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/skills/tree/8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4/skills/frontend-design) |
| Better Layout | UI & visual | Jakub Krehel | MIT | [source](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-layout) |
| Better Typography | UI & visual | Jakub Krehel | MIT | [source](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-typography) |
| Better Colors | UI & visual | Jakub Krehel | MIT | [source](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-colors) |
| Better UI | UI & visual | Jakub Krehel | MIT | [source](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-ui) |
| Design System | Design systems | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/knowledge-work-plugins/tree/8444efcd48f7012f09797778a36a33e73d0861f4/design/skills/design-system) |
| Create DESIGN.md | Design systems | Julien Thibeaut (ibelick) | MIT | [source](https://github.com/ibelick/ui-skills/tree/e4c80664b61b0006a03bb6ba8339d6d82777b690/skills/create-design-md) |
| Design Handoff | Design → code | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/knowledge-work-plugins/tree/8444efcd48f7012f09797778a36a33e73d0861f4/design/skills/design-handoff) |
| Design Engineering | Design → code | Emil Kowalski | MIT | [source](https://github.com/emilkowalski/skills/tree/e8a175de22ae1e49370fc144c1f3bb9aeedf988d/skills/emil-design-eng) |
| Break (every state) | Design → code | Jakub Krehel | MIT | [source](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/break) |
| Accessibility Review | Accessibility | Anthropic | Apache-2.0 | [source](https://github.com/anthropics/knowledge-work-plugins/tree/8444efcd48f7012f09797778a36a33e73d0861f4/design/skills/accessibility-review) |
| Better Accessibility | Accessibility | Jakub Krehel | MIT | [source](https://github.com/jakubkrehel/skills/tree/267330e1adfc66a718fb65fa6918c1f06d0a689e/skills/better-accessibility) |
| Animate | Motion | Emil Kowalski | MIT | [source](https://github.com/emilkowalski/skills/tree/e8a175de22ae1e49370fc144c1f3bb9aeedf988d/skills/animate) |

To refresh one: copy its folder again from the source, update the commit in `catalog.json`, and run the tests (`apps/mcp-server/test/skills.test.ts` checks every entry).
