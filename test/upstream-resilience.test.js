import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

const START = 1_900_000_000_000;
const UNAVAILABLE = {
  status: 404,
  body: { msg: "Music URL not found, song may be unavailable at this quality level" },
};
const EMPTY_SEARCH = { status: 200, body: { code: 200, count: 0, list: [] } };
const TRACK = { id: "186109", name: "晴天", singer: "周杰伦", interval: "04:29" };
const song = (musicInfo = {}, quality = "hq") => ({
  source: "wy",
  quality,
  musicInfo: { ...TRACK, ...musicInfo },
});

const paths = (host) => host.requests.map(({ url }) => new URL(url).pathname);

test("a 429 opens a rate-limit cooldown that fails fast without new requests", async () => {
  let time = START;
  const host = loadPlugin({
    now: () => time,
    response: {
      status: 429,
      headers: { "Retry-After": "30" },
      body: { msg: "请求过于频繁，限制为 20 RPM" },
    },
  });

  await assert.rejects(
    host.handlers.musicUrl(song()),
    (error) => error.code === "CHKSZ_HTTP_429" && error.message.includes("30"),
  );
  assert.equal(host.requests.length, 1);

  await assert.rejects(
    host.handlers.musicUrl(song({ id: "another" })),
    (error) => error.code === "CHKSZ_RATE_LIMITED" && /秒后再试/.test(error.message),
  );
  assert.equal(host.requests.length, 1, "冷却期内不允许再发请求");

  time += 31_000;
  await assert.rejects(host.handlers.musicUrl(song({ id: "another" })));
  assert.equal(host.requests.length, 2, "冷却结束后恢复请求");
});

test("a 429 during cross-platform matching stops the fallback immediately", async () => {
  const host = loadPlugin({
    response: (url) =>
      url.pathname === "/api/163_music"
        ? UNAVAILABLE
        : { status: 429, headers: { "Retry-After": "20" }, body: { msg: "请求过于频繁" } },
  });

  await assert.rejects(
    host.handlers.musicUrl(song({}, "lq")),
    (error) => error.code === "CHKSZ_HTTP_429",
  );
  assert.deepEqual(paths(host), ["/api/163_music", "/api/qq_music"]);
});

test("an upstream 502 cools that platform down instead of re-probing it for the next song", async () => {
  let time = START;
  const host = loadPlugin({
    now: () => time,
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") {
        return { status: 404, body: { msg: "未找到匹配的歌曲" } };
      }
      return { status: 502, body: { msg: "error code: 502" } };
    },
  });

  await assert.rejects(
    host.handlers.musicUrl(song({}, "lq")),
    (error) => error.code === "CHKSZ_CROSS_PLATFORM_UNAVAILABLE",
  );
  assert.deepEqual(paths(host), ["/api/163_music", "/api/qq_music", "/api/kugou_music"]);

  host.requests.length = 0;
  await assert.rejects(
    host.handlers.musicUrl(song({ id: "22831636", name: "My jealousy (Original ver.)" }, "lq")),
    (error) =>
      error.code === "CHKSZ_CROSS_PLATFORM_UNAVAILABLE" &&
      error.message.includes("酷狗") &&
      error.message.includes("秒"),
  );
  assert.ok(
    !paths(host).includes("/api/kugou_music"),
    "酷狗通道在冷却期内不应再被请求",
  );

  time += 121_000;
  host.requests.length = 0;
  await assert.rejects(
    host.handlers.musicUrl(song({ id: "third", name: "第三人" }, "lq")),
    (error) => error.code === "CHKSZ_CROSS_PLATFORM_UNAVAILABLE",
  );
  assert.ok(paths(host).includes("/api/kugou_music"), "冷却结束后应重新探测酷狗");
});

test("skips a cooled primary platform before trying the next song", async () => {
  const host = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") {
        return { status: 502, body: { msg: "upstream unavailable" } };
      }
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return {
          status: 200,
          body: {
            code: 200,
            list: [{ name: "晴天", singer: "周杰伦", mid: "qq-cooldown-mid" }],
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
          url: "https://qq.example.test/cooldown.mp3",
        },
      };
    },
  });

  await host.handlers.musicUrl(song({ id: "primary-first" }, "lq"));

  host.requests.length = 0;
  const result = await host.handlers.musicUrl(song({ id: "primary-second" }, "lq"));

  assert.equal(result.url, "https://qq.example.test/cooldown.mp3");
  assert.ok(!paths(host).includes("/api/163_music"), "cooled primary must not be retried");
  assert.ok(paths(host).includes("/api/qq_music"), "fallback should try another platform");
});

test("reports an upstream outage instead of claiming the song does not exist", async () => {
  const host = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") {
        return { status: 404, body: { msg: "未找到匹配的歌曲" } };
      }
      return { status: 502, body: { msg: "error code: 502" } };
    },
  });

  await assert.rejects(
    host.handlers.musicUrl(song({}, "lq")),
    (error) =>
      error.code === "CHKSZ_CROSS_PLATFORM_UNAVAILABLE" &&
      error.message.includes("晴天") &&
      error.message.includes("QQ 音乐") &&
      error.message.includes("404") &&
      error.message.includes("酷狗") &&
      error.message.includes("502") &&
      !/未匹配到同一首歌/.test(error.message),
  );
});

test("keeps the dedicated no-match error when every platform answered without a candidate", async () => {
  const host = loadPlugin({
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
  });

  await assert.rejects(
    host.handlers.musicUrl(song({}, "lq")),
    (error) =>
      error.code === "CHKSZ_TRACK_UNAVAILABLE" && error.message.includes("晴天"),
  );
});

test("remembers a song without any playable primary quality and skips the ladder next time", async () => {
  let time = START;
  const host = loadPlugin({
    now: () => time,
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
  });
  const originRequests = () =>
    host.requests.filter(({ url }) => new URL(url).pathname === "/api/163_music").length;

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });
  assert.equal(originRequests(), 2, "hq 先在 exhigh、再到 standard 各探测一次");

  time += 90_000;
  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });
  assert.equal(originRequests(), 2, "曲目级记忆应避免重复整条网易云阶梯");
});

test("does not remember a track as unavailable when a later quality still resolves", async () => {
  let time = START;
  const host = loadPlugin({
    now: () => time,
    response: (url) =>
      url.searchParams.get("level") === "exhigh"
        ? UNAVAILABLE
        : { status: 200, body: { code: 200, url: "https://cdn.example.test/song.flac" } },
  });

  await host.handlers.musicUrl(song());
  host.requests.length = 0;
  time += 90_000;
  await host.handlers.musicUrl(song());

  assert.equal(
    host.requests.filter(({ url }) => new URL(url).pathname === "/api/163_music").length,
    2,
    "仍有可用音质时不得跳过阶梯",
  );
});
