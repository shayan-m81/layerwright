// HTML → Figma. Two paths:
//  - renderToPlan: HTML → editable Design DSL (Auto Layout, DS components) → the normal preview/execute pipeline
//  - importHtml:   HTML → pixel-faithful absolute layer tree (figma_import_html)
import { validatePlan, type DesignPlan, type DesignSystem } from "@cde/core";
import { withPage } from "./browser.ts";
import { readPage } from "./dom.ts";
import { toPlan, type ComponentMapping, type Hint, type SourceBoxes } from "./convert.ts";
import { applyDesignSystem } from "./design-system.ts";

export { importHtml, type ImportTarget, type ImportSwap, type ImportAction, type ImportedScreen } from "./tree.ts";
export { toPlan, type ComponentMapping, type Hint, type ConvertResult, type SourceBoxes } from "./convert.ts";
export { applyDesignSystem } from "./design-system.ts";
export { readDom, readPage, type DomNode } from "./dom.ts";
export { decodeToPng, sniff, svgText, MAX_ASSET_BYTES } from "./assets.ts";
export { chromiumInstallCommand, launch, resolveEntry, withPage } from "./browser.ts";
export { screenshotHtml, diffImages, type ImageDiff } from "./compare.ts";

export interface RenderOptions { viewports?: number[]; selector?: string; root?: string; ds?: DesignSystem; name?: string; mappings?: ComponentMapping[]; fontMap?: Record<string, string>;
  /** Several elements of the page, each its own screen (e.g. the cards of a review board). Overrides `selector`. */
  targets?: { selector: string; name?: string }[]; waitMs?: number }
export interface RenderResult { plan: DesignPlan; hints: Hint[]; warnings: string[]; mapped: Record<string, number>; sources: SourceBoxes;
  /** Web font families the page loads, with the formats it ships (e.g. ["woff2"]). */
  webFonts: Record<string, string[]> }

export const DEFAULT_VIEWPORTS = [1440, 390];

export async function renderToPlan(path: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const viewports = opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS;
  const screens: { name: string; width: number; dom: import("./dom.ts").DomNode }[] = [];
  let title = "";
  let webFonts: Record<string, string[]> = {};
  const pictures: string[] = []; // what couldn't be imported as it looks (once per page, not per viewport)
  const marks = (opts.mappings ?? []).map((m) => m.selector);
  const targets = opts.targets?.length ? opts.targets : [{ selector: opts.selector ?? "body", name: undefined as string | undefined }];
  for (const width of viewports) {
    const { reads, t } = await withPage(path, { root: opts.root, width, height: 900, waitMs: opts.waitMs }, async (page) => {
      const reads = [];
      for (const tg of targets) reads.push(await readPage(page, tg.selector, marks));
      return { reads, t: await page.title() };
    });
    title ||= t;
    reads.forEach((read, i) => {
      webFonts = { ...webFonts, ...read.webFonts };
      for (const w of read.warnings) if (!pictures.includes(w)) pictures.push(w);
      const base = targets[i].name ?? (opts.targets?.length ? targets[i].selector : title || "Page");
      // An element keeps its own rendered width; the page takes the viewport's.
      screens.push({ name: viewports.length > 1 || !targets[i].name ? `${base} – ${width}` : base, width: opts.targets?.length ? Math.round(read.root.box.w) : width, dom: read.root });
    });
  }
  const converted = toPlan(screens, { name: opts.name ?? (title || "HTML import"), mappings: opts.mappings, fontMap: opts.fontMap });
  let plan = converted.plan;
  let mapped: Record<string, number> = {};
  const warnings = [...pictures, ...converted.warnings];
  if (opts.ds) {
    const a = applyDesignSystem(plan, converted.hints, opts.ds);
    ({ plan, mapped } = a);
    // Say what was left as a frame and why, grouped, so a user can map it explicitly if it was right after all.
    const groups = new Map<string, string[]>();
    for (const s of a.skipped) { const k = `${s.component}: ${s.reason}`; groups.set(k, [...(groups.get(k) ?? []), s.label ?? s.path]); }
    for (const [k, labels] of groups) warnings.push(`Not mapped to "${k}" (${labels.length} × e.g. "${labels[0]}"); kept as styled frames.`);
  }
  const v = validatePlan(plan);
  if (!v.success) throw new Error(`Converted plan failed validation: ${v.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  return { plan: v.plan, hints: converted.hints, warnings, mapped, sources: converted.sources, webFonts };
}
