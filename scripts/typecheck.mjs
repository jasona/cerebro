// Type-checks every workspace package and app with its own tsconfig.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dirs = ["packages", "apps"].flatMap((root) =>
  readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, "tsconfig.json"))),
);
let failed = 0;
for (const dir of dirs) {
  try {
    execFileSync("npx", ["tsc", "-p", join(dir, "tsconfig.json"), "--noEmit"], { stdio: "pipe" });
    console.log(`ok   ${dir}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${dir}\n${e.stdout?.toString() ?? ""}`);
  }
}
process.exit(failed ? 1 : 0);
