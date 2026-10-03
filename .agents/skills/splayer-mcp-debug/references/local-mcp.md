# Local MCP transport and evidence locations

Observed on SPlayer 1.1.0; rediscover schemas and settings on other versions.

## Discovery

Default Windows data root: `%APPDATA%/SPlayer-Next/app-data`.
Read only needed fields from `config/settings.json`: `mcp.enabled`, `mcp.port`, `mcp.accessKey`. Do not dump the settings object: it also contains unrelated account and plugin secrets. User-customized data roots take precedence.

Default MCP endpoint: `http://127.0.0.1:14559/mcp`; use the configured port. Authenticate with `X-MCP-Key`, held only in memory and sent only to the verified loopback endpoint. Do not follow redirects with this header. External HTTP API (`14558`) is separate and need not be enabled.

If no integrated connector is exposed, use Node `fetch` in a persistent REPL:

1. POST JSON-RPC `initialize`, supplying a supported `protocolVersion`, empty `capabilities`, and a descriptive `clientInfo`. Send `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and the secret header. Apply a finite request timeout.
2. Retain the returned `Mcp-Session-Id`; send it on subsequent requests. Use the negotiated protocol version for subsequent `MCP-Protocol-Version` headers where required.
3. Send `notifications/initialized` without an ID; a 202/empty response is normal.
4. Call `tools/list` and inspect each needed tool's `inputSchema`. Call tools through `tools/call` with `{ name, arguments }` and increasing request IDs.
5. Check HTTP status, JSON-RPC `error`, and tool `isError`. Tool JSON often appears in `result.content[].text`; parse that text rather than assuming structuredContent. Decode SSE responses if the negotiated transport returns SSE; do not blindly JSON-parse them.
6. End the session where supported and clear in-memory credentials when finished. Never write credentials into a helper script, CLI argument, report, or repository fixture.

Relevant observed tools: `get_now_playing`, `get_playback_status`, `search_online_songs`, `play_track`, `pause`, `play`, `seek`. Tool presence does not imply an endpoint exists for changing quality or invoking arbitrary Electron IPC. Do not invent such endpoints.

## Playback sampling shape

Run load polling, progress sampling and pause in one bounded call. Skeleton (helpers must use discovered schemas):

```javascript
try {
  await call('play_track', { trackId: verifiedTrackId });
  await waitForRequestedTrackPlaying(verifiedTrackId, 30_000);
  const a = await snapshot(); // track identity + native status
  await delay(5_000);
  const b = await snapshot();
  verifySameTrackAndAdvancingPosition(a, b);
} finally {
  await call('pause');
}
```

The helper names above describe required checks, not bundled APIs. Inspect fresh state after a timeout or disconnect instead of assuming the action did not happen.

## Logs and installed artifact

- Main logs: `app-data/logs/*.log`; native logs: `app-data/logs/native/audio-engine.*.log`.
- The main log filename can retain the app's launch date across midnight. Choose by modification time and record timestamps, not filename date alone. Native and main files may consequently have different date suffixes.
- Capture offsets before the test, handle rotation/truncation, and inspect only the relevant appended interval. Do not save raw signed source URLs from native logs.
- Installed plugins: inspect `app-data/plugins/manifest.json` and `app-data/plugins/scripts/` to locate the actual script; do not infer filenames or expose `plugins/data` or configuration contents. Compare SHA-256 with the intended artifact.
- Relevant playback diagnostics: ChKSz fallback success and target mid, source-load timestamp, codec/sample rate/bit depth/channels, output-device initialization, decoder errors, and final native state.
- A source-load followed later by `Invalid data found when processing input` is a separate decoding/data-integrity concern even if playback progress advanced. Record the elapsed interval; do not rewrite a partial pass as a clean full-track pass.

## Regression scenarios for this procedure

| Situation | Required interpretation |
| --- | --- |
| MCP returns `ok: true`, old song is still playing | Loading not confirmed; poll identity, do not claim success |
| Search returns a cover with a different artist | Reject candidate; verify original metadata |
| Progress advances but no ChKSz routing log | App playback observed; plugin attribution unverified |
| Seek immediately after dispatch resets to zero | Wait for load completion and retest; no premature seek verdict |
| Short sample passes, later native decoder error | Partial playback passed; full-track cleanliness failed/unverified |
| Main log filename is yesterday, records are today | Read appended records in that file and correlate timestamps |
| MCP is disabled | Ask user to enable loopback service; no config edits or LAN exposure |
| User stops UI automation | Stop UI inputs; use local API only when separately authorized |
