import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "src", "plugin.js");
const output = resolve(projectRoot, "dist", "chksz.splayer-source.js");

await mkdir(dirname(output), { recursive: true });
await copyFile(source, output);
console.log(`Built ${output}`);
