import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

const QUALITY_CASES = [
  ["lq", { wy: "standard", tx: "128k", kg: "128k" }],
  ["sq", { wy: "exhigh", tx: "320k", kg: "320k" }],
  ["hq", { wy: "exhigh", tx: "320k", kg: "320k" }],
  ["lossless", { wy: "lossless", tx: "flac", kg: "flac" }],
  ["hi-res", { wy: "jymaster", tx: "master", kg: "master" }],
];

const SOURCES = [
  {
    source: "wy",
    path: "/api/163_music",
    idParameter: "id",
    id: "wy-track-1",
    musicInfo: { id: "wy-track-1", songmid: "wrong-qq-mid", songId: "wrong-song-id" },
  },
  {
    source: "tx",
    path: "/api/qq_music",
    idParameter: "mid",
    id: "tx-mid-1",
    musicInfo: { mid: "tx-mid-1", id: "wrong-generic-id", songId: "wrong-song-id" },
  },
  {
    source: "kg",
    path: "/api/kugou_music",
    idParameter: "id",
    id: "kg-hash-1",
    musicInfo: { id: "wrong-generic-id", hash: "kg-hash-1", songmid: "wrong-qq-mid" },
  },
];

test("routes every source and requested quality to its documented ChKSz parameter", async () => {
  for (const source of SOURCES) {
    for (const [quality, nativeValues] of QUALITY_CASES) {
      const { handlers, requests } = loadPlugin({
        response: {
          status: 200,
          body: { code: 200, url: `https://cdn.example.test/${source.source}-${quality}.mp3` },
        },
      });

      await handlers.musicUrl({
        source: source.source,
        quality,
        musicInfo: source.musicInfo,
      });

      const requestUrl = new URL(requests[0].url);
      assert.equal(requestUrl.pathname, source.path, `${source.source}/${quality}`);
      assert.equal(requestUrl.searchParams.get(source.idParameter), source.id, `${source.source}/${quality}`);
      assert.equal(
        requestUrl.searchParams.get(source.source === "wy" ? "level" : "size"),
        nativeValues[source.source],
        `${source.source}/${quality}`,
      );
    }
  }
});

test("keeps a multi-artist track playable when its primary channel is unavailable", async () => {
  const { handlers } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/kugou_music") {
        return { status: 504, body: { msg: "upstream timeout" } };
      }
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            list: [
              {
                name: "爱你没差",
                singer: "周杰伦/方文山",
                mid: "qq-multi-artist",
              },
            ],
          },
        };
      }
      return {
        status: 200,
        body: {
          code: 200,
          name: "爱你没差",
          singer: "周杰伦/方文山",
          interval: "04:40",
          url: "https://qq.example.test/ai-ni-mei-cha.flac",
        },
      };
    },
  });

  const result = await handlers.musicUrl({
    source: "kg",
    quality: "lossless",
    musicInfo: {
      source: "kg",
      id: "kg-ai-ni-mei-cha",
      name: "爱你没差",
      singer: "周杰伦/方文山",
      interval: "04:40",
    },
  });

  assert.equal(result.url, "https://qq.example.test/ai-ni-mei-cha.flac");
  assert.equal(result.quality, "lossless");
});
