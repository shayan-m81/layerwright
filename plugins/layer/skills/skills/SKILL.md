---
name: skills
description: The design, UX, UI and design-to-code skills Layerwright gives the agent - list them, read one, add the user's own from a link or pasted SKILL.md, turn one off or remove it. Use for /layer:skills, or when the user asks which skills there are or wants to add one.
argument-hint: "[add <link> | off <id> | on <id> | remove <id>]"
---

# Layerwright skills

Skills are guidance the agent reads before a job they fit: a design critique, a handoff spec with every state, layout, typography, colour, accessibility, motion. The library ships with Layerwright; the user's own live in `~/.layerwright/skills` and stay across updates. The same list is in the **Skills** tab of the Figma window, and `/skill <link>` in its chat box adds one.

- No argument: `layerwright_skills({ action: "list" })` and show a short table by category (name, what it's for, on or off, library or theirs), in the user's language.
- `add <link or text>`: `layerwright_skills({ action: "add", source })`. A GitHub folder, file or repository, a skills page that links to one (aiuxplayground.com/skills/…, skills.sh), or the pasted text of a SKILL.md. Say what was added and that sessions use it from their next step.
- `off <id>` / `on <id>`: `layerwright_skills({ action: "disable" | "enable", id })`.
- `remove <id>`: only the user's own; a library skill can only be turned off. Ask once before removing.
