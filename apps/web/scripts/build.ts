// Usage: bun run --cwd apps/web build [--replay <path.jsonl|json>]
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const ri = process.argv.indexOf("--replay");
let replay = "";
if (ri > 0 && process.argv[ri + 1]) {
  const arg = process.argv[ri + 1]!;
  const cands = [resolve(process.env.INIT_CWD ?? process.cwd(), arg), resolve(process.cwd(), arg), resolve(root, "../..", arg)];
  const p = cands.find((c) => existsSync(c)) ?? cands[0]!;
  const t = readFileSync(p, "utf8").trim();
  const evs = t.startsWith("[") ? JSON.parse(t) : t.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  replay = `<script>window.__BLOCKWISE_REPLAY__=${JSON.stringify(evs).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")};</script>`;
  console.log(`replay: ${evs.length} events from ${p}`);
}
const r = await Bun.build({ entrypoints: [resolve(root, "src/main.tsx")], minify: true, target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1); }
const js = (await r.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script");
const css = readFileSync(resolve(root, "src/style.css"), "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blockwise</title><style>${css}</style></head><body><div id="root"></div>${replay}<script>${js}</script></body></html>`;
const out = resolve(root, "dist/index.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KiB)`);
