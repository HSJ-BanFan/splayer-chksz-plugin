import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginSource = await readFile(resolve(projectRoot, "src", "plugin.js"), "utf8");

const loadPlugin = ({ apiKey = "chksz_test_key", response }) => {
  const registration = {};
  const handlers = {};
  const requests = [];
  const settings = { apiKey };

  const splayer = {
    register(args) {
      Object.assign(registration, args);
    },
    on(action, handler) {
      handlers[action] = handler;
    },
    getSetting(key) {
      return settings[key];
    },
    async request(url, options) {
      requests.push({ url, options });
      return typeof response === "function" ? response(new URL(url), options) : response;
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  };

  const context = {
    splayer,
    URL,
    Promise,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    `${pluginSource}\n;globalThis.__resolutionCore = typeof resolutionCore === "undefined" ? undefined : resolutionCore;\n;globalThis.__sourcePolicies = typeof SOURCE_POLICIES === "undefined" ? undefined : SOURCE_POLICIES;`,
    context,
  );

  return {
    registration,
    handlers,
    requests,
    resolutionCore: context.__resolutionCore,
    sourcePolicies: context.__sourcePolicies,
  };
};

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
  assert.equal(sourcePolicies.wy.playback.qualityValues.lossless, "lossless");
  assert.equal(sourcePolicies.tx.playback.endpoint, "/api/qq_music");
  assert.equal(sourcePolicies.tx.playback.qualityValues.hq, "320k");
  assert.equal(sourcePolicies.kg.playback.endpoint, "/api/kugou_music");
  assert.equal(sourcePolicies.kg.playback.qualityValues["hi-res"], "hires");
  assert.equal(sourcePolicies.wy.actions.musicLyric.endpoint, "/api/163_lyric");
  assert.equal(sourcePolicies.wy.actions.musicPic.endpoint, "/api/163_music");
  assert.equal(sourcePolicies.wy.actions.musicPic.params.level, "standard");
  assert.equal(sourcePolicies.wy.actions.musicPic.params.type, "json");
  assert.equal(sourcePolicies.tx.actions.musicLyric.request, "trackDetails");
  assert.equal(sourcePolicies.tx.actions.musicPic.request, "trackDetails");
  assert.equal(sourcePolicies.kg.actions.musicLyric.request, "trackDetails");
  assert.equal(sourcePolicies.kg.actions.musicPic.request, "trackDetails");
});

test("registers all three SPlayer platform sources and a local key setting", () => {
  const { registration } = loadPlugin({ response: { status: 200, body: {} } });

  assert.deepEqual(Object.keys(registration.sources), ["wy", "tx", "kg"]);
  assert.deepEqual([...registration.sources.wy.actions], ["musicUrl", "musicLyric", "musicPic"]);
  assert.equal(registration.settings[0].key, "apiKey");
  assert.equal(registration.settings[0].type, "text");
});

test("contains publishable plugin metadata and network permission", () => {
  assert.match(pluginSource, /@id\s+chksz\.splayer-source/);
  assert.match(pluginSource, /@type\s+source/);
  assert.match(pluginSource, /@grant\s+network/);
  assert.match(
    pluginSource,
    /@updateUrl\s+https:\/\/raw\.githubusercontent\.com\/HSJ-BanFan\/splayer-chksz-plugin/,
  );
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

      if (["hires", "lossless", "exhigh"].includes(level)) {
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

  assert.deepEqual(requestedLevels, ["hires", "lossless", "exhigh", "standard"]);
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
  assert.equal(kugouUrl.searchParams.get("size"), "hires");
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

test("fails before making a request when the API key is missing", async () => {
  const { handlers, requests } = loadPlugin({ apiKey: "" });

  await assert.rejects(
    handlers.musicUrl({ source: "wy", quality: "hq", musicInfo: { id: "123" } }),
    (error) => error.code === "CHKSZ_CONFIG_MISSING",
  );
  assert.equal(requests.length, 0);
});
