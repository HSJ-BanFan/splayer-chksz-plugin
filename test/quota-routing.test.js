import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlugin } from "./plugin-host.js";

const START = 1_900_000_000_000;
const UNAVAILABLE = { status: 404, body: {
  msg: "Music URL not found, song may be unavailable at this quality level",
} };
const SONG = { source: "wy", quality: "hq", musicInfo: {
  id: "wy-1", name: "晴天", singer: "周杰伦", interval: "04:29",
} };
const success = (extra = {}) => ({ status: 200, body: {
  code: 200, url: "https://cdn.example.test/song.flac", ...extra,
} });
const searchHit = { status: 200, body: { code: 200, list: [
  { mid: "qq-1", name: "晴天", singer: "周杰伦" },
] } };
const levels = (host) => host.requests.map(({ url }) => {
  const params = new URL(url).searchParams;
  return params.get("level") ?? params.get("size") ?? "search";
});

test("coalesces concurrent identical resolutions without retaining unknown-expiry URLs", async () => {
  const host = loadPlugin({ response: success() });
  const results = await Promise.all([host.handlers.musicUrl(SONG), host.handlers.musicUrl(SONG)]);
  assert.equal(results[0].url, "https://cdn.example.test/song.flac");
  assert.equal(results[1].url, results[0].url);
  assert.equal(host.requests.length, 1);
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 2);
});

test("reuses an explicitly valid URL but refreshes within its expiry safety margin", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: success({ expire: (START + 120_000) / 1000 }) });
  await host.handlers.musicUrl(SONG);
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 1);
  time += 90_000;
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 2);
});

test("does not reuse a lower-quality URL for a higher-quality request", async () => {
  const host = loadPlugin({ now: () => START, response: success({ expire: START + 600_000 }) });
  await host.handlers.musicUrl({ ...SONG, quality: "lq" });
  const result = await host.handlers.musicUrl({ ...SONG, quality: "lossless" });
  assert.deepEqual(levels(host), ["standard", "lossless"]);
  assert.equal(result.quality, "lossless");
});

test("remembers only the unavailable native quality and probes it again after 60 seconds", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: (url) =>
    url.searchParams.get("level") === "exhigh" ? UNAVAILABLE : success(),
  });
  await host.handlers.musicUrl(SONG);
  await host.handlers.musicUrl(SONG);
  assert.deepEqual(levels(host), ["exhigh", "standard", "standard"]);
  time += 60_000;
  await host.handlers.musicUrl(SONG);
  assert.deepEqual(levels(host).slice(-2), ["exhigh", "standard"]);
});

test("reuses cross-platform searches while revalidating fresh playback details", async () => {
  let mismatch = false;
  const host = loadPlugin({ response: (url) => {
    if (url.pathname === "/api/163_music") return UNAVAILABLE;
    if (url.pathname === "/api/kugou_music") return { status: 200, body: { list: [] } };
    if (url.searchParams.has("msg")) return searchHit;
    return success({ name: "晴天", singer: "周杰伦", interval: mismatch ? "01:00" : "04:29" });
  } });
  await host.handlers.musicUrl(SONG);
  await host.handlers.musicUrl(SONG);
  assert.deepEqual(levels(host), ["exhigh", "standard", "search", "320k", "320k"]);
  mismatch = true;
  await assert.rejects(host.handlers.musicUrl(SONG), { code: "CHKSZ_TRACK_UNAVAILABLE" });
});

test("shares playback metadata with lyric and cover actions without another API call", async () => {
  for (const source of ["wy", "tx", "kg"]) {
    const host = loadPlugin({ response: success({ lyric: "[00:00]hello", cover: "https://cdn.example.test/cover.jpg" }) });
    const input = { ...SONG, source };
    await host.handlers.musicUrl(input);
    assert.equal((await host.handlers.musicLyric(input)).lyric, "[00:00]hello");
    assert.equal((await host.handlers.musicPic(input)).url, "https://cdn.example.test/cover.jpg");
    assert.equal(host.requests.length, 1, source);
  }
});

test("coalesces QQ lyric and cover detail requests", async () => {
  const host = loadPlugin({ response: success({ lyric: "[00:00]hello", cover: "https://cdn.example.test/cover.jpg" }) });
  const input = { ...SONG, source: "tx" };
  const [lyric, cover] = await Promise.all([host.handlers.musicLyric(input), host.handlers.musicPic(input)]);
  assert.equal(lyric.lyric, "[00:00]hello");
  assert.equal(cover.url, "https://cdn.example.test/cover.jpg");
  assert.equal(host.requests.length, 1);
});

test("metadata opt-out avoids extra requests but still uses metadata from playback", async () => {
  const host = loadPlugin({ settings: { metadataFallback: false }, response: success({ lyric: "[00:00]hello" }) });
  assert.equal((await host.handlers.musicLyric(SONG)).lyric, "");
  assert.equal((await host.handlers.musicPic(SONG)).url, "");
  assert.equal(host.requests.length, 0);
  await host.handlers.musicUrl(SONG);
  assert.equal((await host.handlers.musicLyric(SONG)).lyric, "[00:00]hello");
  assert.equal(host.requests.length, 1);
});

test("smart-cache opt-out disables both reuse and concurrent coalescing", async () => {
  const host = loadPlugin({ settings: { smartCache: false }, response: success({ expire: START }) });
  await Promise.all([host.handlers.musicUrl(SONG), host.handlers.musicUrl(SONG)]);
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 3);
});

test("changing a key or routing setting invalidates session caches", async () => {
  const host = loadPlugin({ now: () => START, response: success({ expire: START + 600_000 }) });
  await host.handlers.musicUrl(SONG);
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 1);
  host.setSetting("apiKey", "chksz_new_key");
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 2);
  assert.equal(new URL(host.requests[1].url).searchParams.get("apikey"), "chksz_new_key");
  host.setSetting("crossPlatformFallback", false);
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 3);
  host.setSetting("apiKey", "");
  await assert.rejects(host.handlers.musicUrl(SONG), { code: "CHKSZ_CONFIG_MISSING" });
  assert.equal(host.requests.length, 3);
});

test("failed and cancelled resolutions are not retained as song unavailability", async () => {
  for (const failure of [
    Object.assign(new Error("cancelled"), { code: "PLUGIN_CANCELLED" }),
    new Error("offline"),
    { status: 503, body: { msg: "busy" } },
    { status: 404, body: { msg: "endpoint missing" } },
  ]) {
    let failed = true;
    const host = loadPlugin({ settings: { crossPlatformFallback: false }, response: () => {
      if (!failed) return success();
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    await assert.rejects(host.handlers.musicUrl(SONG));
    failed = false;
    assert.equal((await host.handlers.musicUrl(SONG)).quality, "hq");
    assert.equal(host.requests.length, 2);
  }
});

test("economy mode tries requested quality then standard, leaving the default ladder intact", async () => {
  for (const source of ["wy", "tx", "kg"]) {
    const host = loadPlugin({ settings: { economyMode: true }, response: (url) => {
      const native = url.searchParams.get("level") ?? url.searchParams.get("size");
      return native === "standard" || native === "128k" ? success() : UNAVAILABLE;
    } });
    const result = await host.handlers.musicUrl({ ...SONG, source, quality: "hi-res" });
    assert.deepEqual(levels(host), source === "wy" ? ["jymaster", "standard"] : ["master", "128k"]);
    assert.equal(result.quality, "lq");
  }
});

test("economy mode probes only one candidate per fallback platform", async () => {
  const host = loadPlugin({ settings: { economyMode: true }, response: (url) => {
    if (url.pathname === "/api/163_music") return UNAVAILABLE;
    if (url.pathname === "/api/kugou_music") return { status: 200, body: { list: [] } };
    if (url.searchParams.has("msg")) return { status: 200, body: { list: [
      { mid: "bad-duration", name: "晴天", singer: "周杰伦" },
      { mid: "second", name: "晴天", singer: "周杰伦" },
    ] } };
    return success({ interval: "01:00" });
  } });
  await assert.rejects(host.handlers.musicUrl(SONG), { code: "CHKSZ_TRACK_UNAVAILABLE" });
  assert.equal(host.requests.some(({ url }) => new URL(url).searchParams.get("mid") === "second"), false);
  assert.equal(host.requests.length, 5);
});

test("caps retained playback URLs instead of accumulating an entire library", async () => {
  const host = loadPlugin({ now: () => START, response: success({ expire: START + 600_000 }) });
  for (let index = 0; index <= 128; index += 1) {
    await host.handlers.musicUrl({ ...SONG, musicInfo: { id: String(index) } });
  }
  await host.handlers.musicUrl({ ...SONG, musicInfo: { id: "128" } });
  assert.equal(host.requests.length, 129);
  await host.handlers.musicUrl({ ...SONG, musicInfo: { id: "0" } });
  assert.equal(host.requests.length, 130);
});

test("does not return old-account results after a key change during an active request", async () => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const host = loadPlugin({ response: () => new Promise((resolve) => {
    release = resolve;
    started();
  }) });
  const pending = host.handlers.musicUrl(SONG);
  const rejected = assert.rejects(pending, { code: "CHKSZ_CONFIG_CHANGED" });
  await ready;
  host.setSetting("apiKey", "chksz_replaced_key");
  release(success());
  await rejected;
});

test("an invalid cached cover does not suppress the cover fallback request", async () => {
  const host = loadPlugin({ response: (url) => success({
    cover: url.searchParams.get("level") === "standard" ? "https://cdn.example.test/cover.jpg" : "not-a-url",
  }) });
  await host.handlers.musicUrl(SONG);
  assert.equal((await host.handlers.musicPic(SONG)).url, "https://cdn.example.test/cover.jpg");
  assert.equal(host.requests.length, 2);
});

test("URL caching stops after five minutes even when the provider gives a long expiry", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: success({ expire: START + 3_600_000 }) });
  await host.handlers.musicUrl(SONG);
  time += 299_999;
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 1);
  time += 1;
  await host.handlers.musicUrl(SONG);
  assert.equal(host.requests.length, 2);
});

test("metadata caches expire and cannot be mistaken for a reusable audio URL", async () => {
  let time = START;
  const host = loadPlugin({ now: () => time, response: success({ lyric: "[00:00]hello" }) });
  const input = { ...SONG, source: "tx", quality: "lq" };
  await host.handlers.musicLyric(input);
  await host.handlers.musicLyric(input);
  assert.equal(host.requests.length, 1);
  await host.handlers.musicUrl(input);
  assert.equal(host.requests.length, 2);
  time += 300_000;
  await host.handlers.musicLyric(input);
  assert.equal(host.requests.length, 3);
});

test("economy cross-platform traffic stays within four requests after origin probes", async () => {
  const host = loadPlugin({ settings: { economyMode: true }, response: (url) => {
    if (url.pathname === "/api/163_music") return UNAVAILABLE;
    if (url.searchParams.has("msg")) return { status: 200, body: { list: [
      { mid: "qq-1", id: "kg-1", name: "晴天", singer: "周杰伦", duration: 269 },
    ] } };
    return UNAVAILABLE;
  } });
  await assert.rejects(host.handlers.musicUrl({ ...SONG, quality: "hi-res" }));
  assert.equal(host.requests.length, 6);
});

test("cached cross-platform playback still obeys the cross-platform time limit", async () => {
  let jumpAfterSearch = false;
  const host = loadPlugin({
    now: () => START + (jumpAfterSearch && host.logs.some((entry) =>
      entry.level === "debug" && entry.args[0].includes("/api/qq_music"),
    ) ? 10_001 : 0),
    response: (url) => {
      if (url.pathname === "/api/163_music") return UNAVAILABLE;
      if (url.searchParams.has("msg")) return searchHit;
      return success({ interval: "04:29", expire: START + 120_000 });
    },
  });
  await host.handlers.musicUrl(SONG);
  jumpAfterSearch = true;
  await assert.rejects(host.handlers.musicUrl(SONG), { code: "CHKSZ_CROSS_PLATFORM_LIMIT" });
  assert.equal(host.requests.length, 4);
});

test("missing or invalid metadata never blocks a later fallback with valid fields", async () => {
  for (const source of ["wy", "tx", "kg"]) {
    let valid = false;
    const host = loadPlugin({ now: () => START, response: () => success({
      expire: START + 120_000,
      cover: valid ? "https://cdn.example.test/cover.jpg" : "not-a-url",
    }) });
    const input = { ...SONG, source };
    assert.equal((await host.handlers.musicPic(input)).url, "");
    valid = true;
    assert.equal((await host.handlers.musicPic(input)).url, "https://cdn.example.test/cover.jpg");
    assert.equal(host.requests.length, 2, source);
  }
});

test("a cached lyric-only detail response cannot mask the missing cover action", async () => {
  let withCover = false;
  const host = loadPlugin({ now: () => START, response: () => success({
    expire: START + 120_000,
    lyric: "[00:00]hello",
    ...(withCover ? { cover: "https://cdn.example.test/cover.jpg" } : {}),
  }) });
  const input = { ...SONG, source: "tx", quality: "lq" };
  assert.equal((await host.handlers.musicLyric(input)).lyric, "[00:00]hello");
  withCover = true;
  assert.equal((await host.handlers.musicPic(input)).url, "https://cdn.example.test/cover.jpg");
  assert.equal(host.requests.length, 2);
  await host.handlers.musicUrl(input);
  assert.equal(host.requests.length, 2, "valid audio response remains reusable");
});
