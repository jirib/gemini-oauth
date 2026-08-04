import { chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
if (!existsSync(cli)) {
  console.error("postbuild: dist/cli.js missing — run tsc first");
  process.exit(1);
}
chmodSync(cli, 0o755);
console.log("postbuild: chmod +x dist/cli.js");
