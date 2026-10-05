// MCP prompts for clients without skills (Claude Desktop, VS Code, Windsurf, …). They are cut from SKILL.md at run
// time, so the skill stays the one source of the workflow: a prompt is the intro, the sections a job needs, and the rules.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { skillSource } from "./meta.ts";

/** The skill without its frontmatter, split at "## " headings: "" is the intro, then heading → section text. */
export function skillSections(md: string): Map<string, string> {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  const out = new Map<string, string>();
  const parts = body.split(/^(?=## )/m);
  out.set("", parts[0].trim());
  for (const p of parts.slice(1)) out.set(p.slice(3, p.indexOf("\n")).trim(), p.trim());
  return out;
}

/** Sections by a distinctive part of their heading ("Job A", "Design DSL"), so renumbering the skill doesn't break it. */
function pick(sections: Map<string, string>, wanted: string[]): string {
  const texts = wanted.map((w) => {
    const hit = [...sections.entries()].find(([h]) => h && h.toLowerCase().includes(w.toLowerCase()));
    if (!hit) throw new Error(`The skill has no "${w}" section.`);
    return hit[1];
  });
  return [sections.get("")!, ...texts].join("\n\n");
}

export interface PromptSpec { name: string; title: string; description: string; sections: string[]; arg?: { name: string; describe: string } }

export const PROMPTS: PromptSpec[] = [
  { name: "figma_design", title: "Figma Design Engineer (full guide)", description: "The whole Layerwright workflow: pick the job, set up, then HTML → Figma, build, change, or Figma → code.",
    sections: ["Know the job", "Setup", "Job A", "Job B", "Job C", "Job D", "official Figma MCP", "Design DSL", "Rules"], arg: { name: "task", describe: "What you want done, in your words" } },
  { name: "html_to_figma", title: "Bring HTML or a Claude Design export into Figma", description: "Import an .html file or folder as editable Auto Layout, then use the Design System.",
    sections: ["Know the job", "Setup", "Job A", "Rules"], arg: { name: "path", describe: "The .html file or export folder, and how faithful it should be" } },
  { name: "build_in_figma", title: "Design a screen or flow in Figma", description: "Build screens, flows and prototypes from a brief with the file's Design System, then critique and fix.",
    sections: ["Setup", "Job B", "Design DSL", "Rules"], arg: { name: "brief", describe: "What to design" } },
  { name: "change_figma", title: "Change an existing Figma design", description: "Edit, componentize, apply or audit the Design System, wire prototypes, annotate or migrate existing layers.",
    sections: ["Setup", "Job C", "Rules"], arg: { name: "request", describe: "What to change (a selection or node id helps)" } },
  { name: "figma_to_code", title: "Implement a Figma frame as code", description: "Read a frame with its components and tokens, implement it, and verify the code uses the mapped components.",
    sections: ["Setup", "Job D", "Rules"], arg: { name: "target", describe: "The frame (selection or node id) and the stack" } },
];

/** A prompt's text; throws if the skill no longer has a section it needs (the tests read the real skill). */
export function promptText(spec: PromptSpec, md: string, value?: string): string {
  const text = pick(skillSections(md), spec.sections);
  return value?.trim() ? `${text}\n\n---\n\n${spec.arg ? `${spec.arg.name[0].toUpperCase()}${spec.arg.name.slice(1)}` : "Task"}: ${value.trim()}` : text;
}

export function registerPrompts(server: McpServer, readSkill: () => string = () => readFileSync(skillSource(), "utf8")) {
  for (const spec of PROMPTS) {
    const argsSchema = spec.arg ? { [spec.arg.name]: z.string().optional().describe(spec.arg.describe) } : {};
    server.registerPrompt(spec.name, { title: spec.title, description: spec.description, argsSchema }, (args: Record<string, string | undefined>) => ({
      description: spec.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: promptText(spec, readSkill(), spec.arg ? args[spec.arg.name] : undefined) } }],
    }));
  }
}

/** Server instructions: short, and they point at the skill or the prompts instead of repeating them. */
export const INSTRUCTIONS = "Layerwright does two jobs: (1) bring HTML or a Claude Design export into Figma as editable layers, (2) design and change screens in Figma with the file's Design System. Call figma_status first, with title: 2–4 words naming your task in the language the user writes in (the plugin window shows it, so the user can tell sessions apart). If the figma-design skill (or the Cursor rule) is installed, follow it; otherwise start from the figma_design prompt (or html_to_figma, build_in_figma, change_figma, figma_to_code). Never write Figma JavaScript: send Design Plans and edit ops, preview before executing, and ask before changing existing layers. Several sessions may share one Figma file: the user's selection belongs to this session only when they give it to it in the plugin window, and a CONFLICT error means another session changed that layer: inspect it again before retrying. figma_export_image shows the picture only to you: when the user wants to see it, pass save: true and send them the file. figma_status lists skills (design, UX, UI, design-to-code guidance) with when each fits: before such a job, read the closest one with layerwright_skills.";
