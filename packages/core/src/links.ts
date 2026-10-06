// Figma links: the file's key and a layer's id. https://www.figma.com/design/<file key>/<name>?node-id=12-34 points at
// layer 12:34 (a frame, a section, a page...). Pure: building a link for a layer, and reading one the user pasted.

export interface FigmaLink {
  /** The file's key (a branch's own key when the link is to a branch). */
  fileKey: string;
  /** The layer, as the Plugin API writes ids ("12:34"); absent for a link to the whole file. */
  nodeId?: string;
  /** design, file (older links), proto, board (FigJam), slides. */
  kind: string;
  /** The file's name as the link spells it ("Talent-Club"), when it has one. */
  slug?: string;
}

const HOSTS = /^(?:www\.)?figma\.com$/i;

/** Read a Figma link: undefined when it isn't one. Accepts links with or without https://, branch links, node-id
 *  written 12-34, 12:34 or 12%3A34, and the starting point of a prototype link. */
export function parseFigmaLink(text: string): FigmaLink | undefined {
  const raw = text.trim();
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return undefined; }
  if (!HOSTS.test(url.hostname)) return undefined;
  const m = /^\/(design|file|proto|board|slides)\/([A-Za-z0-9]{10,})(?:\/branch\/([A-Za-z0-9]{10,}))?(?:\/([^/?#]*))?/.exec(url.pathname);
  if (!m) return undefined;
  const node = url.searchParams.get("node-id") ?? url.searchParams.get("starting-point-node-id") ?? undefined;
  const nodeId = node ? node.replace(/-/g, ":") : undefined;
  return { kind: m[1], fileKey: m[3] ?? m[2], nodeId: nodeId && /^[\w:;-]+$/.test(nodeId) ? nodeId : undefined, slug: m[4] ? decoded(m[4]) : undefined };
}

const decoded = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const letters = (s: string) => decoded(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Is a link with this name part to a file with this name? Figma writes each space or sign as a dash ("Talent Club -
 *  Evaluation (Copy)" → "Talent-Club---Evaluation--Copy-"), so the letters and digits are compared, all of them: "Talent
 *  Club - Evaluation" is another file than its copy. No name part: unknown (false). */
export function slugFits(slug: string | undefined, fileName: string): boolean {
  const a = letters(slug ?? "");
  return !!a && a === letters(fileName);
}


/** The name part of a link Layerwright makes ("Talent Club - Evaluation (Copy)" → "Talent-Club-Evaluation-Copy"). Figma
 *  only reads the key and the node id; the name is for people. */
export function linkSlug(fileName: string): string {
  return encodeURIComponent(fileName.trim().replace(/[\s/\\?#%&()[\]{}<>'"`|^]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "Untitled");
}

/** A link to a layer (or the whole file without one) in a design file. */
export function figmaLink(o: { fileKey: string; fileName?: string; nodeId?: string }): string {
  const base = `https://www.figma.com/design/${o.fileKey}/${linkSlug(o.fileName ?? "")}`;
  return o.nodeId ? `${base}?node-id=${encodeURIComponent(o.nodeId.replace(/:/g, "-"))}` : base;
}
