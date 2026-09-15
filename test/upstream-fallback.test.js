import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

const UNAVAILABLE = {
  status: 404,
  body: { msg: "Music URL not found, song may be unavailable at this quality level" },
};

const describeRequest = (request) => {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  delete params.apikey;
  return { path: url.pathname, params };
};

test("falls back from a Kugou upstream failure to a matching QQ mid", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/kugou_music") {
        return { status: 502, body: { msg: "upstream unavailable" } };
      }
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            count: 1,
            list: [
              { n: 1, name: "晴天", singer: "周杰伦", mid: "qq-mid-1" },
            ],
          },
        };
      }
      return {
        status: 200,
        body: {
          code: 200,
          name: "晴天",
          singer: "周杰伦",
          interval: "04:29",
          mid: "qq-mid-1",
          url: "https://qq.example.test/qingtian.flac",
        },
      };
    },
  });

  const result = await handlers.musicUrl({
    source: "kg",
    quality: "lossless",
    musicInfo: {
      source: "kg",
      id: "kg-hash-1",
      name: "晴天",
      singer: "周杰伦",
      interval: "04:29",
    },
  });

  assert.deepEqual(requests.map(describeRequest), [
    {
      path: "/api/kugou_music",
      params: { id: "kg-hash-1", size: "flac", type: "json" },
    },
    {
      path: "/api/qq_music",
      params: { num: "10", msg: "晴天 周杰伦" },
    },
    {
      path: "/api/qq_music",
      params: { mid: "qq-mid-1", size: "flac", type: "json" },
    },
  ]);
  assert.equal(result.url, "https://qq.example.test/qingtian.flac");
  assert.equal(result.quality, "lossless");
});

test("stops probing a fallback platform after its first upstream failure", async () => {
  const { handlers, requests } = loadPlugin({
    settings: { directSearchFallback: false },
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") {
        return { status: 200, body: { code: 200, list: [] } };
      }
      if (url.pathname === "/api/kugou_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            list: [
              { id: "kg-first", name: "晴天", singer: "周杰伦", duration: 269 },
              { id: "kg-second", name: "晴天", singer: "周杰伦", duration: 269 },
            ],
          },
        };
      }
      if (url.pathname === "/api/kugou_music" && url.searchParams.get("id") === "kg-first") {
        return { status: 502, body: { msg: "upstream unavailable" } };
      }
      return { status: 200, body: { code: 200, url: "https://kg.example.test/second.mp3" } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({
      source: "wy",
      quality: "lq",
      musicInfo: {
        source: "wy",
        id: "wy-primary-id",
        name: "晴天",
        singer: "周杰伦",
        interval: "04:29",
      },
    }),
    { code: "CHKSZ_HTTP_502" },
  );

  assert.deepEqual(
    requests
      .filter(({ url }) => new URL(url).pathname === "/api/kugou_music")
      .map(({ url }) => new URL(url).searchParams.get("id")),
    [null, "kg-first"],
    "a cooled fallback platform must not probe its remaining candidates",
  );
});

test("uses a NetEase search id when QQ is the failed primary source", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/qq_music") {
        return { status: 502, body: { msg: "upstream unavailable" } };
      }
      if (url.pathname === "/api/163_search") {
        return {
          status: 200,
          body: {
            code: 200,
            data: [
              { id: "wy-id-1", name: "晴天", artists: "周杰伦" },
            ],
          },
        };
      }
      return {
        status: 200,
        body: {
          code: 200,
          data: {
            id: "wy-id-1",
            name: "晴天",
            artist: "周杰伦",
            url: "https://wy.example.test/qingtian.flac",
          },
        },
      };
    },
  });

  const result = await handlers.musicUrl({
    source: "tx",
    quality: "lossless",
    musicInfo: {
      source: "tx",
      mid: "qq-mid-1",
      name: "晴天",
      singer: "周杰伦",
      interval: "04:29",
    },
  });

  assert.deepEqual(requests.map(describeRequest), [
    {
      path: "/api/qq_music",
      params: { mid: "qq-mid-1", size: "flac", type: "json" },
    },
    {
      path: "/api/163_search",
      params: { keyword: "晴天 周杰伦", limit: "10" },
    },
    {
      path: "/api/163_music",
      params: { id: "wy-id-1", level: "lossless", type: "json" },
    },
  ]);
  assert.equal(result.url, "https://wy.example.test/qingtian.flac");
  assert.equal(result.quality, "lossless");
});

test("accepts a QQ fallback detail when duration is present without interval", async () => {
  const { handlers, requests } = loadPlugin({
    settings: { directSearchFallback: false },
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            list: [{ name: "晴天", singer: "周杰伦", mid: "qq-duration-only" }],
          },
        };
      }
      if (url.pathname === "/api/qq_music") {
        return {
          status: 200,
          body: {
            code: 200,
            name: "晴天",
            singer: "周杰伦",
            duration: 269,
            url: "https://qq.example.test/duration-only.mp3",
          },
        };
      }
      return { status: 200, body: { code: 200, list: [] } };
    },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hq",
    musicInfo: {
      source: "wy",
      id: "wy-primary-id",
      name: "晴天",
      singer: "周杰伦",
      interval: "04:29",
    },
  });

  assert.equal(result.url, "https://qq.example.test/duration-only.mp3");
  assert.ok(
    requests.some(({ url }) => new URL(url).searchParams.get("mid") === "qq-duration-only"),
  );
});

test("rejects a version-relaxed NetEase candidate when its duration is unavailable", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/qq_music") {
        return { status: 502, body: { msg: "upstream unavailable" } };
      }
      if (url.pathname === "/api/163_search") {
        return {
          status: 200,
          body: {
            code: 200,
            data: [{ id: "wy-clean-title", name: "My jealousy", artists: "DJMAX" }],
          },
        };
      }
      if (url.pathname === "/api/kugou_music") {
        return { status: 200, body: { code: 200, list: [] } };
      }
      return { status: 200, body: { code: 200, url: "https://wy.example.test/wrong-version.flac" } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({
      source: "tx",
      quality: "lq",
      musicInfo: {
        source: "tx",
        mid: "qq-primary-id",
        name: "My jealousy (Live)",
        singer: "DJMAX",
        interval: "02:33",
      },
    }),
    { code: "CHKSZ_CROSS_PLATFORM_UNAVAILABLE" },
  );
  assert.ok(
    !requests.some(({ url }) => new URL(url).pathname === "/api/163_music"),
    "a NetEase candidate without duration must not enter playback resolution",
  );
});

test("keeps an upstream diagnosis when no alternate platform matches", async () => {
  const { handlers } = loadPlugin({
    directSearchResponse: {
      status: 200,
      body: { code: 0, data: { song: { list: [] } } },
    },
    response: (url) => {
      if (url.pathname === "/api/kugou_music") {
        return { status: 502, body: { msg: "upstream unavailable" } };
      }
      if (url.pathname === "/api/qq_music") {
        return { status: 200, body: { code: 200, list: [] } };
      }
      if (url.pathname === "/api/163_search") {
        return { status: 200, body: { code: 200, data: [] } };
      }
      return { status: 200, body: { code: 200, list: [] } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({
      source: "kg",
      quality: "lq",
      musicInfo: {
        source: "kg",
        id: "kg-hash-1",
        name: "不存在的歌",
        singer: "不存在的歌手",
        interval: "04:29",
      },
    }),
    (error) =>
      error.code === "CHKSZ_CROSS_PLATFORM_UNAVAILABLE" &&
      error.message.includes("HTTP 502") &&
      error.message.includes("不代表歌曲不存在"),
  );
});
