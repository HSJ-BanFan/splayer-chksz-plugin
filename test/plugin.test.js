import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin, pluginSource } from "./plugin-host.js";

test("resolution core exposes a narrow playback resolver and normalizes nested URL expiry", async () => {
  const { resolutionCore } = loadPlugin({
    response: {
      status: 200,
      body: { data: { url: " https://cdn.example.test/song.mp3 ", expires_at: "1800000000" } },
    },
  });
  assert.ok(resolutionCore);
  assert.deepEqual(Object.keys(resolutionCore), ["resolve"]);
  const result = await resolutionCore.resolve({ source: "tx", quality: "hq", id: "qq-mid-1" });
  assert.equal(result.url, "https://cdn.example.test/song.mp3");
  assert.equal(result.quality, "hq");
  assert.equal(result.expire, 1_800_000_000_000);
});

test("source policies own provider identity and action request strategies", () => {
  const { sourcePolicies } = loadPlugin({ response: { status: 200, body: {} } });

  assert.deepEqual(Object.keys(sourcePolicies), ["wy", "tx", "kg"]);
  assert.equal(sourcePolicies.wy.identity.idParameter, "id");
  assert.equal(sourcePolicies.tx.identity.idParameter, "mid");
  assert.equal(sourcePolicies.kg.identity.idParameter, "id");
  assert.equal(sourcePolicies.wy.playback.endpoint, "/api/163_music");
  assert.equal(sourcePolicies.wy.playback.qualityValues["hi-res"], "jymaster");
  assert.equal(sourcePolicies.wy.playback.qualityValues.lossless, "lossless");
  assert.equal(sourcePolicies.tx.playback.endpoint, "/api/qq_music");
  assert.equal(sourcePolicies.tx.playback.qualityValues["hi-res"], "master");
  assert.equal(sourcePolicies.tx.playback.qualityValues.hq, "320k");
  assert.equal(sourcePolicies.kg.playback.endpoint, "/api/kugou_music");
  assert.equal(sourcePolicies.kg.playback.qualityValues["hi-res"], "master");
  assert.equal(sourcePolicies.wy.actions.musicLyric.endpoint, "/api/163_lyric");
  assert.equal(sourcePolicies.wy.actions.musicPic.endpoint, "/api/163_music");
  assert.equal(sourcePolicies.wy.actions.musicPic.params.level, "standard");
  assert.equal(sourcePolicies.wy.actions.musicPic.params.type, "json");
  assert.equal(sourcePolicies.tx.actions.musicLyric.request, "trackDetails");
  assert.equal(sourcePolicies.tx.actions.musicPic.request, "trackDetails");
  assert.equal(sourcePolicies.kg.actions.musicLyric.request, "trackDetails");
  assert.equal(sourcePolicies.kg.actions.musicPic.request, "trackDetails");
});


test("maps NetEase lossless requests to the ChKSz 163 endpoint", async () => {
  const { handlers, requests } = loadPlugin({
    response: { status: 200, body: { url: "https://cdn.example.test/song.flac", expire: 1_800_000_000 } },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "lossless",
    musicInfo: { songmid: "2034742057" },
  });

  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.pathname, "/api/163_music");
  assert.equal(requestUrl.searchParams.get("id"), "2034742057");
  assert.equal(requestUrl.searchParams.get("level"), "lossless");
  assert.equal(requestUrl.searchParams.get("type"), "json");
  assert.equal(requestUrl.searchParams.get("apikey"), "chksz_test_key");
  assert.equal(result.url, "https://cdn.example.test/song.flac");
  assert.equal(result.quality, "lossless");
  assert.equal(result.expire, 1_800_000_000_000);
});

test("falls back to standard NetEase quality when the requested level is unavailable", async () => {
  const requestedLevels = [];
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      const level = url.searchParams.get("level");
      requestedLevels.push(level);

      if (level === "exhigh") {
        return {
          status: 404,
          body: { msg: "Music URL not found, song may be unavailable at this quality level" },
        };
      }

      return { status: 200, body: { url: "https://cdn.example.test/song.mp3" } };
    },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hq",
    musicInfo: { id: "issue-track-id" },
  });

  assert.deepEqual(requestedLevels, ["exhigh", "standard"]);
  assert.equal(requests.length, 2);
  assert.equal(result.url, "https://cdn.example.test/song.mp3");
  assert.equal(result.quality, "lq");
});

test("does not retry unrelated NetEase 404 responses", async () => {
  const { handlers, requests } = loadPlugin({
    response: { status: 404, body: { msg: "Endpoint not found" } },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { id: "123" } }),
    (error) => error.code === "CHKSZ_HTTP_404",
  );
  assert.equal(requests.length, 1);
});

test("treats a ChKSz business 404 as an unavailable quality", async () => {
  const requestedLevels = [];
  const { handlers, requests } = loadPlugin({
    response: (url) => {
      const level = url.searchParams.get("level");
      requestedLevels.push(level);
      if (level === "exhigh") {
        return {
          status: 200,
          body: {
            code: 404,
            msg: "Music URL not found, song may be unavailable at this quality level",
          },
        };
      }
      return { status: 200, body: { code: 200, url: "https://cdn.example.test/song.mp3" } };
    },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hq",
    musicInfo: { id: "business-error-track" },
  });

  assert.deepEqual(requestedLevels, ["exhigh", "standard"]);
  assert.equal(requests.length, 2);
  assert.equal(result.quality, "lq");
});

test("surfaces a ChKSz business account error from a successful HTTP response", async () => {
  const { handlers, requests } = loadPlugin({
    response: {
      status: 200,
      body: { code: 402, msg: "今日额度已用尽" },
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { id: "123" } }),
    (error) => error.code === "CHKSZ_HTTP_402" && error.message.includes("今日额度已用尽"),
  );
  assert.equal(requests.length, 1);
});

test("passes a shared end-to-end timeout budget to music URL requests", async () => {
  const { handlers, requests } = loadPlugin({
    response: { status: 200, body: { code: 200, url: "https://cdn.example.test/song.flac" } },
  });

  await handlers.musicUrl({
    source: "tx",
    quality: "hi-res",
    musicInfo: { songmid: "qq-mid-1" },
  });

  assert.ok(requests[0].options.timeout > 0);
  assert.ok(requests[0].options.timeout <= 18_000);
});

test("reports the resolution timeout when the host ignores the total deadline", async () => {
  const sourceText = pluginSource.replace(
    "const RESOLUTION_TIME_BUDGET = 18_000;",
    "const RESOLUTION_TIME_BUDGET = 20;",
  );
  const { handlers } = loadPlugin({
    sourceText,
    response: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: 200, body: { code: 200, url: "https://cdn.example.test/song.flac" } };
    },
  });

  await assert.rejects(
    handlers.musicUrl({
      source: "tx",
      quality: "hi-res",
      musicInfo: { songmid: "qq-mid-1" },
    }),
    (error) => error.code === "CHKSZ_RESOLUTION_TIMEOUT",
  );
});

test("normalises host request timeout errors", async () => {
  const { handlers } = loadPlugin({
    response: () => {
      const error = new Error("host request deadline exceeded");
      error.code = "PLUGIN_REQUEST_TIMEOUT";
      throw error;
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "tx", quality: "hq", musicInfo: { songmid: "qq-mid-1" } }),
    (error) => error.code === "CHKSZ_REQUEST_TIMEOUT",
  );
});

test("classifies network failures without exposing the API key", async () => {
  const { handlers, requests } = loadPlugin({
    response: () => {
      throw new Error(
        "socket failed for https://api.chksz.com/api/qq_music?mid=qq-mid-1&apikey=chksz_test_key",
      );
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "tx", quality: "hq", musicInfo: { songmid: "qq-mid-1" } }),
    (error) =>
      error.code === "CHKSZ_NETWORK_ERROR" &&
      !error.message.includes("chksz_test_key") &&
      error.message.includes("[REDACTED]"),
  );
  assert.equal(requests.length, 1);
});

test("redacts API keys from cross-platform network warnings", async () => {
  const unavailable = {
    status: 404,
    body: { msg: "Music URL not found, song may be unavailable at this quality level" },
  };
  const { handlers, logs } = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return unavailable;
      throw new Error(
        `socket failed for ${url.toString()} with apikey=chksz_test_key`,
      );
    },
  });

  await assert.rejects(
    handlers.musicUrl({
      source: "wy",
      quality: "lq",
      musicInfo: { id: "wy-id-1", name: "晴天", singer: "周杰伦", interval: "04:29" },
    }),
    (error) => error.code === "CHKSZ_NETWORK_ERROR" && !error.message.includes("chksz_test_key"),
  );
  assert.ok(
    logs.every((entry) => !entry.args.join(" ").includes("chksz_test_key")),
  );
});

test("redacts API keys from no-URL response errors", async () => {
  const { handlers } = loadPlugin({
    response: {
      status: 200,
      body: { code: 200, msg: "upstream apikey=chksz_test_key" },
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "tx", quality: "hq", musicInfo: { songmid: "qq-mid-1" } }),
    (error) =>
      error.code === "CHKSZ_NO_URL" &&
      !error.message.includes("chksz_test_key") &&
      error.message.includes("[REDACTED]"),
  );
});

test("does not retry 404 responses without the complete quality-unavailable message", async () => {
  for (const message of ["Music URL not found", "song unavailable at this quality level"]) {
    const { handlers, requests } = loadPlugin({
      response: { status: 404, body: { msg: message } },
    });

    await assert.rejects(
      handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { id: "123" } }),
      (error) => error.code === "CHKSZ_HTTP_404",
    );
    assert.equal(requests.length, 1, message);
  }
});

test("falls through the supported NetEase quality ladder and reports the effective quality", async () => {
  const requestedLevels = [];
  const { handlers } = loadPlugin({
    response: (url) => {
      const level = url.searchParams.get("level");
      requestedLevels.push(level);

      if (["jymaster", "hires", "lossless", "exhigh"].includes(level)) {
        return {
          status: 404,
          body: { msg: "Music URL not found, song may be unavailable at this quality level" },
        };
      }

      return { status: 200, body: { url: "https://cdn.example.test/song.mp3" } };
    },
  });

  const result = await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: { id: "123" },
  });

  assert.deepEqual(requestedLevels, ["jymaster", "hires", "lossless", "exhigh", "standard"]);
  assert.equal(result.quality, "lq");
});

test("maps QQ and Kugou IDs and native quality values", async () => {
  const { handlers, requests } = loadPlugin({
    response: (url) => ({ status: 200, body: { url: `https://cdn.example.test/${url.pathname}.mp3` } }),
  });

  await handlers.musicUrl({
    source: "tx",
    quality: "hq",
    musicInfo: { songmid: "qq-mid-1" },
  });
  await handlers.musicUrl({
    source: "kg",
    quality: "hi-res",
    musicInfo: { id: "kg-id-1" },
  });

  const qqUrl = new URL(requests[0].url);
  assert.equal(qqUrl.pathname, "/api/qq_music");
  assert.equal(qqUrl.searchParams.get("mid"), "qq-mid-1");
  assert.equal(qqUrl.searchParams.get("size"), "320k");

  const kugouUrl = new URL(requests[1].url);
  assert.equal(kugouUrl.pathname, "/api/kugou_music");
  assert.equal(kugouUrl.searchParams.get("id"), "kg-id-1");
  assert.equal(kugouUrl.searchParams.get("size"), "master");
});

test("maps SPlayer hi-res to each provider's top ChKSz quality", async () => {
  const { handlers, requests } = loadPlugin({
    response: { status: 200, body: { url: "https://cdn.example.test/song.flac" } },
  });

  await handlers.musicUrl({
    source: "wy",
    quality: "hi-res",
    musicInfo: { id: "wy-id-1" },
  });
  await handlers.musicUrl({
    source: "tx",
    quality: "hi-res",
    musicInfo: { songmid: "qq-mid-1" },
  });
  await handlers.musicUrl({
    source: "kg",
    quality: "hi-res",
    musicInfo: { id: "kg-id-1" },
  });

  assert.deepEqual(
    requests.map((request) => {
      const url = new URL(request.url);
      return { path: url.pathname, quality: url.searchParams.get("level") ?? url.searchParams.get("size") };
    }),
    [
      { path: "/api/163_music", quality: "jymaster" },
      { path: "/api/qq_music", quality: "master" },
      { path: "/api/kugou_music", quality: "master" },
    ],
  );
});

test("tries each provider's native hires quality before falling to lossless", async () => {
  const requestedQualities = [];
  const { handlers } = loadPlugin({
    response: (url) => {
      const quality = url.searchParams.get("level") ?? url.searchParams.get("size");
      requestedQualities.push(quality);
      if (["jymaster", "master"].includes(quality)) {
        return {
          status: 404,
          body: { msg: "Music URL not found, song may be unavailable at this quality level" },
        };
      }
      return { status: 200, body: { url: "https://cdn.example.test/song.flac" } };
    },
  });

  await handlers.musicUrl({ source: "wy", quality: "hi-res", musicInfo: { id: "wy-id-1" } });
  await handlers.musicUrl({ source: "tx", quality: "hi-res", musicInfo: { songmid: "qq-mid-1" } });
  await handlers.musicUrl({ source: "kg", quality: "hi-res", musicInfo: { id: "kg-id-1" } });

  assert.deepEqual(requestedQualities, [
    "jymaster",
    "hires",
    "master",
    "hires",
    "master",
    "hires",
  ]);
});

test("parses NetEase lyrics and translation", async () => {
  const { handlers, requests } = loadPlugin({
    response: {
      status: 200,
      body: {
        lrc: { lyric: "[00:01.00]主歌词" },
        tlyric: { lyric: "[00:01.00]译文" },
        yrc: { lyric: "[0,100](主歌词)" },
      },
    },
  });

  const result = await handlers.musicLyric({
    source: "wy",
    musicInfo: { id: "123" },
  });

  assert.equal(result.lyric, "[00:01.00]主歌词");
  assert.equal(result.tlyric, "[00:01.00]译文");
  assert.equal(result.awlyric, "[0,100](主歌词)");
  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.pathname, "/api/163_lyric");
  assert.equal(requestUrl.searchParams.get("id"), "123");
  assert.equal(requestUrl.searchParams.get("type"), null);
  assert.equal(requestUrl.searchParams.get("apikey"), "chksz_test_key");
});

test("uses shared track-detail requests for QQ and Kugou lyrics", async () => {
  const { handlers, requests } = loadPlugin({
    response: { status: 200, body: { lyric: "[00:01.00]歌词" } },
  });

  await handlers.musicLyric({ source: "tx", musicInfo: { songmid: "qq-mid-1" } });
  await handlers.musicLyric({ source: "kg", musicInfo: { id: "kg-id-1" } });

  const qqUrl = new URL(requests[0].url);
  assert.equal(qqUrl.pathname, "/api/qq_music");
  assert.equal(qqUrl.searchParams.get("mid"), "qq-mid-1");
  assert.equal(qqUrl.searchParams.get("size"), "128k");
  assert.equal(qqUrl.searchParams.get("type"), "json");
  assert.equal(qqUrl.searchParams.get("apikey"), "chksz_test_key");

  const kugouUrl = new URL(requests[1].url);
  assert.equal(kugouUrl.pathname, "/api/kugou_music");
  assert.equal(kugouUrl.searchParams.get("id"), "kg-id-1");
  assert.equal(kugouUrl.searchParams.get("size"), "128k");
  assert.equal(kugouUrl.searchParams.get("type"), "json");
  assert.equal(kugouUrl.searchParams.get("apikey"), "chksz_test_key");
});

test("uses policy-defined cover requests for all providers", async () => {
  const { handlers, requests } = loadPlugin({
    response: { status: 200, body: { cover: "https://cdn.example.test/cover.jpg" } },
  });

  await handlers.musicPic({ source: "wy", musicInfo: { id: "wy-id-1" } });
  await handlers.musicPic({ source: "tx", musicInfo: { songmid: "qq-mid-1" } });
  await handlers.musicPic({ source: "kg", musicInfo: { id: "kg-id-1" } });

  const neteaseUrl = new URL(requests[0].url);
  assert.equal(neteaseUrl.pathname, "/api/163_music");
  assert.equal(neteaseUrl.searchParams.get("id"), "wy-id-1");
  assert.equal(neteaseUrl.searchParams.get("level"), "standard");
  assert.equal(neteaseUrl.searchParams.get("type"), "json");
  assert.equal(neteaseUrl.searchParams.get("apikey"), "chksz_test_key");

  const qqUrl = new URL(requests[1].url);
  assert.equal(qqUrl.pathname, "/api/qq_music");
  assert.equal(qqUrl.searchParams.get("mid"), "qq-mid-1");
  assert.equal(qqUrl.searchParams.get("size"), "128k");
  assert.equal(qqUrl.searchParams.get("type"), "json");
  assert.equal(qqUrl.searchParams.get("apikey"), "chksz_test_key");

  const kugouUrl = new URL(requests[2].url);
  assert.equal(kugouUrl.pathname, "/api/kugou_music");
  assert.equal(kugouUrl.searchParams.get("id"), "kg-id-1");
  assert.equal(kugouUrl.searchParams.get("size"), "128k");
  assert.equal(kugouUrl.searchParams.get("type"), "json");
  assert.equal(kugouUrl.searchParams.get("apikey"), "chksz_test_key");
});

test("surfaces HTTP errors and Retry-After without retrying", async () => {
  const { handlers, requests } = loadPlugin({
    response: {
      status: 429,
      headers: { "retry-after": "42" },
      body: { msg: "请求过于频繁" },
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { id: "123" } }),
    (error) =>
      error.code === "CHKSZ_HTTP_429" &&
      error.message.includes("请求过于频繁") &&
      error.message.includes("42 秒"),
  );
  assert.equal(requests.length, 1);
});

test("redacts API keys from Retry-After errors", async () => {
  const { handlers } = loadPlugin({
    response: {
      status: 429,
      headers: { "retry-after": "chksz_retry_key" },
      body: { msg: "请求过于频繁" },
    },
  });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { id: "123" } }),
    (error) =>
      error.code === "CHKSZ_HTTP_429" &&
      !error.message.includes("chksz_retry_key") &&
      error.message.includes("[REDACTED]"),
  );
});

test("fails before making a request when the API key is missing", async () => {
  const { handlers, requests } = loadPlugin({ apiKey: "" });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { id: "123" } }),
    (error) => error.code === "CHKSZ_CONFIG_MISSING",
  );
  assert.equal(requests.length, 0);
});
