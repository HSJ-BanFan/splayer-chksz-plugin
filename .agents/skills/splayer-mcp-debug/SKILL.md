---
name: splayer-mcp-debug
description: Use when validating this project's plugin inside the installed SPlayer app, checking real playback through local MCP, or distinguishing URL resolution, metadata fallback, and native audio failures.
---

# SPlayer MCP playback debugging

Prefer the application's local MCP over UI clicking for playback validation. An isolated VM resolving a URL is not evidence that the installed app played it.

## Preconditions and connection

1. Confirm the installed plugin version and, where accessible, its script hash against `dist/chksz.splayer-source.js`. A built artifact is not automatically installed. Ask before replacing the installed plugin; preserve settings and do not silently run market updates.
2. Discover connected SPlayer MCP tools first. If the tool list is stale or unavailable, use the application's loopback HTTP MCP endpoint directly as described in [references/local-mcp.md](references/local-mcp.md). Inspect live tool schemas before constructing arguments.
3. If MCP is disabled, ask the user to enable it in SPlayer's AI integration settings. Do not enable LAN access, change security settings, expose the key, or restart the app into an unrestricted debugger.
4. Record initial track, state, position, volume, repeat mode, plugin version/hash, and log byte offsets. Do not change volume or play mode by default. Playback commands require the user's testing request; read-only discovery does not authorize playback.

## Bounded real-app test

- Search with `search_online_songs`; use a returned `trackId` only after title, artist, version and platform match. Unavailable catalogues can return covers instead of the original.
- If the original is absent, verify its ID and metadata from an authoritative detail endpoint. Pass a complete `track` using the installed app's schema (e.g. `source: netease`, `title`, `artists`, millisecond `duration`). Do not confuse app sources with plugin keys `wy/tx/kg`.
- `play_track` acknowledges dispatch, not completed loading. Poll current track AND native playback status until the requested ID/source is playing with plausible duration. Bound loading to 30 seconds; stop on an error or unexpected track.
- In ONE bounded execution, take two status snapshots about 5-8 seconds apart, checking track identity at both ends. Require advancing position and `playing` state. Use `finally` to pause; do not leave playback running across agent turns, where latency can let the queue advance.
- For seek testing, wait for the correct track to be stably loaded first. Pause, seek to a safe interior position, verify the position, resume for about 5 seconds, verify advancement, and pause in `finally`. A seek during asynchronous loading can be overwritten by the subsequent load.
- Check application logs for the exact plugin ID, original song, matched destination ID, and successful fallback. Other enabled plugins or the official source may otherwise explain successful playback.
- Correlate native audio logs by source-load interval. Inspect errors AFTER the sampled playback, not just startup. A decoder error after successful frames (`had_success=true`) means startup worked, not that the whole file was clean.
- Preserve the user's state as agreed. Report any queue additions or automatic next-track playback. Do not delete queue entries or change modes without authorization.

## Evidence and interpretation

Use separate verdicts: API resolution; installed-plugin routing; native decoding/output initialization; progress/seek; full-track end; audible output. Progress plus a device-open log does not prove audible sound. Ask the user about sound when needed rather than claiming to have listened.

Report current song and final paused state, requested/served quality, measured progress delta, destination ID, relevant errors and untested boundaries. Never mark full-track validation passed after a short sample. If an end-of-file test is requested, bound its duration and stop before unrelated queue playback; do not infer normal completion solely from a changed track.

Redact before printing or saving: ChKSz keys, MCP access keys, cookies, signed media query strings (`vkey`, tokens, GUIDs), device identifiers and unrelated account data. Retain only the needed track identity, codec, time, host, status and diagnostic messages. Persist sanitized evidence under `docs/`; never raw settings or responses containing credentials.

## Metadata warning triage

- `matchCover ... wy ... 404`: inspect `musicPic`'s request route. In v0.8.1 NetEase artwork can trigger `/api/163_music` at standard quality; unavailable audio can therefore block artwork too.
- `matchCover ... tx/kg ... musicSearch not registered`: inspect host matching and advertised/registered plugin actions. Cross-source artwork matching calls `musicSearch` BEFORE `musicPic`; successful `musicUrl` cross-platform matching does not implement that host action.
- Repair by providing a real host-compatible `musicSearch` returning `{ list: [{ id, name, singer, album, durationMs, ... }] }`, preserving platform IDs and full versions, then reusing cached cover metadata or a dedicated metadata endpoint. Verify API-level compatibility before advertising the action.
- Do not suppress warnings by advertising an unimplemented action, pretending an upstream failure is an empty search, or raising the API level without checking installed-host support. Keep this separate from audio decoding bugs.
