import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL(".vite/manifest.json", dist), "utf8"),
);
// Manifest chunks exclude prebuilt DuckDB workers and WASM assets.
const chunks = Object.entries(manifest).filter(
  ([, chunk]) => chunk.file.endsWith(".js") && (chunk.isEntry || chunk.name),
);
const sizes = new Map(
  await Promise.all(
    chunks.map(async ([key, chunk]) => [
      key,
      (await stat(new URL(chunk.file, dist))).size,
    ]),
  ),
);
const initial = new Set();
function visit(key) {
  if (initial.has(key)) return;
  if (!manifest[key]) throw Error(`Missing manifest entry: ${key}`);
  initial.add(key);
  for (const dependency of manifest[key].imports ?? []) visit(dependency);
}
for (const [key, chunk] of chunks) if (chunk.isEntry) visit(key);
const initialBytes = [...initial].reduce(
  (total, key) => total + (sizes.get(key) ?? 0),
  0,
);
const oversized = chunks.filter(([key]) => sizes.get(key) > 500_000);
console.log(
  `Initial JavaScript: ${(initialBytes / 1000).toFixed(1)} kB (budget: 1,000 kB)`,
);
console.log(
  `Largest JavaScript chunk: ${(Math.max(...sizes.values()) / 1000).toFixed(1)} kB (budget: 500 kB)`,
);
if (!chunks.length || initialBytes > 1_000_000 || oversized.length) {
  for (const [, chunk] of oversized)
    console.error(`Oversized: ${fileURLToPath(new URL(chunk.file, dist))}`);
  process.exitCode = 1;
}
