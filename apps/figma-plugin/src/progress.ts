// Progress of a long operation. The plugin window shows it (a bar and a label) and forwards it to the server, which
// extends the request's deadline: a big file can take minutes, and that's fine while Figma is still working.
// The cursor of the session doing the work says it too ("building “Hero” · 2/5").
import { cursorProgress } from "./cursor.ts";

export const progress = (label: string, done?: number, total?: number) => {
  try { figma.ui.postMessage({ type: "progress", label, done, total }); } catch { /* no UI */ }
  try { cursorProgress(label, done, total); } catch { /* decoration */ }
};
