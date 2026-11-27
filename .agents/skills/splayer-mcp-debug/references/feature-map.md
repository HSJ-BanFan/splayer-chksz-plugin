# SPlayer ChKSz Feature Map

Source baseline: `origin/main` at `ab19e09fab8791c87ad4bfe835ace5e97d7cfce7`, inspected on 2026-11-27. This map describes the plugin's registered actions and settings. SPlayer decides when to invoke the plugin.

Every `T` below means the existing `npm test` command, with the linked test files identifying the relevant assertions. These tests run the script in a VM through [loadPlugin](../../../../test/plugin-host.js). HTTP responses, playback addresses, settings, time, and host actions are synthetic. No real account is needed.

All live verdicts in this map are `not_tested`. Source inspection, passing mocks, and historical reports do not establish current platform availability, installed-plugin compatibility, or actual playback.

## User-visible features

Source-link labels are exact `const` symbols, including symbols inside the resolution core. Test links are relative to this file. The reference check below verifies both.

| ID | Feature and behavior | Source entries | Relevant existing tests | Offline command | Live verdict |
| --- | --- | --- | --- | --- | --- |
| F01 | Importable source plugin. Registers `wy`, `tx`, `kg`, four actions, five qualities, and local settings. | [runtimeAdapter](../../../../src/plugin.js), [createRuntimeAdapter](../../../../src/plugin.js) | [runtime-adapter.test.js](../../../../test/runtime-adapter.test.js), [release-seam.test.js](../../../../test/release-seam.test.js) | T | not_tested |
| F02 | Resolve a platform track to `{ url, quality, expire? }` through `musicUrl`. Each platform keeps its own identifier. | [resolveUrl](../../../../src/plugin.js), [getMusicId](../../../../src/plugin.js), [SOURCE_POLICIES](../../../../src/plugin.js) | [source-routing.test.js](../../../../test/source-routing.test.js), [compatibility-matrix.test.js](../../../../test/compatibility-matrix.test.js), [plugin.test.js](../../../../test/plugin.test.js) | T | not_tested |
| F03 | Quality selection and downgrade. Tries native alternatives, deduplicates equivalent qualities, and reports served quality when present. Only the specific quality-unavailable 404 or failed delivery permits a lower tier. | [QUALITY_FALLBACKS](../../../../src/plugin.js), [selectQualityCandidates](../../../../src/plugin.js), [resolveOnPlatform](../../../../src/plugin.js), [readServedQuality](../../../../src/plugin.js) | [plugin.test.js](../../../../test/plugin.test.js), [cross-platform.test.js](../../../../test/cross-platform.test.js) | T | not_tested |
| F04 | `musicLyric` returns original, translated, romanized, and word-level lyric fields. NetEase uses a lyric endpoint. QQ and Kugou use track details. | [getLyric](../../../../src/plugin.js), [requestAction](../../../../src/plugin.js), [buildActionRequest](../../../../src/plugin.js) | [plugin.test.js](../../../../test/plugin.test.js), [quota-routing.test.js](../../../../test/quota-routing.test.js) | T | not_tested |
| F05 | `musicPic` returns an HTTP(S) cover from supplied metadata, cache, or a request. NetEase uses song details without forwarding the ChKSz key. QQ and Kugou use track details. | [getCover](../../../../src/plugin.js), [requestSongMetadata](../../../../src/plugin.js), [requestAction](../../../../src/plugin.js) | [metadata-search.test.js](../../../../test/metadata-search.test.js), [plugin.test.js](../../../../test/plugin.test.js) | T | not_tested |
| F06 | Host `musicSearch` returns `{ list }` with native IDs, full titles, singers, albums, optional `durationMs`, and covers. Supports page 1 only, at most 10 results, and a bounded keyword. This action supports host matching. | [searchMetadata](../../../../src/plugin.js), [searchCandidates](../../../../src/plugin.js) | [metadata-search.test.js](../../../../test/metadata-search.test.js) | T | not_tested |
| F07 | Local API key configuration. Missing or invalid keys fail before a request. A changed configuration invalidates old pending results and caches. | [getApiKey](../../../../src/plugin.js), [getSession](../../../../src/plugin.js), [assertCurrentSession](../../../../src/plugin.js) | [plugin.test.js](../../../../test/plugin.test.js), [quota-routing.test.js](../../../../test/quota-routing.test.js) | T | not_tested |
| F08 | Cross-platform fallback after primary quality unavailability or upstream failure. Matches title, artist, version, and available duration, then resolves the destination ID. It needs a title and the enabled switch. | [resolveUncached](../../../../src/plugin.js), [resolveAcrossPlatforms](../../../../src/plugin.js), [findMatchingTracks](../../../../src/plugin.js), [matchScore](../../../../src/plugin.js) | [cross-platform.test.js](../../../../test/cross-platform.test.js), [upstream-fallback.test.js](../../../../test/upstream-fallback.test.js) | T | not_tested |
| F09 | QQ public search fallback when ChKSz search fails, is cooling down, or returns no candidates. The resulting mid still goes through ChKSz playback resolution. Search and playback cooldowns stay separate. | [performDirectSearch](../../../../src/plugin.js), [searchCandidates](../../../../src/plugin.js), [SOURCE_POLICIES](../../../../src/plugin.js) | [direct-search.test.js](../../../../test/direct-search.test.js), [metadata-search.test.js](../../../../test/metadata-search.test.js) | T | not_tested |
| F10 | Optional Jianbin fallback. Tries same-platform ID lookup before ChKSz cross-platform matching, then cross-type name search. Name matching requires an exact normalized title and artist. Validates signed URLs and caps reported quality at `hq`. Still requires a ChKSz key. | [jianbinProvider](../../../../src/plugin.js), [resolveJianbinSameType](../../../../src/plugin.js), [resolveJianbinCrossType](../../../../src/plugin.js), [jianbinResolveCandidate](../../../../src/plugin.js), [runFallbackStage](../../../../src/plugin.js) | [jianbin-fallback.test.js](../../../../test/jianbin-fallback.test.js), [fallback-coordinator.test.js](../../../../test/fallback-coordinator.test.js) | T | not_tested |
| F11 | Smart request reuse. Coalesces identical pending operations, caches explicitly valid URLs with expiry margins, and reuses search and metadata results. Unknown-expiry URLs are not retained. | [sharePending](../../../../src/plugin.js), [requestJson](../../../../src/plugin.js), [readCache](../../../../src/plugin.js), [getSession](../../../../src/plugin.js) | [quota-routing.test.js](../../../../test/quota-routing.test.js), [direct-search.test.js](../../../../test/direct-search.test.js) | T | not_tested |
| F12 | Playable-first setting moves NetEase master/effect tiers after lighter tiers. Default is master-first. Economy mode keeps its own order. | [selectQualityCandidates](../../../../src/plugin.js), [MASTER_TIER_LEVELS](../../../../src/plugin.js) | [plugin.test.js](../../../../test/plugin.test.js) | T | not_tested |
| F13 | Delivery verification probes `bytes=0-3` before returning an address. A refused or unreachable address permits downgrade. Unsupported host probe options are inconclusive and allow the address. Jianbin additionally rejects text and empty bodies. | [probeDelivery](../../../../src/plugin.js), [resolveOnPlatform](../../../../src/plugin.js), [resolveJianbinCandidates](../../../../src/plugin.js) | [delivery-probe.test.js](../../../../test/delivery-probe.test.js), [jianbin-fallback.test.js](../../../../test/jianbin-fallback.test.js) | T | not_tested |
| F14 | Economy mode tries requested and standard quality, with one candidate per ChKSz fallback platform and four ChKSz cross-platform requests. This can miss intermediate qualities or alternate versions. | [selectQualityCandidates](../../../../src/plugin.js), [findMatchingTracks](../../../../src/plugin.js), [resolveAcrossPlatforms](../../../../src/plugin.js) | [quota-routing.test.js](../../../../test/quota-routing.test.js) | T | not_tested |
| F15 | Metadata-request switch disables extra lyric, cover, and host-search requests. Existing cached lyrics/covers and supplied covers can still be returned. | [requestAction](../../../../src/plugin.js), [searchMetadata](../../../../src/plugin.js), [getCover](../../../../src/plugin.js) | [quota-routing.test.js](../../../../test/quota-routing.test.js), [metadata-search.test.js](../../../../test/metadata-search.test.js) | T | not_tested |
| F16 | Bounded failures. Distinguishes unavailable tracks from failed search channels, limits resolution time, preserves cancellation, and applies quota/upstream cooldowns. Account errors stop fallback. | [resolveUncached](../../../../src/plugin.js), [requestWithTimeout](../../../../src/plugin.js), [throwHttpError](../../../../src/plugin.js), [throwApiError](../../../../src/plugin.js), [noteRateLimit](../../../../src/plugin.js), [noteChannelFailure](../../../../src/plugin.js) | [upstream-resilience.test.js](../../../../test/upstream-resilience.test.js), [direct-search.test.js](../../../../test/direct-search.test.js), [plugin.test.js](../../../../test/plugin.test.js) | T | not_tested |
| F17 | Diagnostic logs report direct resolution, destination platform/ID, served quality, and fallback failures. ChKSz keys are redacted in tested error and warning paths. | [resolveUncached](../../../../src/plugin.js), [resolveAcrossPlatforms](../../../../src/plugin.js), [redactSensitiveData](../../../../src/plugin.js) | [plugin.test.js](../../../../test/plugin.test.js), [direct-search.test.js](../../../../test/direct-search.test.js) | T | not_tested |

## Platform routing and settings

The [SOURCE_POLICIES](../../../../src/plugin.js) entries own these routes. Platform labels in SPlayer MCP can differ from plugin source keys.

| Plugin source | Playback ID parameter | Playback endpoint | ChKSz cross-platform order |
| --- | --- | --- | --- |
| wy | id | /api/163_music | tx, kg |
| tx | mid | /api/qq_music | wy, kg |
| kg | id | /api/kugou_music | tx, wy |

All three sources advertise `lq`, `sq`, `hq`, `lossless`, and `hi-res`. `hq` and `sq` share a native tier. Native top-tier names differ by platform. A returned quality describes resolution and does not prove the file's codec or audible output.

The [runtimeAdapter](../../../../src/plugin.js) registration and [getSession](../../../../src/plugin.js) configuration reads define these nine settings. Empty key means unconfigured. Defaults are plugin declarations, not the user's installed settings.

| Setting key | Default | Feature |
| --- | --- | --- |
| apiKey | empty | F07 |
| crossPlatformFallback | true | F08 |
| jianbinFallback | false | F10 |
| directSearchFallback | true | F09 |
| smartCache | true | F11 |
| playableFirst | false | F12 |
| verifyDelivery | true | F13 |
| economyMode | false | F14 |
| metadataFallback | true | F15 |

## Safe offline commands

Run from the repository root with Node.js 20 or newer and npm. [package.json](../../../../package.json) defines these commands. The existing build script copies the source over the distribution artifact. Use the read-only parity and artifact checks for this documentation task.

| ID | Command | Evidence boundary |
| --- | --- | --- |
| T | `npm test` | Existing unit, static, and synthetic VM checks. [plugin-host.js](../../../../test/plugin-host.js) intercepts requests. Release tests also use temporary local files and child Node processes. |
| S | `npm run check` | Syntax of the source containing [resolveUrl](../../../../src/plugin.js) and [dist/chksz.splayer-source.js](../../../../dist/chksz.splayer-source.js). |
| D | `npm run check:dist` | [check-dist.mjs](../../../../scripts/check-dist.mjs) compares source and tracked artifact bytes without rebuilding. |
| A | `npm run check:artifact` | [check-artifact.mjs](../../../../scripts/check-artifact.mjs) loads the tracked artifact in the synthetic VM host and verifies a fake URL request. |

### Reference check

Run this PowerShell command from the repository root to send the JavaScript block below to Node stdin:

```powershell
$sa02MapText = Get-Content -Raw .agents/skills/splayer-mcp-debug/references/feature-map.md
$sa02Check = [regex]::Match($sa02MapText, '(?s)```javascript\r?\n(.*?)\r?\n```')
if (-not $sa02Check.Success) { throw 'Feature Map reference check is missing' }
$sa02Check.Groups[1].Value | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Feature Map reference check failed' }
```

The check reads files and loads the synthetic VM host. It checks links throughout this skill directory, declared source symbols, test paths, command definitions, feature verdicts, registered actions, platform routes, qualities, and setting defaults. It does not execute the npm checks. Run the four commands above separately and retain their output and exit codes after the final commit.

```javascript
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { loadPlugin } from "./test/plugin-host.js";

const root = process.cwd();
const skill = resolve(root, ".agents/skills/splayer-mcp-debug");
const mapPath = resolve(skill, "references/feature-map.md");
const map = readFileSync(mapPath, "utf8");
const prose = (text) => text.replace(/```[^\n]*\n[\s\S]*?```/g, "");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const source = readFileSync(resolve(root, "src/plugin.js"), "utf8");
const symbols = new Set();
const tests = new Set();
let links = 0;

function checkLink(file, label, target) {
	const path = resolve(dirname(file), target);
	const within = relative(root, path);
	assert.ok(!within.startsWith(`..${sep}`) && within !== "..", target);
	assert.ok(statSync(path).isFile(), target);
	if (within.replaceAll(sep, "/") === "src/plugin.js") {
		assert.match(source, new RegExp(`\\bconst\\s+${escape(label)}\\s*=`), label);
		symbols.add(label);
	}
	if (/\.test\.js$/.test(path)) {
		assert.match(readFileSync(path, "utf8"), /\btest\(/, target);
		tests.add(path);
	}
}

function checkDocs(dir) {
	for (const name of readdirSync(dir)) {
		const path = resolve(dir, name);
		if (statSync(path).isDirectory()) checkDocs(path);
		else if (name.endsWith(".md")) {
			for (const [, label, target] of prose(readFileSync(path, "utf8"))
				.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
				checkLink(path, label, target);
				links += 1;
			}
		}
	}
}
checkDocs(skill);

const features = prose(map).split("\n").filter((line) => /^\| F\d+ \|/.test(line));
assert.equal(features.length, 17);
assert.equal(new Set(features.map((line) => line.split("|")[1].trim())).size, 17);
for (const line of features) {
	assert.ok(line.includes("../../../../src/plugin.js"), line);
	assert.ok(line.includes(".test.js)"), line);
	assert.ok(line.endsWith("| T | not_tested |"), line);
}

const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
const safe = new Map([
	["npm test", "node --test"],
	["npm run check", "node --check src/plugin.js && node --check dist/chksz.splayer-source.js"],
	["npm run check:dist", "node scripts/check-dist.mjs"],
	["npm run check:artifact", "node scripts/check-artifact.mjs"],
]);
function checkCommand(command) {
	assert.ok(safe.has(command), command);
	const key = command === "npm test" ? "test" : command.slice("npm run ".length);
	assert.equal(scripts[key], safe.get(command), command);
}
const commands = [...prose(map).matchAll(/^\| [TSDA] \| `([^`]+)` \|/gm)]
	.map((match) => match[1]);
assert.deepEqual(commands, [...safe.keys()]);
commands.forEach(checkCommand);

const { registration, handlers, sourcePolicies } = loadPlugin();
assert.deepEqual(Object.keys(registration.sources), ["wy", "tx", "kg"]);
for (const entry of Object.values(registration.sources)) {
	assert.deepEqual([...entry.actions], ["musicUrl", "musicLyric", "musicPic", "musicSearch"]);
	assert.deepEqual([...entry.qualities], ["lq", "sq", "hq", "lossless", "hi-res"]);
	for (const action of entry.actions) assert.equal(typeof handlers[action], "function");
}
const routes = [...prose(map)
	.matchAll(/^\| (wy|tx|kg) \| (\w+) \| (\/api\/\w+) \| ([^|]+) \|/gm)];
assert.equal(routes.length, 3);
assert.deepEqual(routes.map((match) => match[1]), Object.keys(registration.sources));
for (const [, key, id, endpoint, order] of routes) {
	assert.equal(sourcePolicies[key].identity.idParameter, id);
	assert.equal(sourcePolicies[key].playback.endpoint, endpoint);
	assert.deepEqual([...sourcePolicies[key].crossPlatform.sources], order.trim().split(", "));
}
const defaults = [...prose(map).matchAll(/^\| (\w+) \| (empty|true|false) \| F\d+ \|/gm)]
	.map(([, key, value]) => [key, value === "empty" ? "" : value === "true"]);
assert.equal(defaults.length, 9);
assert.deepEqual(Array.from(registration.settings, ({ key, default: value }) => [key, value]), defaults);
assert.match(readFileSync(resolve(skill, "SKILL.md"), "utf8"),
	/^---\r?\nname: splayer-mcp-debug\r?\ndescription: .+\r?\n---/);

assert.throws(() => checkLink(mapPath, "missing", "../../../../__missing_sa02__.md"));
assert.throws(() => checkLink(mapPath, "__missing_sa02_symbol__", "../../../../src/plugin.js"));
assert.throws(() => checkCommand("npm run __missing_sa02__"));
console.log(`Verified ${features.length} features, ${links} links, ${symbols.size} source symbols, ${tests.size} test files, ${commands.length} npm commands, 3 sources, 4 actions, 5 qualities, 9 settings.`);
console.log("Negative controls: missing path, missing symbol, and unknown command rejected.");
console.log("Live SPlayer and online platforms: not_tested.");
```

## Real SPlayer acceptance

Use [the playback procedure](../SKILL.md) and [local MCP transport](local-mcp.md) only under a separate authorized test. Discover current tool schemas. The example helper names in the transport guide are pseudocode, not installed commands.

For F01, confirm the installed artifact hash and registered actions. For F02, F03, and F08–F14, attribute resolution to this plugin in appended logs and record the original and destination IDs, requested/served quality, and bounded request behavior. A successful URL or four-byte probe does not establish native decoding. Test cold-cache and warm-cache behavior separately when checking reuse.

For F04–F06 and F15, inspect the installed host's actual lyric, cover, and matching results and whether extra requests occur. The synthetic return shape alone does not prove the installed host renders those fields. For F07, F16, and F17, use controlled failures with sanitized evidence. Keep real keys and signed media URLs out of reports.

Report API resolution, installed-plugin routing, decoding/output initialization, progress/seek, full-track completion, and audible output as separate verdicts. This task exercises none of those live boundaries. API quota behavior, remote catalogues, CDN content integrity, and the installed application's state remain `not_tested`.
