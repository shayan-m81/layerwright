// Resolver: maps semantic requirements (component names, roles, variants, tokens) to real
// Design System entities, and compiles a validated DesignPlan into an executable ResolvedPlan.
import { MAX_RADIUS, type ComponentDefinition, type ComponentSetDefinition, type DesignSystem, type Num, type Paint, type ResolvedFrame, type ResolvedImageFill, type ResolvedInstance, type ResolvedInteraction, type ResolvedNode, type ResolvedPlan, type ResolvedShadow, type Sizing, type StructuredError, type TypographyDefinition, type VariableDefinition } from "./types.ts";
import type { DesignPlan } from "./dsl.ts";
import { norm } from "./semantics.ts";

export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const ROLE_BASE: Record<string, string> = {
  "primary-action": "button", "secondary-action": "button", "destructive-action": "button", action: "button",
  input: "text-input", "password-input": "text-input", textfield: "text-input", "error-dialog": "dialog", modal: "dialog",
};
const ROLE_EMPHASIS: Record<string, string> = { "primary-action": "primary", "secondary-action": "secondary", "destructive-action": "destructive", "password-input": "password" };

type Match = { def: ComponentDefinition; set?: ComponentSetDefinition; unscanned?: boolean };
export interface ComponentRequest { component?: string | { id?: string; key?: string }; role?: string; variant?: string | Record<string, string> }
type Fail = { error: StructuredError };

export class Resolver {
  private setById: Map<string, ComponentSetDefinition>;
  /** name → component (set) id: earlier choices between same-named components (project memory). */
  preferred: Record<string, string> = {};
  constructor(public ds: DesignSystem) {
    this.setById = new Map(ds.componentSets.map((s) => [s.id, s]));
  }

  private variantsOf(set: ComponentSetDefinition) {
    return this.ds.components.filter((c) => c.componentSetId === set.id);
  }

  /** Resolve a variant inside a chosen set or standalone component. */
  private within(c: { kind: "set"; v: ComponentSetDefinition } | { kind: "comp"; v: ComponentDefinition }, variant: ComponentRequest["variant"], role: string | undefined, path: string, start?: ComponentDefinition): Match | Fail {
    if (c.kind === "comp") return { def: c.v }; // standalone component: a variant is ignored, not fatal
    const set = c.v;
    const variants = this.variantsOf(set);
    if (variants.length === 0) return { error: { type: "COMPONENT_NOT_FOUND", path, component: set.name, message: `Component set "${set.name}" has no variants available.` } };
    const def = start ?? variants.find((v) => v.id === set.defaultVariantId) ?? variants[0];
    if (start && !variant) return { def: start, set };
    const pick = this.pickVariant(set, variants, def, variant, role, path);
    if ("error" in pick) return pick;
    return { def: pick.def, set };
  }

  /** One line per candidate, so an ambiguity error says exactly which set is which. */
  describe(set: ComponentSetDefinition | ComponentDefinition) {
    const variants = "variantIds" in set ? this.variantsOf(set) : [];
    const props = "variantIds" in set ? set.properties : set.properties ?? [];
    return { id: set.id, key: set.key, name: set.name, page: set.page, remote: set.remote, variantCount: variants.length,
      properties: props.map((p) => (p.type === "VARIANT" ? `${p.name}: ${(p.options ?? []).join(" | ")}` : `${p.name} (${p.type.toLowerCase()})`)) };
  }

  /** Find a component (and variant) by exact id/key, name and/or semantic role. Equal name matches are never
   *  picked silently: the one that has the requested variant wins, otherwise AMBIGUOUS_COMPONENT. */
  findComponent(req: ComponentRequest, path = ""): Match | Fail {
    const standalone = this.ds.components.filter((c) => !c.componentSetId);
    type Cand = { kind: "set"; v: ComponentSetDefinition } | { kind: "comp"; v: ComponentDefinition };
    const role = req.role;

    if (req.component && typeof req.component === "object") {
      const { id, key } = req.component;
      const hit = (x: { id: string; key: string }) => (id ? x.id === id : x.key === key);
      const set = this.ds.componentSets.find(hit);
      if (set) return this.within({ kind: "set", v: set }, req.variant, role, path);
      const comp = this.ds.components.find(hit);
      if (comp) {
        const parent = comp.componentSetId ? this.setById.get(comp.componentSetId) : undefined;
        return parent ? this.within({ kind: "set", v: parent }, req.variant, role, path, comp) : { def: comp };
      }
      if (key) {
        // Not in the scan (a library component this file doesn't use yet): the plugin imports it by key, and
        // variants/props are matched by name on the instance.
        return { def: { id: "", key, name: `library:${key}`, remote: true }, unscanned: true };
      }
      return { error: { type: "COMPONENT_NOT_FOUND", path, component: id, message: `No component or component set with id "${id}" in the scan. Rescan (figma_scan_design_system refresh: true) if it was just created.` } };
    }

    const cands: Cand[] = [...this.ds.componentSets.map((v) => ({ kind: "set" as const, v })), ...standalone.map((v) => ({ kind: "comp" as const, v }))];
    const scored: { c: Cand; score: number }[] = [];
    const want = req.component ? norm(req.component) : undefined;
    const wantLast = req.component ? norm(req.component.split("/").pop()!) : undefined;
    const baseRole = role ? ROLE_BASE[role] ?? role : undefined;
    for (const c of cands) {
      const n = norm(c.v.name);
      const last = norm(c.v.name.split("/").pop()!);
      const hints = c.v.semanticHints ?? [];
      let score = 0;
      if (want) {
        if (n === want) score += 100;
        else if (last === wantLast) score += 80;
        else if (n.includes(want) || want.includes(last)) score += 30;
        else continue;
      }
      if (role) {
        if (hints.includes(role)) score += 20;
        else if (baseRole && hints.includes(baseRole)) score += 12;
        else if (hints.includes(`${baseRole}?`)) score += 4;
        else if (!want) continue;
      }
      if (!want && !role) continue;
      if (c.v.remote) score += 1;
      if (c.kind === "set") score += 2; // prefer sets (they carry variants)
      score -= n.split(" ").length * 0.1; // prefer shorter, canonical names
      scored.push({ c, score });
    }
    if (!scored.length) {
      return { error: { type: "COMPONENT_NOT_FOUND", path, component: (req.component as string | undefined) ?? req.role, message: `No component matches ${req.component ? `name "${req.component}"` : ""}${req.component && role ? " / " : ""}${role ? `role "${role}"` : ""}.`, suggestions: this.suggest((req.component as string | undefined) ?? role ?? "") } };
    }
    const top = Math.max(...scored.map((x) => x.score));
    const tied = scored.filter((x) => Math.abs(x.score - top) < 1e-9);
    if (!want || tied.length === 1 || top < 80) return this.within(tied[0].c, req.variant, role, path);
    // Several components with the same name: keep the ones that can satisfy the request.
    const results = tied.map((x) => ({ x, r: this.within(x.c, req.variant, role, path) }));
    const usageOf = (y: (typeof results)[number]) => (y.x.c.v as ComponentSetDefinition).usage ?? 0;
    // Copies of one published component share its key (a file can hold several nodes of the same library set):
    // one per key, the most used, since picking between copies isn't a real choice.
    const byKey = new Map<string, (typeof results)[number]>();
    for (const y of results.filter((z) => !("error" in z.r))) {
      const k = y.x.c.v.key || y.x.c.v.id;
      const cur = byKey.get(k);
      if (!cur || usageOf(y) > usageOf(cur)) byKey.set(k, y);
    }
    const fits = [...byKey.values()];
    if (fits.length === 1) return fits[0].r;
    // The user already chose one of these in this project.
    const chosen = req.component ? this.preferred[req.component] : undefined;
    const pref = chosen && fits.find((y) => y.x.c.v.id === chosen);
    if (pref) return pref.r;
    // Copies of one library set (published versions, several libraries): the one this file uses clearly most wins.
    if (fits.length > 1 && fits.every((y) => y.x.c.v.remote)) {
      const used = [...fits].sort((a, b) => usageOf(b) - usageOf(a));
      const [u0, u1] = used.map(usageOf);
      if (u0 > 0 && u0 >= 2 * u1) return used[0].r;
    }
    const candidates = tied.map((x) => this.describe(x.c.v));
    if (!fits.length) {
      const first = results[0].r as Fail;
      return { error: { ...first.error, message: `${first.error.message} (${tied.length} components are named "${req.component}"; none has this variant.)`, candidates } };
    }
    return { error: { type: "AMBIGUOUS_COMPONENT", path, component: req.component as string, message: `${fits.length} components are named "${req.component}" and all match. Pass component: { id } (or { key }) to choose one.`, candidates: fits.map((y) => this.describe(y.x.c.v)) } };
  }

  private pickVariant(set: ComponentSetDefinition, variants: ComponentDefinition[], def: ComponentDefinition, variant: string | Record<string, string> | undefined, role: string | undefined, path: string): { def: ComponentDefinition } | Fail {
    const defVals = def.variants ?? {};
    const closeness = (v: ComponentDefinition) => Object.entries(v.variants ?? {}).filter(([k, x]) => defVals[k] === x).length;
    const options = () => set.properties.filter((p) => p.type === "VARIANT").map((p) => `${p.name}: ${(p.options ?? []).join(" | ")}`);
    if (typeof variant === "string") {
      const parts = variant.split(/[,/]/).map((s) => norm(s)).filter(Boolean);
      const matches = variants.filter((v) => { const vals = Object.values(v.variants ?? {}).map(norm); return parts.every((p) => vals.includes(p) || vals.some((x) => x.includes(p))); });
      if (!matches.length) return { error: { type: "INVALID_VARIANT", path, component: set.name, message: `Variant "${variant}" not found on "${set.name}".`, suggestions: options() } };
      matches.sort((a, b) => closeness(b) - closeness(a));
      return { def: matches[0] };
    }
    if (variant && typeof variant === "object") {
      const entries = Object.entries(variant).map(([k, v]) => [norm(k), norm(v)] as const);
      const matches = variants.filter((c) => { const vv = Object.fromEntries(Object.entries(c.variants ?? {}).map(([k, v]) => [norm(k), norm(v)])); return entries.every(([k, v]) => vv[k] === v); });
      if (!matches.length) return { error: { type: "INVALID_VARIANT", path, component: set.name, message: `Variant ${JSON.stringify(variant)} not found on "${set.name}".`, suggestions: options() } };
      matches.sort((a, b) => closeness(b) - closeness(a));
      return { def: matches[0] };
    }
    if (role) {
      const byRole = variants.filter((v) => v.semanticHints?.includes(role));
      if (byRole.length) { byRole.sort((a, b) => closeness(b) - closeness(a)); return { def: byRole[0] }; }
      const emph = ROLE_EMPHASIS[role];
      if (emph) {
        const e = variants.filter((v) => Object.values(v.variants ?? {}).some((x) => norm(x).includes(emph)));
        if (e.length) { e.sort((a, b) => closeness(b) - closeness(a)); return { def: e[0] }; }
      }
    }
    return { def };
  }

  suggest(q: string): string[] {
    const t = norm(q).split(" ").filter((x) => x.length > 2);
    const names = [...this.ds.componentSets.map((s) => s.name), ...this.ds.components.filter((c) => !c.componentSetId).map((c) => c.name)];
    const scored = names.map((n) => ({ n, s: t.filter((x) => norm(n).includes(x)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    return (scored.length ? scored.map((x) => x.n) : names).slice(0, 5);
  }

  findVariable(ref: string, type: VariableDefinition["type"]): VariableDefinition | undefined {
    const r = norm(ref.replace(/^[${]+|}$/g, ""));
    const pool = this.ds.variables.filter((v) => v.type === type);
    return (
      pool.find((v) => norm(v.name) === r) ??
      pool.find((v) => norm(`${v.collection} ${v.name}`) === r) ??
      pool.filter((v) => norm(v.name).endsWith(` ${r}`) || norm(v.name).endsWith(r)).sort((a, b) => a.name.length - b.name.length)[0]
    );
  }

  resolveNum(v: number | string | undefined, path: string, errors: StructuredError[], category = "spacing"): Num | undefined {
    if (v === undefined) return undefined;
    if (typeof v === "number") return { value: v };
    const asNum = Number(v);
    if (!Number.isNaN(asNum)) return { value: asNum };
    const found = this.findVariable(v, "FLOAT");
    if (!found) {
      errors.push({ type: "TOKEN_NOT_FOUND", path, message: `No ${category} variable matches "${v}".`, suggestions: this.ds.variables.filter((x) => x.type === "FLOAT").map((x) => x.name).filter((n) => norm(n).includes(norm(category).split(" ")[0])).slice(0, 8) });
      return undefined;
    }
    return { variableId: found.id, variableKey: found.remote ? found.key : undefined, value: typeof found.value === "number" ? found.value : undefined };
  }

  resolvePaint(ref: string | undefined, path: string, errors: StructuredError[]): Paint | undefined {
    if (!ref) return undefined;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(ref)) return { hex: ref };
    const v = this.findVariable(ref, "COLOR");
    if (v) return { variableId: v.id, variableKey: v.remote ? v.key : undefined };
    const r = norm(ref);
    const style = this.ds.styles.find((s) => s.type === "PAINT" && (norm(s.name) === r || norm(s.name).endsWith(r)));
    if (style) return { styleId: style.id, styleKey: style.remote ? style.key : undefined };
    errors.push({ type: "TOKEN_NOT_FOUND", path, message: `No color variable or paint style matches "${ref}".`, suggestions: this.ds.variables.filter((x) => x.type === "COLOR").map((x) => x.name).filter((n) => r.split(" ").some((t) => t.length > 2 && norm(n).includes(t))).slice(0, 8) });
    return undefined;
  }

  findTextStyle(style: string | undefined, role: string | undefined): TypographyDefinition | undefined {
    const ty = this.ds.typography;
    if (style) {
      const r = norm(style);
      return ty.find((t) => norm(t.name) === r) ?? ty.filter((t) => norm(t.name).endsWith(r) || norm(t.name).includes(r)).sort((a, b) => a.name.length - b.name.length)[0];
    }
    if (!role) return undefined;
    const target: Record<string, number> = { display: 40, heading: 28, title: 22, subheading: 18, body: 16, label: 14, caption: 12, overline: 11, code: 14 };
    const r = role === "title" ? "heading" : role;
    const pool = ty.filter((t) => t.role === r);
    if (!pool.length) return undefined;
    const size = target[role] ?? 16;
    return [...pool].sort((a, b) => Math.abs(a.fontSize - size) - Math.abs(b.fontSize - size) || a.name.length - b.name.length)[0];
  }

  /** Map DSL props onto component property keys. Unknown props fall back to text-layer overrides. */
  mapProps(def: ComponentDefinition, set: ComponentSetDefinition | undefined, props: Record<string, string | number | boolean> | undefined, path: string, warnings: string[]) {
    const properties: Record<string, string | boolean> = {};
    const textOverrides: Record<string, string> = {};
    const defs = (set?.properties ?? def.properties ?? []).filter((p) => p.type !== "VARIANT");
    for (const [k, raw] of Object.entries(props ?? {})) {
      const nk = norm(k);
      let p = defs.find((d) => norm(d.name) === nk) ?? defs.find((d) => norm(d.name).startsWith(nk) || nk.startsWith(norm(d.name)));
      if (!p && ["label", "text", "content", "title", "value"].includes(nk)) {
        const texts = defs.filter((d) => d.type === "TEXT");
        if (texts.length === 1) p = texts[0];
      }
      if (p && p.type === "TEXT") { properties[p.key] = String(raw); continue; }
      if (p && p.type === "BOOLEAN") {
        const isFlag = typeof raw === "boolean" || raw === "true" || raw === "false";
        properties[p.key] = isFlag ? raw === true || raw === "true" : true;
        // A text value for a visibility toggle (e.g. Label: "Email") means "show it, with this text".
        if (!isFlag) {
          const layer = (def.textLayers ?? []).find((l) => norm(l) === nk);
          if (layer) textOverrides[layer] = String(raw);
          else warnings.push(`${path}: "${p.name}" is a show/hide toggle; turned it on but found no text layer named "${k}" for "${raw}".`);
        }
        continue;
      }
      if (p && p.type === "INSTANCE_SWAP") { warnings.push(`${path}: instance-swap property "${p.name}" is not supported yet; ignored.`); continue; }
      // Fallback: override a text layer by name.
      const layers = def.textLayers ?? [];
      const layer = layers.find((l) => norm(l) === nk) ?? (layers.length === 1 && typeof raw !== "boolean" ? layers[0] : undefined);
      if (layer && typeof raw !== "boolean") { textOverrides[layer] = String(raw); continue; }
      warnings.push(`${path}: "${def.componentSet ?? def.name}" has no property or text layer "${k}"; ignored. Available: ${defs.map((d) => d.name).join(", ") || "none"}.`);
    }
    return { properties, textOverrides };
  }
}

const MAP_BASE: Record<string, string> = { "primary-action": "button", "secondary-action": "button", "text-input": "text-input", "password-input": "text-input", link: "link" };

/** Why a candidate is not a confident match, or undefined when it is. A wrong component is worse than none:
 *  the element would lose its look and content, so anything doubtful stays a styled frame. */
export function mappingDoubt(found: { def: ComponentDefinition; set?: ComponentSetDefinition }, h: { role: string; label?: string; placeholder?: string; box?: { w: number; h: number } }): string | undefined {
  const owner = found.set ?? found.def;
  const hints = new Set([...(owner.semanticHints ?? []), ...(found.def.semanticHints ?? [])]);
  if (!hints.has(h.role) && !hints.has(MAP_BASE[h.role] ?? h.role)) return "matched only by shape, not by name or description";
  if (/^[_.]/.test(owner.name)) return "private component";
  const props = (found.set?.properties ?? found.def.properties ?? []);
  const hasTextSlot = props.some((p) => p.type === "TEXT") || (found.def.textLayers?.length ?? 0) > 0;
  if ((h.label || h.placeholder) && !hasTextSlot) return "no text property or text layer for the label";
  const dim = found.def.dimensions;
  // Inputs often include their label and hint in the component, so only actions are compared by height.
  if (!h.role.endsWith("input") && h.box && dim && dim.height > 0 && h.box.h > 0) {
    const ratio = dim.height / h.box.h;
    if (ratio < 0.6 || ratio > 1.6) return `height ${Math.round(dim.height)}px vs ${Math.round(h.box.h)}px in the HTML`;
  }
  return undefined;
}

// ---------------- Prototype interactions ----------------

const TRIGGER = { click: "ON_CLICK", hover: "ON_HOVER", press: "ON_PRESS", drag: "ON_DRAG", "mouse-enter": "MOUSE_ENTER", "mouse-leave": "MOUSE_LEAVE", "after-delay": "AFTER_TIMEOUT" } as const;
const ACTION = { navigate: "NAVIGATE", overlay: "OVERLAY", swap: "SWAP", "scroll-to": "SCROLL_TO", "change-to": "CHANGE_TO", back: "BACK", close: "CLOSE", url: "URL" } as const;
const EASING: Record<string, string> = { "ease-out": "EASE_OUT", "ease-in": "EASE_IN", "ease-in-out": "EASE_IN_AND_OUT", linear: "LINEAR", "ease-in-back": "EASE_IN_BACK", "ease-out-back": "EASE_OUT_BACK", gentle: "GENTLE", quick: "QUICK", bouncy: "BOUNCY", slow: "SLOW" };
/** Figma node ids ("12:34", instance sublayers "I12:34;5:6"). */
export const isFigmaId = (s: string) => /^I?\d+:\d+(;\d+:\d+)*$/.test(s);

/** DSL interaction → plugin-ready one. `lookup` maps a plan-local id or screen name to its plan path. */
export function resolveInteraction(i: any, path: string, lookup: (ref: string) => string | undefined, errors: StructuredError[], known: () => string[]): ResolvedInteraction | undefined {
  let to: ResolvedInteraction["to"];
  if (i.to) {
    const p = lookup(i.to);
    if (p) to = { path: p };
    else if (isFigmaId(i.to)) to = { nodeId: i.to };
    else { errors.push({ type: "INVALID_PLAN", path: `${path}.interactions`, message: `Interaction target "${i.to}" is not a node id or screen name in this plan, nor a Figma node id.`, suggestions: known().slice(0, 12) }); return undefined; }
  }
  const t = i.transition;
  const needsDir = t && ["move-in", "move-out", "push", "slide-in", "slide-out"].includes(t.type);
  return {
    trigger: TRIGGER[(i.trigger ?? "click") as keyof typeof TRIGGER], delay: i.delay !== undefined ? i.delay / 1000 : i.trigger === "after-delay" ? 0.8 : undefined,
    action: ACTION[i.action as keyof typeof ACTION], to, url: i.url,
    transition: t && t.type !== "instant" ? { type: t.type.toUpperCase().replace(/-/g, "_") as any, direction: needsDir ? (t.direction ?? "left").toUpperCase() : undefined, duration: (t.duration ?? 300) / 1000, easing: EASING[t.easing ?? "ease-out"] } : undefined,
    preserveScroll: i.preserveScroll,
  };
}

// ---------------- Plan compilation ----------------

const CONTAINERS = new Set(["screen", "frame", "section", "stack", "row", "card", "modal", "navigation", "list"]);
const PRESETS: Record<string, any> = {
  screen: { layout: { direction: "vertical", padding: 24, gap: 16 } },
  section: { layout: { direction: "vertical", gap: 12 } },
  stack: { layout: { direction: "vertical", gap: 8 } },
  row: { layout: { direction: "horizontal", gap: 8, crossAlign: "center" } },
  card: { layout: { direction: "vertical", padding: 16, gap: 12 }, radius: 12 },
  modal: { layout: { direction: "vertical", padding: 24, gap: 16 }, radius: 16 },
  navigation: { layout: { direction: "horizontal", padding: { x: 16, y: 12 }, gap: 8, align: "space-between", crossAlign: "center" } },
  list: { layout: { direction: "vertical", gap: 0 } },
  frame: {},
};
const ALIGN: Record<string, "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" | "BASELINE"> = { start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN", baseline: "BASELINE" };
const WEIGHT = { thin: "Thin", extralight: "Extra Light", light: "Light", regular: "Regular", medium: "Medium", semibold: "Semi Bold", bold: "Bold", extrabold: "Extra Bold", black: "Black" } as const;
const LH_UNIT = { px: "PIXELS", percent: "PERCENT" } as const;
const SCALE_MODE = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" } as const;
/** An image already in the file, as the plugin paints it. */
const imageFill = (img: { hash: string; fit?: keyof typeof SCALE_MODE } | undefined): ResolvedImageFill | undefined => img && { hash: img.hash, scaleMode: SCALE_MODE[img.fit ?? "fill"] };
/** A raw radius above MAX_RADIUS (Figma's "full" pill value, 33554400) is fully round all the same: clamp it. */
const clampRadius = (n: Num | undefined): Num | undefined => (n && !n.variableId && !n.variableKey && n.value !== undefined && n.value > MAX_RADIUS ? { value: MAX_RADIUS } : n);
const ROLE_FALLBACK: Record<string, { size: number; weight: "Regular" | "Medium" | "Semi Bold" | "Bold" }> = {
  display: { size: 40, weight: "Bold" }, heading: { size: 28, weight: "Bold" }, title: { size: 22, weight: "Semi Bold" }, subheading: { size: 18, weight: "Semi Bold" },
  body: { size: 16, weight: "Regular" }, label: { size: 14, weight: "Medium" }, caption: { size: 12, weight: "Regular" }, overline: { size: 11, weight: "Medium" }, code: { size: 14, weight: "Regular" },
};

export interface PlanSummary {
  screens: string[];
  instances: Record<string, number>;
  frames: number;
  texts: number;
  primitives: number;
  tokensUsed: string[];
  textStylesUsed: string[];
}

export interface CompileResult {
  ok: boolean;
  plan?: ResolvedPlan;
  errors: StructuredError[];
  warnings: string[];
  summary: PlanSummary;
}

function sizing(v: number | "hug" | "fill" | undefined): { size?: number; mode?: Sizing } {
  if (v === undefined) return {};
  if (typeof v === "number") return { size: v, mode: "fixed" };
  return { mode: v };
}

/** A Design System with nothing in it: plans compile to plain frames, text and primitives. */
export function emptyDesignSystem(fileName = ""): DesignSystem {
  return { fileName, scannedAt: new Date(0).toISOString(), components: [], componentSets: [], variableCollections: [], variables: [], styles: [], typography: [], semanticTokens: [] };
}

export function compilePlan(ds: DesignSystem, plan: DesignPlan, opts: { preferred?: Record<string, string> } = {}): CompileResult {
  const r = new Resolver(ds);
  if (opts.preferred) r.preferred = opts.preferred;
  const errors: StructuredError[] = [];
  const warnings: string[] = [];
  const summary: PlanSummary = { screens: [], instances: {}, frames: 0, texts: 0, primitives: 0, tokensUsed: [], textStylesUsed: [] };
  const tokenSet = new Set<string>();
  const styleSet = new Set<string>();
  const varName = (id?: string) => ds.variables.find((v) => v.id === id)?.name;
  const noteNum = (n?: Num) => { const nm = varName(n?.variableId); if (nm) tokenSet.add(nm); return n; };
  const notePaint = (p?: Paint) => { const nm = varName(p?.variableId) ?? ds.styles.find((s) => s.id === p?.styleId)?.name; if (nm) tokenSet.add(nm); return p; };

  const instanceFrom = (node: any, path: string, role?: string, defaultName?: string): ResolvedInstance | Fail => {
    const m = r.findComponent({ component: node.component, role: node.role ?? role, variant: node.variant }, path);
    if ("error" in m) return m;
    if (m.unscanned) {
      // A library component this file doesn't use yet: variants and props are matched by name when it's imported.
      const variant = typeof node.variant === "string" ? Object.fromEntries(node.variant.split(",").map((p: string) => p.split("=").map((x) => x.trim())).filter((kv: string[]) => kv.length === 2)) : node.variant ?? {};
      if (typeof node.variant === "string" && !node.variant.includes("=")) warnings.push(`${path}: variant "${node.variant}" needs "Prop=Value" form for an unscanned library component; ignored.`);
      const lateProps = { ...variant, ...Object.fromEntries(Object.entries(node.props ?? {}).map(([k, v]) => [k, typeof v === "number" ? String(v) : v])) } as Record<string, string | boolean>;
      summary.instances[m.def.name] = (summary.instances[m.def.name] ?? 0) + 1;
      const w = sizing(node.width), h = sizing(node.height);
      return { kind: "instance", path, name: node.name ?? defaultName ?? "Instance", componentId: "", componentKey: m.def.key, remote: true, componentName: m.def.name, properties: {}, textOverrides: {}, lateProps, width: w.size, height: h.size, sizingH: w.mode, sizingV: h.mode };
    }
    const { properties, textOverrides } = r.mapProps(m.def, m.set, node.props, path, warnings);
    const label = m.set ? `${m.set.name} / ${Object.values(m.def.variants ?? {}).join(", ")}` : m.def.name;
    summary.instances[label] = (summary.instances[label] ?? 0) + 1;
    const w = sizing(node.width), h = sizing(node.height);
    return { kind: "instance", path, name: node.name ?? defaultName ?? m.set?.name ?? m.def.name, componentId: m.def.id, componentKey: m.def.remote ? m.def.key : undefined, remote: m.def.remote, componentName: label, properties, textOverrides, width: w.size, height: h.size, sizingH: w.mode, sizingV: h.mode };
  };

  const pad = (p: any, path: string) => {
    if (p === undefined) return undefined;
    const n = (v: any, sub: string) => noteNum(r.resolveNum(v, `${path}.${sub}`, errors));
    if (typeof p === "number" || typeof p === "string") { const v = n(p, "padding"); return { top: v, right: v, bottom: v, left: v }; }
    if ("x" in p || "y" in p) { const x = n(p.x, "padding.x"), y = n(p.y, "padding.y"); return { top: y, bottom: y, left: x, right: x }; }
    return { top: n(p.top, "padding.top"), right: n(p.right, "padding.right"), bottom: n(p.bottom, "padding.bottom"), left: n(p.left, "padding.left") };
  };

  /** Colors for effects and gradients must be concrete: hex, or a color variable's value. */
  const hexOf = (ref: string, path: string): string | undefined => {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(ref)) return ref;
    const v = r.findVariable(ref, "COLOR");
    if (v && typeof v.value === "string" && v.value.startsWith("#")) { tokenSet.add(v.name); return v.value; }
    errors.push({ type: "TOKEN_NOT_FOUND", path, message: `Color "${ref}" must be a hex value or a color variable with a plain value.` });
    return undefined;
  };
  /** Fields shared by every node type. */
  const common = (node: any) => ({
    opacity: node.opacity,
    absolute: node.position ? { x: node.position.x, y: node.position.y } : undefined,
    minWidth: node.minWidth, maxWidth: node.maxWidth,
  });

  // Interaction targets: plan-local ids and screen names, by the paths build() will give them.
  const refs = new Map<string, string>();
  const collect = (n: any, path: string, top: boolean) => {
    if (n.id) { if (refs.has(n.id) && refs.get(n.id) !== path) errors.push({ type: "INVALID_PLAN", path, message: `Duplicate node id "${n.id}".` }); refs.set(n.id, path); }
    if (top && n.name && !refs.has(n.name)) refs.set(n.name, path);
    (n.children ?? []).forEach((c: any, i: number) => collect(c, `${path}.children[${i}]`, top && n.type === "section"));
  };
  plan.screens.forEach((s: any, i: number) => collect(s, `screens[${i}]`, true));
  (plan.inserts ?? []).forEach((ins: any, i: number) => ins.nodes.forEach((n: any, j: number) => collect(n, `inserts[${i}].nodes[${j}]`, true)));
  const known = () => [...refs.keys()];
  const interactions = (node: any, path: string) => node.interactions?.map((i: any) => resolveInteraction(i, path, (r) => refs.get(r), errors, known)).filter(Boolean) as ResolvedInteraction[] | undefined;

  const build = (node: any, path: string, parentDir: "HORIZONTAL" | "VERTICAL" | "NONE" | null, rtl = false): ResolvedNode | undefined => {
    const res = buildInner(node, path, parentDir, rtl);
    if (res && node.interactions?.length) res.interactions = interactions(node, path);
    if (res && node.annotations?.length) res.annotations = node.annotations;
    if (res) Object.assign(res, Object.fromEntries(Object.entries(common(node)).filter(([, v]) => v !== undefined)));
    // An absolutely positioned child doesn't stretch with the flow.
    if (res && node.position && res.sizingH === "fill" && node.width === undefined) res.sizingH = undefined;
    return res;
  };

  /** Effect style (by name: exact first, then contained), raw shadows and blurs: shared by frames and shapes. */
  const effectsOf = (node: any, path: string) => {
    let effectStyleId: string | undefined;
    if (node.effect) {
      const fx = ds.styles.filter((s) => s.type === "EFFECT");
      const e = fx.find((s) => norm(s.name) === norm(node.effect)) ?? fx.find((s) => norm(s.name).includes(norm(node.effect)));
      if (e) effectStyleId = e.id; else errors.push({ type: "STYLE_NOT_FOUND", path: `${path}.effect`, message: `No effect style matches "${node.effect}".`, suggestions: fx.map((s) => s.name).slice(0, 8) });
    }
    return {
      effectStyleId,
      shadows: node.shadows?.map((s: any, i: number) => ({ type: s.type === "inner" ? "INNER_SHADOW" : "DROP_SHADOW", x: s.x, y: s.y, blur: s.blur, spread: s.spread, hex: hexOf(s.color, `${path}.shadows[${i}].color`) ?? "#00000040" })) as ResolvedShadow[] | undefined,
      blur: node.blur as number | undefined, backgroundBlur: node.backgroundBlur as number | undefined,
    };
  };
  const gradientOf = (g: any, path: string) => g && { type: g.type, angle: g.angle, stops: g.stops.map((s: any, i: number) => ({ hex: hexOf(s.color, `${path}.gradient.stops[${i}].color`) ?? "#000000", position: s.position })) };

  const buildInner = (node: any, path: string, parentDir: "HORIZONTAL" | "VERTICAL" | "NONE" | null, rtlIn: boolean): ResolvedNode | undefined => {
    const t = node.type as string;
    const rtl = node.direction ? node.direction === "rtl" : rtlIn;
    const stretch = parentDir === "VERTICAL" ? "fill" : undefined;
    const w = sizing(node.width), h = sizing(node.height);
    const defaultH = (x: Sizing | undefined) => w.mode ?? x;

    if (CONTAINERS.has(t)) {
      // A container can ask to *be* a component (e.g. card/modal/navigation from the DS).
      if (node.component || (node.role && t !== "screen")) {
        const inst = instanceFrom(node, path, node.role, node.name);
        if (!("error" in inst)) {
          if (node.children?.length) warnings.push(`${path}: children ignored because "${t}" resolved to component ${inst.componentName}.`);
          inst.sizingH ??= stretch;
          return inst;
        }
        if (!node.allowFallback) { errors.push(inst.error); return undefined; }
        warnings.push(`${path}: ${inst.error.message} Falling back to a plain ${t} frame (allowFallback).`);
      }
      const preset = PRESETS[t] ?? {};
      const layoutIn = { ...(preset.layout ?? {}), ...(node.layout ?? {}) };
      const dir = layoutIn.direction === "horizontal" ? "HORIZONTAL" : layoutIn.direction === "none" ? "NONE" : "VERTICAL";
      // Figma has a row gap only for a horizontal layout that wraps (counterAxisSpacing).
      const rowGap = layoutIn.counterGap !== undefined && layoutIn.wrap === true && dir === "HORIZONTAL";
      if (layoutIn.counterGap !== undefined && !rowGap) warnings.push(`${path}: layout.counterGap only applies to a horizontal layout with wrap: true; ignored.`);
      // Side-by-side form fields have labels/hints of different heights; centring misaligns them.
      if (dir === "HORIZONTAL" && !node.layout?.crossAlign && (node.children ?? []).some((c: any) => c.type === "input")) layoutIn.crossAlign = "start";
      summary.frames++;
      let fill = notePaint(r.resolvePaint(node.fill, `${path}.fill`, errors));
      if (!fill && (t === "screen" || t === "card" || t === "modal")) fill = { hex: "#FFFFFF" };
      const frame: ResolvedFrame = {
        kind: "frame", path, role: t, name: node.name ?? t[0].toUpperCase() + t.slice(1),
        layout: dir === "NONE" ? { direction: "NONE" } : {
          direction: dir,
          gap: noteNum(r.resolveNum(layoutIn.gap, `${path}.layout.gap`, errors)),
          padding: pad(layoutIn.padding, `${path}.layout`),
          primaryAlign: layoutIn.align ? (ALIGN[layoutIn.align] as any) : undefined,
          counterAlign: layoutIn.crossAlign ? (ALIGN[layoutIn.crossAlign] as any) : undefined,
          wrap: layoutIn.wrap,
          counterGap: rowGap ? noteNum(r.resolveNum(layoutIn.counterGap, `${path}.layout.counterGap`, errors)) : undefined,
        },
        fill,
        image: imageFill(node.image),
        stroke: notePaint(r.resolvePaint(node.stroke, `${path}.stroke`, errors)),
        strokeWeight: node.strokeWeight,
        strokeSides: node.strokeSides,
        radius: clampRadius(noteNum(r.resolveNum(node.radius ?? preset.radius, `${path}.radius`, errors, "radius"))),
        strokeWeights: node.strokeWeights,
        ...effectsOf(node, path),
        gradient: gradientOf(node.gradient, path),
        clip: node.clip,
        scroll: node.scroll ? node.scroll.toUpperCase() : undefined, fixedChildren: node.fixedChildren,
        width: w.size ?? (t === "screen" ? 390 : undefined),
        height: h.size,
        sizingH: t === "screen" ? w.mode ?? "fixed" : defaultH(stretch ?? (parentDir === null ? "hug" : undefined)),
        sizingV: h.mode ?? "hug",
        children: [],
      };
      // A top-level section is a real Figma Section: no Auto Layout, so its children are placed like screens.
      const realSection = t === "section" && parentDir === null;
      if (realSection) { frame.sizingH = undefined; frame.sizingV = undefined; if (!node.layout?.padding) frame.layout = { ...frame.layout!, padding: { top: { value: 80 }, right: { value: 80 }, bottom: { value: 80 }, left: { value: 80 } } }; if (!node.layout?.gap) frame.layout = { ...frame.layout!, gap: { value: 80 } }; if (!node.layout?.direction) frame.layout = { ...frame.layout!, direction: "HORIZONTAL" }; }
      (node.children ?? []).forEach((c: any, i: number) => { const b = build(c, `${path}.children[${i}]`, realSection ? null : dir, rtl); if (b) frame.children.push(b); });
      // RTL: the first child sits on the right. Figma lays out left-to-right, so reverse the order.
      if (rtl && dir === "HORIZONTAL") frame.children.reverse();
      return frame;
    }

    if (t === "link" && !node.component && !node.role) {
      const m = r.findComponent({ role: "link" }, path);
      if (!("error" in m)) return build({ ...node, role: "link" }, path, parentDir);
    }
    if (t === "text" || (t === "link" && !node.component && !node.role)) {
      summary.texts++;
      const role = t === "link" ? "body" : node.role ?? "body";
      // Explicit font fields always win. A style is applied when named explicitly, or inferred from a role only
      // when the node sets no font fields of its own (an HTML import sets them all, and must keep them).
      const explicitType = node.fontSize !== undefined || node.fontFamily !== undefined || node.weight !== undefined;
      const inferFromRole = t === "text" && node.role && !explicitType && node.style !== null;
      const byId = node.style && typeof node.style === "object" ? ds.typography.find((x) => x.styleId === node.style.id) : undefined;
      const st = byId ?? (typeof node.style === "string" ? r.findTextStyle(node.style, undefined) : inferFromRole ? r.findTextStyle(undefined, role) : undefined);
      if (node.style && !st) errors.push({ type: "STYLE_NOT_FOUND", path: `${path}.style`, message: `No text style matches ${JSON.stringify(node.style)}.`, suggestions: ds.typography.map((x) => x.name).slice(0, 10) });
      // The scan couldn't read this style's font (a library style Figma returns no data for): it may not apply.
      if (st && !st.fontFamily && !styleSet.has(st.name)) warnings.push(`Text style "${st.name}": the scan couldn't read its font, so it's imported from the library when applied. If that fails, its texts keep their own font and size, and the warning says why.`);
      if (st) styleSet.add(st.name);
      else if (inferFromRole && ds.typography.length) warnings.push(`${path}: no text style for role "${role}"; using raw font size.`);
      const fb = ROLE_FALLBACK[role] ?? ROLE_FALLBACK.body;
      let color = node.color;
      if (!color && t === "link") color = r.findVariable("link", "COLOR")?.name ?? r.findVariable("primary", "COLOR")?.name;
      const align = node.align ? node.align.toUpperCase() : rtl ? "RIGHT" : undefined;
      return {
        fontFamily: node.fontFamily, italic: node.italic,
        lineHeight: node.lineHeight ? (node.lineHeight.unit === "auto" ? { unit: "AUTO" } : { unit: LH_UNIT[node.lineHeight.unit as "px"], value: node.lineHeight.value }) : undefined,
        letterSpacing: node.letterSpacing ? { unit: LH_UNIT[node.letterSpacing.unit as "px"], value: node.letterSpacing.value } : undefined,
        kind: "text", path, name: node.name ?? (t === "link" ? "Link" : node.content.slice(0, 40)), content: node.content,
        textStyleId: st?.styleId, textStyleKey: st ? ds.styles.find((s) => s.id === st.styleId && s.remote)?.key : undefined,
        textStyleFont: st?.fontFamily && st.fontStyle ? { family: st.fontFamily, style: st.fontStyle } : undefined,
        textStyleName: st?.name, textStyleSize: st?.fontSize || undefined,
        fontSize: node.fontSize ?? (st ? undefined : fb.size), fontWeight: node.weight ? WEIGHT[node.weight as keyof typeof WEIGHT] : st ? undefined : fb.weight,
        fill: notePaint(r.resolvePaint(color, `${path}.color`, errors)),
        align, hyperlink: node.href,
        runs: node.runs ? (() => {
          if (node.runs.map((x: any) => x.text).join("") !== node.content) { errors.push({ type: "INVALID_PLAN", path: `${path}.runs`, message: "The runs' texts joined must equal content." }); return undefined; }
          let at = 0;
          return node.runs.map((x: any, i: number) => {
            const start = at; at += x.text.length;
            return { start, end: at, fontFamily: x.fontFamily, fontWeight: x.weight ? WEIGHT[x.weight as keyof typeof WEIGHT] : undefined, italic: x.italic, fontSize: x.fontSize,
              fill: notePaint(r.resolvePaint(x.color, `${path}.runs[${i}].color`, errors)), hyperlink: x.href };
          }).filter((x: any) => x.fontFamily || x.fontWeight || x.italic !== undefined || x.fontSize || x.fill || x.hyperlink);
        })() : undefined,
        width: w.size, height: h.size, sizingH: defaultH(stretch), sizingV: h.mode,
      } as ResolvedNode;
    }

    if (t === "divider" && !node.component && !node.role) {
      const m = r.findComponent({ role: "divider" }, path);
      if (!("error" in m)) {
        summary.instances[m.def.name] = (summary.instances[m.def.name] ?? 0) + 1;
        return { kind: "instance", path, name: "Divider", componentId: m.def.id, componentKey: m.def.remote ? m.def.key : undefined, remote: m.def.remote, componentName: m.set?.name ?? m.def.name, properties: {}, textOverrides: {}, sizingH: "fill" };
      }
      summary.primitives++;
      const fill = notePaint(r.resolvePaint(node.color ?? r.findVariable("border", "COLOR")?.name ?? "#E5E7EB", `${path}.color`, errors));
      return { kind: "rect", role: "divider", path, name: node.name ?? "Divider", height: 1, sizingH: parentDir === "HORIZONTAL" ? "fixed" : "fill", width: typeof node.width === "number" ? node.width : parentDir === "HORIZONTAL" ? 1 : undefined, fill };
    }

    if (t === "icon" && node.svg) {
      summary.primitives++;
      if (!/^\s*<svg[\s>]/i.test(node.svg)) { errors.push({ type: "INVALID_PLAN", path: `${path}.svg`, message: "svg must be inline <svg> markup." }); return undefined; }
      return { kind: "svg", path, name: node.name ?? "Icon", svg: node.svg, fill: notePaint(r.resolvePaint(node.color, `${path}.color`, errors)), width: w.size ?? 24, height: h.size ?? 24, sizingH: w.mode ?? "fixed", sizingV: h.mode ?? "fixed" };
    }

    if (t === "shape") {
      summary.primitives++;
      const line = node.shape === "line";
      // A line is its stroke; other shapes are filled (a grey placeholder when nothing is given).
      const stroke = notePaint(r.resolvePaint(node.stroke ?? (line ? node.fill ?? r.findVariable("border", "COLOR")?.name ?? "#E5E7EB" : undefined), `${path}.stroke`, errors));
      const fill = line ? undefined : notePaint(r.resolvePaint(node.fill ?? (node.gradient || node.stroke || node.image ? undefined : "#E5E7EB"), `${path}.fill`, errors));
      if (line && node.image) warnings.push(`${path}: a line has no fill, so its image is left out.`);
      return { kind: "shape", shape: node.shape, path, name: node.name ?? node.shape[0].toUpperCase() + node.shape.slice(1),
        width: w.size ?? (line ? (w.mode || stretch ? undefined : 100) : 24), height: line ? undefined : h.size ?? 24,
        sizingH: w.mode ?? (line ? stretch : undefined) ?? "fixed", sizingV: line ? undefined : h.mode ?? "fixed",
        fill, stroke, strokeWeight: node.strokeWeight ?? (line ? 1 : undefined), gradient: gradientOf(node.gradient, path), image: line ? undefined : imageFill(node.image), ...effectsOf(node, path),
        pointCount: node.pointCount, innerRadius: node.innerRadius, arc: node.arc };
    }

    if (t === "image") {
      summary.primitives++;
      if (node.src && !/^(data:image\/|https:\/\/)/.test(node.src)) errors.push({ type: "INVALID_PLAN", path: `${path}.src`, message: "Image src must be a data:image/… URL or an https URL." });
      if (node.src && node.imageHash) errors.push({ type: "INVALID_PLAN", path: `${path}.imageHash`, message: "Give src (new image bytes) or imageHash (an image already in this file), not both." });
      return { kind: "rect", role: "image", src: node.src, imageHash: node.imageHash, fit: node.src || node.imageHash ? SCALE_MODE[node.fit as keyof typeof SCALE_MODE] ?? "FILL" : undefined, path, name: node.name ?? `Image${node.alt ? ` – ${node.alt}` : ""}`, width: w.size ?? 120, height: h.size ?? 120, sizingH: w.mode ?? stretch ?? "fixed", sizingV: h.mode ?? "fixed", fill: notePaint(r.resolvePaint(node.fill ?? "#E5E7EB", `${path}.fill`, errors)), radius: clampRadius(noteNum(r.resolveNum(node.radius, `${path}.radius`, errors, "radius"))) };
    }

    // component / component-instance / button / input / icon / link(component) / divider(component)
    const defaultRole = t === "button" ? "primary-action" : t === "input" ? "text-input" : t === "icon" ? "icon" : t === "link" ? "link" : t === "divider" ? "divider" : undefined;
    const node2 = t === "link" && node.content && !node.props ? { ...node, props: { label: node.content } } : node;
    const inst = instanceFrom(node2, path, node.component && !node.role ? (t === "button" && !node.variant ? "primary-action" : undefined) : defaultRole);
    if ("error" in inst) {
      if (node.allowFallback) {
        warnings.push(`${path}: ${inst.error.message} Drawing a labelled placeholder frame (allowFallback).`);
        summary.primitives++;
        const label = String(node.props?.label ?? node.props?.text ?? node.name ?? t);
        return { kind: "frame", role: "fallback", path, name: `⚠ ${node.name ?? t} (no DS component)`, layout: { direction: "HORIZONTAL", padding: { top: { value: 12 }, bottom: { value: 12 }, left: { value: 16 }, right: { value: 16 } }, primaryAlign: "CENTER", counterAlign: "CENTER" }, stroke: { hex: "#F59E0B" }, strokeWeight: 1, radius: { value: 8 }, sizingH: defaultH(stretch), sizingV: "hug", children: [{ kind: "text", path: `${path}.label`, name: "Label", content: label, fontSize: 14, fontWeight: "Medium" }] };
      }
      errors.push(inst.error);
      return undefined;
    }
    // Children of vertical containers stretch (the DSL contract). Keep small inline pieces (icons,
    // badges, avatars, toggles) at their natural size; pass width: "hug" to opt out.
    if (!inst.sizingH && stretch && !["icon"].includes(t) && !/badge|avatar|icon|toggle|switch|checkbox|radio/i.test(inst.componentName)) inst.sizingH = "fill";
    return inst;
  };

  const roots: ResolvedNode[] = [];
  plan.screens.forEach((s: any, i: number) => {
    const b = build(s, `screens[${i}]`, null);
    if (b) { roots.push(b); summary.screens.push(b.name); }
  });
  const inserts = (plan.inserts ?? []).map((ins: any, i: number) => ({ parentId: ins.parentId, index: ins.index,
    roots: ins.nodes.map((n: any, j: number) => build(n, `inserts[${i}].nodes[${j}]`, null)).filter(Boolean) as ResolvedNode[] }));
  summary.tokensUsed = [...tokenSet];
  summary.textStylesUsed = [...styleSet];
  const body = JSON.stringify({ plan, roots, inserts, scanned: ds.scannedAt });
  const flows = (plan.prototype?.flows ?? []).map((f: any, i: number) => {
    const p = refs.get(f.start);
    if (!p && !isFigmaId(f.start)) { errors.push({ type: "INVALID_PLAN", path: `prototype.flows[${i}].start`, message: `Flow start "${f.start}" is not a screen name or node id in this plan, nor a Figma node id.`, suggestions: known().slice(0, 12) }); return undefined; }
    return { name: f.name, description: f.description, to: p ? { path: p } : { nodeId: f.start } };
  }).filter(Boolean) as NonNullable<ResolvedPlan["flows"]>;
  const resolved: ResolvedPlan = { planId: `plan_${hash(body)}`, name: plan.name, target: { ...(plan.target ?? {}) }, screenGap: plan.screenGap, roots, inserts: inserts.length ? inserts : undefined, flows: flows.length ? flows : undefined };
  return { ok: errors.length === 0, plan: errors.length === 0 ? resolved : undefined, errors, warnings, summary };
}
