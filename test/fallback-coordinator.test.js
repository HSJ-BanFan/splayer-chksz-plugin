import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

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
  body: `<script>document.cookie="mk_visit=${cookie};path=/;max-age=43200;SameSite=Lax"</script>`,
});
const searchResult = (items) => ({ status: 200, body: { code: 200, data: items } });

// 关掉煎饼开关，让注入的 fake provider 成为唯一会真正尝试的兜底通道。
const loadFallbackHost = (overrides = {}) =>
  loadPlugin({
    settings: { jianbinFallback: false },
    directSearchResponse: LITE_EMPTY,
    response: (url) => (url.pathname === "/api/163_music" ? UNAVAILABLE : EMPTY_SEARCH),
    ...overrides,
  });

const createFakeProvider = ({
  id = "fake",
  name = "测试源",
  enabled = () => true,
  behavior = () => null,
  classify = () => "service",
  noteFailure = () => {},
  sequence = [],
} = {}) => {
  const provider = {
    id,
    name,
    stages: ["same", "cross"],
    enabled,
    createState: () => ({}),
    classify,
    noteFailure,
    calls: [],
    async attempt(task, ctx) {
      provider.calls.push({ task, ctx });
      sequence.push(`${id}:${task.stage}`);
      return behavior(task, ctx);
    },
  };
  return provider;
};

const warned = (host, message) =>
  host.logs.some(({ level, args }) => level === "warn" && String(args[0]) === message);

// VM 里的对象来自另一个 realm，比较前先转成普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

test("runs enabled providers in registration order for the same and cross stages", async () => {
  const host = loadFallbackHost();
  const sequence = [];
  const first = createFakeProvider({ id: "fake-1", sequence });
  const second = createFakeProvider({ id: "fake-2", sequence });
  host.fallbackProviders.push(first, second);

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });

  assert.deepEqual(sequence, [
    "fake-1:same",
    "fake-2:same",
    "fake-1:cross",
    "fake-2:cross",
  ]);
  assert.deepEqual(plain(first.calls[0].task), {
    stage: "same",
    source: "wy",
    id: "186109",
    track: { name: "晴天", singer: "周杰伦", interval: "04:29" },
  });
  assert.deepEqual(plain(first.calls[1].task), {
    stage: "cross",
    source: "wy",
    id: "",
    track: { name: "晴天", singer: "周杰伦", interval: "04:29" },
  });
  const context = first.calls[0].ctx;
  for (const key of ["state", "deadline", "stageDeadline", "budget", "attempted"]) {
    assert.ok(key in context, `ctx 缺少 ${key}`);
  }
  assert.equal(context.deadline, context.stageDeadline);
  assert.ok(context.budget.remaining > 0);
  assert.equal(context.state.config.jianbinFallback, false);
  assert.equal(context.attempted, false, "provider 自己决定何时标记 attempted");
  assert.equal(second.calls[0].ctx, context, "两个阶段共享同一个 ctx");
});

test("skips a disabled provider without marking the context as attempted", async () => {
  const host = loadFallbackHost();
  const disabled = createFakeProvider({ id: "off", enabled: () => false });
  const active = createFakeProvider({ id: "on" });
  host.fallbackProviders.push(disabled, active);

  await assert.rejects(host.handlers.musicUrl(song()), (error) => {
    assert.equal(error.code, "CHKSZ_TRACK_UNAVAILABLE");
    assert.ok(
      !error.message.includes("（煎饼免费源已尝试，未返回可播放地址）"),
      "没有 provider 真正尝试过时不应追加兜底注记",
    );
    return true;
  });

  assert.equal(disabled.calls.length, 0);
  assert.deepEqual(active.calls.map(({ task }) => task.stage), ["same", "cross"]);
});

test("adopts the first provider result and stops the stage", async () => {
  const host = loadFallbackHost();
  const resolved = {
    url: "https://fake.example.test/qingtian.mp3",
    quality: "hq",
    expire: 1_900_060_000_000,
  };
  const winner = createFakeProvider({ id: "winner", behavior: () => resolved });
  const later = createFakeProvider({ id: "later" });
  host.fallbackProviders.push(winner, later);

  const result = await host.handlers.musicUrl(song());

  assert.deepEqual(plain(result), resolved);
  assert.deepEqual(winner.calls.map(({ task }) => task.stage), ["same"]);
  assert.equal(later.calls.length, 0, "同一阶段命中后不再调用后续 provider 与跨平台兜底");
  assert.equal(host.requests.length, 2, "provider 命中后不再走跨平台搜索");
});

test("records a service failure on the provider and keeps going", async () => {
  const host = loadFallbackHost();
  const failures = [];
  const broken = createFakeProvider({
    id: "broken",
    behavior: () => {
      throw Object.assign(new Error("上游 500"), { code: "FAKE_SERVICE_DOWN" });
    },
    classify: () => "service",
    noteFailure: (state, error) => failures.push({ state, error }),
  });
  const later = createFakeProvider({ id: "later" });
  host.fallbackProviders.push(broken, later);

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });

  // same / cross 两个阶段各失败一次，冷却记录都落在同一个 provider 上。
  assert.deepEqual(failures.map(({ error }) => error.code), ["FAKE_SERVICE_DOWN", "FAKE_SERVICE_DOWN"]);
  assert.ok(warned(host, "测试源免费源兜底失败：上游 500"));
  assert.deepEqual(later.calls.map(({ task }) => task.stage), ["same", "cross"]);
});

test("warns about a candidate failure without recording a cooldown", async () => {
  const host = loadFallbackHost();
  const failures = [];
  const broken = createFakeProvider({
    id: "broken",
    behavior: () => {
      throw Object.assign(new Error("地址打不开"), { code: "FAKE_CANDIDATE", candidateId: "c-9" });
    },
    classify: () => "candidate",
    noteFailure: (state, error) => failures.push({ state, error }),
  });
  const later = createFakeProvider({ id: "later" });
  host.fallbackProviders.push(broken, later);

  await assert.rejects(host.handlers.musicUrl(song()), { code: "CHKSZ_TRACK_UNAVAILABLE" });

  assert.ok(warned(host, "测试源候选（c-9）不可用：地址打不开"));
  assert.equal(failures.length, 0);
  assert.deepEqual(later.calls.map(({ task }) => task.stage), ["same", "cross"]);
});

test("rethrows a terminal provider error unchanged", async () => {
  const host = loadFallbackHost();
  const terminal = Object.assign(new Error("SPlayer 已取消请求。"), { code: "PLUGIN_CANCELLED" });
  const provider = createFakeProvider({
    id: "terminal",
    behavior: () => {
      throw terminal;
    },
    classify: () => "terminal",
  });
  host.fallbackProviders.push(provider);

  await assert.rejects(host.handlers.musicUrl(song()), (error) => error === terminal);
  assert.equal(provider.calls.length, 1);
});

test("keeps the built-in provider working next to an injected one", async () => {
  const t = 1_900_000_000;
  const playbackUrl = `https://www.jbsou.cn/api.php?get=url&type=wy&id=186109&sign=s1gn&t=${t}`;
  const host = loadPlugin({
    response: UNAVAILABLE,
    jianbinResponse: (url, options) =>
      options?.method === "POST"
        ? searchResult([{
          name: "晴天",
          artist: "周杰伦",
          songid: "186109",
          url: `api.php?get=url&type=wy&id=186109&sign=s1gn&t=${t}`,
        }])
        : landing("cookie-1"),
  });
  assert.deepEqual([...host.fallbackProviders].map(({ id }) => id), ["jianbin"]);

  const injected = createFakeProvider({ id: "injected" });
  host.fallbackProviders.unshift(injected);
  const resolved = await host.handlers.musicUrl(song());

  assert.equal(resolved.url, playbackUrl);
  assert.deepEqual(injected.calls.map(({ task }) => task.stage), ["same"]);

  host.fallbackProviders.shift();
  assert.deepEqual([...host.fallbackProviders].map(({ id }) => id), ["jianbin"]);
});
