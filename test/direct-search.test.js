import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

const START = 1_900_000_000_000;
const UNAVAILABLE = {
  status: 404,
  body: { msg: "Music URL not found, song may be unavailable at this quality level" },
};
const CHKSZ_SEARCH_404 = { status: 404, body: { code: 404, msg: "未找到匹配的歌曲" } };
const KUGOU_DOWN = { status: 502, body: "<!DOCTYPE html>", headers: { "Retry-After": "60" } };

/** NetEase track as SPlayer-Next passes it to musicUrl. */
const JAY_TRACK = { id: "186109", name: "晴天", singer: "周杰伦", source: "wy", interval: "04:29" };
const song = (musicInfo = {}, quality = "lq") => ({
  source: "wy",
  quality,
  musicInfo: { ...JAY_TRACK, ...musicInfo },
});

/** Raw shape of c.y.qq.com/soso/fcgi-bin/client_search_cp (format=json). */
const QQ_PUBLIC_HIT = {
  status: 200,
  body: {
    code: 0,
    data: {
      song: {
        list: [
          {
            songmid: "004Fs2FP1EvZYc",
            songname: "晴天 (Live)",
            singer: [{ id: 1, mid: "x", name: "周杰伦" }],
            interval: 249,
            albumname: "演唱会",
          },
          {
            songmid: "0039MnYb0qxYhV",
            songname: "晴天",
            singer: [{ id: 4558, mid: "0025NhlN2yWrP4", name: "周杰伦" }],
            interval: 269,
            albumname: "叶惠美",
          },
        ],
      },
    },
  },
};

const chkszPaths = (host) => host.requests.map(({ url }) => new URL(url).pathname);
const qqMidRequests = (host) =>
  host.requests.filter(({ url }) => new URL(url).searchParams.has("mid"));

/** ChKSz: NetEase unavailable, QQ search 404, QQ mid resolution works, Kugou down. */
const outageResponse = (url) => {
  if (url.pathname === "/api/163_music") return UNAVAILABLE;
  if (url.pathname === "/api/qq_music") {
    if (url.searchParams.has("mid")) {
      return {
        status: 200,
        body: {
          code: 200,
          name: "晴天",
          singer: "周杰伦",
          interval: "4:29",
          url: "https://qq.example.test/qingtian.mp3",
          mid: url.searchParams.get("mid"),
          bitrate: "320k",
        },
      };
    }
    return CHKSZ_SEARCH_404;
  }
  return KUGOU_DOWN;
};

test("resolves via QQ public search when the ChKSz QQ search returns 404 for the keyword", async () => {
  const host = loadPlugin({ response: outageResponse, directSearchResponse: QQ_PUBLIC_HIT });

  const result = await host.handlers.musicUrl(song());

  assert.equal(result.url, "https://qq.example.test/qingtian.mp3");
  assert.equal(result.quality, "hq");
  assert.equal(host.directSearches.length, 1, "公开搜索只发一次");
  const direct = new URL(host.directSearches[0].url);
  assert.equal(direct.host, "c.y.qq.com");
  assert.equal(direct.searchParams.get("w"), "晴天 周杰伦");
  assert.equal(direct.searchParams.get("format"), "json");
  assert.equal(host.directSearches[0].options.headers.Referer, "https://y.qq.com/");
  assert.ok(!direct.searchParams.has("apikey"), "公开搜索不能带 ChKSz Key");
  assert.equal(qqMidRequests(host).length, 1, "命中后按 mid 交给 ChKSz 解析");
  assert.equal(qqMidRequests(host)[0] && new URL(qqMidRequests(host)[0].url).searchParams.get("mid"), "0039MnYb0qxYhV", "精确标题优先于 Live 版本");
  assert.ok(!chkszPaths(host).includes("/api/kugou_music"), "QQ 已命中，不再探测酷狗");
  assert.ok(
    host.logs.some((entry) => entry.level === "info" && /QQ 音乐公开搜索返回 2 个候选/.test(entry.args.join(" "))),
  );
});

test("keeps the ChKSz outage diagnosis when the public search also fails", async () => {
  const host = loadPlugin({ response: outageResponse, directSearchResponse: { status: 503, body: "" } });

  await assert.rejects(
    host.handlers.musicUrl(song()),
    (error) =>
      error.code === "CHKSZ_CROSS_PLATFORM_UNAVAILABLE" &&
      error.message.includes("QQ 音乐") &&
      error.message.includes("404") &&
      error.message.includes("酷狗"),
  );
  assert.equal(host.directSearches.length, 1);
});

test("public search candidates still go through artist and duration matching", async () => {
  const host = loadPlugin({
    response: outageResponse,
    directSearchResponse: {
      status: 200,
      body: {
        code: 0,
        data: {
          song: {
            list: [
              { songmid: "wrong-artist", songname: "晴天", singer: [{ name: "林俊杰" }], interval: 269 },
              { songmid: "wrong-length", songname: "晴天", singer: [{ name: "周杰伦" }], interval: 180 },
            ],
          },
        },
      },
    },
  });

  await assert.rejects(host.handlers.musicUrl(song()));
  assert.equal(qqMidRequests(host).length, 0, "没有通过校验的候选，不应向 ChKSz 请求 mid");
});

test("the public search switch can be turned off", async () => {
  const host = loadPlugin({
    response: outageResponse,
    directSearchResponse: QQ_PUBLIC_HIT,
    settings: { directSearchFallback: false },
  });

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_CROSS_PLATFORM_UNAVAILABLE" });
  assert.equal(host.directSearches.length, 0);
});

test("public search results are reused within the smart cache window", async () => {
  const host = loadPlugin({ response: outageResponse, directSearchResponse: QQ_PUBLIC_HIT });

  await host.handlers.musicUrl(song());
  await host.handlers.musicUrl(song({}, "hq"));

  assert.equal(host.directSearches.length, 1, "同一关键词的公开搜索结果应复用");
});

test("does not consult the public search after an account-level ChKSz error", async () => {
  const host = loadPlugin({
    response: (url) =>
      url.pathname === "/api/163_music"
        ? UNAVAILABLE
        : { status: 429, headers: { "Retry-After": "20" }, body: { msg: "请求过于频繁" } },
    directSearchResponse: QQ_PUBLIC_HIT,
  });

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_HTTP_429" });
  assert.equal(host.directSearches.length, 0);
});

test("public search does not consume the ChKSz cross-platform request budget in economy mode", async () => {
  const host = loadPlugin({
    response: outageResponse,
    directSearchResponse: QQ_PUBLIC_HIT,
    settings: { economyMode: true },
  });

  const result = await host.handlers.musicUrl(song({}, "hq"));

  assert.equal(result.url, "https://qq.example.test/qingtian.mp3");
  // 163 exhigh + 163 standard + ChKSz QQ 搜索 + ChKSz QQ mid = 4 次 ChKSz 请求；公开搜索不计入。
  assert.equal(host.requests.length, 4);
});

test("three distinct keywords hitting search 404 put the ChKSz search on cooldown and go straight to public search", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: outageResponse, directSearchResponse: QQ_PUBLIC_HIT });

  for (const [id, name] of [["1", "晴天"], ["2", "说谎"], ["3", "恋人未满"]]) {
    await host.handlers.musicUrl(song({ id, name })).catch(() => {});
  }
  const before = chkszPaths(host).filter((path) => path === "/api/qq_music").length;
  host.requests.length = 0;

  await host.handlers.musicUrl(song({ id: "4", name: "世界末日" })).catch(() => {});
  const searchCalls = host.requests.filter(
    ({ url }) => new URL(url).pathname === "/api/qq_music" && new URL(url).searchParams.has("msg"),
  );
  assert.equal(searchCalls.length, 0, "冷却期内不再向 ChKSz 发 QQ 搜索");
  assert.ok(before >= 3);
  assert.ok(
    host.logs.some((entry) => entry.level === "warn" && /搜索通道故障冷却中/.test(entry.args.join(" "))),
  );

  time += 121_000;
  host.requests.length = 0;
  await host.handlers.musicUrl(song({ id: "5", name: "夜曲" })).catch(() => {});
  assert.ok(
    host.requests.some(({ url }) => new URL(url).searchParams.has("msg")),
    "冷却结束后恢复 ChKSz 搜索",
  );
});

test("a 5xx Retry-After header shortens the platform cooldown instead of the fixed two minutes", async () => {
  let time = START;
  const host = loadPlugin({
    now: () => time,
    directSearchResponse: { status: 503, body: "" },
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.pathname === "/api/qq_music") return CHKSZ_SEARCH_404;
      return { status: 502, headers: { "Retry-After": "45" }, body: "" };
    },
  });

  await assert.rejects(host.handlers.musicUrl(song()));
  host.requests.length = 0;
  time += 46_000;
  await assert.rejects(host.handlers.musicUrl(song({ id: "2", name: "说谎" })));
  assert.ok(chkszPaths(host).includes("/api/kugou_music"), "45 秒后酷狗应重新探测");
});

test("quota errors include the remaining free and paid quota from the response headers", async () => {
  const host = loadPlugin({
    response: {
      status: 402,
      headers: { "X-Quota-Free-Remaining": "0", "X-Quota-Paid-Remaining": "0" },
      body: { msg: "额度已用尽" },
    },
  });

  await assert.rejects(
    host.handlers.musicUrl(song()),
    (error) => error.code === "CHKSZ_HTTP_402" && /免费额度剩余 0，付费额度剩余 0/.test(error.message),
  );
});

test("search keywords are capped so Kugou does not reject them as too long", async () => {
  const longTitle = "很长的歌名".repeat(20);
  const host = loadPlugin({
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : CHKSZ_SEARCH_404),
    directSearchResponse: { status: 503, body: "" },
  });

  await assert.rejects(host.handlers.musicUrl(song({ name: longTitle })));
  const keywords = host.requests
    .map(({ url }) => new URL(url).searchParams.get("msg"))
    .filter(Boolean);
  assert.ok(keywords.length > 0);
  assert.ok(keywords.every((keyword) => keyword.length <= 60), `关键词过长：${keywords[0]?.length}`);
});
