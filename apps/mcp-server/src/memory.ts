// What Layerwright learns in a project, so the next run starts from what worked: font substitutions, component
// mappings, which of several same-named components the user meant, the user's own notes, and the problems that keep
// coming back. Stored in .layerwright/memory.json (plain JSON, safe to commit and share with the team). Nothing here
// leaves the machine; `layerwright report` turns it into an issue draft the user reviews and sends themselves.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Problem { at: string; tool: string; type: string; message: string }
export interface ProjectMemory {
  version: 1;
  /** Font family substitutions used for imports (e.g. a web font → an installed family). */
  fontMap: Record<string, string>;
  /** Element → component mappings used for HTML imports. */
  mappings: { selector: string; component: string | { id?: string; key?: string }; variant?: string | Record<string, string>; props?: Record<string, string | boolean> }[];
  /** Component name → the id chosen when several share the name. */
  components: Record<string, { id: string; at: string }>;
  /** The user's own notes and corrections, in their words. */
  notes: { at: string; text: string }[];
  /** Recent problems (newest last), capped. */
  problems: Problem[];
  /** The folder of the last imported export (where its fonts may be). */
  lastExport?: string;
  /** Figma file name → its file key, learned from a link the user pasted, for files whose plugin can't read its own
   *  key (links to layers need it). */
  fileKeys?: Record<string, string>;
}

const MAX_PROBLEMS = 200;
const empty = (): ProjectMemory => ({ version: 1, fontMap: {}, mappings: [], components: {}, notes: [], problems: [] });

export class MemoryStore {
  constructor(private file: string) {}

  read(): ProjectMemory {
    try { return { ...empty(), ...JSON.parse(readFileSync(this.file, "utf8")) }; } catch { return empty(); }
  }

  private write(m: ProjectMemory) {
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(m, null, 2) + "\n"); } catch { /* read-only project */ }
  }

  update(fn: (m: ProjectMemory) => void): ProjectMemory {
    const m = this.read();
    fn(m);
    this.write(m);
    return m;
  }

  rememberFonts(map?: Record<string, string>) {
    if (map && Object.keys(map).length) this.update((m) => { Object.assign(m.fontMap, map); });
  }

  rememberMappings(list?: ProjectMemory["mappings"]) {
    if (!list?.length) return;
    this.update((m) => { for (const x of list) { m.mappings = m.mappings.filter((y) => y.selector !== x.selector); m.mappings.push(x); } });
  }

  rememberComponent(name: string, id: string) {
    this.update((m) => { m.components[name] = { id, at: new Date().toISOString() }; });
  }

  note(text: string) { this.update((m) => { m.notes.push({ at: new Date().toISOString(), text: text.slice(0, 500) }); }); }

  forget(what: { note?: number; component?: string; font?: string; selector?: string; all?: boolean }) {
    return this.update((m) => {
      if (what.all) Object.assign(m, empty());
      if (what.note !== undefined) m.notes.splice(what.note, 1);
      if (what.component) delete m.components[what.component];
      if (what.font) delete m.fontMap[what.font];
      if (what.selector) m.mappings = m.mappings.filter((x) => x.selector !== what.selector);
    });
  }

  problem(tool: string, type: string, message: string) {
    this.update((m) => {
      m.problems.push({ at: new Date().toISOString(), tool, type, message: message.slice(0, 300) });
      if (m.problems.length > MAX_PROBLEMS) m.problems.splice(0, m.problems.length - MAX_PROBLEMS);
    });
  }

  /** The short version for figma_status: what will be reused, and what keeps going wrong (with a hint). */
  summary() {
    const m = this.read();
    const byType = new Map<string, { n: number; last: Problem }>();
    const recent = m.problems.slice(-50);
    for (const p of recent) { const k = `${p.tool}:${p.type}`; byType.set(k, { n: (byType.get(k)?.n ?? 0) + 1, last: p }); }
    const recurring = [...byType.values()].filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 5)
      .map((x) => ({ times: x.n, tool: x.last.tool, type: x.last.type, last: x.last.message, hint: hintFor(x.last) }));
    const has = Object.keys(m.fontMap).length || m.mappings.length || Object.keys(m.components).length || m.notes.length || recurring.length;
    return has ? { fontMap: Object.keys(m.fontMap).length ? m.fontMap : undefined, mappings: m.mappings.length || undefined,
      components: Object.keys(m.components).length ? Object.fromEntries(Object.entries(m.components).map(([k, v]) => [k, v.id])) : undefined,
      notes: m.notes.length ? m.notes.map((n) => n.text) : undefined, recurring: recurring.length ? recurring : undefined } : undefined;
  }
}

/** A next step for a problem that keeps happening. */
export function hintFor(p: Problem): string | undefined {
  const m = p.message;
  if (/text style .*can't be applied/i.test(m)) return "Read the reason in the message. Rescan the Design System (refresh: true) after a library update; if the library import failed, check Assets → Libraries and that the style is published.";
  if (/library isn't available|isn't enabled|library didn't answer/i.test(m)) return "The Design System library isn't enabled for this file: Assets panel → Libraries → enable it, then run it again.";
  if (/font .*(not available|could not be loaded)|Cannot unwrap symbol/i.test(m)) return "A font is missing on this computer: `npx layerwright fonts <export folder> --install`, restart Figma, or pass fontMap.";
  if (p.type === "AMBIGUOUS_COMPONENT") return "Pick one candidate by { id }; the choice is remembered for this project.";
  if (p.type === "COMPONENT_NOT_FOUND") return "Rescan the Design System (refresh: true); for a library component not used in the file yet, pass its { key }.";
  if (p.type === "TIMEOUT") return "Figma was busy or a library didn't answer; inspect before retrying, and check the library is enabled for this file.";
  if (/size far from the source/.test(m)) return "Compare with figma_export_image({ compareWith: { html } }) and look at the regions it lists.";
  if (p.type === "DESIGN_SYSTEM_NOT_SCANNED") return "Call figma_scan_design_system once per file.";
  return undefined;
}

/** Remove what could identify a design: quoted text, layer names, node ids, paths and URLs. */
export function redact(s: string): string {
  // A single quote is a quote only outside a word: "can't" and "isn't" are apostrophes, and keep the message readable.
  return s.replace(/"[^"]*"|«[^»]*»|“[^”]*”|(?<![\p{L}\p{N}])'[^']*'(?![\p{L}\p{N}])/gu, '"…"').replace(/\b\d+:\d+(;\d+:\d+)*\b/g, "<id>")
    .replace(/(?:\/[\w.-]+){2,}/g, "<path>").replace(/https?:\/\/\S+/g, "<url>").replace(/[؀-ۿ]+(?:\s+[؀-ۿ]+)*/g, "…");
}

/** An issue draft for the Layerwright maintainers, built from this project's problems. Nothing is sent. */
export function reportDraft(m: ProjectMemory, env: { version: string; node: string; os: string }, repo = "shayan-m81/layerwright") {
  const groups = new Map<string, { n: number; tool: string; type: string; examples: Set<string> }>();
  for (const p of m.problems.slice(-100)) {
    const k = `${p.tool}|${p.type}`;
    const g = groups.get(k) ?? { n: 0, tool: p.tool, type: p.type, examples: new Set<string>() };
    g.n++; if (g.examples.size < 3) g.examples.add(redact(p.message));
    groups.set(k, g);
  }
  const top = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  const title = top.length ? `Recurring ${top[0].type} in ${top[0].tool}` : "Feedback";
  const body = [
    `**Layerwright** ${env.version} · Node ${env.node} · ${env.os}`,
    "",
    top.length ? "### Recurring problems (from .layerwright/memory.json, redacted)" : "No recorded problems.",
    ...top.flatMap((g) => [`- **${g.type}** in \`${g.tool}\` × ${g.n}`, ...[...g.examples].map((e) => `  - ${e}`)]),
    "",
    "### What I was doing",
    "<!-- A sentence or two: e.g. importing a Claude Design export into a file with a library Design System. -->",
    "",
    "_Drafted by `layerwright report`. Design content (texts, names, ids, paths) was removed; please check before sending._",
  ].join("\n");
  const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 5500))}&labels=feedback`;
  return { title, body, url };
}
