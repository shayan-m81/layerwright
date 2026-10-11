// Undo steps. Every request that changes the document is one undo step of its own: while it runs, commits are held
// (the handlers end with commitUndo(), which then only asks for one), and code.ts closes the step once the request is
// over.
//
// The AI cursors (cursor.ts) are layers too, and they stay on the canvas for as long as their session works, across
// steps. So every step is closed the same way: the cursors come off the canvas, the step is committed, and they are
// drawn again where they were, all in the same moment (nothing flickers). Their comings and goings cancel out within
// each step, so no step holds any of them and an undo or redo never brings one back.
//
// What Layerwright writes outside any request (what a note on the canvas remembers, a session's answer under it) is
// a step of its own too. While a request runs it waits for that request's step to close, so it never merges into it.
import { cursorsStash } from "./cursor.ts";

let held = false;
let wanted = false;
const later: (() => boolean | void)[] = [];
let queued = false;

/** Close the step, without any AI cursor in it. */
function commit() {
  const back = cursorsStash();
  try { figma.commitUndo(); } finally { back(); }
}

/** Close the current undo step now, or, while a request runs, when it ends. */
export function commitUndo() {
  if (held) wanted = true;
  else commit();
}

/** code.ts: a request that changes the document starts (the desk runs them one at a time). */
export function holdUndo() { held = true; wanted = false; }

/** code.ts: the request is over: close its step if it made one, then do what waited. */
export function releaseUndo() {
  held = false;
  if (wanted) { wanted = false; commit(); }
  flush();
}

/** Write outside any request, as one undo step (writes in the same moment share it). `fn` returns false when it
 *  wrote nothing after all. While a request runs, the write waits for it. */
export function ownStep(fn: () => boolean | void) {
  later.push(fn);
  if (!held && !queued) { queued = true; void Promise.resolve().then(flush); }
}

function flush() {
  queued = false;
  if (held || !later.length) return;
  let wrote = false;
  for (const fn of later.splice(0)) { try { if (fn() !== false) wrote = true; } catch { /* the layer went away */ } }
  if (wrote) commit();
}
