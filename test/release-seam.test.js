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
const workflowPath = resolve(projectRoot, ".github", "workflows", "ci.yml");

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

test("CI guards the tracked distribution artifact after build", () => {
  const workflow = readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");
  const steps = [
    "run: npm run build",
    "run: git diff --exit-code -- dist/chksz.splayer-source.js",
    "run: npm run check:dist",
    "run: npm run check:artifact",
    "run: npm test",
    "run: npm run check",
  ].map((step) => workflow.indexOf(`        ${step}\n`));

  assert.ok(steps.every((index) => index >= 0));
  assert.ok(steps.every((index, position) => position === 0 || steps[position - 1] < index));
});

test("artifact check loads the built distribution through the shared VM host", () => {
  const result = runScript(artifactScript, distPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /artifact/i);
});
