#!/usr/bin/env node
/**
 * Copy whole packages (and their installed dependency closure) from a full
 * node_modules tree into the Next.js standalone output.
 *
 * `output: "standalone"` keeps only the files that output file tracing can
 * see. Some server-external packages load files it cannot see:
 *
 * - tesseract.js starts a worker thread from a path and that worker requires
 *   `tesseract.js-core` (WASM) by a computed name;
 * - the OCR language data (`@tesseract.js-data/eng/4.0.0_best_int`) is a
 *   directory chosen at runtime;
 * - an AI SDK provider (`CEREBRO_AI_SDK_MODULE`, any installed `@ai-sdk/*`)
 *   is imported by a name read from the environment.
 *
 * Usage: node copy-runtime-packages.mjs <source root> <standalone root> <pkg>... [--scope @ai-sdk]
 * Packages that are not installed are skipped (optional platform builds).
 */
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [srcRoot, destRoot, ...rest] = process.argv.slice(2);
if (!srcRoot || !destRoot) {
  console.error("Usage: copy-runtime-packages.mjs <source root> <standalone root> <pkg>... [--scope <@scope>]");
  process.exit(1);
}

const names = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--scope") {
    const scope = rest[++i];
    const dir = join(srcRoot, "node_modules", scope);
    if (existsSync(dir)) for (const entry of readdirSync(dir)) names.push(`${scope}/${entry}`);
  } else {
    names.push(rest[i]);
  }
}

/** Node's lookup: `<from>/node_modules/<name>`, then each ancestor up to the source root. */
function locate(name, from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === srcRoot || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

const seen = new Set();
const queue = names.map((name) => ({ name, from: srcRoot }));
let copied = 0;
while (queue.length) {
  const { name, from } = queue.shift();
  const dir = locate(name, from);
  if (!dir || seen.has(dir)) continue;
  seen.add(dir);
  cpSync(dir, join(destRoot, relative(srcRoot, dir)), { recursive: true, dereference: true });
  copied++;
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
    queue.push({ name: dep, from: dir });
  }
}
console.log(`copy-runtime-packages: copied ${copied} packages for ${names.join(", ") || "(none)"}`);
