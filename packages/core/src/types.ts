// Shared types: the normalized Design System, the compact node snapshot, the
// resolved (executable) plan and the bridge protocol. This file has no runtime
// dependencies so it can be bundled into the Figma plugin sandbox.

// ---------- Errors ----------
export type ErrorType =
  | "INVALID_PLAN"
  | "COMPONENT_NOT_FOUND"
  | "INVALID_VARIANT"
  | "UNSUPPORTED_PROPERTY"
  | "TOKEN_NOT_FOUND"
  | "STYLE_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "FIGMA_API_ERROR"
  | "PLUGIN_DISCONNECTED"
  | "TIMEOUT"
  | "PARTIAL_EXECUTION"
  | "NOT_APPROVED"
  | "AMBIGUOUS_COMPONENT"
  | "DESIGN_SYSTEM_NOT_SCANNED"
  /** Another session changed a layer after this session last read it. */
  | "CONFLICT"
  /** Several sessions are connected and the user didn't give the current selection to this one. */
  | "SELECTION_NOT_CONFIRMED" | "STOPPED";

export interface StructuredError {
  type: ErrorType;
  message: string;
  path?: string;
  component?: string;
  suggestions?: string[];
  [k: string]: unknown;
}

export type Result<T> =
  | { success: true; data: T; warnings?: string[] }
  | { success: false; errors: StructuredError[]; warnings?: string[] };

// ---------- Design System ----------
export interface PropertyDefinition {
  /** Full Figma key, e.g. "Label#12:3" (needed for setProperties). */
  key: string;
  /** Human name without the "#id" suffix, e.g. "Label". */
  name: string;
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
  defaultValue?: unknown;
  options?: string[];
}

export interface Padding { top: number; right: number; bottom: number; left: number }

export interface LayoutInfo {
  mode: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  gap?: number;
  padding?: Padding;
}

export interface ComponentDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
  remote: boolean;
  page?: string;
  componentSetId?: string;
  componentSet?: string;
  variants?: Record<string, string>;
  properties?: PropertyDefinition[];
  dimensions?: { width: number; height: number };
  layout?: LayoutInfo;
  textLayers?: string[];
  semanticHints?: string[];
  /** Look of the variant's root: first solid fill and stroke, corner radius (for matching drawn elements). */
  look?: { fill?: string; stroke?: string; radius?: number; text?: string };
}

export interface ComponentSetDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
  remote: boolean;
  page?: string;
  properties: PropertyDefinition[];
  variantIds: string[];
  defaultVariantId?: string;
  semanticHints?: string[];
  /** Instances of this set found in the file (a tie-breaker between copies of the same library set). */
  usage?: number;
}

export interface VariableDefinition {
  id: string;
  key: string;
  name: string;
  collection: string;
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  remote: boolean;
  /** Value in the collection's default mode (colors as #rrggbb[aa]); aliases as "alias:<name>". */
  value?: unknown;
  valuesByMode?: Record<string, unknown>;
  scopes?: string[];
  description?: string;
}

export interface VariableCollectionDefinition {
  id: string;
  name: string;
  remote: boolean;
  modes: { id: string; name: string }[];
  defaultModeId?: string;
}

export interface StyleDefinition {
  id: string;
  key: string;
  name: string;
  type: "PAINT" | "TEXT" | "EFFECT" | "GRID";
  remote: boolean;
  description?: string;
  /** Summary: hex for solid paint, font spec for text, effect kinds for effects. */
  value?: unknown;
}

export interface TypographyDefinition {
  styleId: string;
  name: string;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  lineHeight?: number | "AUTO" | string;
  letterSpacing?: number;
  role?: string;
}

export interface SemanticToken {
  name: string;
  category: "color" | "spacing" | "radius" | "size" | "typography" | "other";
  source: "variable" | "style";
  refId: string;
  value?: unknown;
}

export interface DesignSystem {
  fileName: string;
  scannedAt: string;
  components: ComponentDefinition[];
  componentSets: ComponentSetDefinition[];
  variableCollections: VariableCollectionDefinition[];
  variables: VariableDefinition[];
  styles: StyleDefinition[];
  typography: TypographyDefinition[];
  semanticTokens: SemanticToken[];
}

/** Largest corner radius a plan writes. Figma reports a fully round ("pill") corner as a huge number (33554400): any
 *  radius above this is fully round, so plans clamp it here instead of rejecting it. */
export const MAX_RADIUS = 9999;

// ---------- Compact node snapshot (inspection) ----------
export interface NodeSnapshot {
  id: string;
  type: string;
  name: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
  layout?: LayoutInfo & {
    primaryAlign?: string;
    counterAlign?: string;
    sizingH?: string;
    sizingV?: string;
    /** Horizontal Auto Layout that wraps, and the gap between its rows (counterAxisSpacing). */
    wrap?: boolean;
    counterGap?: number;
  };
  /** Absolutely positioned inside its Auto Layout parent (layoutPositioning ABSOLUTE). */
  absolute?: boolean;
  /** The top visible image fill: the file's image hash (the bytes stay in Figma) and its scale mode. */
  image?: { hash: string; scaleMode: string };
  fills?: string[];
  strokes?: string[];
  radius?: number;
  bound?: Record<string, string>; // field -> variable name/id
  fillStyle?: string;
  text?: { chars: string; fontSize?: number; font?: string; lineHeight?: number | "AUTO" | string; styleId?: string; style?: string; align?: string; letterSpacing?: number; autoResize?: string;
    /** Styled pieces of a text whose font, size, colour or link changes inside it (inspect for a plan only). */
    runs?: { chars: string; font?: string; fontSize?: number; fill?: string; href?: string }[] };
  strokeWeight?: number;
  opacity?: number;
  clip?: boolean;
  /** The top gradient fill, and shadows/blurs, as the DSL writes them. */
  gradient?: { type: "linear" | "radial" | "angular" | "diamond"; angle: number; stops: { color: string; position: number }[] };
  effects?: { shadows?: { type: "drop" | "inner"; x: number; y: number; blur: number; spread: number; color: string }[]; blur?: number; backgroundBlur?: number };
  effectStyle?: string;
  /** SVG markup of a vector or boolean shape (inspect with svg: true). */
  svg?: string;
  /** Polygon/star points, star inner radius, and an ellipse's arc (degrees) when it isn't a full circle. */
  shape?: { pointCount?: number; innerRadius?: number; arc?: { start: number; end: number; innerRadius: number } };
  annotations?: AnnotationSpec[];
  /** Prototype interactions, summarized: trigger, action and destination. */
  reactions?: { trigger?: string; delay?: number; action?: string; to?: string; toName?: string; url?: string; transition?: { type: string; direction?: string; duration: number; easing?: string } }[];
  instance?: { componentId?: string; component?: string; componentSet?: string; componentSetId?: string; variants?: Record<string, string>; props?: Record<string, unknown>; overrides?: Record<string, string[]> };
  children?: NodeSnapshot[];
  truncated?: number;
  warnings?: string[];
}

// ---------- Resolved plan (what the plugin executes) ----------
export type Paint = { variableId?: string; variableKey?: string; styleId?: string; styleKey?: string; hex?: string };
export type Num = { value?: number; variableId?: string; variableKey?: string };

export type Sizing = "fixed" | "hug" | "fill";

/** A prototype interaction ready for the plugin: `to` is a plan path or an existing node id. */
export interface ResolvedInteraction {
  trigger: "ON_CLICK" | "ON_HOVER" | "ON_PRESS" | "ON_DRAG" | "MOUSE_ENTER" | "MOUSE_LEAVE" | "AFTER_TIMEOUT";
  delay?: number; // seconds
  action: "NAVIGATE" | "OVERLAY" | "SWAP" | "SCROLL_TO" | "CHANGE_TO" | "BACK" | "CLOSE" | "URL";
  to?: { path: string } | { nodeId: string };
  url?: string;
  transition?: { type: "DISSOLVE" | "SMART_ANIMATE" | "MOVE_IN" | "MOVE_OUT" | "PUSH" | "SLIDE_IN" | "SLIDE_OUT"; direction?: "LEFT" | "RIGHT" | "TOP" | "BOTTOM"; duration: number; easing: string };
  preserveScroll?: boolean;
}

/** A native Figma annotation (dev handoff note): markdown text, measured properties, a category by label. */
export interface AnnotationSpec { label: string; properties?: string[]; category?: string }

export interface ResolvedBase {
  path: string;
  name: string;
  interactions?: ResolvedInteraction[];
  annotations?: AnnotationSpec[];
  width?: number;
  height?: number;
  sizingH?: Sizing;
  sizingV?: Sizing;
  opacity?: number;
  /** Absolutely positioned inside the parent (also inside Auto Layout). */
  absolute?: { x: number; y: number };
  minWidth?: number;
  maxWidth?: number;
}

export interface ResolvedShadow { type: "DROP_SHADOW" | "INNER_SHADOW"; x: number; y: number; blur: number; spread: number; hex: string }
export interface ResolvedGradient { type?: "linear" | "radial" | "angular" | "diamond"; angle: number; stops: { hex: string; position: number }[] }
/** An image already in the file, by its hash (figma.getImageByHash): nothing is uploaded again. */
export interface ResolvedImageFill { hash: string; scaleMode: "FILL" | "FIT" | "CROP" | "TILE" }
export type ResolvedLineHeight = { unit: "PIXELS" | "PERCENT"; value: number } | { unit: "AUTO" };

export interface ResolvedFrame extends ResolvedBase {
  kind: "frame";
  role: string;
  layout?: {
    direction: "HORIZONTAL" | "VERTICAL" | "NONE";
    gap?: Num;
    padding?: { top?: Num; right?: Num; bottom?: Num; left?: Num };
    primaryAlign?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
    counterAlign?: "MIN" | "CENTER" | "MAX" | "BASELINE";
    wrap?: boolean;
    /** Gap between wrapped rows (counterAxisSpacing); only with wrap. */
    counterGap?: Num;
  };
  fill?: Paint;
  /** An image already in the file, painted above the fill and below the gradient. */
  image?: ResolvedImageFill;
  stroke?: Paint;
  strokeWeight?: number;
  strokeSides?: ("top" | "right" | "bottom" | "left")[];
  radius?: Num;
  effectStyleId?: string;
  shadows?: ResolvedShadow[];
  strokeWeights?: { top?: number; right?: number; bottom?: number; left?: number };
  gradient?: ResolvedGradient;
  blur?: number;
  backgroundBlur?: number;
  clip?: boolean;
  scroll?: "NONE" | "VERTICAL" | "HORIZONTAL" | "BOTH";
  fixedChildren?: number;
  children: ResolvedNode[];
}

export interface ResolvedText extends ResolvedBase {
  kind: "text";
  content: string;
  textStyleId?: string;
  textStyleKey?: string;
  /** The style's font, when the scan learned it from a layer (a library style may not report it). */
  textStyleFont?: { family: string; style: string };
  /** The style's name and size, so the text keeps its size when the style can't be applied. */
  textStyleName?: string;
  textStyleSize?: number;
  fontSize?: number;
  /** Requested family; the executor falls back to an available one with a warning. Default Inter. */
  fontFamily?: string;
  /** Canonical weight name, matched loosely against available styles ("Semi Bold" ≈ "SemiBold"). */
  fontWeight?: "Thin" | "Extra Light" | "Light" | "Regular" | "Medium" | "Semi Bold" | "Bold" | "Extra Bold" | "Black";
  italic?: boolean;
  lineHeight?: ResolvedLineHeight;
  letterSpacing?: { unit: "PIXELS" | "PERCENT"; value: number };
  fill?: Paint;
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  hyperlink?: string;
  /** Character ranges with their own style, applied after the base font. */
  runs?: { start: number; end: number; fontFamily?: string; fontWeight?: ResolvedText["fontWeight"]; italic?: boolean; fontSize?: number; fill?: Paint; hyperlink?: string }[];
}

export interface ResolvedInstance extends ResolvedBase {
  kind: "instance";
  componentId: string;
  componentKey?: string;
  remote: boolean;
  componentName: string;
  /** setProperties payload (full keys, excluding variants which are chosen via componentId). */
  properties: Record<string, string | boolean>;
  /** Fallback: text layer name -> content. */
  textOverrides: Record<string, string>;
  /** Props/variants matched by name on the instance at execution time (a library component that wasn't scanned). */
  lateProps?: Record<string, string | boolean>;
}

export interface ResolvedRect extends ResolvedBase {
  kind: "rect";
  role: "divider" | "image" | "icon-placeholder";
  fill?: Paint;
  radius?: Num;
  /** Image bytes as a data: URL (https sources are inlined by the MCP server before execution). */
  src?: string;
  /** An image already in the file (figma.getImageByHash), used instead of src. */
  imageHash?: string;
  fit?: "FILL" | "FIT" | "CROP" | "TILE";
}

export interface ResolvedSvg extends ResolvedBase {
  kind: "svg";
  svg: string;
  /** Recolor every vector fill/stroke (icons that use currentColor). */
  fill?: Paint;
}

export interface ResolvedShape extends ResolvedBase {
  kind: "shape";
  shape: "ellipse" | "line" | "polygon" | "star";
  fill?: Paint;
  stroke?: Paint;
  strokeWeight?: number;
  gradient?: ResolvedGradient;
  image?: ResolvedImageFill;
  pointCount?: number;
  innerRadius?: number;
  /** Degrees; the executor converts to radians. */
  arc?: { start: number; end: number; innerRadius: number };
  effectStyleId?: string;
  shadows?: ResolvedShadow[];
  blur?: number;
  backgroundBlur?: number;
}

export type ResolvedNode = ResolvedFrame | ResolvedText | ResolvedInstance | ResolvedRect | ResolvedSvg | ResolvedShape;

export interface ResolvedPlan {
  planId: string;
  name: string;
  target: { parentId?: string; page?: string; x?: number; y?: number };
  screenGap?: number;
  roots: ResolvedNode[];
  /** Prototype flow starting points. */
  flows?: { name: string; description?: string; to: { path: string } | { nodeId: string } }[];
  /** Nodes added into existing parents. */
  inserts?: { parentId: string; index?: number; roots: ResolvedNode[] }[];
}

// ---------- Transformations (Mode B) ----------
export type Transformation =
  | { id: string; op: "replace_with_instance"; nodeId: string; nodeName: string; componentId: string; componentKey?: string; remote: boolean; componentName: string; properties: Record<string, string | boolean>; textOverrides: Record<string, string>; reason: string }
  | { id: string; op: "bind_number"; nodeId: string; nodeName: string; field: "itemSpacing" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "cornerRadius"; from: number; variableId: string; variableKey?: string; variableName: string; reason: string }
  | { id: string; op: "bind_fill"; nodeId: string; nodeName: string; from: string; variableId: string; variableKey?: string; variableName: string; reason: string }
  | { id: string; op: "apply_fill_style"; nodeId: string; nodeName: string; from: string; styleId: string; styleKey?: string; styleName: string; reason: string }
  | { id: string; op: "apply_text_style"; nodeId: string; nodeName: string; styleId: string; styleKey?: string; styleName: string; reason: string; font?: { family: string; style: string } }
  | { id: string; op: "convert_auto_layout"; nodeId: string; nodeName: string; direction: "HORIZONTAL" | "VERTICAL"; gap: number; padding: Padding; reason: string };

// ---------- Execution results ----------
export interface ExecutionReport {
  createdRootIds: string[];
  page?: { id: string; name: string };
  nodeIds: Record<string, string>; // plan path -> figma node id
  warnings: string[];
}

export interface TransformReport {
  applied: { id: string; nodeId: string; newNodeId?: string }[];
  failed: { id: string; error: string }[];
  hiddenOriginals: string[];
}

// ---------- Bridge protocol ----------
export type BridgeMethod =
  | "ping"
  | "scanDesignSystem"
  | "inspect"
  | "executePlan"
  | "applyTransformations"
  | "select"
  | "importTree"
  | "ensurePages"
  | "foundations"
  | "exportImage"
  | "editNodes"
  | "cleanup";

/** A Claude Code / Cursor session connected to the shared bridge (the hub). */
/** `titled`: the name is the agent's title for its task, not the folder name it started with. */
/** `connectedAt`: when it first joined (kept across reconnects). */
export interface SessionInfo { id: string; name: string; color: string; workdir?: string; client?: string; version?: string; connectedAt: number; titled?: boolean }
/** A request the user sent from the Figma window to one session: a quick action ("code", "polish"…) or their own
 *  words ("ask"), about the layers selected when they sent it. */
/** `skills`: skills the user picked for this request in the window's chat box (@name): the agent reads them first.
 *  `via`: the user wrote it on the canvas ("@session …"), in a note (a text layer, id `note`, on the layers) or in an
 *  annotation on the layer; the answer goes under it. */
export interface FigmaAction { id: string; kind: string; text?: string; nodes: { id: string; name: string; type: string }[]; more?: number; page?: string; file?: string; at: number; skills?: string[]; via?: "annotation" | "note"; note?: string }
/** queued: waiting for the session's next step · sent: pushed into the conversation · seen: the agent has it ·
 *  working / done / failed: what the agent reported with figma_reply · stopped: the user stopped it in the window. */
export type FigmaActionStatus = "queued" | "sent" | "seen" | "working" | "done" | "failed" | "stopped";
/** `session` is set by the hub: which session sent the request. Absent with a direct (single-session) bridge. */
/** `task`: the request from the Figma window this work is for (its own cursor in the plugin), when the agent named it. */
export interface BridgeRequest { id: string; method: BridgeMethod; params?: unknown; session?: SessionInfo; task?: string }
export interface BridgeResponse { id: string; ok: boolean; result?: unknown; error?: StructuredError }
/** `protocol` 2+: the plugin understands sessions (selection hand-off, per-session activity). */
export interface BridgeHello { type: "hello"; fileName: string; fileKey?: string; page: string; user?: string; pluginBuild?: string; protocol?: number }

/** How a swapped element becomes an instance. `overrides`: "none" keeps the component as is, "text" (default) copies
 *  matching text only, "match" also hides component layers the element doesn't have. Fills are copied only with `fills`. */
export interface ImportSwapRef { component: string; id?: string; key?: string; variant?: string; overrides?: "none" | "text" | "match"; fills?: boolean }

/** A node serialized from rendered HTML (absolute boxes, relative to the parent node). */
export interface ImportPaint { hex: string; a: number }
export type ImportNode =
  | { type: "frame"; name: string; x: number; y: number; w: number; h: number; fill?: ImportPaint; gradient?: { type?: "linear" | "radial" | "angular" | "diamond"; angle: number; stops: (ImportPaint & { pos: number })[] }; blur?: number; backdropBlur?: number;
      shadows?: (ImportPaint & { inset: boolean; x: number; y: number; blur: number; spread: number })[]; stroke?: ImportPaint & { weights: number[] };
      radius?: number[]; clip?: boolean; blend?: string; opacity?: number; placeholder?: string; swap?: ImportSwapRef; children: ImportNode[] }
  | { type: "text"; name: string; x: number; y: number; w: number; h: number; content: string; font: { family: string; style: string }; size: number;
      lineHeight?: number; letterSpacing?: number; color?: string; opacity?: number; align: "LEFT" | "RIGHT" | "CENTER"; wrap: boolean }
  | { type: "svg"; name: string; x: number; y: number; w: number; h: number; svg: string };
