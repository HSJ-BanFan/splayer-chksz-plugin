import assert from "node:assert/strict";
import { test } from "node:test";

import { loadPlugin, pluginSource } from "./plugin-host.js";

test("VM host accepts explicit source text for alternate runtime scripts", () => {
  const { registration, handlers } = loadPlugin({
    sourceText: `
      splayer.register({
        sources: { custom: { name: "Custom", actions: ["musicUrl"], qualities: ["lq"] } },
        settings: [{ key: "custom" }],
      });
      splayer.on("musicUrl", () => "custom-handler");
    `,
  });

  assert.equal(registration.sources.custom.name, "Custom");
  assert.deepEqual([...registration.sources.custom.actions], ["musicUrl"]);
  assert.deepEqual([...registration.sources.custom.qualities], ["lq"]);
  assert.equal(registration.settings[0].key, "custom");
  assert.equal(handlers.musicUrl(), "custom-handler");
});

test("runtime adapter delegates supplied metadata and the three public actions", () => {
  const { createRuntimeAdapter } = loadPlugin({ response: { status: 200, body: {} } });
  const registrations = [];
  const bindings = [];
  const adapter = createRuntimeAdapter({
    register(value) {
      registrations.push(value);
    },
    on(action, handler) {
      bindings.push([action, handler]);
    },
  });
  const handlers = {
    musicUrl: () => "url",
    musicLyric: () => "lyric",
    musicPic: () => "pic",
  };
  const metadata = { sources: { custom: {} }, settings: [{ key: "custom" }] };

  adapter.register(metadata);
  adapter.bind(handlers);

  assert.deepEqual(registrations, [metadata]);
  assert.deepEqual(bindings.map(([action]) => action), ["musicUrl", "musicLyric", "musicPic"]);
  assert.deepEqual(bindings.map(([, handler]) => handler()), ["url", "lyric", "pic"]);
});

test("registers all three SPlayer platform sources and a local key setting", () => {
  const { registration } = loadPlugin({ response: { status: 200, body: {} } });

  assert.deepEqual(Object.keys(registration.sources), ["wy", "tx", "kg"]);
  assert.deepEqual([...registration.sources.wy.actions], ["musicUrl", "musicLyric", "musicPic"]);
  assert.deepEqual([...registration.sources.tx.actions], ["musicUrl", "musicLyric", "musicPic"]);
  assert.deepEqual([...registration.sources.kg.actions], ["musicUrl", "musicLyric", "musicPic"]);
  assert.deepEqual([...registration.sources.wy.qualities], ["lq", "sq", "hq", "lossless", "hi-res"]);
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
