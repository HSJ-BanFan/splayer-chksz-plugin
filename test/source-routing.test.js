import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin } from "./plugin-host.js";

const describeRequest = (request) => {
  const url = new URL(request.url);
  return {
    path: url.pathname,
    id: url.searchParams.get("id"),
    mid: url.searchParams.get("mid"),
  };
};

test("reads the identifier belonging to the selected source", async () => {
  const cases = [
    {
      source: "wy",
      musicInfo: { id: "wy-id", songmid: "wrong-songmid", songId: "wrong-song-id" },
      expected: { path: "/api/163_music", id: "wy-id", mid: null },
    },
    {
      source: "tx",
      musicInfo: { mid: "tx-mid", id: "wrong-id", songId: "wrong-song-id" },
      expected: { path: "/api/qq_music", id: null, mid: "tx-mid" },
    },
    {
      source: "kg",
      musicInfo: { id: "wrong-generic-id", hash: "kg-hash", songmid: "wrong-songmid" },
      expected: { path: "/api/kugou_music", id: "kg-hash", mid: null },
    },
  ];

  for (const { source, musicInfo, expected } of cases) {
    const { handlers, requests } = loadPlugin({
      response: { status: 200, body: { url: `https://cdn.example.test/${source}.mp3` } },
    });

    await handlers.musicUrl({ source, quality: "lq", musicInfo });

    assert.deepEqual(describeRequest(requests[0]), expected, source);
  }
});
