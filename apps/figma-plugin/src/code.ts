// Plugin main thread: a deterministic worker that answers bridge requests.
import type { BridgeRequest, BridgeResponse, ResolvedPlan, SessionInfo, Transformation } from "@cde/core";
import { scanDesignSystem, snapshot } from "./scan.ts";
import { executePlan, applyTransformations, ExecError, pageOf } from "./execute.ts";
import { editNodes, cleanup } from "./edit.ts";
import { importTree, ensurePages, foundations } from "./import.ts";
import { progress } from "./progress.ts";
import { DeskError, SessionDesk } from "./sessions.ts";
import { cursorAsk, cursorBegin, cursorBusy, cursorEnabled, cursorEnd, cursorGone, cursorsClear, userActed, isOverlayId, removeLeftovers, setCursorEnabled, shade } from "./cursor.ts";
import { setZoomEnabled, showResult, zoomAfter, zoomEnabled, zoomRequest, type Shown } from "./zoom.ts";
import { NoteWatch, isNote, type NoteItem } from "./notes.ts";

declare const __BUILD__: string;
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";

figma.showUI(__html__, { width: 340, height: 600, themeColors: true });

// Sessions sharing this plugin through the hub: selection hand-off, conflicts, one edit at a time (see sessions.ts).
const desk = new SessionDesk({
  selection: () => figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name })),
  post: (msg) => figma.ui.postMessage(msg),
  progress: (label) => progress(label),
  nodeName: async (id) => (await figma.getNodeByIdAsync(id))?.name,
});

// Several requests from the window can run at once (multitasking). A session's first open request works with the
// session's own cursor; each other one gets its own cursor ("Checkout · Mobile", in a nearby shade), and the session's
// Figma calls that name that request as their task are drawn with it. So the user sees who works on what.
const SHORT: Record<string, string> = { code: "Code", polish: "Polish", component: "Component", mobile: "Mobile", ask: "Question" };
const tasks = new Map<string, { session: string; kind: string; own: boolean; turn: number }>();
function noteTask(id: string, session: string, kind: string) {
  const t = tasks.get(id);
  if (t) { t.session = session; return; }
  const mine = [...tasks.values()].filter((x) => x.session === session);
  tasks.set(id, { session, kind, own: !mine.some((x) => x.own), turn: mine.length });
}
/** Who draws the work for a request (or for a session's work that names no request). */
function whoFor(session: SessionInfo | { id: string; name?: string; color?: string } | undefined, task?: string) {
  const t = task ? tasks.get(task) : undefined;
  if (!session || !t || t.own) return session;
  const s = desk.sessions.find((x) => x.id === session.id) ?? session;
  return { id: `${session.id}~${task}`, name: `${s.name ?? "Claude"} · ${SHORT[t.kind] ?? "Task"}`, color: shade(s.color ?? "#7c3aed", (t.turn % 2 ? -1 : 1) * (38 + 14 * Math.floor(t.turn / 2))) };
}

// The user comes first: while a request runs, changes and selections are its own; any other is the user working in
// Figma: the view stays where the user has it (zoom.ts), and the cursors carry on beside them (cursor.ts).
let running = 0;
const ours = () => running > 0;
/** A result the view didn't glide to because the user was busy: the window offers "Show the result". */
function offer(r: Shown, session?: string) { if (r.held?.length) figma.ui.postMessage({ type: "result-ready", ids: r.held.slice(0, 200), session }); }

async function resolveTarget(target?: string, session?: SessionInfo): Promise<BaseNode[]> {
  if (!target || target === "selection") { await desk.claimSelection(session); return [...figma.currentPage.selection]; }
  if (target === "page") return [figma.currentPage];
  const n = await figma.getNodeByIdAsync(target);
  if (!n) throw new ExecError({ type: "NODE_NOT_FOUND", message: `Node ${target} not found.` });
  return [n];
}

async function handle(req: BridgeRequest): Promise<unknown> {
  const p = (req.params ?? {}) as any;
  switch (req.method) {
    case "ping":
      return { fileName: figma.root.name, page: figma.currentPage.name, pluginBuild: BUILD,
        // Changes seen since this plugin window opened; a scan older than that can't be vouched for.
        dsChangedSinceScan: dsChanged || (typeof p.scannedAt === "string" && p.scannedAt < watchingSince) || undefined, watchingSince,
        ...desk.pingInfo(req.session, figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name, type: n.type }))) };
    case "scanDesignSystem":
      dsChanged = false;
      return scanDesignSystem(p);
    case "inspect": {
      const nodes = await resolveTarget(p.target, req.session);
      const depth = p.depth ?? (p.target === "page" ? 1 : 6);
      const out = [];
      for (const n of nodes) out.push(await snapshot(n, { depth, maxNodes: p.maxNodes ?? 400, expandInstances: !!p.expandInstances, svg: !!p.svg }));
      return { page: figma.currentPage.name, nodes: out };
    }
    case "executePlan":
      return executePlan(p.plan as ResolvedPlan, p.meta);
    case "editNodes":
      return editNodes(p);
    case "cleanup":
      return cleanup(p);
    case "applyTransformations":
      return applyTransformations(p.transformations as Transformation[]);
    case "importTree":
      return importTree(p);
    case "foundations":
      return foundations(p);
    case "ensurePages":
      return ensurePages(p.pages as string[]);
    case "exportImage": {
      // A PNG/JPG of one node, capped so a huge frame doesn't produce a huge payload.
      const n = await figma.getNodeByIdAsync(p.nodeId);
      if (!n || !("exportAsync" in n)) throw new ExecError({ type: "NODE_NOT_FOUND", message: `Node ${p.nodeId} not found or can't be exported.` });
      const node = n as SceneNode;
      const longest = Math.max(node.width, node.height, 1);
      const scale = Math.max(0.05, Math.min(p.scale ?? 1, (p.maxDimension ?? 2000) / longest));
      const bytes = await node.exportAsync({ format: p.format === "jpg" ? "JPG" : "PNG", constraint: { type: "SCALE", value: scale } });
      return { base64: figma.base64Encode(bytes), format: p.format === "jpg" ? "jpg" : "png", scale, width: Math.round(node.width * scale), height: Math.round(node.height * scale), name: node.name };
    }
    case "select": {
      // Selection only works on the current page: switch to the page of the first node, select what's on it.
      const all = (await Promise.all((p.nodeIds as string[]).map((id) => figma.getNodeByIdAsync(id)))).filter((n): n is SceneNode => !!n && "x" in n);
      const page = all.length ? pageOf(all[0]) : undefined;
      if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
      const nodes = all.filter((n) => pageOf(n)?.id === figma.currentPage.id);
      figma.currentPage.selection = nodes;
      if (nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
      return { selected: nodes.length, page: figma.currentPage.name, skippedOnOtherPages: all.length - nodes.length || undefined };
    }
    default:
      throw new ExecError({ type: "FIGMA_API_ERROR", message: `Unknown method ${(req as any).method}` });
  }
}

// protocol 2: this plugin understands sessions (the hub sends them only to plugins that do).
const hello = () => ({ type: "hello", fileName: figma.root.name, fileKey: figma.fileKey, page: figma.currentPage.name, user: figma.currentUser?.name, pluginBuild: BUILD, selection: figma.currentPage.selection.length, protocol: 2 });

figma.ui.onmessage = async (msg: any) => {
  if (msg?.type === "ui-ready") {
    figma.ui.postMessage({ type: "hello", hello: hello() });
    // Remember the bridge port per user (parallel sessions use different ports).
    const port = await figma.clientStorage.getAsync("bridgePort").catch(() => undefined);
    if (typeof port === "number" && port !== 7331) figma.ui.postMessage({ type: "port", port });
    const cursor = await figma.clientStorage.getAsync("aiCursor").catch(() => undefined);
    if (typeof cursor === "boolean") setCursorEnabled(cursor);
    const mini = (await figma.clientStorage.getAsync("compact").catch(() => undefined)) === true;
    const zoom = await figma.clientStorage.getAsync("zoomResult").catch(() => undefined);
    if (typeof zoom === "boolean") setZoomEnabled(zoom);
    figma.ui.postMessage({ type: "settings", cursor: cursorEnabled(), zoom: zoomEnabled(), mini });
    void sendThumb();
    return;
  }
  if (msg?.type === "open-repo") { figma.openExternal(REPO_URL); return; }
  // A link in a skill's page (its source, a reference): only https, opened in the browser.
  if (msg?.type === "open-url" && typeof msg.url === "string" && /^https:\/\/[^\s]+$/.test(msg.url) && msg.url.length < 2000) { figma.openExternal(msg.url); return; }
  if (msg?.type === "set-cursor") { setCursorEnabled(!!msg.on); await figma.clientStorage.setAsync("aiCursor", !!msg.on); return; }
  if (msg?.type === "set-zoom") { setZoomEnabled(!!msg.on); await figma.clientStorage.setAsync("zoomResult", !!msg.on); return; }
  if (msg?.type === "compose-action" && typeof msg.session === "string") {
    // A request from the window ("Build this in code", or the user's own words) for one session, about the
    // selection. The selection goes with it: that session may use it without asking.
    const sel = figma.currentPage.selection;
    const kind = typeof msg.kind === "string" ? msg.kind.slice(0, 24) : "ask";
    const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 2000) : "";
    if (!sel.length && kind !== "ask") { figma.ui.postMessage({ type: "action-error", message: "Select the layers first." }); return; }
    const skills: string[] = Array.isArray(msg.skills) ? [...new Set<string>(msg.skills.filter((s: unknown): s is string => typeof s === "string" && /^[\w-]{1,60}$/.test(s)))].slice(0, 6) : [];
    composeAction(msg.session, kind, text, sel, { skills: skills.length ? skills : undefined });
    return;
  }
  if (msg?.type === "show-result" && Array.isArray(msg.ids)) { void showResult(msg.ids.filter((x: unknown) => typeof x === "string")); return; }
  if (msg?.type === "session-state" && typeof msg.session === "string") {
    // The session asks the user something in its chat (or got the answer): Figma says so, the cursor waves.
    const who = desk.sessions.find((x) => x.id === msg.session) ?? { id: msg.session };
    if (msg.waiting) {
      const name = (who as SessionInfo).name ?? "Claude";
      figma.notify(msg.kind === "permission" ? `${name} needs your OK in Claude Code. Answer in the chat.` : `${name} asked you something in Claude Code. Answer in the chat.`, { timeout: 8000 });
    }
    void cursorAsk(who, !!msg.waiting, typeof msg.kind === "string" ? msg.kind : undefined, typeof msg.text === "string" ? msg.text : undefined);
    return;
  }
  if (msg?.type === "set-mini") {
    // Compact window: the window sizes itself to its content (resize below); full size is the usual 340 × 600.
    await figma.clientStorage.setAsync("compact", !!msg.on);
    if (!msg.on) figma.ui.resize(340, 600);
    return;
  }
  if (msg?.type === "resize" && typeof msg.width === "number" && typeof msg.height === "number") {
    figma.ui.resize(Math.round(Math.min(480, Math.max(240, msg.width))), Math.round(Math.min(800, Math.max(90, msg.height))));
    return;
  }
  if (msg?.type === "zoom-to") {
    // A click on the picture of the selection: zoom to that layer (on its page), or to the whole selection.
    const n = typeof msg.id === "string" ? await figma.getNodeByIdAsync(msg.id) : null;
    const node = n && "x" in n ? (n as SceneNode) : undefined;
    const page = node ? pageOf(node) : undefined;
    if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
    const nodes = node ? [node] : [...figma.currentPage.selection];
    if (nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
    return;
  }
  if (msg?.type === "set-port" && typeof msg.port === "number") { await figma.clientStorage.setAsync("bridgePort", msg.port); return; }
  if (msg?.type === "sessions" && Array.isArray(msg.sessions)) {
    const live = new Set((msg.sessions as SessionInfo[]).map((x) => x.id));
    for (const old of desk.sessions) if (!live.has(old.id)) cursorGone(old.id);
    desk.setSessions(msg.sessions);
    return;
  }
  if (msg?.type === "session-activity" && typeof msg.session === "string") {
    // A request from the window reached a session (its cursor comes to the layers) or was finished.
    // Each request has its own cursor when the session already works on another one.
    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (id) noteTask(id, msg.session, typeof msg.kind === "string" ? msg.kind : tasks.get(id)?.kind ?? "ask");
    const session = desk.sessions.find((x) => x.id === msg.session) ?? { id: msg.session };
    const who = whoFor(session, id);
    const busy = ["sending", "sent", "queued", "seen", "working"].includes(msg.status);
    if (typeof msg.status === "string") void zoomRequest(msg.session, msg.status, id).then((r) => offer(r, msg.session)).catch(() => {}); // done: show what it changed
    void cursorBusy(who, busy, Array.isArray(msg.nodes) ? msg.nodes : [], typeof msg.kind === "string" ? msg.kind : undefined);
    if (!busy && id) tasks.delete(id);
    if (id && typeof msg.status === "string") void notes.finished(id, msg.status, typeof msg.message === "string" ? msg.message : undefined);
    return;
  }
  if (msg?.type === "note-send" && typeof msg.key === "string" && typeof msg.session === "string") { notes.sendTo(msg.key, msg.session); return; }
  if (msg?.type === "note-dismiss" && typeof msg.key === "string") { notes.dismiss(msg.key); return; }
  if (msg?.type === "assign-selection" && typeof msg.session === "string") { desk.assign(msg.session); return; }
  if (msg?.type === "answer-selection" && typeof msg.id === "string") { desk.answer(msg.id, !!msg.ok); return; }
  if (msg?.type === "show-selection") {
    // "Show" on a request in the window: bring the selected layers into view.
    const sel = figma.currentPage.selection;
    if (sel.length) figma.viewport.scrollAndZoomIntoView(sel);
    return;
  }
  if (msg?.type !== "request") return;
  const req = msg.req as BridgeRequest;
  let res: BridgeResponse;
  running++;
  try {
    // The session's cursor goes where it works or looks, and thinks between steps (cursor.ts; undo.ts keeps it out
    // of undo steps).
    // When a change lands, the view glides to it (a build always; anything else when it's off screen) while the
    // cursor clicks there (zoom.ts).
    // Work for a request from the window that the session named as its task is drawn with that request's cursor.
    const who = whoFor(req.session, req.task);
    const zoom = (r: unknown) => { void zoomAfter(req.session?.id, req.method, r, req.task).then((z) => offer(z, req.session?.id)).catch(() => {}); };
    const work = async () => {
      if (!cursorEnabled() || req.method === "ping") { const r = await handle(req); zoom(r); return r; }
      await cursorBegin(who, req.method, req.params).catch(() => {});
      let r: unknown;
      try { r = await handle(req); } catch (e) { await cursorEnd(who, req.method, undefined, false, req.params).catch(() => {}); throw e; }
      zoom(r);
      await cursorEnd(who, req.method, r, true, req.params).catch(() => {});
      return r;
    };
    res = { id: req.id, ok: true, result: await desk.run(req.method, req.params, req.session, work) };
  } catch (e) {
    const error = e instanceof ExecError || e instanceof DeskError ? e.detail : { type: "FIGMA_API_ERROR" as const, message: (e as Error)?.message ?? String(e) };
    res = { id: req.id, ok: false, error };
  }
  // Its own changes and selections arrive a moment after it ends: they still count as its own.
  setTimeout(() => { running--; }, 400);
  figma.ui.postMessage({ type: "response", res });
};
/** A request for one session about these layers, handed to the window to send (the window's actions, annotations). */
function composeAction(session: string, kind: string, text: string, nodes: readonly SceneNode[], extra: { skills?: string[]; via?: "annotation" | "note"; note?: string } = {}): string {
  desk.assign(session);
  const action = { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind, text: text || undefined, ...extra,
    nodes: nodes.slice(0, 20).map((n) => ({ id: n.id, name: n.name, type: n.type })), more: nodes.length > 20 ? nodes.length - 20 : undefined,
    page: figma.currentPage.name, file: figma.root.name, at: Date.now() };
  noteTask(action.id, session, kind);
  figma.ui.postMessage({ type: "send-action", session, action });
  return action.id;
}

// Tasks written on the canvas (notes.ts): "@Checkout make this responsive" in a text layer (a note) or in an
// annotation goes to that session. Notes are found as text changes arrive; annotations on the selected layers.
const texts = new Map<string, TextNode>(); // text layers written lately that may be notes
function noteText(n: BaseNode | null | undefined) {
  if (!n || n.type !== "TEXT" || n.removed || isOverlayId(n.id)) return;
  texts.delete(n.id); texts.set(n.id, n);
  if (texts.size > 60) texts.delete(texts.keys().next().value!);
}
const AREA = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "GROUP"]);
const areaSize = (n: SceneNode) => { const r = n.absoluteBoundingBox; return r ? r.width * r.height : 0; };
/** What a note is about: the frame it's in (or, on the canvas, the top-level layer under it), and inside that the
 *  smallest part under the note that is at least as big as the note. */
function areaOf(note: TextNode): SceneNode | undefined {
  const b = note.absoluteBoundingBox;
  if (!b) return undefined;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const under = (n: SceneNode) => { const r = n.absoluteBoundingBox; return !!r && cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height; };
  const bySize = (x: SceneNode, y: SceneNode) => areaSize(x) - areaSize(y);
  let box: SceneNode | undefined;
  for (let p = note.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) if (AREA.has(p.type)) { box = p as SceneNode; break; }
  box ??= (pageOf(note)?.children ?? []).filter((n) => n.id !== note.id && !isOverlayId(n.id) && under(n)).sort(bySize)[0];
  if (!box) return undefined;
  const size = b.width * b.height;
  const parts = "findAll" in box ? (box as FrameNode).findAll((n) => n.id !== note.id && AREA.has(n.type) && n.visible && under(n) && areaSize(n) >= size) : [];
  return parts.sort(bySize)[0] ?? box;
}
const notes = new NoteWatch({
  items: () => {
    const out: NoteItem[] = [];
    const sel = figma.currentPage.selection;
    for (const n of sel.slice(0, 20)) {
      noteText(n);
      if ("annotations" in n) n.annotations.forEach((a, i) => { const text = a.labelMarkdown ?? a.label ?? ""; if (text.includes("@")) out.push({ key: `${n.id}#${i}`, kind: "annotation", text, store: n }); });
    }
    for (const [id, t] of texts) {
      if (t.removed || !isNote(t.characters)) { texts.delete(id); continue; }
      out.push({ key: id, kind: "note", text: t.characters, store: t, editing: sel.some((n) => n.id === id) });
    }
    return out;
  },
  sessions: () => desk.sessions,
  send: (session, it, text) => {
    if (it.kind === "annotation") return composeAction(session, "ask", text, [it.store as SceneNode], { via: "annotation" });
    const note = it.store as unknown as TextNode; // a note's store is its text layer
    const area = !note.removed ? areaOf(note) : undefined;
    if (!area) { figma.notify("Put the note on the frame or layer it's about, then edit it to send it again.", { timeout: 6000 }); return null; }
    texts.delete(it.key);
    return composeAction(session, "ask", text, [area], { via: "note", note: note.id });
  },
  write: async (key, kind, was, text) => {
    if (kind === "annotation") {
      const [id] = key.split("#");
      const n = (await figma.getNodeByIdAsync(id)) as (SceneNode & AnnotationsMixin) | null;
      if (!n || n.removed || !("annotations" in n)) return false;
      const list = [...n.annotations], i = list.findIndex((a) => (a.labelMarkdown ?? a.label ?? "") === was);
      if (i < 0) return false;
      const a = list[i];
      list[i] = { ...(a.labelMarkdown !== undefined ? { labelMarkdown: text } : { label: text }), ...(a.properties ? { properties: a.properties } : {}), ...(a.categoryId ? { categoryId: a.categoryId } : {}) };
      n.annotations = list;
      return true;
    }
    const t = await figma.getNodeByIdAsync(key);
    if (!t || t.removed || t.type !== "TEXT" || t.characters !== was || !text.startsWith(was)) return false;
    await Promise.all(t.getRangeAllFontNames(0, t.characters.length).map((f) => figma.loadFontAsync(f)));
    t.insertCharacters(t.characters.length, text.slice(was.length));
    return true;
  },
  notify: (m) => figma.notify(m, { timeout: 6000 }),
  asks: (list) => figma.ui.postMessage({ type: "note-asks", asks: list }),
  now: () => Date.now(),
});
setInterval(() => { try { notes.check(); } catch { /* a layer went away mid-look */ } }, 700);

figma.on("currentpagechange", () => { figma.ui.postMessage({ type: "hello", hello: hello() }); if (!ours()) userActed(); });
figma.on("close", () => cursorsClear());
figma.on("selectionchange", () => { figma.ui.postMessage({ type: "selection", count: figma.currentPage.selection.length }); desk.onSelectionChange(); queueThumb(); if (!ours()) userActed(); });

// A small picture of the selection for the window, so the user sees what they are about to give a session.
const REPO_URL = "https://github.com/shayan-m81/layerwright";
let thumbTimer: ReturnType<typeof setTimeout> | undefined;
let thumbSeq = 0;
function queueThumb() { clearTimeout(thumbTimer); thumbTimer = setTimeout(() => { void sendThumb(); }, 250); }
async function sendThumb() {
  const my = ++thumbSeq;
  const sel = figma.currentPage.selection;
  const node = sel.find((n) => "exportAsync" in n && n.visible !== false && n.width > 0 && n.height > 0);
  if (!node) { figma.ui.postMessage({ type: "thumb", count: sel.length }); return; }
  try {
    // 2× the 296 px the window shows, never more than the layer's own pixels.
    const scale = Math.min(2, 592 / Math.max(node.width, node.height * 1.6, 1));
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: Math.max(0.01, scale) } });
    if (my !== thumbSeq) return; // the selection changed while this one rendered
    figma.ui.postMessage({ type: "thumb", count: sel.length, id: node.id, name: node.name, kind: node.type, w: Math.round(node.width), h: Math.round(node.height), png: figma.base64Encode(bytes) });
  } catch {
    if (my === thumbSeq) figma.ui.postMessage({ type: "thumb", count: sel.length, id: node.id, name: node.name, kind: node.type, w: Math.round(node.width), h: Math.round(node.height) });
  }
}

// Watch for Design System changes (components, component sets, styles) so a stale scan can be flagged.
let dsChanged = false;
const watchingSince = new Date().toISOString();
figma.loadAllPagesAsync().then(() => { removeLeftovers(); figma.on("documentchange", (e) => {
  // The cursors' own drawing isn't a change to the design (and there's a lot of it): leave it out.
  const changes = e.documentChanges.filter((c) => !isOverlayId((c as { id?: string }).id));
  if (!changes.length) return;
  if (!ours() && changes.some((c) => (c as { origin?: string }).origin !== "REMOTE")) userActed(); // the user is editing
  desk.onDocumentChange(changes as { id?: string; origin?: string }[]);
  if (!ours()) for (const c of changes) if (c.type === "CREATE" || (c.type === "PROPERTY_CHANGE" && c.properties.includes("characters"))) noteText(c.node as BaseNode);
  if (dsChanged) return;
  for (const c of changes) {
    const t = (c as { node?: { type?: string } }).node?.type;
    if (c.type.startsWith("STYLE_") || t === "COMPONENT" || t === "COMPONENT_SET") { dsChanged = true; return; }
  }
}); }).catch(() => { /* no watch: status just can't tell */ });
