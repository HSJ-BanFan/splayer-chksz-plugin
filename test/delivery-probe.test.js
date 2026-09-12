import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

const UNAVAILABLE = {
  status: 404,
  body: { msg: "Music URL not found, song may be unavailable at this quality level" },
};
const TRACK = { id: "22831636", name: "My jealousy (Original ver.)", singer: "DJMAX", interval: "02:33" };
const song = () => ({ source: "wy", quality: "hi-res", musicInfo: TRACK });

const STREAMABLE = { status: 206, body: new Uint8Array([0x66, 0x4c, 0x61, 0x43]) };
const BLOCKED = { status: 403, body: new Uint8Array(0) };
const apiOk = (level) => ({
  status: 200,
  body: { code: 200, data: { url: `https://cdn.example.test/${level}.flac`, level, br: 5667204 } },
});
const requestedLevels = (host) =>
  host.requests.map(({ url }) => new URL(url).searchParams.get("level"));

test("falls to the next tier when the returned address cannot be streamed", async () => {
  const host = loadPlugin({
    response: (url) => apiOk(url.searchParams.get("level")),
    probeResponse: (url) => (url.pathname === "/jymaster.flac" ? BLOCKED : STREAMABLE),
  });

  const result = await host.handlers.musicUrl(song());

  assert.deepEqual(
    requestedLevels(host),
    ["jymaster", "hires"],
    "母带档地址不可用时必须继续降级",
  );
  assert.equal(result.url, "https://cdn.example.test/hires.flac");
  assert.deepEqual(
    host.deliveryProbes.map(({ options }) => ({ range: options.headers.Range, responseType: options.responseType })),
    [
      { range: "bytes=0-3", responseType: "arraybuffer" },
      { range: "bytes=0-3", responseType: "arraybuffer" },
    ],
  );
});

test("keeps the first tier when its address streams", async () => {
  const host = loadPlugin({ response: (url) => apiOk(url.searchParams.get("level")) });

  const result = await host.handlers.musicUrl(song());

  assert.equal(result.url, "https://cdn.example.test/jymaster.flac");
  assert.equal(host.requests.length, 1);
  assert.equal(host.deliveryProbes.length, 1);
});

test("reuses a probed address result instead of probing it again", async () => {
  const host = loadPlugin({ response: (url) => apiOk(url.searchParams.get("level")) });

  await host.handlers.musicUrl(song());
  await host.handlers.musicUrl(song());

  assert.equal(host.deliveryProbes.length, 1, "同一个地址只探测一次");
});

test("skips probing entirely when delivery verification is turned off", async () => {
  const host = loadPlugin({
    settings: { verifyDelivery: false },
    response: (url) => apiOk(url.searchParams.get("level")),
  });

  const result = await host.handlers.musicUrl(song());

  assert.equal(result.url, "https://cdn.example.test/jymaster.flac");
  assert.equal(host.deliveryProbes.length, 0);
});

test("keeps the tier when the host cannot run the probe at all", async () => {
  const host = loadPlugin({
    response: (url) => apiOk(url.searchParams.get("level")),
    probeResponse: () => {
      const error = new Error("host does not support arraybuffer responses");
      error.code = "PLUGIN_BAD_REQUEST";
      throw error;
    },
  });

  const result = await host.handlers.musicUrl(song());

  assert.equal(result.url, "https://cdn.example.test/jymaster.flac", "探测能力缺失不能导致降级");
  assert.equal(host.requests.length, 1);
});

test("treats an unreachable address as unusable and moves on", async () => {
  const host = loadPlugin({
    response: (url) => apiOk(url.searchParams.get("level")),
    probeResponse: () => {
      const error = new Error("request timeout");
      error.code = "PLUGIN_REQUEST_TIMEOUT";
      throw error;
    },
  });

  await assert.rejects(
    host.handlers.musicUrl(song()),
    (error) => error.code === "CHKSZ_DELIVERY_UNUSABLE" && /打不开/.test(error.message),
  );
  assert.equal(host.requests.length, 5, "整条阶梯都要体检一遍后才放弃");
});

test("does not cross-search when the primary platform delivery fails", async () => {
  const host = loadPlugin({
    response: (url) => (url.pathname === "/api/163_music" ? apiOk(url.searchParams.get("level")) : UNAVAILABLE),
    probeResponse: BLOCKED,
  });

  await assert.rejects(
    host.handlers.musicUrl(song()),
    (error) => error.code === "CHKSZ_DELIVERY_UNUSABLE",
  );
  assert.ok(
    !host.requests.some(({ url }) => new URL(url).pathname !== "/api/163_music"),
    "地址不可用不是版权问题，不该触发跨平台兜底",
  );
});
