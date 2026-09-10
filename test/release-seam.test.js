import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(projectRoot, "src", "plugin.js");
const distPath = resolve(projectRoot, "dist", "chksz.splayer-source.js");
const parityScript = resolve(projectRoot, "scripts", "check-dist.mjs");
const artifactScript = resolve(projectRoot, "scripts", "check-artifact.mjs");

const runScript = (script, ...args) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
  });

test("parity check accepts identical bytes and rejects a stale artifact", () => {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "splayer-release-seam-"));
  const tempSourcePath = resolve(tempRoot, "src.js");
  const tempDistPath = resolve(tempRoot, "dist.js");

  try {
    const sourceText = readFileSync(sourcePath);
    writeFileSync(tempSourcePath, sourceText);
    writeFileSync(tempDistPath, sourceText);

    const matching = runScript(parityScript, tempSourcePath, tempDistPath);
    assert.equal(matching.status, 0, matching.stderr);

    writeFileSync(tempDistPath, Buffer.concat([sourceText, Buffer.from("\n")]));
    const stale = runScript(parityScript, tempSourcePath, tempDistPath);
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /differs/i);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("artifact check loads the built distribution through the shared VM host", () => {
  const result = runScript(artifactScript, distPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /artifact/i);
});
