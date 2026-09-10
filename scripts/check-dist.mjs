import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [sourceArg, distArg] = process.argv.slice(2);
const sourcePath = resolve(projectRoot, sourceArg ?? "src/plugin.js");
const distPath = resolve(projectRoot, distArg ?? "dist/chksz.splayer-source.js");

try {
  const [source, dist] = await Promise.all([readFile(sourcePath), readFile(distPath)]);
  if (!source.equals(dist)) {
    throw new Error(`Distribution artifact differs from source:\nsource: ${sourcePath}\ndist: ${distPath}`);
  }
  process.stdout.write(`Verified byte parity: ${sourcePath} == ${distPath}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
