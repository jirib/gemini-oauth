import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });

for (const entry of readdirSync(root)) {
  if (entry.endsWith(".tgz")) {
    rmSync(join(root, entry), { force: true });
  }
}
