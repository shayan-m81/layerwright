// Undo steps. Every request that changes the document is one undo step of its own: while it runs, commits are held
// (the handlers end with commitUndo(), which then only asks for one), and code.ts closes the step once the request is
// over and its AI cursor is erased (cursor.ts). The cursor lives only inside that step, drawn after it opens and
// erased before it closes, so its comings and goings cancel out and an undo or redo never brings one back.
//
// What Layerwright writes outside any request (what a note on the canvas remembers, a session's answer under it) is
// a step of its own too. While a request runs it waits for that request's step to close, so it never merges into it.

let held = false;
let wanted = false;
const later: (() => boolean | void)[] = [];
let queued = false;

/** Close the current undo step now, or, while a request runs, when it ends. */
export function commitUndo() {
  if (held) wanted = true;
  else figma.commitUndo();
}

/** code.ts: a request that changes the document starts (the desk runs them one at a time). */
export function holdUndo() { held = true; wanted = false; }

/** code.ts: the request is over and its cursor is erased: close its step if it made one, then do what waited. */
export function releaseUndo() {
  held = false;
  if (wanted) { wanted = false; figma.commitUndo(); }
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
  if (wrote) figma.commitUndo();
}
