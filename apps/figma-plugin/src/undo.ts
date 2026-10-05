// Undo steps. Every change a request makes lands in one undo step; the handlers end with commitUndo(). While AI
// cursors are on the canvas (cursor.ts) that commit is held: at the end of the request the cursors are taken off,
// the step is committed, and they are drawn again. So every committed step holds the change and nothing of the
// cursors (an undo never brings one back), and the cursors' own comings and goings cancel out.

let deferring = false;
let wanted = false;

/** Close the current undo step now, or, while cursors are drawn, at the end of the request. */
export function commitUndo() {
  if (deferring) wanted = true;
  else figma.commitUndo();
}

/** cursor.ts: hold commits while any cursor is on the canvas. */
export function setDeferring(on: boolean) { deferring = on; }

/** cursor.ts: did a handler ask for a commit since the last one? (and forget the request) */
export function takeCommitRequest(): boolean {
  const w = wanted;
  wanted = false;
  return w;
}
