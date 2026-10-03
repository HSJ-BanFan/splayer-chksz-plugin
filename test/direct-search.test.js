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

/** Captured QQ Lite response shape, including full versioned titles. */
const liteResponse = (list) => ({
  status: 200,
  body: { code: 0, request: { code: 0, data: { body: { item_song: list } } } },
});
const QQ_PUBLIC_HIT = liteResponse([
  { mid: "004Fs2FP1EvZYc", name: "晴天", title: "晴天 (Live)",
    singer: [{ name: "周杰伦" }], interval: 249, album: { name: "演唱会" } },
  { mid: "0039MnYb0qxYhV", title: "晴天", singer: [{ name: "周杰伦" }],
    interval: 269, album: { name: "叶惠美" } },
]);

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
  assert.equal(direct.host, "u.y.qq.com");
  assert.equal(direct.pathname, "/cgi-bin/musicu.fcg");
  const { options } = host.directSearches[0];
  assert.equal(options.method, "POST");
  assert.ok(options.timeout <= 4000);
  const payload = JSON.parse(options.body);
  assert.equal(payload.request.module, "music.search.SearchCgiService");
  assert.equal(payload.request.method, "DoSearchForQQMusicLite");
  assert.equal(payload.request.param.query, "晴天 周杰伦");
  assert.equal(payload.request.param.page_num, 1);
  assert.equal(payload.request.param.num_per_page, 10);
  assert.match(payload.request.param.search_id, /^\d+$/);
  assert.equal(payload.comm.ct, 11);
  assert.equal(payload.comm.tmeAppID, "qqmusiclight");
  assert.equal(payload.comm.cv, "1003006");
  assert.equal(payload.comm.v, "1003006");
  assert.equal(options.headers.Cookie, "tmeLoginType=-1;");
  assert.equal(options.headers.Referer, "https://y.qq.com");
  assert.ok(!JSON.stringify(options).includes("chksz_test_key"));
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
    directSearchResponse: liteResponse([
      { mid: "wrong-artist", title: "晴天", singer: [{ name: "林俊杰" }], interval: 269 },
      { mid: "wrong-length", title: "晴天", singer: [{ name: "周杰伦" }], interval: 180 },
    ]),
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

const qqSearchRequests = (host) => host.requests.filter(({ url }) => {
  const u = new URL(url);
  return u.pathname === "/api/qq_music" && u.searchParams.has("msg");
});
const upstreamSearchResponse = (url) =>
  url.pathname === "/api/qq_music" && url.searchParams.has("msg")
    ? { status: 503, body: { msg: "search upstream down" } }
    : outageResponse(url);

for (const [label, bad] of [
  ["inner business error", { status: 200, body: { code: 0, request: { code: 2001, data: { body: { item_song: [] } } } } }],
  ["outer business error", { status: 200, body: { code: 2001, request: { code: 0, data: { body: { item_song: [] } } } } }],
  ["missing business code", { status: 200, body: { request: { code: 0, data: { body: { item_song: [] } } } } }],
  ["missing list", { status: 200, body: { code: 0, request: { code: 0, data: {} } } }],
  ["non JSON", { status: 200, body: "<html>not JSON</html>" }],
  ["HTTP error", { status: 500, body: "" }],
]) {
  test(`Lite ${label} is a search failure, not an empty match, and is cooled independently`, async () => {
    let time = START;
    let failing = true;
    const host = loadPlugin({
      now: () => time,
      response: (url) => url.pathname === "/api/163_music" ? UNAVAILABLE : { status: 200, body: { list: [] } },
      directSearchResponse: () => failing ? bad : QQ_PUBLIC_HIT,
    });
    await assert.rejects(host.handlers.musicUrl(song()), (error) =>
      error.message.includes("QQ 音乐公开搜索") && !error.message.includes("以上是 ChKSz 服务端"));
    failing = false;
    await assert.rejects(host.handlers.musicUrl(song({ id: "second" })));
    assert.equal(host.directSearches.length, 1);
    time += 121_000;
    // Re-probe search after cooldown even if the later playback response is unavailable.
    await host.handlers.musicUrl(song({ id: "third" })).catch(() => {});
    assert.equal(host.directSearches.length, 2);
  });
}

test("a public-search failure preserves both providers' errors", async () => {
  const host = loadPlugin({ response: upstreamSearchResponse,
    directSearchResponse: { status: 500, body: "" } });
  await assert.rejects(host.handlers.musicUrl(song()), error =>
    error.code === "CHKSZ_CROSS_PLATFORM_UNAVAILABLE" &&
    /503/.test(error.message) && /500/.test(error.message) &&
    /QQ 音乐公开搜索/.test(error.message));
});

test("search failures never cool down a known-mid playback request", async () => {
  const host = loadPlugin({ response: upstreamSearchResponse,
    directSearchResponse: { status: 500, body: "" } });
  await assert.rejects(host.handlers.musicUrl(song()));
  const result = await host.handlers.musicUrl({ source: "tx", quality: "hq",
    musicInfo: { songmid: "0039MnYb0qxYhV" } });
  assert.equal(result.url, "https://qq.example.test/qingtian.mp3");
  assert.equal(qqMidRequests(host).length, 1);
});

test("503 search cooldown bypasses ChKSz but keeps Lite and playback available", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: upstreamSearchResponse, directSearchResponse: QQ_PUBLIC_HIT });
  await host.handlers.musicUrl(song());
  await host.handlers.musicUrl(song({ id: "second" }, "hq"));
  assert.equal(qqSearchRequests(host).length, 1);
  assert.equal(qqMidRequests(host).length, 2);
  assert.equal(host.directSearches.length, 1);
  time += 121_000;
  await host.handlers.musicUrl(song({ id: "third" }));
  assert.equal(qqSearchRequests(host).length, 2);
});

test("valid empty Lite results are cached for a minute without opening a cooldown", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: outageResponse, directSearchResponse: liteResponse([]) });
  await assert.rejects(host.handlers.musicUrl(song()));
  await assert.rejects(host.handlers.musicUrl(song({ id: "second" })));
  assert.equal(host.directSearches.length, 1);
  time += 61_000;
  await assert.rejects(host.handlers.musicUrl(song({ id: "third" })));
  assert.equal(host.directSearches.length, 2);
});

test("Lite cache ignores random search_id and expires after five minutes", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: outageResponse, directSearchResponse: QQ_PUBLIC_HIT });
  await host.handlers.musicUrl(song());
  time += 121_000;
  await host.handlers.musicUrl(song({ id: "second" }));
  assert.equal(host.directSearches.length, 1);
  time += 180_000;
  await host.handlers.musicUrl(song({ id: "third" }));
  assert.equal(host.directSearches.length, 2);
  const ids = host.directSearches.map(r => JSON.parse(r.options.body).request.param.search_id);
  assert.notEqual(ids[0], ids[1]);
});

for (const items of [
  [{ mid: "live", name: "晴天", title: "晴天 (Live)", singer: [{ name: "周杰伦" }], interval: 269 }],
  [{ title: "晴天", singer: [{ name: "周杰伦" }], interval: 269 }],
]) {
  test("Lite never uses a bare name or a missing mid to bypass candidate checks", async () => {
    const host = loadPlugin({ response: outageResponse, directSearchResponse: liteResponse(items) });
    await assert.rejects(host.handlers.musicUrl(song()));
    assert.equal(qqMidRequests(host).length, 0);
  });
}

test("Lite matches still require duration in the resolved QQ details", async () => {
  const host = loadPlugin({ response: url => {
    const result = outageResponse(url);
    return url.searchParams.has("mid") ? { ...result, body: { ...result.body, interval: undefined } } : result;
  }, directSearchResponse: QQ_PUBLIC_HIT });
  await assert.rejects(host.handlers.musicUrl(song()));
  assert.equal(qqMidRequests(host).length, 1);
  assert.ok(host.logs.some(l => /详情缺少有效时长/.test(l.args.join(" "))));
});

test("Lite timeouts are bounded without consuming the whole fallback deadline", async () => {
  const host = loadPlugin({ response: outageResponse, directSearchResponse: (_url, options) => {
    assert.equal(options.timeout, 4000);
    throw Object.assign(new Error("timed out"), { code: "PLUGIN_REQUEST_TIMEOUT" });
  } });
  await assert.rejects(host.handlers.musicUrl(song()), error => error.message.includes("timed out"));
  assert.ok(chkszPaths(host).includes("/api/kugou_music"));
  assert.equal(host.directSearches.length, 1);
});

test("Lite requests inherit a smaller remaining cross-platform deadline", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: url => {
    if (url.searchParams.has("msg") && url.pathname === "/api/qq_music") time += 8500;
    return outageResponse(url);
  }, directSearchResponse: (_url, options) => {
    assert.equal(options.timeout, 1500);
    return QQ_PUBLIC_HIT;
  } });
  await host.handlers.musicUrl(song());
});

test("Lite cancellation propagates and does not create a search cooldown", async () => {
  let cancel = true;
  const host = loadPlugin({ response: outageResponse, directSearchResponse: () => {
    if (cancel) throw Object.assign(new Error("cancelled"), { code: "PLUGIN_CANCELLED" });
    return QQ_PUBLIC_HIT;
  } });
  await assert.rejects(host.handlers.musicUrl(song()), { code: "PLUGIN_CANCELLED" });
  assert.ok(!chkszPaths(host).includes("/api/kugou_music"));
  cancel = false;
  await host.handlers.musicUrl(song());
  assert.equal(host.directSearches.length, 2);
});

test("a changed key invalidates a pending Lite response without caching it", async () => {
  let finish;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const host = loadPlugin({ response: outageResponse, directSearchResponse: () => {
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = host.handlers.musicUrl(song());
  await ready;
  host.setSetting("apiKey", "chksz_new_test_key");
  finish(QQ_PUBLIC_HIT);
  await assert.rejects(pending, { code: "CHKSZ_CONFIG_CHANGED" });
  assert.equal(qqMidRequests(host).length, 0);
});

test("a search cooldown plus a failed public search remains an error, not a no-match", async () => {
  const host = loadPlugin({ response: url => url.pathname === "/api/kugou_music"
    ? { status: 200, body: { list: [] } } : upstreamSearchResponse(url),
    directSearchResponse: { status: 500, body: "" } });
  await assert.rejects(host.handlers.musicUrl(song()));
  await assert.rejects(host.handlers.musicUrl(song({ id: "second" })), error =>
    error.code !== "CHKSZ_TRACK_UNAVAILABLE" && error.message.includes("QQ 音乐公开搜索"));
  assert.equal(host.directSearches.length, 1);
  assert.equal(qqSearchRequests(host).length, 1);
});

for (const throwsHostTimeout of [false, true]) {
  test(`a late Lite ${throwsHostTimeout ? "host timeout" : "response"} preserves the cross-platform deadline`, async () => {
    let time = START;
    const host = loadPlugin({ now: () => time, response: url => {
      if (url.searchParams.has("msg") && url.pathname === "/api/qq_music") time += 8500;
      return outageResponse(url);
    }, directSearchResponse: () => {
      time += 1600;
      if (throwsHostTimeout) throw Object.assign(new Error("timeout"), { code: "PLUGIN_REQUEST_TIMEOUT" });
      return QQ_PUBLIC_HIT;
    } });
    await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_CROSS_PLATFORM_LIMIT" });
    assert.equal(qqMidRequests(host).length, 0);
    assert.ok(!chkszPaths(host).includes("/api/kugou_music"));
  });
}

test("the overall deadline takes precedence over Lite's request timeout", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: url => {
    if (url.pathname === "/api/163_music") time += 9000;
    if (url.searchParams.has("msg") && url.pathname === "/api/qq_music") time += 8500;
    return outageResponse(url);
  }, directSearchResponse: (_url, options) => {
    assert.equal(options.timeout, 500);
    time += 501;
    throw Object.assign(new Error("timeout"), { code: "PLUGIN_REQUEST_TIMEOUT" });
  } });
  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_RESOLUTION_TIMEOUT" });
});

test("public search network errors are redacted and cooled without skipping ChKSz search", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: outageResponse, directSearchResponse: () => {
    throw new Error("network failed with chksz_test_key");
  } });
  await assert.rejects(host.handlers.musicUrl(song()), error => !error.message.includes("chksz_test_key"));
  time += 60000;
  await assert.rejects(host.handlers.musicUrl(song({ id: "second" })));
  assert.equal(host.directSearches.length, 1);
  assert.equal(qqSearchRequests(host).length, 2);
  time += 61000;
  await assert.rejects(host.handlers.musicUrl(song({ id: "third" })));
  assert.equal(host.directSearches.length, 2, "skipped requests must not extend cooldown");
  assert.ok(!JSON.stringify(host.logs).includes("chksz_test_key"));
});

test("Lite is never called on a ChKSz search hit or account failure", async () => {
  for (const status of [200, 401, 402, 403, 429]) {
    const host = loadPlugin({ response: url => {
      if (url.pathname === "/api/qq_music" && url.searchParams.has("msg")) {
        return status === 200 ? { status, body: { list: [{ mid: "0039MnYb0qxYhV", name: "晴天", singer: "周杰伦" }] } }
          : { status, body: { msg: "account rejected" } };
      }
      return outageResponse(url);
    }, directSearchResponse: QQ_PUBLIC_HIT });
    if (status === 200) await host.handlers.musicUrl(song());
    else await assert.rejects(host.handlers.musicUrl(song()), { code: `CHKSZ_HTTP_${status}` });
    assert.equal(host.directSearches.length, 0);
  }
});

test("a playback 503 still suppresses search and direct resolution until its cooldown expires", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, settings: { crossPlatformFallback: false },
    response: { status: 503, body: { msg: "playback down" } } });
  const input = { source: "tx", quality: "hq", musicInfo: { mid: "known-mid" } };
  await assert.rejects(host.handlers.musicUrl(input), { code: "CHKSZ_HTTP_503" });
  await assert.rejects(host.handlers.musicUrl(input), { code: "CHKSZ_CHANNEL_COOLDOWN" });
  assert.equal(host.requests.length, 1);
  time += 121000;
  await assert.rejects(host.handlers.musicUrl(input), { code: "CHKSZ_HTTP_503" });
  assert.equal(host.requests.length, 2);
});
