import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

const UNAVAILABLE = {
  status: 404,
  body: { msg: "Music URL not found, song may be unavailable at this quality level" },
};

/** NetEase track as SPlayer-Next passes it to musicUrl (see resolveByPlugin). */
const JAY_TRACK = {
  id: "186109",
  songmid: "186109",
  songId: "186109",
  name: "晴天",
  singer: "周杰伦",
  source: "wy",
  interval: "04:29",
};

const QQ_SEARCH_HIT = {
  status: 200,
  body: {
    code: 200,
    msg: "成功",
    count: 2,
    list: [
      { n: 1, name: "晴天 (Live)", singer: "林俊杰", album: "演唱会", pay: "付费", mid: "wrong-mid" },
      { n: 2, name: "晴天", singer: "周杰伦", album: "叶惠美", pay: "付费", mid: "0039MnYb0qxYhV" },
    ],
  },
};

const KUGOU_SEARCH_HIT = {
  status: 200,
  body: {
    code: 200,
    msg: "成功",
    keyword: "晴天 周杰伦",
    total: 1,
    list: [
      { n: 1, id: "kg-hash-1", name: "晴天", singer: "周杰伦", album: "叶惠美", duration: 269 },
    ],
  },
};

const describeRequest = (request) => {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  delete params.apikey;
  return { path: url.pathname, params };
};

test("matches an unavailable NetEase song on QQ Music and plays it there", async () => {
  const { handlers, requests, logs } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.searchParams.has("msg")) return QQ_SEARCH_HIT;
      return {
        status: 200,
        body: {
          code: 200,
          name: "晴天",
          singer: "周杰伦",
          interval: "04:29",
          url: "https://qq.example.test/qingtian.flac",
          mid: "0039MnYb0qxYhV",
        },
      };
    },
  });

  const result = await handlers.musicUrl({ source: "wy", quality: "lossless", musicInfo: JAY_TRACK });

  assert.deepEqual(requests.map(describeRequest), [
    { path: "/api/163_music", params: { id: "186109", level: "lossless", type: "json" } },
    { path: "/api/163_music", params: { id: "186109", level: "exhigh", type: "json" } },
    { path: "/api/163_music", params: { id: "186109", level: "standard", type: "json" } },
    { path: "/api/qq_music", params: { num: "10", msg: "晴天 周杰伦" } },
    { path: "/api/qq_music", params: { mid: "0039MnYb0qxYhV", size: "flac", type: "json" } },
  ]);
  assert.equal(result.url, "https://qq.example.test/qingtian.flac");
  assert.equal(result.quality, "lossless");
  assert.ok(logs.some((entry) => entry.level === "info" && /QQ 音乐/.test(entry.args.join(" "))));
});

test("falls through to Kugou when QQ Music has no matching candidate", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") {
        return { status: 200, body: { code: 200, count: 1, list: [{ n: 1, name: "晴天", singer: "别人", mid: "x" }] } };
      }
      if (url.searchParams.has("msg")) return KUGOU_SEARCH_HIT;
      return { status: 200, body: { code: 200, url: "https://kg.example.test/qingtian.mp3" } };
    },
  });

  const result = await handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: JAY_TRACK });

  assert.deepEqual(requests.slice(2).map(describeRequest), [
    { path: "/api/qq_music", params: { num: "10", msg: "晴天 周杰伦" } },
    { path: "/api/kugou_music", params: { msg: "晴天 周杰伦" } },
    { path: "/api/kugou_music", params: { id: "kg-hash-1", size: "320k", type: "json" } },
  ]);
  assert.equal(result.url, "https://kg.example.test/qingtian.mp3");
  assert.equal(result.quality, "hq");
});

test("rejects candidates whose duration differs by more than 20 seconds", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") return { status: 200, body: { code: 200, count: 0, list: [] } };
      if (url.searchParams.get("id") === "original") {
        return { status: 200, body: { code: 200, url: "https://kg.example.test/original.mp3" } };
      }
      return {
        status: 200,
        body: {
          code: 200,
          list: [
            { n: 1, id: "short-edit", name: "晴天", singer: "周杰伦", duration: 120 },
            { n: 2, id: "original", name: "晴天", singer: "周杰伦", duration: 269000 },
          ],
        },
      };
    },
  });

  const result = await handlers.musicUrl({ source: "wy", quality: "lq", musicInfo: JAY_TRACK });

  assert.equal(result.url, "https://kg.example.test/original.mp3");
  assert.equal(describeRequest(requests.at(-1)).params.id, "original");
  assert.ok(!requests.some((request) => new URL(request.url).searchParams.get("id") === "short-edit"));
});

test("validates QQ candidate duration from the resolved track details", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            count: 1,
            list: [{ n: 1, name: "晴天", singer: "周杰伦", mid: "qq-wrong" }],
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
            interval: "02:00",
            mid: "qq-wrong",
            url: "https://qq.example.test/wrong-duration.mp3",
          },
        };
      }
      return { status: 200, body: { code: 200, list: [] } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: JAY_TRACK }),
    (error) => error.code === "CHKSZ_TRACK_UNAVAILABLE",
  );
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/api/163_music",
      "/api/163_music",
      "/api/qq_music",
      "/api/qq_music",
      "/api/kugou_music",
    ],
  );
});

test("bounds cross-platform candidate probes and API requests", async () => {
  const qqCandidates = Array.from({ length: 10 }, (_, index) => ({
    n: index + 1,
    name: "晴天",
    singer: "周杰伦",
    mid: `qq-${index + 1}`,
  }));
  const kugouCandidates = Array.from({ length: 10 }, (_, index) => ({
    n: index + 1,
    name: "晴天",
    singer: "周杰伦",
    duration: 269,
    id: `kg-${index + 1}`,
  }));
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return { status: 200, body: { code: 200, list: qqCandidates } };
      }
      if (url.pathname === "/api/qq_music") {
        return {
          status: 200,
          body: {
            code: 200,
            name: "晴天",
            singer: "周杰伦",
            interval: "02:00",
            url: "https://qq.example.test/wrong-duration.mp3",
          },
        };
      }
      if (url.pathname === "/api/kugou_music" && url.searchParams.has("msg")) {
        return { status: 200, body: { code: 200, list: kugouCandidates } };
      }
      return {
        status: 200,
        body: {
          code: 200,
          name: "晴天",
          singer: "周杰伦",
          interval: "02:00",
          url: "https://kg.example.test/wrong-duration.mp3",
        },
      };
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: JAY_TRACK }),
    (error) => error.code === "CHKSZ_CROSS_PLATFORM_LIMIT",
  );

  const fallbackRequests = requests.slice(2);
  assert.equal(fallbackRequests.length, 8);
  assert.deepEqual(
    fallbackRequests.map((request) => new URL(request.url).pathname),
    [
      "/api/qq_music",
      "/api/qq_music",
      "/api/qq_music",
      "/api/qq_music",
      "/api/kugou_music",
      "/api/kugou_music",
      "/api/kugou_music",
      "/api/kugou_music",
    ],
  );
});

test("rejects a QQ candidate when its details omit the required interval", async () => {
  const { handlers } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            list: [{ name: "晴天", singer: "周杰伦", duration: 269, mid: "qq-missing-interval" }],
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
            url: "https://qq.example.test/missing-interval.mp3",
            mid: "qq-missing-interval",
          },
        };
      }
      return { status: 200, body: { code: 200, list: [] } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "lq", musicInfo: JAY_TRACK }),
    (error) => error.code === "CHKSZ_TRACK_UNAVAILABLE",
  );
});

test("prefers an exact title over a live or remix variant listed first", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            list: [
              { n: 1, name: "晴天 (Live)", singer: "周杰伦", mid: "live-mid" },
              { n: 2, name: "晴天", singer: "周杰伦", mid: "studio-mid" },
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
          url: "https://qq.example.test/studio.mp3",
        },
      };
    },
  });

  const result = await handlers.musicUrl({ source: "wy", quality: "lq", musicInfo: JAY_TRACK });

  assert.equal(result.url, "https://qq.example.test/studio.mp3");
  assert.equal(describeRequest(requests.at(-1)).params.mid, "studio-mid");
});

test("reports a dedicated error when no platform carries the song", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) =>
      url.pathname === "/api/163_music"
        ? UNAVAILABLE
        : { status: 200, body: { code: 200, list: [] } },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "lq", musicInfo: JAY_TRACK }),
    (error) =>
      error.code === "CHKSZ_TRACK_UNAVAILABLE" &&
      error.message.includes("晴天") &&
      error.message.includes("HTTP 404") &&
      error.message.includes("QQ 音乐") &&
      error.message.includes("酷狗"),
  );
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/api/163_music", "/api/qq_music", "/api/kugou_music"],
  );
});

test("skips cross-platform matching without a song name or when the switch is off", async () => {
  for (const { musicInfo, settings } of [
    { musicInfo: { id: "186109" }, settings: {} },
    { musicInfo: JAY_TRACK, settings: { crossPlatformFallback: false } },
  ]) {
    const { handlers, requests } = loadPlugin({ settings, response: UNAVAILABLE });

    await assert.rejects(
      handlers.musicUrl({ source: "wy", quality: "lq", musicInfo }),
      (error) => error.code === "CHKSZ_HTTP_404",
    );
    assert.deepEqual(
      requests.map((request) => new URL(request.url).pathname),
      ["/api/163_music"],
    );
  }
});

test("stops immediately when the account itself is rejected during matching", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) =>
      url.pathname === "/api/163_music"
        ? UNAVAILABLE
        : { status: 402, body: { msg: "今日额度已用尽" } },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "lq", musicInfo: JAY_TRACK }),
    (error) => error.code === "CHKSZ_HTTP_402" && error.message.includes("今日额度已用尽"),
  );
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/api/163_music", "/api/qq_music"],
  );
});

test("continues to the next platform after an unrelated matching failure", async () => {
  const { handlers, logs } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") return { status: 503, body: { msg: "QQ 音乐服务暂不可用" } };
      if (url.searchParams.has("msg")) return KUGOU_SEARCH_HIT;
      return { status: 200, body: { code: 200, url: "https://kg.example.test/qingtian.mp3" } };
    },
  });

  const result = await handlers.musicUrl({ source: "wy", quality: "sq", musicInfo: JAY_TRACK });

  assert.equal(result.url, "https://kg.example.test/qingtian.mp3");
  assert.ok(logs.some((entry) => entry.level === "warn" && /QQ 音乐服务暂不可用/.test(entry.args.join(" "))));
});

test("preserves a final cross-platform provider error", async () => {
  const { handlers } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") {
        return { status: 503, body: { msg: "provider temporarily unavailable" } };
      }
      return { status: 200, body: { code: 200, list: [] } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: JAY_TRACK }),
    (error) =>
      error.code === "CHKSZ_HTTP_503" &&
      error.message.includes("provider temporarily unavailable"),
  );
});

test("rejects a version-only candidate instead of playing it as the original", async () => {
  const { handlers } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            list: [{ name: "晴天 Live", singer: "周杰伦", interval: "04:29", mid: "qq-live" }],
          },
        };
      }
      if (url.pathname === "/api/qq_music") {
        return {
          status: 200,
          body: {
            code: 200,
            name: "晴天 Live",
            singer: "周杰伦",
            interval: "04:29",
            url: "https://qq.example.test/live.mp3",
          },
        };
      }
      return { status: 200, body: { code: 200, list: [] } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "lq", musicInfo: JAY_TRACK }),
    (error) => error.code === "CHKSZ_TRACK_UNAVAILABLE",
  );
});

test("does not cross-search for QQ Music or Kugou tracks", async () => {
  for (const source of ["tx", "kg"]) {
    const { handlers, requests } = loadPlugin({ response: UNAVAILABLE });

    await assert.rejects(
      handlers.musicUrl({ source, quality: "lq", musicInfo: { ...JAY_TRACK, source } }),
      (error) => error.code === "CHKSZ_HTTP_404",
    );
    assert.equal(requests.length, 1, source);
  }
});

test("downgrades QQ Music and Kugou qualities on the same unavailable signal", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) =>
      ["master", "hires"].includes(url.searchParams.get("size"))
        ? UNAVAILABLE
        : { status: 200, body: { code: 200, url: "https://cdn.example.test/song.flac" } },
  });

  const qq = await handlers.musicUrl({ source: "tx", quality: "hi-res", musicInfo: { songmid: "mid-1" } });
  const kugou = await handlers.musicUrl({ source: "kg", quality: "hi-res", musicInfo: { id: "kg-1" } });

  assert.deepEqual(
    requests.map((request) => new URL(request.url).searchParams.get("size")),
    ["master", "hires", "flac", "master", "hires", "flac"],
  );
  assert.equal(qq.quality, "lossless");
  assert.equal(kugou.quality, "lossless");
});

test("registers the cross-platform switch as an opt-out setting", () => {
  const { registration } = loadPlugin({ response: { status: 200, body: {} } });
  const setting = registration.settings.find((item) => item.key === "crossPlatformFallback");

  assert.equal(setting.type, "switch");
  assert.equal(setting.default, true);
  assert.match(setting.label, /QQ 音乐/);
});
