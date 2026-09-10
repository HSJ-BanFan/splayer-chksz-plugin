import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlugin } from "../test/plugin-host.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(
  projectRoot,
  process.argv[2] ?? "dist/chksz.splayer-source.js",
);

try {
  const sourceText = await readFile(artifactPath, "utf8");
  const { registration, handlers, requests } = loadPlugin({
    sourceText,
    response: {
      status: 200,
      body: { url: "https://cdn.example.test/release-seam.mp3" },
    },
  });
  const actions = ["musicUrl", "musicLyric", "musicPic"];
  const qualities = ["lq", "sq", "hq", "lossless", "hi-res"];

  assert.deepEqual(Object.keys(registration.sources), ["wy", "tx", "kg"]);
  for (const source of Object.values(registration.sources)) {
    assert.deepEqual([...source.actions], actions);
    assert.deepEqual([...source.qualities], qualities);
  }
  assert.equal(registration.settings[0].key, "apiKey");
  assert.equal(typeof handlers.musicUrl, "function");

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hq",
    musicInfo: { id: "release-seam-track" },
  });
  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.pathname, "/api/163_music");
  assert.equal(requestUrl.searchParams.get("id"), "release-seam-track");
  assert.equal(requestUrl.searchParams.get("level"), "exhigh");
  assert.equal(requestUrl.searchParams.get("type"), "json");
  assert.equal(requestUrl.searchParams.get("apikey"), "chksz_test_key");
  assert.equal(result.url, "https://cdn.example.test/release-seam.mp3");
  assert.equal(result.quality, "hq");

  process.stdout.write(`Verified distribution artifact: ${artifactPath}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
