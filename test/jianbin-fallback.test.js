import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { loadPlugin as loadHost } from "./plugin-host.js";

// Fallback scenarios explicitly opt in; privacy-default checks use loadHost directly.
const loadPlugin = (options = {}) => loadHost({
  ...options,
  settings: { jianbinFallback: true, ...options.settings },
});

const START = 1_900_000_000_000;
const UNAVAILABLE = {
  status: 404,
  body: { msg: "Music URL not found, song may be unavailable at this quality level" },
};
const EMPTY_SEARCH = { status: 200, body: { code: 200, count: 0, list: [] } };
const LITE_EMPTY = {
  status: 200,
  body: { code: 0, request: { code: 0, data: { body: { item_song: [] } } } },
};
const TRACK = { id: "186109", name: "晴天", singer: "周杰伦", interval: "04:29" };
const song = (musicInfo = {}, { source = "wy", quality = "hq" } = {}) => ({
  source,
  quality,
  musicInfo: { source, ...TRACK, ...musicInfo },
});

const landing = (cookie) => ({
  status: 200,
  body: `<script>document.cookie="mk_visit=${cookie};path=/;max-age=43200;SameSite=Lax";location.reload()</script>`,
});

const searchResult = (items) => ({ status: 200, body: { code: 200, data: items } });

// 站点返回的 url 字段是相对地址；绝对地址只是同一签名的另一种写法。
const jianbinQuery = (type, id, { sign = "s1gn", t = 1_900_000_000 } = {}) =>
  `api.php?get=url&type=${type}&id=${id}&sign=${sign}&t=${t}`;
const jianbinUrl = (type, id, options) =>
  `https://www.jbsou.cn/${jianbinQuery(type, id, options)}`;

const result = (songid, { type = "kw", name = "晴天", artist = "周杰伦", ...urlOptions } = {}) => ({
  name,
  artist,
  songid,
  url: jianbinQuery(type, songid, urlOptions),
});

const bodyParams = (request) => new URLSearchParams(request.options.body);
const postOf = (host, predicate) =>
  host.jianbinRequests.find((request) =>
    request.options.method === "POST" && predicate(bodyParams(request), request),
  );
const requestIndex = (host, predicate) => host.hostRequests.findIndex(predicate);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const clock = () => {
  let time = START;
  let nextTimer = 0;
  const pending = new Map();
  return {
    now: () => time,
    timers: {
      setTimeout(callback, delay) {
        const id = ++nextTimer;
        pending.set(id, { callback, at: time + delay });
        return id;
      },
      clearTimeout(id) { pending.delete(id); },
    },
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, timer] of pending) {
        if (timer.at <= time) {
          pending.delete(id);
          timer.callback();
        }
      }
    },
  };
};

const outcome = (promise) => promise.then(
  (value) => ({ value }),
  (error) => ({ error }),
);

test("falls back to jianbin when the primary chksz path is unavailable", async () => {
  const t = 1_900_000_000;
  const playbackUrl = jianbinUrl("wy", "186109", { t });
  const host = loadPlugin({
    response: UNAVAILABLE,
    jianbinResponse: (url, options) =>
      options?.method === "POST"
        ? searchResult([result("186109", { type: "wy", t })])
        : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, playbackUrl);
  assert.equal(resolved.quality, "hq");
  assert.equal(resolved.expire, (t + 1_700 - 60) * 1000);
  assert.deepEqual(
    host.jianbinRequests.map(({ options }) => options.method),
    ["GET", "POST"],
  );
  const search = postOf(host, (params) => params.get("filter") === "id");
  assert.equal(search.options.body, "input=186109&filter=id&type=netease&page=1");
  assert.equal(search.options.headers.Cookie, "mk_visit=cookie-1");
  assert.equal(host.deliveryProbes.at(-1).url, playbackUrl);
});

test("uses the jianbin qq id lookup when the tx primary fails", async () => {
  const mid = "0039MnYb0qxYhV";
  const playbackUrl = jianbinUrl("qq", mid);
  const host = loadPlugin({
    response: UNAVAILABLE,
    jianbinResponse: (url, options) =>
      options?.method === "POST"
        ? searchResult([result(mid, { type: "qq" })])
        : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song({
    songmid: mid,
    name: "晴天",
  }, { source: "tx" }));

  assert.equal(resolved.url, playbackUrl);
  const search = postOf(host, (params) => params.get("filter") === "id");
  assert.equal(search.options.body, `input=${mid}&filter=id&type=qq&page=1`);
  assert.equal(host.requests.length, 2, "QQ 主渠道阶梯 320k / 128k 各探测一次");
});

test("uses the jianbin kugou id lookup when the kg primary fails", async () => {
  const hash = "0123456789abcdef0123456789abcdef";
  const playbackUrl = jianbinUrl("kg", hash);
  const host = loadPlugin({
    response: UNAVAILABLE,
    jianbinResponse: (url, options) =>
      options?.method === "POST"
        ? searchResult([result(hash, { type: "kg" })])
        : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song({
    id: hash,
    name: "晴天",
  }, { source: "kg" }));

  assert.equal(resolved.url, playbackUrl);
  const search = postOf(host, (params) => params.get("filter") === "id");
  assert.equal(search.options.body, `input=${hash}&filter=id&type=kugou&page=1`);
  assert.equal(host.requests.length, 2, "酷狗主渠道阶梯 320k / 128k 各探测一次");
});

test("tries jianbin id lookup before chksz cross-platform matching", async () => {
  const host = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.searchParams.has("msg")) {
        return { status: 200, body: { code: 200, list: [{ name: "晴天", singer: "周杰伦", mid: "qq-mid-1" }] } };
      }
      return {
        status: 200,
        body: { code: 200, name: "晴天", singer: "周杰伦", interval: "04:29", url: "https://qq.example.test/qingtian.mp3" },
      };
    },
    jianbinResponse: (url, options) =>
      options?.method === "POST" ? searchResult([]) : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, "https://qq.example.test/qingtian.mp3");
  const jianbinLookup = requestIndex(host, ({ url, options }) =>
    new URL(url).host === "www.jbsou.cn" && options.method === "POST");
  const chkszCross = requestIndex(host, ({ url }) =>
    new URL(url).host === "api.chksz.com" && new URL(url).searchParams.has("msg"));
  assert.ok(jianbinLookup >= 0 && jianbinLookup < chkszCross, "煎饼 ID 直查必须排在 ChKSz 跨平台之前");
  assert.equal(host.jianbinRequests.length, 2, "顺序 1 只做一次煎饼搜索");
});

test("tries chksz cross-platform before jianbin cross-type search", async () => {
  const host = loadPlugin({
    directSearchResponse: LITE_EMPTY,
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
    jianbinResponse: (url, options) => {
      if (options?.method !== "POST") return landing("cookie-1");
      const params = bodyParams({ options });
      if (params.get("filter") === "id") return searchResult([]);
      if (params.get("type") === "kuwo") return searchResult([result("kw-1")]);
      return searchResult([]);
    },
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, jianbinUrl("kw", "kw-1"));
  const jianbinLookup = requestIndex(host, ({ url, options }) =>
    new URL(url).host === "www.jbsou.cn" && options.method === "POST" && options.body.includes("filter=id"));
  const chkszCross = requestIndex(host, ({ url }) =>
    new URL(url).host === "api.chksz.com" && new URL(url).searchParams.has("msg"));
  const jianbinCross = requestIndex(host, ({ url, options }) =>
    new URL(url).host === "www.jbsou.cn" && options.method === "POST" && options.body.includes("filter=name"));
  assert.ok(jianbinLookup >= 0 && jianbinLookup < chkszCross && chkszCross < jianbinCross);
});

test("finds a kuwo match through jianbin when chksz cross-platform had none", async () => {
  const host = loadPlugin({
    directSearchResponse: LITE_EMPTY,
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
    jianbinResponse: (url, options) => {
      if (options?.method !== "POST") return landing("cookie-1");
      const params = bodyParams({ options });
      if (params.get("filter") === "id") return searchResult([]);
      if (params.get("type") !== "kuwo") return searchResult([]);
      return searchResult([
        result("kw-live", { name: "晴天 (Live)" }),
        result("kw-studio"),
      ]);
    },
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, jianbinUrl("kw", "kw-studio"));
  const crossSearch = postOf(host, (params) => params.get("filter") === "name");
  assert.equal(
    crossSearch.options.body,
    `input=${encodeURIComponent("晴天")}&filter=name&type=kuwo&page=1`,
  );
});

test("parses mk_visit from the landing page and sends it on the form search", async () => {
  const host = loadPlugin({
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => {
      if (options?.method !== "POST") return landing("mk-visit_9");
      if (options.headers.Cookie !== "mk_visit=mk-visit_9") {
        return { status: 403, body: "missing cached Cookie" };
      }
      const params = bodyParams({ options });
      const id = params.get("input");
      return searchResult([result(id, { type: "wy" })]);
    },
  });

  const first = await host.handlers.musicUrl(song());
  const second = await host.handlers.musicUrl(song({ id: "22831636" }));

  assert.deepEqual(
    host.jianbinRequests.map(({ options }) => options.method),
    ["GET", "POST", "POST"],
    "同一会话内 cookie 复用，第二首歌不再取首页",
  );
  const post = host.jianbinRequests[1];
  assert.equal(post.options.headers.Cookie, "mk_visit=mk-visit_9");
  assert.equal(
    post.options.headers["X-Requested-With"],
    "XMLHttpRequest",
    "缺少该头时站点返回 HTML 而不是 JSON",
  );
  assert.equal(
    post.options.headers["Content-Type"],
    "application/x-www-form-urlencoded; charset=UTF-8",
  );
  assert.equal(post.options.body, "input=186109&filter=id&type=netease&page=1");
  const secondPost = host.jianbinRequests[2];
  assert.equal(secondPost.options.headers.Cookie, "mk_visit=mk-visit_9");
  assert.equal(bodyParams(secondPost).get("input"), "22831636");
  assert.equal(secondPost.options.body, "input=22831636&filter=id&type=netease&page=1");
  assert.equal(first.url, jianbinUrl("wy", "186109"));
  assert.equal(second.url, jianbinUrl("wy", "22831636"));
  assert.equal(new URL(second.url).searchParams.get("id"), "22831636");
  assert.equal(host.deliveryProbes.length, 2);
});

test("accepts an absolute api.php url as well as the relative shape", async () => {
  const host = loadPlugin({
    response: UNAVAILABLE,
    jianbinResponse: (url, options) =>
      options?.method === "POST"
        ? searchResult([{
          name: "晴天",
          artist: "周杰伦",
          songid: "186109",
          url: jianbinUrl("wy", "186109", { t: 1_900_000_500 }),
        }])
        : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, jianbinUrl("wy", "186109", { t: 1_900_000_500 }));
});

test("treats a not-found id lookup as an empty search instead of a channel failure", async () => {
  const host = loadPlugin({
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
    jianbinResponse: (url, options) => {
      if (options?.method !== "POST") return landing("cookie-1");
      const params = bodyParams({ options });
      if (params.get("filter") === "id") {
        return { status: 200, body: { data: "", code: 404, error: "没有找到相关信息" } };
      }
      if (params.get("type") === "kuwo") return searchResult([result("kw-1")]);
      return searchResult([]);
    },
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, jianbinUrl("kw", "kw-1"));
  const jianbinPosts = host.jianbinRequests.filter(({ options }) => options.method === "POST");
  assert.deepEqual(
    jianbinPosts.map((request) => bodyParams(request).get("filter")),
    ["id", "name"],
    "无结果不打开冷却，跨类型搜索照常进行",
  );
});

test("ignores id-lookup echoes without a song name", async () => {
  const host = loadPlugin({
    directSearchResponse: LITE_EMPTY,
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
    jianbinResponse: (url, options) => {
      if (options?.method !== "POST") return landing("cookie-1");
      const params = bodyParams({ options });
      if (params.get("filter") === "id") {
        const id = params.get("input");
        return searchResult([{ name: "", artist: "", songid: id, url: jianbinQuery("wy", id) }]);
      }
      return searchResult([]);
    },
  });

  await assert.rejects(
    host.handlers.musicUrl(song()),
    (error) => error.code === "CHKSZ_TRACK_UNAVAILABLE",
  );
  assert.equal(host.deliveryProbes.length, 0, "无歌名的回显条目不得进入交付体检");
});

test("refreshes mk_visit once after a search 403 and retries", async () => {
  for (const forbidden of [
    { status: 403, body: "code=403" },
    { status: 200, body: { code: 403 } },
  ]) {
    let landingCount = 0;
    let searchCount = 0;
    const host = loadPlugin({
      response: UNAVAILABLE,
      jianbinResponse: (url, options) => {
        if (options?.method !== "POST") {
          landingCount += 1;
          return landing(`cookie-${landingCount}`);
        }
        searchCount += 1;
        return searchCount === 1
          ? forbidden
          : searchResult([result("186109", { type: "wy" })]);
      },
    });

    const resolved = await host.handlers.musicUrl(song());

    assert.equal(resolved.url, jianbinUrl("wy", "186109"));
    assert.deepEqual(
      host.jianbinRequests.map(({ options }) => options.method),
      ["GET", "POST", "GET", "POST"],
    );
    assert.equal(host.jianbinRequests[1].options.headers.Cookie, "mk_visit=cookie-1");
    assert.equal(host.jianbinRequests[3].options.headers.Cookie, "mk_visit=cookie-2");
    assert.equal(host.jianbinRequests[3].options.body, host.jianbinRequests[1].options.body);
  }
});

test("cools jianbin down after a repeated 403 without tripping account error handling", async () => {
  let time = START;
  const host = loadPlugin({
    now: () => time,
    directSearchResponse: LITE_EMPTY,
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
    jianbinResponse: (url, options) =>
      options?.method === "POST"
        ? { status: 403, body: "code=403" }
        : landing("cookie-1"),
  });

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });
  assert.equal(host.jianbinRequests.length, 4, "首次搜索 + 刷新后重试各取一次 cookie");

  await assert.rejects(host.handlers.musicUrl(song({ id: "22831636" })), {
    code: "CHKSZ_TRACK_UNAVAILABLE",
  });
  assert.equal(host.jianbinRequests.length, 4, "冷却期内不再请求煎饼，也不进入账户错误处理");

  time += 121_000;
  await assert.rejects(host.handlers.musicUrl(song({ id: "third" })), {
    code: "CHKSZ_TRACK_UNAVAILABLE",
  });
  assert.equal(
    host.jianbinRequests.length,
    7,
    "冷却结束后先复用 cookie 搜索，403 后再取一次 cookie 重试",
  );
});

test("jianbin fallback can be disabled without extra jbsou requests", async () => {
  const host = loadPlugin({
    settings: { jianbinFallback: false },
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.searchParams.has("msg")) {
        return { status: 200, body: { code: 200, list: [{ name: "晴天", singer: "周杰伦", mid: "qq-mid-1" }] } };
      }
      return {
        status: 200,
        body: { code: 200, name: "晴天", singer: "周杰伦", interval: "04:29", url: "https://qq.example.test/qingtian.mp3" },
      };
    },
    jianbinResponse: landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, "https://qq.example.test/qingtian.mp3");
  assert.equal(host.jianbinRequests.length, 0);
});

test("rejects jianbin candidates whose title artist or version marker differs", async () => {
  const cases = [
    { track: {}, candidate: { name: "晴天 (Live)" } },
    { track: {}, candidate: { artist: "陈奕迅" } },
    {
      track: { name: "My jealousy (Original ver.)", singer: "DJMAX", interval: "02:33" },
      candidate: { name: "My jealousy", artist: "DJMAX" },
    },
  ];
  for (const { track, candidate } of cases) {
    const host = loadPlugin({
      directSearchResponse: LITE_EMPTY,
      response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
      jianbinResponse: (url, options) =>
        options?.method === "POST"
          ? searchResult([result("kw-bad", candidate)])
          : landing("cookie-1"),
    });

    await assert.rejects(
      host.handlers.musicUrl(song(track)),
      (error) =>
        error.code === "CHKSZ_TRACK_UNAVAILABLE" && error.message.includes("煎饼免费源已尝试"),
    );
    assert.equal(host.deliveryProbes.length, 0, "被拒候选不得进入交付体检");
  }
});

test("rejects foreign or mismatched api.php urls", async () => {
  const cases = [
    { name: "foreign", url: "https://evil.example/api.php?get=url&type=kw&id=kw-1&sign=s&t=1900000000" },
    { name: "wrong type", url: jianbinUrl("qq", "kw-1") },
    { name: "id mismatch", url: jianbinUrl("kw", "other-song") },
    { name: "missing sign", url: jianbinUrl("kw", "kw-1", { sign: "" }) },
    { name: "zero timestamp", url: jianbinUrl("kw", "kw-1", { t: 0 }) },
  ];
  for (const { name, url } of cases) {
    const host = loadPlugin({
      settings: { economyMode: true },
      directSearchResponse: LITE_EMPTY,
      response: (url, options) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
      jianbinResponse: (requestUrl, options) => {
        if (options?.method !== "POST") return landing("cookie-1");
        const params = bodyParams({ options });
        if (params.get("filter") === "id") return searchResult([]);
        if (params.get("type") === "kuwo") {
          return searchResult([{ name: "晴天", artist: "周杰伦", songid: "kw-1", url }]);
        }
        return searchResult([]);
      },
    });

    await assert.rejects(
      host.handlers.musicUrl(song()),
      (error) =>
        error.code === "CHKSZ_TRACK_UNAVAILABLE" &&
        !error.message.includes("jbsou.cn/api.php"),
      `case ${name}`,
    );
    assert.equal(host.deliveryProbes.length, 0, `case ${name}`);
    assert.equal(host.jianbinRequests.length, 3, "economy budget ends after bootstrap, ID and name search");
    assert.ok(
      !host.jianbinRequests.some((request) =>
        request.options.method === "POST" && bodyParams(request).get("type") === "qq"),
      `case ${name}`,
    );
  }
});

test("caps jianbin quality at hq and derives expiry from the signature time", async () => {
  const t = 1_900_100_000;
  const host = loadPlugin({
    now: () => START,
    response: UNAVAILABLE,
    jianbinResponse: (url, options) =>
      options?.method === "POST"
        ? searchResult([result("186109", { type: "wy", t })])
        : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song({}, { quality: "hi-res" }));

  assert.equal(resolved.quality, "hq");
  assert.equal(resolved.expire, (t + 1_700 - 60) * 1000);

  host.jianbinRequests.length = 0;
  const cached = await host.handlers.musicUrl(song({}, { quality: "hi-res" }));
  assert.equal(cached.url, resolved.url);
  assert.equal(host.jianbinRequests.length, 0, "缓存命中不再请求煎饼");
});

test("stops jianbin after its shared request budget is exhausted", async () => {
  const host = loadPlugin({
    directSearchResponse: LITE_EMPTY,
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
    probeResponse: (url) => (url.host === "www.jbsou.cn"
      ? { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<html>err</html>" }
      : { status: 206, body: new Uint8Array([0x66]) }),
    jianbinResponse: (url, options) => {
      if (options?.method !== "POST") return landing("cookie-1");
      const params = bodyParams({ options });
      if (params.get("filter") === "id") return searchResult([]);
      if (params.get("type") === "kuwo") {
        return searchResult([result("kw-1"), result("kw-2"), result("kw-3")]);
      }
      return searchResult([result("qq-1", { type: "qq" })]);
    },
  });

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });

  const jianbinTraffic = host.hostRequests.filter(({ url }) => new URL(url).host === "www.jbsou.cn");
  assert.equal(jianbinTraffic.length, 6, "共享预算 6 次用尽后必须停止煎饼");
  assert.equal(host.jianbinRequests.length, 3, "首页 + 两次搜索，第三次搜索已被预算拦下");
  assert.ok(
    !host.jianbinRequests.some((request) => bodyParams(request).get("type") === "qq"),
  );
});

test("keeps chksz cross-platform behavior when jianbin is unavailable", async () => {
  const host = loadPlugin({
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.searchParams.has("msg")) {
        return { status: 200, body: { code: 200, list: [{ name: "晴天", singer: "周杰伦", mid: "qq-mid-1" }] } };
      }
      return {
        status: 200,
        body: { code: 200, name: "晴天", singer: "周杰伦", interval: "04:29", url: "https://qq.example.test/qingtian.mp3" },
      };
    },
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.deepEqual(
    host.requests.map(({ url }) => {
      const parsed = new URL(url);
      const params = Object.fromEntries(parsed.searchParams.entries());
      delete params.apikey;
      return { path: parsed.pathname, params };
    }),
    [
      { path: "/api/163_music", params: { id: "186109", level: "exhigh", type: "json" } },
      { path: "/api/163_music", params: { id: "186109", level: "standard", type: "json" } },
      { path: "/api/qq_music", params: { num: "10", msg: "晴天 周杰伦" } },
      { path: "/api/qq_music", params: { mid: "qq-mid-1", size: "320k", type: "json" } },
    ],
  );
  assert.equal(resolved.url, "https://qq.example.test/qingtian.mp3");
  assert.deepEqual(
    host.jianbinRequests.map(({ options }) => options.method),
    ["GET"],
    "煎饼默认不可用时只失败一次，不重试",
  );
});

test("does not run jianbin on account errors cancellation or pure delivery failures", async () => {
  const account = loadPlugin({ response: { status: 402, body: { msg: "今日额度已用尽" } } });
  await assert.rejects(account.handlers.musicUrl(song()), { code: "CHKSZ_HTTP_402" });
  assert.equal(account.jianbinRequests.length, 0);

  const cancelled = loadPlugin({
    response: () => {
      throw Object.assign(new Error("cancelled"), { code: "PLUGIN_CANCELLED" });
    },
  });
  await assert.rejects(cancelled.handlers.musicUrl(song()), { code: "PLUGIN_CANCELLED" });
  assert.equal(cancelled.jianbinRequests.length, 0);

  const delivery = loadPlugin({
    response: { status: 200, body: { code: 200, url: "https://cdn.example.test/song.mp3" } },
    probeResponse: { status: 403, body: new Uint8Array(0) },
  });
  await assert.rejects(delivery.handlers.musicUrl(song()), { code: "CHKSZ_DELIVERY_UNUSABLE" });
  assert.equal(delivery.jianbinRequests.length, 0);
});

for (const [label, singer] of [
  ["missing singer", undefined],
  ["empty singer", ""],
  ["unparseable singer", " / ， & "],
]) {
  test(`rejects cross-type matches with ${label}`, async () => {
    const host = loadPlugin({
      directSearchResponse: LITE_EMPTY,
      response: (url) => url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH,
      jianbinResponse: (url, options) => {
        if (options.method !== "POST") return landing("cookie-1");
        return bodyParams({ options }).get("filter") === "id"
          ? searchResult([])
          : searchResult([result("unrelated", { artist: "Unrelated Artist" })]);
      },
    });

    await assert.rejects(host.handlers.musicUrl(song({ singer })), {
      code: "CHKSZ_TRACK_UNAVAILABLE",
    });
    assert.equal(host.deliveryProbes.length, 0, "unknown source singer cannot verify a match");
  });
}

for (const [label, track, candidate] of [
  ["different title and singer", {}, { name: "另一首歌", artist: "Unrelated Artist" }],
  ["different version", {}, { name: "晴天 (Live)" }],
  ["different singer", {}, { artist: "Unrelated Artist" }],
  ["missing candidate singer", {}, { artist: "" }],
  ["missing source singer", { singer: undefined }, {}],
  ["unparseable source singer", { singer: " / ， & " }, {}],
  ["relaxed original version", { name: "晴天 (Original ver.)" }, {}],
]) {
  test(`validates same-platform name fallback against ${label}`, async () => {
    const host = loadPlugin({
      settings: { crossPlatformFallback: false },
      response: UNAVAILABLE,
      jianbinResponse: (url, options) => options.method === "POST"
        ? searchResult([result("22831636", { type: "wy", ...candidate })])
        : landing("cookie-1"),
    });

    await assert.rejects(host.handlers.musicUrl(song({ id: "invalid-id", ...track })), {
      code: "CHKSZ_HTTP_404",
    });
    assert.equal(host.deliveryProbes.length, 0, "unverified name results cannot reach delivery");
  });
}

test("accepts a strictly matched same-platform name fallback", async () => {
  const host = loadPlugin({
    settings: { crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => options.method === "POST"
      ? searchResult([result("22831636", { type: "wy", artist: "周杰伦 / 合作者" })])
      : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song({ id: "invalid-id" }));

  assert.equal(resolved.url, jianbinUrl("wy", "22831636"));
  assert.equal(bodyParams(host.jianbinRequests[1]).get("filter"), "name");
  assert.equal(host.deliveryProbes.length, 1);
});

test("skips a malformed cross-type candidate URL without cooling later candidates", async () => {
  const host = loadPlugin({
    directSearchResponse: LITE_EMPTY,
    response: (url) => url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") return landing("cookie-1");
      const params = bodyParams({ options });
      if (params.get("filter") === "id") return searchResult([]);
      return searchResult([
        { ...result("malformed"), url: "https://[" },
        result("valid-later"),
      ]);
    },
  });

  const first = await host.handlers.musicUrl(song());
  const second = await host.handlers.musicUrl(song({ id: "22831636" }));

  assert.equal(first.url, jianbinUrl("kw", "valid-later"));
  assert.equal(second.url, first.url);
  assert.equal(host.deliveryProbes.length, 1, "only the valid candidate is probed and cached");
  assert.equal(host.jianbinRequests.length, 5, "candidate rejection must not cool the service");
});

test("tries later exact-ID candidates after a malformed URL", async () => {
  const host = loadPlugin({
    settings: { crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => options.method === "POST"
      ? searchResult([
        { ...result("186109", { type: "wy" }), url: "https://[" },
        result("186109", { type: "wy" }),
      ])
      : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, jianbinUrl("wy", "186109"));
  assert.equal(host.deliveryProbes.length, 1);
  assert.equal(host.jianbinRequests.length, 2);
});

test("malformed candidate URLs do not consume the economy candidate cap", async () => {
  const host = loadPlugin({
    settings: { economyMode: true, crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => options.method === "POST"
      ? searchResult([
        { ...result("bad", { type: "wy" }), url: "https://[" },
        result("22831636", { type: "wy" }),
      ])
      : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song({ id: "invalid-id" }));

  assert.equal(resolved.url, jianbinUrl("wy", "22831636"));
  assert.equal(host.deliveryProbes.length, 1);
  assert.equal(host.hostRequests.filter(({ url }) => new URL(url).host === "www.jbsou.cn").length, 3);
});

test("an all-malformed result list leaves later search types available", async () => {
  const host = loadPlugin({
    directSearchResponse: LITE_EMPTY,
    response: (url) => url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") return landing("cookie-1");
      const params = bodyParams({ options });
      if (params.get("filter") === "id") return searchResult([]);
      return params.get("type") === "kuwo"
        ? searchResult([{ ...result("malformed"), url: "https://[" }])
        : searchResult([result("qq-later", { type: "qq" })]);
    },
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, jianbinUrl("qq", "qq-later"));
  assert.equal(host.deliveryProbes.length, 1);
  assert.deepEqual(host.jianbinRequests.filter(({ options }) => options.method === "POST")
    .map((request) => bodyParams(request).get("type")), ["netease", "kuwo", "qq"]);
});

test("skips invalid candidate items before a valid same-platform result", async () => {
  const host = loadPlugin({
    settings: { crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => options.method === "POST"
      ? searchResult([
        null,
        "invalid item",
        { ...result("bad", { type: "wy" }), songid: { invalid: true } },
        result("22831636", { type: "wy" }),
      ])
      : landing("cookie-1"),
  });

  const resolved = await host.handlers.musicUrl(song({ id: "invalid-id" }));

  assert.equal(resolved.url, jianbinUrl("wy", "22831636"));
  assert.equal(host.deliveryProbes.length, 1);
});

for (const stage of ["same", "cross"]) {
  test(`caps delivery probes at the remaining ${stage}-type stage time`, async () => {
    const time = clock();
    const host = loadPlugin({
      ...time,
      directSearchResponse: LITE_EMPTY,
      response: (url) => url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH,
      jianbinResponse: (url, options) => {
        if (options.method !== "POST") return landing("cookie-1");
        const params = bodyParams({ options });
        if (params.get("filter") === "id" && stage === "cross") return searchResult([]);
        if (stage === "cross" && params.get("type") === "kuwo") {
          time.advance(2_900);
          return searchResult([]);
        }
        time.advance(stage === "same" ? 3_900 : 3_000);
        return searchResult([result(stage === "same" ? "186109" : "qq-stage", {
          type: stage === "same" ? "wy" : "qq",
        })]);
      },
    });

    const resolved = await host.handlers.musicUrl(song());

    assert.equal(resolved.url, jianbinUrl(stage === "same" ? "wy" : "qq",
      stage === "same" ? "186109" : "qq-stage"));
    assert.equal(host.deliveryProbes[0].options.timeout, 100);
  });
}

for (const provider of ["primary", "jianbin"]) {
  test(`propagates delivery cancellation from ${provider}`, async () => {
    const cancellation = Object.assign(new Error("cancelled probe"), { code: "PLUGIN_CANCELLED" });
    const host = loadPlugin({
      response: provider === "primary"
        ? { status: 200, body: { code: 200, url: "https://cdn.example.test/song.mp3" } }
        : UNAVAILABLE,
      jianbinResponse: (url, options) => options.method === "POST"
        ? searchResult([result("186109", { type: "wy" })])
        : landing("cookie-1"),
      probeResponse: () => { throw cancellation; },
    });

    await assert.rejects(host.handlers.musicUrl(song()), { code: "PLUGIN_CANCELLED" });
    assert.equal(host.deliveryProbes.length, 1);
    assert.equal(host.requests.length, provider === "primary" ? 1 : 2);
    assert.equal(host.jianbinRequests.length, provider === "primary" ? 0 : 2);
  });
}

for (const method of ["GET", "POST"]) {
  for (const [label, status, retryAfter, seconds] of [
    ["numeric seconds", 429, "300", 300],
    ["HTTP date", 429, new Date(START + 300_000).toUTCString(), 300],
    ["503 numeric seconds", 503, "300", 300],
    ["503 HTTP date", 503, new Date(START + 300_000).toUTCString(), 300],
    ["clamped numeric seconds", 429, "999999", 900],
    ["clamped HTTP date", 429, new Date(START + 86_400_000).toUTCString(), 900],
    ["malformed header", 429, "invalid", 60],
    ["past HTTP date", 429, new Date(START - 1_000).toUTCString(), 60],
    ["negative seconds", 429, "-300", 60],
    ["zero seconds", 429, "0", 60],
    ["malformed 503 header", 503, "invalid", 120],
  ]) {
    test(`honors ${method} Retry-After ${label}`, async () => {
      const time = clock();
      const failure = { status, headers: { "Retry-After": retryAfter }, body: "unavailable" };
      const host = loadPlugin({
        ...time,
        settings: { crossPlatformFallback: false },
        response: UNAVAILABLE,
        jianbinResponse: (url, options) => options.method === method
          ? failure
          : landing("cookie-1"),
      });

      await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_HTTP_404" });
      const count = host.jianbinRequests.length;
      assert.equal(count, method === "GET" ? 1 : 2);
      time.advance(seconds * 1000 - 1);
      await assert.rejects(host.handlers.musicUrl(song({ id: "22831636" })), {
        code: "CHKSZ_HTTP_404",
      });
      assert.equal(host.jianbinRequests.length, count, "Retry-After must prevent early traffic");
      time.advance(2);
      await assert.rejects(host.handlers.musicUrl(song({ id: "100" })), {
        code: "CHKSZ_HTTP_404",
      });
      assert.equal(host.jianbinRequests.length, count + 1, "cooldown must expire at its deadline");
    });
  }
}

test("a concurrent shorter service failure cannot shorten a longer cooldown", async () => {
  const time = clock();
  const firstPost = deferred();
  const secondPost = deferred();
  const firstReady = deferred();
  const secondReady = deferred();
  const host = loadPlugin({
    ...time,
    settings: { crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") return landing("cookie-1");
      const id = bodyParams({ options }).get("input");
      if (id === "186109") { firstReady.resolve(); return firstPost.promise; }
      if (id === "22831636") { secondReady.resolve(); return secondPost.promise; }
      return searchResult([]);
    },
  });

  const first = outcome(host.handlers.musicUrl(song()));
  await firstReady.promise;
  const second = outcome(host.handlers.musicUrl(song({ id: "22831636" })));
  await secondReady.promise;
  firstPost.resolve({ status: 429, headers: { "Retry-After": "600" }, body: "limited" });
  assert.equal((await first).error.code, "CHKSZ_HTTP_404");
  secondPost.resolve({ status: 503, body: "unavailable" });
  assert.equal((await second).error.code, "CHKSZ_HTTP_404");
  const count = host.jianbinRequests.length;

  time.advance(121_000);
  await assert.rejects(host.handlers.musicUrl(song({ id: "300" })), { code: "CHKSZ_HTTP_404" });
  assert.equal(host.jianbinRequests.length, count, "503 must preserve the active 600s deadline");
  time.advance(479_001);
  await assert.rejects(host.handlers.musicUrl(song({ id: "400" })), { code: "CHKSZ_HTTP_404" });
  assert.equal(host.jianbinRequests.length, count + 1);
});

for (const deadline of ["stage", "overall"]) {
  test(`a short ${deadline} waiter cannot fail the shared cookie bootstrap`, async () => {
    const time = clock();
    const page = deferred();
    const ready = deferred();
    let landingCount = 0;
    let firstPrimary = true;
    const host = loadPlugin({
      ...time,
      settings: { crossPlatformFallback: false, smartCache: false },
      response: () => {
        if (deadline === "overall" && firstPrimary) time.advance(17_900);
        firstPrimary = false;
        return UNAVAILABLE;
      },
      jianbinResponse: (url, options) => {
        if (options.method !== "POST") {
          landingCount += 1;
          if (deadline === "stage" && landingCount === 1) return landing("cookie-1");
          ready.resolve();
          return page.promise;
        }
        const id = bodyParams({ options }).get("input");
        if (deadline === "stage" && options.headers.Cookie === "mk_visit=cookie-1") {
          time.advance(3_900);
          return { status: 403, body: "refresh needed" };
        }
        return searchResult([result(id, { type: "wy" })]);
      },
    });

    const first = outcome(host.handlers.musicUrl(song()));
    await ready.promise;
    const second = outcome(host.handlers.musicUrl(song({ id: "22831636" })));
    await setImmediate();
    time.advance(100);
    const firstResult = await first;
    page.resolve(landing("cookie-2"));
    const secondResult = await second;

    assert.equal(secondResult.error, undefined, "healthy waiter must survive the other caller's timeout");
    assert.equal(secondResult.value.url, jianbinUrl("wy", "22831636"));
    assert.equal(firstResult.error.code, deadline === "overall"
      ? "CHKSZ_RESOLUTION_TIMEOUT" : "CHKSZ_HTTP_404");
    assert.equal(host.jianbinRequests.filter(({ options }) => options.method === "GET").at(-1)
      .options.timeout, 4_000, "shared network timeout belongs to the bootstrap operation");
    assert.equal(landingCount, deadline === "stage" ? 2 : 1);
    assert.equal(host.deliveryProbes.length, 1);
  });
}

test("only the initiating waiter receives a host-cancelled cookie bootstrap", async () => {
  const page = deferred();
  const ready = deferred();
  let landingCount = 0;
  const host = loadPlugin({
    settings: { crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") {
        landingCount += 1;
        if (landingCount > 1) return landing("cookie-2");
        ready.resolve();
        return page.promise;
      }
      const id = bodyParams({ options }).get("input");
      return searchResult([result(id, { type: "wy" })]);
    },
  });

  const first = outcome(host.handlers.musicUrl(song()));
  await ready.promise;
  const second = outcome(host.handlers.musicUrl(song({ id: "22831636" })));
  await setImmediate();
  page.reject(Object.assign(new Error("initiating request cancelled"), { code: "PLUGIN_CANCELLED" }));
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.error.code, "PLUGIN_CANCELLED");
  assert.equal(secondResult.error, undefined, "live waiters may retry a cancelled owner's bootstrap");
  assert.equal(secondResult.value.url, jianbinUrl("wy", "22831636"));
  assert.equal(landingCount, 2);
  assert.equal(host.jianbinRequests.filter(({ options }) => options.method === "POST").length, 1);
});

test("charges each shared-bootstrap waiter against its own economy request budget", async () => {
  const page = deferred();
  const ready = deferred();
  let landingCount = 0;
  const host = loadPlugin({
    settings: { crossPlatformFallback: false, economyMode: true },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") {
        landingCount += 1;
        if (landingCount > 1) return landing("cookie-2");
        ready.resolve();
        return page.promise;
      }
      const id = bodyParams({ options }).get("input");
      return id === "22831636" && options.headers.Cookie === "mk_visit=cookie-1"
        ? { status: 403, body: "refresh needed" }
        : searchResult([result(id, { type: "wy" })]);
    },
  });

  const first = outcome(host.handlers.musicUrl(song()));
  await ready.promise;
  const second = outcome(host.handlers.musicUrl(song({ id: "22831636" })));
  await setImmediate();
  page.resolve(landing("cookie-1"));
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.value.url, jianbinUrl("wy", "186109"));
  assert.equal(secondResult.error.code, "CHKSZ_HTTP_404");
  assert.equal(host.jianbinRequests.filter((request) => request.options.method === "POST" &&
    bodyParams(request).get("input") === "22831636").length, 1,
  "shared GET + first POST + refresh GET exhaust the caller's three requests");
});

test("a stale 403 cannot discard the cookie refreshed by another request", async () => {
  const delayed = deferred();
  const ready = deferred();
  let landingCount = 0;
  const host = loadPlugin({
    settings: { crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") return landing(`cookie-${++landingCount}`);
      const id = bodyParams({ options }).get("input");
      if (options.headers.Cookie === "mk_visit=cookie-1") {
        if (id === "186109") { ready.resolve(); return delayed.promise; }
        return { status: 403, body: "expired cookie" };
      }
      return searchResult([result(id, { type: "wy" })]);
    },
  });

  const first = outcome(host.handlers.musicUrl(song()));
  await ready.promise;
  const second = await host.handlers.musicUrl(song({ id: "22831636" }));
  delayed.resolve({ status: 403, body: "delayed expired cookie" });
  const firstResult = await first;

  assert.equal(second.url, jianbinUrl("wy", "22831636"));
  assert.equal(firstResult.value.url, jianbinUrl("wy", "186109"));
  assert.equal(landingCount, 2, "a delayed cookie-1 failure must reuse cookie-2");
  assert.equal(host.jianbinRequests.at(-1).options.headers.Cookie, "mk_visit=cookie-2");
});

test("shared bootstrap results cannot populate a replacement configuration session", async () => {
  const page = deferred();
  const ready = deferred();
  let landingCount = 0;
  const host = loadPlugin({
    settings: { crossPlatformFallback: false },
    response: UNAVAILABLE,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") {
        landingCount += 1;
        if (landingCount > 1) return landing("cookie-new");
        ready.resolve();
        return page.promise;
      }
      return searchResult([result(bodyParams({ options }).get("input"), { type: "wy" })]);
    },
  });

  const first = outcome(host.handlers.musicUrl(song()));
  await ready.promise;
  const second = outcome(host.handlers.musicUrl(song({ id: "22831636" })));
  await setImmediate();
  host.setSetting("apiKey", "chksz_replaced_key");
  page.resolve(landing("cookie-old"));
  const results = await Promise.all([first, second]);

  assert.deepEqual(results.map(({ error }) => error.code), ["CHKSZ_CONFIG_CHANGED", "CHKSZ_CONFIG_CHANGED"]);
  assert.equal(host.jianbinRequests.length, 1, "old session must not search with its cookie");
  const resolved = await host.handlers.musicUrl(song({ id: "300" }));
  assert.equal(resolved.url, jianbinUrl("wy", "300"));
  assert.equal(landingCount, 2);
  assert.equal(host.jianbinRequests.at(-1).options.headers.Cookie, "mk_visit=cookie-new");
});

for (const [label, settings] of [
  ["unset", {}],
  ["null", { jianbinFallback: null }],
  ["empty", { jianbinFallback: "" }],
  ["false", { jianbinFallback: false }],
]) {
  test(`sends no Jianbin traffic when the opt-in is ${label}`, async () => {
    const host = loadHost({
      settings,
      directSearchResponse: LITE_EMPTY,
      response: (url) => url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH,
      jianbinResponse: (url, options) => options.method === "POST"
        ? searchResult([result("186109", { type: "wy" })])
        : landing("cookie-1"),
    });

    await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });
    assert.equal(host.registration.settings.find(({ key }) => key === "jianbinFallback").default, false);
    assert.equal(host.jianbinRequests.length, 0, "metadata must stay off the free channel until opt-in");
  });
}

test("an opted-in Jianbin fallback still requires the ChKSz API key", async () => {
  const host = loadPlugin({ apiKey: "", response: UNAVAILABLE });

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_CONFIG_MISSING" });
  assert.equal(host.hostRequests.length, 0);
});

const chkszRequestLimit = (url) => {
  if (url.pathname === "/api/163_music") return UNAVAILABLE;
  if (url.searchParams.has("msg")) {
    return { status: 200, body: { code: 200, list: [1, 2, 3].map((number) => ({
      name: "晴天", singer: "周杰伦", mid: `qq-${number}`, id: `kg-${number}`,
    })) } };
  }
  // Successful responses with a different duration reject candidates without a
  // provider error taking precedence over the exhausted ChKSz request budget.
  return { status: 200, body: {
    code: 200, name: "晴天", singer: "周杰伦", interval: "00:01",
    url: `https://cdn.example.test/${url.searchParams.get("mid") ?? url.searchParams.get("id")}.mp3`,
  } };
};

test("continues into opted-in Jianbin after eight ChKSz cross-platform requests", async () => {
  const host = loadPlugin({
    response: chkszRequestLimit,
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") return landing("cookie-1");
      return bodyParams({ options }).get("filter") === "id"
        ? searchResult([])
        : searchResult([result("kw-after-limit")]);
    },
  });

  const resolved = await host.handlers.musicUrl(song({}, { quality: "lq" }));

  assert.equal(resolved.url, jianbinUrl("kw", "kw-after-limit"));
  assert.equal(host.requests.length, 9, "one primary request plus exactly eight cross-platform requests");
  assert.deepEqual(host.jianbinRequests.map(({ options }) => options.method), ["GET", "POST", "POST"]);
  assert.equal(bodyParams(host.jianbinRequests.at(-1)).get("filter"), "name");
});

for (const [label, settings] of [["disabled", { jianbinFallback: false }], ["default", {}]]) {
  test(`preserves the ChKSz limit error with Jianbin ${label}`, async () => {
    const host = loadHost({ settings, response: chkszRequestLimit });

    await assert.rejects(host.handlers.musicUrl(song({}, { quality: "lq" })), {
      code: "CHKSZ_CROSS_PLATFORM_LIMIT",
    });
    assert.equal(host.requests.length, 9);
    assert.equal(host.jianbinRequests.length, 0);
  });
}

test("preserves the ChKSz limit error when the independent Jianbin fallback also misses", async () => {
  const host = loadPlugin({
    response: chkszRequestLimit,
    jianbinResponse: (url, options) => options.method === "POST" ? searchResult([]) : landing("cookie-1"),
  });

  await assert.rejects(host.handlers.musicUrl(song({}, { quality: "lq" })), (error) =>
    error.code === "CHKSZ_CROSS_PLATFORM_LIMIT" && error.message.includes("煎饼免费源已尝试"));
  assert.equal(host.requests.length, 9);
  assert.equal(host.jianbinRequests.length, 5, "same-type lookup plus all three cross-type searches");
});

test("continues into Jianbin after the ChKSz ten-second stage expires", async () => {
  const time = clock();
  const host = loadPlugin({
    ...time,
    settings: { directSearchFallback: false },
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      time.advance(10_001);
      return EMPTY_SEARCH;
    },
    jianbinResponse: (url, options) => {
      if (options.method !== "POST") return landing("cookie-1");
      return bodyParams({ options }).get("filter") === "id"
        ? searchResult([]) : searchResult([result("kw-after-time-limit")]);
    },
  });

  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, jianbinUrl("kw", "kw-after-time-limit"));
  assert.equal(host.requests.filter(({ url }) => new URL(url).searchParams.has("msg")).length, 1);
  assert.equal(host.deliveryProbes.length, 1);
});

test("ChKSz stage exhaustion cannot bypass the overall resolution deadline", async () => {
  const time = clock();
  const host = loadPlugin({
    ...time,
    settings: { directSearchFallback: false },
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      time.advance(18_000);
      return EMPTY_SEARCH;
    },
    jianbinResponse: (url, options) => options.method === "POST" ? searchResult([]) : landing("cookie-1"),
  });

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_RESOLUTION_TIMEOUT" });
  assert.equal(host.jianbinRequests.length, 2, "only the earlier same-type lookup ran");
  assert.equal(host.deliveryProbes.length, 0);
});
