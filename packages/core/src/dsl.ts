// The Design DSL: what Claude writes. Validated with Zod before anything reaches Figma.
import { z } from "zod";
import { MAX_RADIUS } from "./types.ts";

/** A number (raw px) or a token reference such as "spacing/md" or "$spacing.md". */
export const NumberOrToken = z.union([z.number().min(0).max(10000), z.string().min(1)]);
/** A corner radius: like NumberOrToken, but a larger number (Figma reports a pill as 33554400) is clamped to
 *  MAX_RADIUS, fully round all the same, instead of rejected. */
export const Radius = z.preprocess((v) => (typeof v === "number" && v > MAX_RADIUS ? MAX_RADIUS : v), NumberOrToken);
/** A color: token reference ("color/bg/surface") or hex ("#1A73E8"). */
export const ColorRef = z.string().min(1);

export const PaddingSchema = z.union([
  NumberOrToken,
  z.object({ x: NumberOrToken.optional(), y: NumberOrToken.optional() }).strict(),
  z.object({ top: NumberOrToken.optional(), right: NumberOrToken.optional(), bottom: NumberOrToken.optional(), left: NumberOrToken.optional() }).strict(),
]);

export const Layout = z
  .object({
    direction: z.enum(["vertical", "horizontal", "none"]).default("vertical"),
    gap: NumberOrToken.optional(),
    padding: PaddingSchema.optional(),
    align: z.enum(["start", "center", "end", "space-between"]).optional(), // primary axis
    crossAlign: z.enum(["start", "center", "end", "baseline"]).optional(), // counter axis
    wrap: z.boolean().optional(),
    /** Gap between wrapped rows (Figma's counterAxisSpacing). Only with wrap: true on a horizontal layout. */
    counterGap: NumberOrToken.optional(),
  })
  .strict();

export const SizeValue = z.union([z.number().positive().max(20000), z.enum(["hug", "fill"])]);

/** Line height / letter spacing: { unit: "px" | "percent", value } (line height also takes "auto"). */
export const LineHeight = z.union([z.object({ unit: z.enum(["px", "percent"]), value: z.number().min(0).max(1000) }).strict(), z.object({ unit: z.literal("auto") }).strict()]);
export const LetterSpacing = z.object({ unit: z.enum(["px", "percent"]), value: z.number().min(-100).max(100) }).strict();
const WEIGHT_NAMES = ["thin", "extralight", "light", "regular", "medium", "semibold", "bold", "extrabold", "black"] as const;
/** A weight name, or a CSS weight (600, "600") taken as the nearest name; "Semi Bold" and "normal" are read too. */
export const Weight = z.preprocess((v) => {
  if (typeof v === "number" || (typeof v === "string" && /^\s*\d{3}\s*$/.test(v))) return WEIGHT_NAMES[Math.min(8, Math.max(0, Math.round(Number(v) / 100) - 1))];
  if (typeof v !== "string") return v;
  const k = v.toLowerCase().replace(/[\s_-]+/g, "");
  return k === "normal" ? "regular" : k;
}, z.enum(WEIGHT_NAMES));
/** A text style: its name, or an exact { id } (as figma_inspect and figma_edit give it). */
export const TextStyleRef = z.union([z.string().min(1), z.object({ id: z.string().min(1) }).strict()]);
export const Shadow = z.object({
  type: z.enum(["drop", "inner"]).default("drop"),
  x: z.number().default(0), y: z.number().default(0), blur: z.number().min(0).default(0), spread: z.number().default(0),
  color: z.string().min(1).default("#00000040"),
}).strict();
export const Gradient = z.object({
  /** linear (with angle), radial and diamond (from the centre), angular (conic, starting at angle). */
  type: z.enum(["linear", "radial", "angular", "diamond"]).default("linear"),
  /** CSS angle: 0 = to top, 90 = to right, 180 = to bottom (default). */
  angle: z.number().default(180),
  stops: z.array(z.object({ color: z.string().min(1), position: z.number().min(0).max(1) }).strict()).min(2).max(16),
}).strict();
/** An image already in this Figma file, by its hash (as figma_inspect exports it): the bytes stay in Figma, nothing is
 *  uploaded again. A hash that isn't in the file leaves the node without the image, with a warning. */
export const ImageHash = z.string().min(1).max(100);
export const ImageFit = z.enum(["fill", "fit", "crop", "tile"]);
export const ImageFill = z.object({ hash: ImageHash, fit: ImageFit.default("fill") }).strict();
/** Take a child out of the Auto Layout flow and place it at x/y inside its parent. */
export const Position = z.object({ type: z.literal("absolute"), x: z.number(), y: z.number() }).strict();

/** A prototype interaction. `to` is a node `id` from this plan, a screen name from this plan, or an existing Figma
 *  node id ("12:34"). Durations are milliseconds. */
export const Interaction = z.object({
  trigger: z.enum(["click", "hover", "press", "drag", "mouse-enter", "mouse-leave", "after-delay"]).default("click"),
  delay: z.number().min(0).max(60000).optional().describe("ms, for after-delay / mouse-enter / mouse-leave"),
  action: z.enum(["navigate", "overlay", "swap", "scroll-to", "change-to", "back", "close", "url"]),
  to: z.string().min(1).optional(),
  url: z.string().url().optional(),
  transition: z.object({
    type: z.enum(["instant", "dissolve", "smart-animate", "move-in", "move-out", "push", "slide-in", "slide-out"]).default("instant"),
    direction: z.enum(["left", "right", "top", "bottom"]).optional(),
    duration: z.number().min(0).max(10000).default(300),
    easing: z.enum(["ease-out", "ease-in", "ease-in-out", "linear", "ease-in-back", "ease-out-back", "gentle", "quick", "bouncy", "slow"]).default("ease-out"),
  }).strict().optional(),
  preserveScroll: z.boolean().optional(),
}).strict().superRefine((i, ctx) => {
  if (["navigate", "overlay", "swap", "scroll-to", "change-to"].includes(i.action) && !i.to) ctx.addIssue({ code: "custom", message: `"${i.action}" needs "to"` });
  if (i.action === "url" && !i.url) ctx.addIssue({ code: "custom", message: '"url" needs "url"' });
});

/** Properties Figma can measure on an annotation. */
export const ANNOTATION_PROPERTIES = ["width", "height", "maxWidth", "minWidth", "maxHeight", "minHeight", "fills", "strokes", "effects", "strokeWeight", "cornerRadius",
  "textStyleId", "textAlignHorizontal", "fontFamily", "fontStyle", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "itemSpacing", "padding", "layoutMode", "alignItems", "opacity", "mainComponent"] as const;
/** A dev handoff note shown in Figma's annotation layer. */
export const AnnotationDsl = z.object({
  label: z.string().min(1).max(2000).describe("Markdown text"),
  properties: z.array(z.enum(ANNOTATION_PROPERTIES)).max(12).optional().describe("Values Figma shows live, e.g. padding, fills"),
  category: z.string().min(1).max(40).optional().describe("Category label (created if missing), e.g. Development, Interaction"),
}).strict();

const Base = {
  annotations: z.array(AnnotationDsl).max(10).optional(),
  /** A plan-local id, so interactions and flows can point at this node. */
  id: z.string().min(1).max(100).optional(),
  interactions: z.array(Interaction).max(20).optional(),
  name: z.string().min(1).max(200).optional(),
  width: SizeValue.optional(),
  height: SizeValue.optional(),
  /** Free-form hint for responsive intent, carried into the node name/description for code handoff. */
  responsive: z.string().max(200).optional(),
  opacity: z.number().min(0).max(1).optional(),
  position: Position.optional(),
  minWidth: z.number().min(0).max(20000).optional(),
  maxWidth: z.number().min(0).max(20000).optional(),
};

/** A piece of a text with its own style (bold word, coloured link). Unset fields inherit from the text. */
export const TextRun = z.object({
  text: z.string().min(1).max(5000), weight: Weight.optional(), italic: z.boolean().optional(), fontFamily: z.string().min(1).max(100).optional(),
  fontSize: z.number().min(1).max(400).optional(), color: ColorRef.optional(), href: z.string().optional(),
}).strict();

export const TextRole = z.enum(["display", "heading", "subheading", "title", "body", "label", "caption", "overline", "code"]);

const ContainerStyle = {
  layout: Layout.optional(),
  fill: ColorRef.optional(),
  stroke: ColorRef.optional(),
  strokeWeight: z.number().min(0).max(100).optional(),
  /** Draw the stroke only on these sides (e.g. ["top"] for a footer divider). Default: all sides. */
  strokeSides: z.array(z.enum(["top", "right", "bottom", "left"])).min(1).optional(),
  radius: Radius.optional(),
  /** An image from this file painted over the fill (below the gradient). */
  image: ImageFill.optional(),
  effect: z.string().optional(), // effect style name
  /** Raw shadows, used when no effect style fits. */
  shadows: z.array(Shadow).max(8).optional(),
  /** Per-side stroke widths; overrides strokeWeight/strokeSides. */
  strokeWeights: z.object({ top: z.number().min(0), right: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0) }).partial().strict().optional(),
  gradient: Gradient.optional(),
  /** Layer blur and background blur (frosted glass), in px. */
  blur: z.number().min(0).max(250).optional(),
  backgroundBlur: z.number().min(0).max(250).optional(),
  clip: z.boolean().optional(),
  /** "rtl" reverses the visual order of horizontal children and right-aligns text inside (Persian/Arabic/Hebrew). */
  direction: z.enum(["ltr", "rtl"]).optional(),
  /** Prototype: how the frame scrolls when its content is bigger than it, and how many first children stay fixed. */
  scroll: z.enum(["none", "vertical", "horizontal", "both"]).optional(),
  fixedChildren: z.number().int().min(0).max(200).optional(),
};

const ComponentRef = {
  /** Component or component set: a name ("Button", "Forms/Input"), or an exact { id } / { key } when names are
   *  ambiguous. A { key } may also be a library component that isn't used in this file yet. */
  component: z.union([z.string().min(1), z.object({ id: z.string().min(1).optional(), key: z.string().min(1).optional() }).strict()
    .refine((c) => !!c.id !== !!c.key, "give exactly one of id or key")]).optional(),
  /** Semantic role used to find a component, e.g. "primary-action", "text-input". */
  role: z.string().min(1).optional(),
  /** Variant name ("Primary") or explicit variant properties ({ Type: "Primary", Size: "Large" }). */
  variant: z.union([z.string(), z.record(z.string())]).optional(),
  /** Component properties / text content, e.g. { label: "Email", disabled: false }. */
  props: z.record(z.union([z.string(), z.boolean(), z.number()])).optional(),
  /** Allow drawing a primitive if no component resolves. Default false. */
  allowFallback: z.boolean().optional(),
};

export type DesignNode =
  | { type: "screen" | "frame" | "section" | "stack" | "row" | "card" | "modal" | "navigation" | "list"; children?: DesignNode[]; [k: string]: unknown }
  | { type: "text" | "link"; content: string; [k: string]: unknown }
  | { type: "component" | "component-instance" | "button" | "input" | "icon"; [k: string]: unknown }
  | { type: "divider" | "image"; [k: string]: unknown }
  | { type: "shape"; shape: "ellipse" | "line" | "polygon" | "star"; [k: string]: unknown };

export const DesignNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion("type", ([
    ...(["screen", "frame", "section", "stack", "row", "card", "modal", "navigation", "list"] as const).map((t) =>
      z.object({ type: z.literal(t), ...Base, ...ContainerStyle, ...ComponentRef, children: z.array(DesignNodeSchema).max(200).default([]) }).strict(),
    ) as any,
    /** Typography: an explicit `style` is applied first and explicit font fields override it. A `role` picks a DS text
     *  style only when no font fields are given. `style: null` never applies a style. */
    z.object({ type: z.literal("text"), ...Base, content: z.string().max(5000), role: TextRole.optional(), style: TextStyleRef.nullable().optional(), color: ColorRef.optional(), fontSize: z.number().min(1).max(400).optional(),
      fontFamily: z.string().min(1).max(100).optional(), weight: Weight.optional(), italic: z.boolean().optional(),
      lineHeight: LineHeight.optional(), letterSpacing: LetterSpacing.optional(),
      align: z.enum(["left", "center", "right", "justified"]).optional(), direction: z.enum(["ltr", "rtl"]).optional(),
      /** Styled pieces of one text; their texts joined must equal `content`. */
      runs: z.array(TextRun).max(200).optional() }).strict(),
    z.object({ type: z.literal("link"), ...Base, content: z.string().max(500), href: z.string().optional(), style: TextStyleRef.optional(), color: ColorRef.optional(), ...ComponentRef }).strict(),
    ...(["component", "component-instance", "button", "input"] as const).map((t) =>
      z.object({ type: z.literal(t), ...Base, ...ComponentRef }).strict(),
    ) as any,
    /** An icon: a DS component (component/role), or inline SVG markup (svg). */
    z.object({ type: z.literal("icon"), ...Base, ...ComponentRef, svg: z.string().min(1).max(200_000).optional(), color: ColorRef.optional() }).strict(),
    z.object({ type: z.literal("divider"), ...Base, color: ColorRef.optional(), ...ComponentRef }).strict(),
    /** A basic shape: an ellipse (an arc makes rings, progress and pie slices), a horizontal line, a polygon or a star. */
    z.object({ type: z.literal("shape"), ...Base, shape: z.enum(["ellipse", "line", "polygon", "star"]),
      fill: ColorRef.optional(), stroke: ColorRef.optional(), strokeWeight: z.number().min(0).max(100).optional(), gradient: Gradient.optional(), image: ImageFill.optional(),
      effect: z.string().optional(), shadows: z.array(Shadow).max(8).optional(), blur: z.number().min(0).max(250).optional(), backgroundBlur: z.number().min(0).max(250).optional(),
      /** Polygon sides / star points (default 3 / 5). */
      pointCount: z.number().int().min(3).max(60).optional(),
      /** Star: inner radius as a share of the outer one (default 0.38). */
      innerRadius: z.number().min(0).max(1).optional(),
      /** Ellipse: draw from `start` to `end` degrees (0 = right, clockwise); innerRadius 0–1 cuts a hole (a ring). */
      arc: z.object({ start: z.number().min(-360).max(360), end: z.number().min(-360).max(360), innerRadius: z.number().min(0).max(1).default(0) }).strict().optional() }).strict(),
    z.object({ type: z.literal("image"), ...Base, alt: z.string().optional(), fill: ColorRef.optional(), radius: Radius.optional(),
      /** data: URL or https URL (fetched by the MCP server, never by the plugin). */
      src: z.string().min(1).max(15_000_000).optional(),
      /** Or an image already in this file, by its hash. */
      imageHash: ImageHash.optional(), fit: ImageFit.default("fill") }).strict(),
  ]) as any),
);

export const DesignPlanSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /** Where to put it. Default: new top-level frames on the current page, placed right of existing content. */
    target: z.object({ parentId: z.string().optional(), page: z.string().min(1).optional().describe("Page name or id (default: the current page); switched to before building"), x: z.number().optional(), y: z.number().optional() }).strict().optional(),
    /** Horizontal gap between multiple top-level screens. */
    screenGap: z.number().min(0).max(2000).default(80),
    screens: z.array(DesignNodeSchema).max(30).default([]),
    /** Prototype flows: named starting points (a screen name, a node id from this plan, or a Figma node id). */
    prototype: z.object({ flows: z.array(z.object({ name: z.string().min(1), start: z.string().min(1), description: z.string().optional() }).strict()).max(20).optional() }).strict().optional(),
    /** Add nodes into existing parents (e.g. fill 9 slots) in the same run and undo step. Needs approval. */
    inserts: z.array(z.object({ parentId: z.string().min(1), index: z.number().int().min(0).optional(), nodes: z.array(DesignNodeSchema).min(1).max(100) }).strict()).max(50).optional(),
  })
  .strict()
  .refine((p) => p.screens.length > 0 || (p.inserts?.length ?? 0) > 0, { message: "A plan needs screens or inserts.", path: ["screens"] });

export type DesignPlan = z.infer<typeof DesignPlanSchema>;

/** "Invalid input" says nothing: for a field that takes one of several shapes, say what each shape wanted. */
function explain(i: z.ZodIssue): string {
  if (i.code !== "invalid_union") return i.message;
  const why = [...new Set(i.unionErrors.map((e) => e.issues.map((x) => `${x.path.slice(i.path.length).join(".") || "value"}: ${x.message}`).join(", ")))];
  return `No accepted form matches (${why.slice(0, 4).join(" | ")}).`;
}

export function validatePlan(input: unknown):
  | { success: true; plan: DesignPlan }
  | { success: false; errors: { type: "INVALID_PLAN"; path: string; message: string }[] } {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (e) {
      return { success: false, errors: [{ type: "INVALID_PLAN", path: "", message: `Malformed JSON: ${(e as Error).message}` }] };
    }
  }
  const r = DesignPlanSchema.safeParse(value);
  if (r.success) return { success: true, plan: r.data };
  return {
    success: false,
    errors: r.error.issues.slice(0, 25).map((i) => ({ type: "INVALID_PLAN" as const, path: i.path.join("."), message: explain(i) })),
  };
}
