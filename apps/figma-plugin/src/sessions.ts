// Several Claude Code / Cursor sessions can share this plugin through the hub. This desk keeps their work apart:
//
// - Selection hand-off. Figma has one selection, and every session would read it as "the layers the user means".
//   With more than one session connected, a session gets the selection only if it is *its* selection: the user
//   gave it to that session in the plugin window, approved the session's request there, or the session's own
//   work selected it (a build, figma_select). A new selection by the user goes to *their* session: the one they last
//   picked in the window (or sent a request to from it, or said yes to), or the one they were using when it was the
//   only one, until they pick another; with several sessions and none of that, nobody (the window asks them to
//   choose). Nothing else moves it. Anything else waits for the user's answer in the window.
// - Conflicts. A change is attributed to the session whose edit was running when it touches what that edit works on
//   (the layers it names, the layers it creates); any other change is the user's. A session that edits a layer
//   another session changed after this one last read it gets a CONFLICT error instead of silently overwriting that
//   work.
// - One edit at a time. Edits from different sessions run one after another, never interleaved.
import type { SessionInfo, StructuredError } from "@cde/core";

/** Requests that change the document (or the selection): run one at a time, attributed to their session. */
export const MUTATING = new Set(["executePlan", "editNodes", "cleanup", "applyTransformations", "importTree", "foundations", "ensurePages", "select"]);

export class DeskError extends Error {
  constructor(public detail: StructuredError) { super(detail.message); }
}

export interface DeskHost {
  selection(): { id: string; name: string }[];
  post(msg: Record<string, unknown>): void;
  progress(label: string): void;
  nodeName(id: string): Promise<string | undefined>;
  /** The selection Layerwright itself set (sorted ids), while it is still the selection (own.ts). */
  ownSelection?(): string[] | null;
  now?(): number;
}

interface Ask { id: string; session: SessionInfo; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; keepalive: ReturnType<typeof setInterval> }

/** Why the selection goes to that session, as the window says it: the user picked it in the window (or sent it a
 *  request from there, or said yes to its ask), it's the session they were using when it was the only one, it's the
 *  only session, or (the selection's owner, never Send to) its own work selected it. */
export type Why = "picked" | "kept" | "only" | "made";

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const ids = (sel: { id: string }[]) => sel.map((n) => n.id).sort();

export class SessionDesk {
  sessions: SessionInfo[] = [];
  /** Who the current selection belongs to, which layers it was when it was given, and why it's that session's. */
  owner: { session: string; ids: string[]; why?: Why } | null = null;
  private expected: string[] | null = null;
  private mutator: string | null = null;
  /** What the running edit works on, and the layers it created: only changes to these are its own. */
  private touch = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private changed = new Map<string, { by: string; at: number }>();
  private seen = new Map<string, Map<string, number>>();
  private asks = new Map<string, Ask>();
  private askSeq = 0;
  /** How long a request waits for the user to give it the selection. */
  askTimeoutMs = 5 * 60_000;
  /** How long an edit keeps its slot after it returns, for Figma's late change events. */
  flushMs = 40;

  constructor(private host: DeskHost) {}

  private now() { return this.host.now?.() ?? Date.now(); }
  shared() { return this.sessions.length > 1; }
  name(id: string) { return this.sessions.find((s) => s.id === id)?.name ?? "another session"; }
  private live(id: string | undefined) { return id ? this.sessions.find((s) => s.id === id) : undefined; }

  /** The user's session: the one they last picked in the window (or sent a request to from it, or said yes to), or
   *  the one they were using when it was the only one. Kept while it's away for a moment (a reconnect, the hub
   *  restarting), so a blip never resets it. */
  private picked: { session: string; why: "picked" | "kept" } | null = null;
  /** The last session that was the only one: when a second joins, the user's session stays the one they were using. */
  private lastOnly: string | null = null;
  /** When a session went missing from the list: what it read is kept through a reconnect (CONFLICT checks). */
  private away = new Map<string, number>();

  /** Who the user's selection and a request from the window go to, and why. One rule, so the window always says who
   *  and why: the only session; else the user's session (picked); else nobody, and the window asks them to choose.
   *  Nothing else moves it: not a session joining or reconnecting (a Claude Code session open in another folder),
   *  not another session's work, not a note on the canvas. */
  choose(): { session?: SessionInfo; why?: Why } {
    if (this.sessions.length === 1) return { session: this.sessions[0], why: "only" };
    const s = this.live(this.picked?.session);
    return s ? { session: s, why: this.picked!.why } : {};
  }

  /** The selection's owner, while that session is connected and the selection is still those layers. */
  private ownerNow(sel = this.host.selection()) {
    return this.owner && sameIds(this.owner.ids, ids(sel)) && this.live(this.owner.session) ? this.owner : null;
  }

  setSessions(list: SessionInfo[]) {
    this.sessions = list;
    const live = new Set(list.map((s) => s.id));
    const now = this.now();
    for (const id of live) this.away.delete(id);
    for (const id of this.seen.keys()) if (!live.has(id) && !this.away.has(id)) this.away.set(id, now);
    for (const [id, at] of this.away) if (now - at > 30 * 60_000) { this.away.delete(id); this.seen.delete(id); } // gone for good
    if (list.length === 1) this.lastOnly = list[0].id;
    else if (list.length > 1 && !this.live(this.picked?.session) && this.live(this.lastOnly ?? undefined)) this.picked = { session: this.lastOnly!, why: "kept" };
    for (const a of [...this.asks.values()]) if (!live.has(a.session.id)) this.finish(a, false);
    this.publish();
  }

  /** What the window needs: who has the selection (`owner`), who a request from the window goes to (`to`, with `why`:
   *  choose), which sessions are waiting for it. The window shows `to` as "Send to" and in the line under it, so the
   *  two always name the session that gets a request. */
  publish() {
    const sel = this.host.selection();
    const owner = this.ownerNow(sel);
    const to = this.choose();
    this.host.post({ type: "desk", count: sel.length, names: sel.slice(0, 3).map((n) => n.name), owner: owner ? owner.session : null,
      to: to.session?.id ?? null, why: to.why ?? null,
      asks: [...this.asks.values()].map((a) => ({ id: a.id, session: a.session.id })) });
  }

  // ---------- selection ----------

  /** `own`: Layerwright made this selection (own.ts). Any other is the user's, even while a session's edit runs. */
  onSelectionChange(own = false) {
    const now = ids(this.host.selection());
    if (this.expected && sameIds(now, this.expected)) this.expected = null; // Layerwright's own selection, already attributed
    else if (own && this.mutator) this.owner = { session: this.mutator, ids: now, why: "made" };
    else if (own) { /* Layerwright's, arriving late: the edit that made it took it when it ended (run) */ }
    else {
      // The user picked something new: it goes to their session (choose), until they give it to another one.
      const to = this.choose();
      this.owner = to.session && now.length ? { session: to.session.id, ids: now, why: to.why } : null;
    }
    this.publish();
  }

  /** The user gave the current selection to a session in the window (Send to, or a request sent from there): it's
   *  their session from now on. */
  assign(sessionId: string) {
    if (!this.live(sessionId)) return;
    this.picked = { session: sessionId, why: "picked" };
    this.owner = { session: sessionId, ids: ids(this.host.selection()), why: "picked" };
    for (const a of [...this.asks.values()]) if (a.session.id === sessionId) this.finish(a, true);
    this.publish();
  }

  answer(askId: string, ok: boolean) {
    const a = this.asks.get(askId);
    if (!a) return;
    if (ok) { this.owner = { session: a.session.id, ids: ids(this.host.selection()), why: "picked" }; this.picked = { session: a.session.id, why: "picked" }; }
    this.finish(a, ok);
    // One answer settles every request that session has waiting.
    if (ok) for (const b of [...this.asks.values()]) if (b.session.id === a.session.id) this.finish(b, true);
    this.publish();
  }

  /** Can this session use the current selection? Waits for the user when it isn't clearly theirs. */
  async claimSelection(session: SessionInfo | undefined): Promise<void> {
    const sel = this.host.selection();
    if (!session || !sel.length) return;
    if (!this.shared()) { this.owner = { session: session.id, ids: ids(sel), why: "only" }; return; }
    if (this.ownerNow(sel)?.session === session.id) return;
    const ok = await this.ask(session);
    if (!ok) {
      throw new DeskError({ type: "SELECTION_NOT_CONFIRMED", message: `Other sessions share this Figma file, and the user didn't give the current selection to this session ("${session.name}"). Ask the user which layers to work on, or to select them and choose "${session.name}" in the Layerwright window; or use node ids.` });
    }
  }

  private ask(session: SessionInfo): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `a${++this.askSeq}`;
      const label = `Waiting for you: "${session.name}" asks for your selection in the Layerwright window`;
      this.host.progress(label);
      const a: Ask = { id, session, resolve,
        timer: setTimeout(() => this.finish(a, false), this.askTimeoutMs),
        keepalive: setInterval(() => this.host.progress(label), 15_000) }; // keeps the request's deadline alive
      this.asks.set(id, a);
      this.publish();
    });
  }

  private finish(a: Ask, ok: boolean) {
    if (!this.asks.delete(a.id)) return;
    clearTimeout(a.timer);
    clearInterval(a.keepalive);
    a.resolve(ok);
    this.publish();
  }

  /** figma_status for one session: the selection's ids only when it's theirs. */
  pingInfo(session: SessionInfo | undefined, selection: { id: string; name: string; type: string }[]) {
    if (!session || !this.shared() || !selection.length) return { selection };
    const owner = this.ownerNow(selection);
    if (owner?.session === session.id) return { selection, selectionOwner: "this session" };
    return { selection: undefined, selectionCount: selection.length, selectionOwner: owner ? this.name(owner.session) : "nobody yet",
      selectionNote: "This selection isn't this session's. Don't act on it: ask the user, or call figma_inspect (target 'selection') to ask them in the Layerwright window." };
  }

  // ---------- requests ----------

  /** Run one request: edits one at a time with conflict checks, reads right away. */
  run<T>(method: string, params: any, session: SessionInfo | undefined, fn: () => Promise<T>): Promise<T> {
    if (!MUTATING.has(method)) {
      const at = this.now();
      return fn().then((r) => { if (session) this.markSeen(session.id, method, params, r, at); return r; });
    }
    const go = async () => {
      if (session) await this.checkConflicts(session, method, params);
      const before = ids(this.host.selection());
      this.mutator = session?.id ?? null;
      this.touch = new Set(targets(method, params));
      try { return await fn(); } finally {
        // Figma reports document and selection changes asynchronously: let them arrive while this session still
        // owns the slot, so they're attributed to it and not to the user.
        await new Promise((r) => setTimeout(r, this.flushMs));
        const after = ids(this.host.selection());
        // The selection is the session's only when its own request set it, not when the user picked something meanwhile.
        const set = this.host.ownSelection?.();
        // A select request selects on purpose: it counts even when those layers were already selected (no change).
        if (session && set && sameIds(set, after) && (method === "select" || !sameIds(before, after))) { this.owner = { session: session.id, ids: after, why: "made" }; this.expected = after; this.publish(); }
        this.mutator = null;
        this.touch = new Set();
      }
    };
    const run = this.chain.then(go, go);
    this.chain = run.catch(() => {});
    return run;
  }

  /** Figma's documentchange: remember who changed what. Figma can't tell this plugin's changes from the user's (both
   *  are LOCAL), so a running edit is credited only with what it works on and what it creates; the rest is the user's. */
  onDocumentChange(changes: { id?: string; origin?: string; type?: string }[]) {
    const at = this.now();
    for (const c of changes) {
      if (!c.id) continue;
      const m = c.origin === "REMOTE" ? null : this.mutator;
      if (m && c.type === "CREATE") this.touch.add(c.id);
      this.changed.set(c.id, { by: m && this.touch.has(c.id) ? m : "user", at });
    }
    if (this.changed.size > 50_000) for (const k of [...this.changed.keys()].slice(0, 10_000)) this.changed.delete(k);
  }

  private markSeen(session: string, method: string, params: any, result: any, at: number) {
    const m = this.seen.get(session) ?? new Map<string, number>();
    this.seen.set(session, m);
    if (method === "exportImage" && params?.nodeId) m.set(String(params.nodeId), at);
    const walk = (n: any) => { if (!n || typeof n !== "object") return; if (typeof n.id === "string") m.set(n.id, at); if (Array.isArray(n.children)) n.children.forEach(walk); };
    if (method === "inspect" && Array.isArray(result?.nodes)) result.nodes.forEach(walk);
  }

  private async checkConflicts(session: SessionInfo, method: string, params: any) {
    const seen = this.seen.get(session.id);
    const hits: { id: string; by: string; at: number }[] = [];
    for (const id of targets(method, params)) {
      const c = this.changed.get(id);
      if (!c || c.by === session.id || c.by === "user") continue;
      if (c.at > (seen?.get(id) ?? session.connectedAt)) hits.push({ id, ...c });
    }
    if (!hits.length) return;
    const lines = await Promise.all(hits.slice(0, 3).map(async (h) => `"${(await this.host.nodeName(h.id)) ?? h.id}" (${h.id}) was changed by session "${this.name(h.by)}" ${Math.max(1, Math.round((this.now() - h.at) / 1000))}s ago`));
    throw new DeskError({ type: "CONFLICT", message: `${lines.join("; ")}${hits.length > 3 ? ` (+${hits.length - 3} more)` : ""}, after this session last read it. Nothing was changed. Inspect it again (figma_inspect) and redo the change on top of the current state, or ask the user.`, nodeIds: hits.map((h) => h.id) });
  }
}

/** The existing layers a request edits. New layers and parents that only receive children don't count. */
export function targets(method: string, p: any): string[] {
  const out = new Set<string>();
  const add = (r: unknown) => { if (typeof r === "string" && r && !r.startsWith("$")) out.add(r); };
  if (method === "editNodes") for (const op of p?.ops ?? []) { add(op?.node); for (const n of op?.nodes ?? []) add(n); }
  if (method === "applyTransformations") for (const t of p?.transformations ?? []) add(t?.nodeId);
  return [...out];
}
