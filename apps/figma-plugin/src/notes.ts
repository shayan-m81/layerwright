// Tasks written on the canvas: the user writes "@Checkout make this one responsive" and that session gets the request,
// as if it were sent from the window about those layers, and the window follows it in Activity. When the session is
// done, its answer is added under what the user wrote. Two places to write it:
// - a note: a text layer that starts with "@session", on or inside the frame it's about (any plan, the free one too);
// - an annotation on a layer (paid plans, where Figma has annotations).
// Plugins can't read Figma comments, so these are the way in.
//
// A note or annotation goes once it has stayed the same for a moment, so it isn't sent half-typed (a note still being
// edited waits longer). What was sent is remembered on the layer (plugin data), so it isn't sent twice, by this window
// or another user's; editing it sends it again. The host finds them: notes as the user's own text changes arrive (never
// a collaborator's, never what Layerwright wrote), annotations as the user writes them on the selected layers (their
// edits don't arrive as document changes).
//
// Text that only looks like a note ("@john_doe followed you" in a design) stays the user's: an @name that is no
// session's and none of the words for "any session" is offered in the window for a moment, and nothing is written to
// the layer or said in Figma.

export interface Mentionable { id: string; name?: string }
/** The layer that remembers what was sent from it. */
export interface Store { getPluginData(key: string): string; setPluginData(key: string, value: string): void }
export interface NoteItem {
  /** Where it is: "5:6" (a note) or "1:2#0" (a layer's first annotation). */
  key: string;
  kind: "note" | "annotation";
  text: string;
  store: Store;
  /** The user is still on it (a selected note): it waits longer before it goes. */
  editing?: boolean;
}
export interface NoteHost {
  items(): NoteItem[];
  sessions(): Mentionable[];
  /** Send it to the session; returns the request id, or null when it can't go (the host said why). */
  send(session: string, item: NoteItem, text: string): string | null;
  /** Replace the text of what's at `key` if it still reads `was`; `mark` runs in the same write, just before. */
  write(key: string, kind: NoteItem["kind"], was: string, text: string, mark: () => void): Promise<boolean>;
  /** Write to the file outside any request, as an undo step of its own (undo.ts ownStep). */
  step(fn: () => void): void;
  notify(message: string): void;
  /** The notes waiting for the user to pick a session (the name after @ isn't one): the window shows them. */
  asks(list: NoteAsk[]): void;
  now(): number;
}
/** A note whose @name isn't a session: the user picks the session in the window, or lets it go. `quiet`: the name is
 *  no session's and not a word for one, so it may well not be a note at all: a low-key card that goes by itself. */
export interface NoteAsk { key: string; text: string; name: string; quiet?: boolean }

const DATA = "layerwrightNotes";
/** Names that mean "whichever session there is" when only one is connected. */
const ANY = ["layerwright", "claude", "codex", "ai"];
/** The answers added under a note start with this, so they aren't read as part of the task. */
export const REPLY = "↳ ";

/** A short fingerprint of a text (FNV-1a). */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const forms = (name: string) => { const n = name.trim().toLowerCase(); return [...new Set([n, n.replace(/\s+/g, "-"), n.replace(/\s+/g, "_"), n.replace(/\s+/g, "")])].filter(Boolean); };
const endsWord = (s: string, at: number) => at >= s.length || !/[\p{L}\p{N}_]/u.test(s[at]);

/** A text layer may be a note when it starts with "@" (findMention decides). */
export const isNote = (text: string) => text.trimStart().startsWith("@");

/** "@Checkout redesign make it responsive" → that session and "make it responsive". The longest session name that
 *  follows an @ wins ("@Checkout redesign" over "@Checkout"); @layerwright, @claude… mean the only session there is
 *  (with several, or none, they are `generic`: the user picks the session). */
export function findMention(label: string, sessions: Mentionable[]): { session: Mentionable; text: string } | { unknown: string; text: string; generic?: boolean } | null {
  const body = label.split("\n").filter((l) => !l.trimStart().startsWith(REPLY.trim())).join("\n");
  const lower = body.toLowerCase();
  let best: { session: Mentionable; from: number; to: number } | null = null;
  let unknown = "", unknownAt = -1;
  for (let i = lower.indexOf("@"); i >= 0; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && !/\s|[(«"']/.test(lower[i - 1])) continue; // an email address, not a mention
    const rest = lower.slice(i + 1);
    for (const s of sessions) for (const f of forms(s.name ?? "")) {
      if (rest.startsWith(f) && endsWord(rest, f.length) && (!best || f.length > best.to - best.from - 1)) best = { session: s, from: i, to: i + 1 + f.length };
    }
    const word = /^[\p{L}\p{N}_-]+/u.exec(rest)?.[0] ?? "";
    if (!best && ANY.includes(word)) {
      if (sessions.length === 1) best = { session: sessions[0], from: i, to: i + 1 + word.length };
      else if (!unknown) { unknown = word; unknownAt = i; }
    } else if (!best && word && !unknown) { unknown = word; unknownAt = i; }
  }
  const cut = (from: number, to: number) => (body.slice(0, from) + body.slice(to)).replace(/^[\s,:،-]+/, "").replace(/\s+$/, "");
  if (!best) return unknown ? { unknown, text: cut(unknownAt, unknownAt + 1 + unknown.length), ...(ANY.includes(unknown) ? { generic: true } : {}) } : null;
  return { session: best.session, text: cut(best.from, best.to) };
}

export class NoteWatch {
  /** How long a note stays unchanged before it goes; one the user is still on waits `editingMs`; how long a card for
   *  an @name that is no session's stays in the window. */
  stableMs = 2000;
  editingMs = 6000;
  quietMs = 45_000;
  private seen = new Map<string, { text: string; since: number }>();
  private asked = new Map<string, { key: string; kind: NoteItem["kind"]; text: string; session: string; store: Store }>(); // request id → its note
  private pending = new Map<string, NoteAsk & { item: NoteItem; label: string; at: number }>(); // note key → waiting for a session
  /** Texts already settled in this window (sent, let go, not a note): the plugin data on the layer may still be on its
   *  way (it waits for a running request), and what isn't a note is remembered here only, never on the layer. */
  private settled = new Set<string>();
  constructor(private host: NoteHost) {}

  private done(s: Store): string[] { try { const v = JSON.parse(s.getPluginData(DATA) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
  private rememberNow(s: Store, text: string) { s.setPluginData(DATA, JSON.stringify([...this.done(s), hash(text)].slice(-30))); }
  /** Sent (or let go): remembered on the layer, for every window. */
  private remember(it: { key: string; store: Store }, text: string) { this.settle(it.key, text); this.host.step(() => this.rememberNow(it.store, text)); }
  /** Remembered in this window only. */
  private settle(key: string, text: string) {
    this.settled.add(`${key}\n${hash(text)}`);
    if (this.settled.size > 500) this.settled.delete(this.settled.values().next().value!);
  }
  private isSettled(it: NoteItem, label: string) { return this.settled.has(`${it.key}\n${hash(label)}`) || this.done(it.store).includes(hash(label)); }

  /** Look at the notes and annotations the host found: send the ones that name a session and have stopped changing. */
  check() {
    const now = this.host.now();
    this.expire(now);
    for (const it of this.host.items()) {
      const label = it.text;
      if (!label.includes("@") || this.isSettled(it, label)) continue;
      if (this.pending.get(it.key)?.label === label) continue; // already waiting for the user's pick
      const s = this.seen.get(it.key);
      if (!s || s.text !== label) { this.seen.set(it.key, { text: label, since: now }); continue; }
      if (now - s.since < (it.editing ? this.editingMs : this.stableMs)) continue;
      this.seen.delete(it.key);
      const m = findMention(label, this.host.sessions());
      if (!m) { this.settle(it.key, label); continue; } // an @ that mentions nobody: not a note, and the layer stays as it is
      const quiet = "unknown" in m && !m.generic;
      if (!m.text) {
        this.settle(it.key, label);
        if (!quiet) { this.remember(it, label); this.host.notify(`Write what @${"unknown" in m ? m.unknown : m.session.name ?? "the session"} should do after the name.`); }
        continue;
      }
      if ("unknown" in m) {
        // Not a session's name: it waits in the window until the user picks the session (or lets it go).
        this.pending.set(it.key, { key: it.key, text: m.text, name: m.unknown, quiet: quiet || undefined, item: it, label, at: now });
        this.publish();
        continue;
      }
      this.remember(it, label);
      this.pending.delete(it.key);
      this.dispatch(m.session, it, label, m.text);
    }
  }

  /** A quiet card goes by itself after a while; the text stays as it is, and comes back only when edited. */
  private expire(now: number) {
    let gone = false;
    for (const [k, p] of this.pending) if (p.quiet && now - p.at >= this.quietMs) { this.pending.delete(k); this.settle(k, p.label); gone = true; }
    if (gone) this.publish();
  }

  private dispatch(s: Mentionable, it: NoteItem, label: string, text: string) {
    const id = this.host.send(s.id, it, text);
    if (id) this.asked.set(id, { key: it.key, kind: it.kind, text: label, session: s.name ?? "Claude", store: it.store });
  }
  private publish() { this.host.asks([...this.pending.values()].map(({ key, text, name, quiet }) => ({ key, text, name, ...(quiet ? { quiet } : {}) }))); }

  /** The user picked the session for a waiting note in the window. */
  sendTo(key: string, session: string) {
    const p = this.pending.get(key), s = this.host.sessions().find((x) => x.id === session);
    if (!p || !s) return;
    this.pending.delete(key);
    this.remember(p.item, p.label);
    this.publish();
    this.dispatch(s, p.item, p.label, p.text);
  }
  /** The user let a waiting note go: it stays on the canvas, and goes again only when they edit it. */
  dismiss(key: string) {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    if (p.quiet) this.settle(key, p.label); // probably not a note at all: nothing is written to the layer
    else this.remember(p.item, p.label);
    this.publish();
  }

  /** The session finished a request from a note: its answer goes under it. */
  async finished(id: string, status: string, message?: string) {
    const a = this.asked.get(id);
    if (!a || (status !== "done" && status !== "failed" && status !== "stopped")) return;
    this.asked.delete(id);
    if (status === "stopped") return;
    const said = (message ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const text = `${a.text}\n${a.kind === "annotation" ? "\n" : ""}${REPLY}${a.session}: ${status === "done" ? `✓ ${said || "done"}` : `✗ ${said || "couldn't do it"}`}`;
    // Remembered first, in the same write: the written answer arrives as a change to the note, and mustn't send it again.
    this.settle(a.key, text);
    await this.host.write(a.key, a.kind, a.text, text, () => this.rememberNow(a.store, text)).catch(() => false); // false: the user changed it meanwhile, theirs stays
  }
}
