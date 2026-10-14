import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

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

const jianbinUrl = (type, id, { sign = "s1gn", t = 1_900_000_000 } = {}) =>
  `https://www.jbsou.cn/api.php?get=url&type=${type}&id=${id}&sign=${sign}&t=${t}`;

const result = (songid, { type = "kw", name = "晴天", artist = "周杰伦", ...urlOptions } = {}) => ({
  name,
  artist,
  songid,
  url: jianbinUrl(type, songid, urlOptions),
});

const bodyParams = (request) => new URLSearchParams(request.options.body);
const postOf = (host, predicate) =>
  host.jianbinRequests.find((request) =>
    request.options.method === "POST" && predicate(bodyParams(request), request),
  );
const requestIndex = (host, predicate) => host.hostRequests.findIndex(predicate);

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
      const params = bodyParams({ options });
      const id = params.get("input");
      return searchResult([result(id, { type: "wy" })]);
    },
  });

  await host.handlers.musicUrl(song());
  await host.handlers.musicUrl(song({ id: "22831636" }));

  assert.deepEqual(
    host.jianbinRequests.map(({ options }) => options.method),
    ["GET", "POST", "POST"],
    "同一会话内 cookie 复用，第二首歌不再取首页",
  );
  const post = host.jianbinRequests[1];
  assert.equal(post.options.headers.Cookie, "mk_visit=mk-visit_9");
  assert.equal(
    post.options.headers["Content-Type"],
    "application/x-www-form-urlencoded; charset=UTF-8",
  );
  assert.equal(post.options.body, "input=186109&filter=id&type=netease&page=1");
  assert.equal(host.deliveryProbes.length, 2);
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
