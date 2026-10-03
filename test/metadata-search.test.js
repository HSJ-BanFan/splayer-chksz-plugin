import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPlugin } from "./plugin-host.js";

const cover = "https://p4.music.126.net/example.jpg";
const detail = { status: 200, body: { code: 200, songs: [{ id: 108390, album: { picUrl: cover } }] } };

test("NetEase cover uses song metadata without requesting an audio URL or forwarding the key", async () => {
  const host = loadPlugin({ response: { status: 404, body: { msg: "audio unavailable" } }, directSearchResponse: detail });
  const result = await host.handlers.musicPic({ source: "wy", musicInfo: { id: "108390" } });
  assert.equal(result.url, cover);
  assert.equal(host.requests.length, 0);
  const request = host.directSearches[0];
  const url = new URL(request.url);
  assert.equal(url.origin, "https://music.163.com");
  assert.equal(url.pathname, "/api/song/detail/");
  assert.equal(url.searchParams.get("ids"), "[108390]");
  assert.ok(!JSON.stringify(request).includes("chksz_test_key"));
  await host.handlers.musicPic({ source: "wy", musicInfo: { id: "108390" } });
  assert.equal(host.directSearches.length, 1);
});

test("cover uses supplied album metadata even when extra metadata requests are disabled", async () => {
  const host = loadPlugin({ settings: { metadataFallback: false } });
  assert.equal((await host.handlers.musicPic({ source: "wy", musicInfo: { id: "108390", album: { picUrl: cover } } })).url, cover);
  assert.equal(host.hostRequests.length, 0);
  assert.equal((await host.handlers.musicPic({ source: "wy", musicInfo: { id: "108390" } })).url, "");
});

for (const body of [
  { code: 200, songs: [] },
  { code: 200, songs: [{ id: 999, album: { picUrl: cover } }] },
  { code: 200, songs: [{ id: 108390, album: { picUrl: "javascript:bad" } }] },
]) {
  test("NetEase detail never returns another song's or unsafe cover", async () => {
    const host = loadPlugin({ directSearchResponse: { status: 200, body } });
    assert.equal((await host.handlers.musicPic({ source: "wy", musicInfo: { id: "108390" } })).url, "");
  });
}

test("NetEase cover errors are not cached as empty metadata and can recover", async () => {
  let fail = true;
  const host = loadPlugin({ directSearchResponse: () => fail ? { status: 503, body: {} } : detail });
  await assert.rejects(host.handlers.musicPic({ source: "wy", musicInfo: { id: "108390" } }));
  fail = false;
  assert.equal((await host.handlers.musicPic({ source: "wy", musicInfo: { id: "108390" } })).url, cover);
});

for (const [source, field, id] of [["wy", "id", "108390"], ["tx", "mid", "qq-mid"], ["kg", "id", "kg-hash"]]) {
  test(`host musicSearch returns ${source} IDs and durationMs and reuses cover metadata`, async () => {
    const host = loadPlugin({ response: { status: 200, body: { list: [{ [field]: id, name: "Song (Live)", singer: "Artist", album: "Album", interval: "04:24", cover }] } } });
    assert.equal(typeof host.handlers.musicSearch, "function");
    assert.ok(host.registration.sources[source].actions.includes("musicSearch"));
    const result = await host.handlers.musicSearch({ source, keyword: "Song Artist", limit: 5 });
    assert.equal(result.list.length, 1);
    assert.equal(result.list[0].id, id);
    assert.equal(result.list[0].name, "Song (Live)");
    assert.equal(result.list[0].durationMs, 264000);
    assert.equal((await host.handlers.musicPic({ source, musicInfo: result.list[0] })).url, cover);
    assert.equal(host.hostRequests.length, 1);
  });
}

test("host QQ search falls back to Lite and musicPic uses the candidate's QQ mid", async () => {
  const host = loadPlugin({
    response: url => url.searchParams.has("msg") ? { status: 404, body: { msg: "search down" } }
      : { status: 200, body: { cover } },
    directSearchResponse: { status: 200, body: { code: 0, request: { code: 0, data: { body: { item_song: [
      { mid: "qq-native-mid", title: "Song", singer: [{ name: "Artist" }], interval: 264, album: { name: "Album" } },
    ] } } } } },
  });
  const { list } = await host.handlers.musicSearch({ source: "tx", keyword: "Song Artist" });
  assert.equal(list[0].id, "qq-native-mid");
  assert.equal(list[0].durationMs, 264000);
  assert.equal((await host.handlers.musicPic({ source: "tx", musicInfo: list[0] })).url, cover);
  assert.equal(new URL(host.requests.at(-1).url).searchParams.get("mid"), "qq-native-mid");
});

test("metadata opt-out prevents host search requests; invalid search input is bounded", async () => {
  const host = loadPlugin({ settings: { metadataFallback: false } });
  assert.equal((await host.handlers.musicSearch({ source: "tx", keyword: "Song" })).list.length, 0);
  assert.equal(host.hostRequests.length, 0);
});

test("host search preserves account failures rather than returning no candidates", async () => {
  const host = loadPlugin({ response: { status: 429, body: { msg: "limited" } } });
  await assert.rejects(host.handlers.musicSearch({ source: "tx", keyword: "Song" }), { code: "CHKSZ_HTTP_429" });
  assert.equal(host.directSearches.length, 0);
});

test("host search caps results and rejects unsupported pages without spending quota", async () => {
  const host = loadPlugin({ response: { status: 200, body: { list: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: "Song", interval: 60 })) } } });
  assert.equal((await host.handlers.musicSearch({ source: "wy", keyword: "Song", limit: 2 })).list.length, 2);
  assert.equal((await host.handlers.musicSearch({ source: "wy", keyword: "Song", page: 2 })).list.length, 0);
  assert.equal((await host.handlers.musicSearch({ source: "wy", keyword: " " })).list.length, 0);
  assert.equal(host.requests.length, 1);
});

test("NetEase cover cancellation propagates and concurrent requests share metadata", async () => {
  const cancelled = loadPlugin({ directSearchResponse: () => { throw Object.assign(new Error("cancelled"), { code: "PLUGIN_CANCELLED" }); } });
  await assert.rejects(cancelled.handlers.musicPic({ source: "wy", musicInfo: { id: "108390" } }), { code: "PLUGIN_CANCELLED" });
  const host = loadPlugin({ directSearchResponse: detail });
  const input = { source: "wy", musicInfo: { id: "108390" } };
  await Promise.all([host.handlers.musicPic(input), host.handlers.musicPic(input)]);
  assert.equal(host.directSearches.length, 1);
});
