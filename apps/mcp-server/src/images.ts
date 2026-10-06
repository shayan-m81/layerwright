// Image sources are resolved here, in Node, so the Figma plugin never needs network access to
// arbitrary hosts. https URLs become data: URLs; failures leave the placeholder and add a warning.
import type { ResolvedNode, ResolvedPlan } from "@cde/core";

const MAX_BYTES = 10 * 1024 * 1024;

export async function inlineImages(plan: ResolvedPlan, fetcher: typeof fetch = fetch): Promise<{ plan: ResolvedPlan; warnings: string[] }> {
  const warnings: string[] = [];
  const cache = new Map<string, string | null>();
  const load = async (url: string): Promise<string | null> => {
    if (cache.has(url)) return cache.get(url)!;
    let out: string | null = null;
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(15_000) });
      const type = res.headers.get("content-type")?.split(";")[0] ?? "";
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!/^image\/(png|jpe?g|gif)$/.test(type)) throw new Error(`unsupported content-type "${type || "none"}" (Figma accepts PNG, JPEG, GIF)`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error(`image is ${(buf.length / 1e6).toFixed(1)} MB (limit 10 MB)`);
      out = `data:${type};base64,${buf.toString("base64")}`;
    } catch (e) {
      warnings.push(`Image ${url} could not be fetched (${(e as Error).message}); a placeholder is used.`);
    }
    cache.set(url, out);
    return out;
  };
  const walk = async (n: ResolvedNode): Promise<ResolvedNode> => {
    if (n.kind === "rect" && n.src?.startsWith("https://")) {
      const data = await load(n.src);
      return data ? { ...n, src: data } : { ...n, src: undefined };
    }
    if (n.kind === "frame") return { ...n, children: await Promise.all(n.children.map(walk)) };
    return n;
  };
  // Nodes inserted into existing frames (inserts) carry images too.
  const inserts = plan.inserts && await Promise.all(plan.inserts.map(async (x) => ({ ...x, roots: await Promise.all(x.roots.map(walk)) })));
  return { plan: { ...plan, roots: await Promise.all(plan.roots.map(walk)), ...(inserts ? { inserts } : {}) }, warnings };
}
