# Spec: 煎饼（jbsou.cn）免费兜底通道（v0.9.0）

## 目标与验收

在 `src/plugin.js` 内新增「煎饼免费源」通道，作为 ChKSz 之外的免费兜底。验收（用户原话拆解）：

- (a) 无版权 / 上游故障：ChKSz 主渠道不可用时，能经煎饼解析并播放同一首歌。
- (b) `tx`（QQ）渠道：ChKSz 主渠道失败后，煎饼能按同一首歌的 QQ mid 解析并播放。
- (c) `kg`（酷狗）渠道：ChKSz 主渠道失败后，煎饼能按同一首歌的酷狗 hash 解析并播放。

非目标（本批不做）：煎饼提供歌词/封面；直接 ID 反查以外的签名刷新复检；ChKSz 账户错误（401/402/403/429）后继续用煎饼；主渠道阶段时间上限改造；通道注册表大重构。

## 已核实的外部事实（2026-10-14 实测，勿改写）

1. 落地页 `https://www.jbsou.cn/` 是 476 字节 JS 引导页：`document.cookie="mk_visit=<ts>-<hex>;path=/;max-age=43200;SameSite=Lax"`，随后 reload。`mk_visit` 必须从 HTML 正文解析（不是 Set-Cookie 响应头）；无 cookie 的搜索 POST 返回 HTTP 403（body `code=403`）。
2. 搜索：`POST https://www.jbsou.cn/`，`application/x-www-form-urlencoded`，字段 `input` / `filter` / `type` / `page`。`filter=name`（歌名搜索）；`filter=id`（ID 直查，站点自身的续签机制）。`type ∈ netease|qq|kugou|kuwo`。响应 `{code:200, data:[{link,name,artist,songid,lrc,url,cover}]}`；`url` 形如 `api.php?get=url&type=wy|qq|kg|kw&id=<songid>&sign=<sig>&t=<unix 秒>`。搜索结果无时长、无专辑。
3. ID 直查已实测可用：`wy` 数字 id、`qq` songmid、`kg` 32 位 hash、`kuwo` 数字 rid 都能 `filter=id` 精确命中（各返回 n=1，songid 与输入一致）。
4. `api.php?get=url...` 是 302 跳转到平台 CDN mp3（已见 aqqmusic.tc.qq.com / fsandroid.kugou.com / kw-er.kuwo.cn / m801.music.126.net）；无需 cookie；单曲约 10.8MB/269s ≈ 320kbps mp3。
5. 签名有效期：站点自身 music.js 在 `age ≥ 1700s` 时重新搜索续签；实测 5 分钟仍有效。`t=` 是签发时间（unix 秒）。
6. SPlayer-Next 宿主契约（来自 SPlayer-Dev/SPlayer-Next `electron/main/plugins/net.ts`）：`splayer.request` 走 Electron `net.fetch`，跳转自动跟随、无 manual 模式、拿不到最终 URL；返回 `{status, headers(终态), body}`。播放器只会调用 `wy/tx/kg` 三个 source key；播放解码是 FFmpeg，会跟随 302。⇒ 煎饼的播放地址就用 `api.php` 绝对地址本身；每次调用生成新 vkey。
7. vm 测试上下文只提供 `{splayer, URL, Promise, console, setTimeout, clearTimeout, Date}`；没有 `URLSearchParams`、`TextDecoder`。表单体用 `encodeURIComponent` 手工拼接。

## 设计

### 数据形状（先定形状）

不把煎饼塞进 `SOURCE_POLICIES`（那是 ChKSz 平台身份 + 音质阶梯 + endpoint 契约，还会被注册给宿主）。新增独立只读表 + 每会话状态：

```js
const JIANBIN_BASE_URL = "https://www.jbsou.cn/";
const JIANBIN_SETTING = "jianbinFallback";
const JIANBIN_API_TYPES = { netease: "wy", qq: "qq", kugou: "kg", kuwo: "kw" };
const JIANBIN_POLICIES = {
  wy: { name: "煎饼·网易云", searchType: "netease", idPattern: /^\d+$/,
        crossTypes: ["kuwo", "qq", "kugou"] },
  tx: { name: "煎饼·QQ 音乐", searchType: "qq", idPattern: /^[A-Za-z0-9]{8,20}$/,
        crossTypes: ["kuwo", "netease", "kugou"] },
  kg: { name: "煎饼·酷狗", searchType: "kugou", idPattern: /^[0-9A-Fa-f]{32}$/,
        crossTypes: ["kuwo", "netease", "qq"] },
};
```

会话状态（并入 `getSession()` 的新建对象）：

```js
jianbinCookie: null,        // { value, until }
jianbinCookiePending: null, // 并发合并，即使 smartCache 关闭也合并
```

错误码：`JIANBIN_BOOTSTRAP_FAILED`、`JIANBIN_FORBIDDEN`、`JIANBIN_RATE_LIMITED`、`JIANBIN_HTTP_<status>`、`JIANBIN_NETWORK_ERROR`、`JIANBIN_INVALID_RESPONSE`、`JIANBIN_DELIVERY_UNUSABLE`。**禁止**复用 `CHKSZ_HTTP_403` / `CHKSZ_CONFIG_*`（会误触 `isAccountError` 全局终止）。

冷却：单一服务级键 `"jianbin"` 存 `state.channelCooldowns`（2 分钟；429 用 Retry-After，缺省 60s，上限 `MAX_CHANNEL_COOLDOWN`）。只对服务级失败（bootstrap 失败、403 复检后仍 403、429、5xx、网络、响应形状非法）设冷却；候选级失败（probe 不通、id 不一致、无匹配）不设冷却。

### 通道函数（全部放 `createResolutionCore` 内）

```js
bootstrapJianbinCookie(state, ctx)     // GET 首页 text → 正则解析 mk_visit → 缓存 11h55m
jianbinRequest(body, state, ctx, kind) // form POST，带 Cookie: mk_visit=...；统一超时/预算/会话校验
jianbinSearchByType(type, filter, input, state, ctx) // -> candidates[]
jianbinLookupById(sourceType, id, state, ctx)        // filter=id 精确命中，校验 songid === id
jianbinMatchesTrack(type, track, state, ctx)         // 严格匹配（见下）
jianbinResolveCandidate(candidate, apiType)          // 校验 url 形状 → { url, expire, quality:"hq" }
probeDelivery(url, state, deadline, { strict: true }) // 扩展现有函数
resolveViaJianbin(stage, source, track, id, state, ctx) // 返回 result 或 null（内部吸收非终止错误）
```

`jianbinRequest` 的 `body` 形如 `input=${encodeURIComponent(input)}&filter=${filter}&type=${type}&page=1`；headers：`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`、`Referer: https://www.jbsou.cn/`、`Cookie: mk_visit=...`、常规 UA。

### 集成顺序（resolveUncached 统一失败协调）

主渠道失败（或主渠道冷却）后的尝试顺序：

1. **煎饼同类型（ID 直查）**：`source → JIANBIN_POLICIES[source].searchType`，`filter=id`，`input=原平台 ID`（仅当 id 匹配 `idPattern`；不匹配则改用歌名搜索该类型）。不需要歌名，不需要匹配校验（songid 必须等于输入 id）。
2. **现有 ChKSz 跨平台**（`resolveAcrossPlatforms` 原样保留：自己的 8 请求 / 10 秒预算，逐个平台搜索 + 解析 + 时长校验）。
3. **煎饼跨类型（歌名搜索）**：按 `crossTypes` 顺序逐 type 搜索（`filter=name`，input = 原始标题截断 ≤60 字符），严格匹配后候选逐个 probe，命中即返回。

触发门：

- 顺序 1：`state.config.jianbinFallback` 为真，且失败属于「可恢复」（`isUnavailableQualityError` 或 `isUpstreamUnavailableError`，或主渠道冷却）。与 `crossPlatformFallback` 无关（同平台不算跨平台）。
- 顺序 2：现有逻辑不变（`crossPlatformFallback` + 有歌名）。
- 顺序 3：`jianbinFallback` 且 `crossPlatformFallback` 且 `policy.crossPlatform` 存在、有歌名。
- 煎饼各步都吸收自身非终止错误（记录日志/冷却），流程继续；终止错误（宿主取消、`RESOLUTION_TIMEOUT`、`CROSS_PLATFORM_LIMIT`、账户错误）不进入煎饼，也不被吸收。
- 主渠道纯 `DELIVERY_UNUSABLE` 不触发任何兜底（保持既有测试语义）。

返回与报错：任一阶段命中即返回其结果（`quality` 固定上报 `"hq"`，不读服务端档位，`expire = (t + 1700 - 60) * 1000`）。全部失败时保留现有分支的错误选择逻辑（`canCrossSearchAfterFailure` 为假时直接抛主渠道错误；为真时维持原有 wrapper 错误码），仅在文案末尾追加煎饼已尝试的简述（不得改动既有测试断言依赖的子串）。

### 匹配策略（顺序 3 专用）

- 复用 `normaliseText` / `splitArtists`；仅接受归一化标题**严格相等**（等价 `matchScore === 2`）。
- 歌手的处理沿用 `matchScore`：原曲有歌手时要求至少一个归一化歌手 token 与候选完全一致；原曲无歌手时只按标题（服务端返回顺序优先）。
- 不使用 `isVariantFallback` 宽松路径（候选无时长，无法证明干净标题与原版本等价；与 `requireDurationForRelaxed` 的既有先例一致）。
- 每 type 命中候选按服务端顺序取前 `CROSS_PLATFORM_MAX_CANDIDATES`（economy 为 1），逐个 probe。

### 预算与超时

煎饼自有预算，不动 ChKSz 预算：

```js
const JIANBIN_REQUEST_BUDGET = 6;        // economy 3；bootstrap/search/probe 各计 1，缓存命中不计
const JIANBIN_SAME_TYPE_DEADLINE = 4_000;  // 顺序 1 时间上限
const JIANBIN_CROSS_TYPE_DEADLINE = 6_000; // 顺序 3 时间上限
const JIANBIN_BOOTSTRAP_TIMEOUT = 4_000;
const JIANBIN_SEARCH_TIMEOUT = 5_000;
const JIANBIN_SIGN_TTL_SECONDS = 1_700;
const JIANBIN_EXPIRY_MARGIN = 60_000;
const JIANBIN_COOKIE_TTL = 11 * 60 * 60_000 + 55 * 60_000;
```

每个请求超时取 `min(该步超时, 阶段剩余, 总 deadline 剩余)`；预算耗尽即停止煎饼并返回 null（记录原因）。所有数值待真实延迟数据校准。

### cookie 生命周期

- `bootstrapJianbinCookie`：GET 首页（text，clamp 超时），正则 `/document\.cookie\s*=\s*["']mk_visit=([A-Za-z0-9_-]+);/` 提取；成功缓存 `{value, until: now + JIANBIN_COOKIE_TTL}`；缺字段/非 2xx/网络失败 → `JIANBIN_BOOTSTRAP_FAILED`（服务级冷却）。
- 并发合并：`jianbinCookiePending` 存 in-flight promise，逻辑同 `sharePending` 模式；`assertCurrentSession` 后写回。
- 搜索响应 HTTP 403 或 body `code === 403` → 丢弃 cookie；**本次解析内最多**重新 bootstrap 一次并重试一次原搜索（都计预算）；再 403 → `JIANBIN_FORBIDDEN` + 服务级冷却。

### 解析、缓存与交付体检

- 播放地址 = 校验通过的 `api.php` 绝对地址。校验：`https:`、host `www.jbsou.cn`、path `/api.php`、`get=url`、`type` 与映射一致、`id === songid`、`sign` 非空、`t` 为正整数；不合法 → `JIANBIN_INVALID_RESPONSE`（服务级）。
- 缓存：按 `jianbin:v1:<searchType>:<songid>` 存 `{ url, expire, quality: "hq" }` 于 `state.responses`，TTL 取 `min(expire - URL_EXPIRY_MARGIN, now + CACHE_TTL)`；命中即直接返回。过期即重新走完整流程（不做续签复检）。
- probe：复用 `probeDelivery`，新增 `strict` 选项：状态 2xx 之外判不可用；`content-type` 以 `text/` 开头（HTML 错误页）判不可用；body 为空判不可用；旧宿主不支持 arraybuffer/自定义头时维持「无法判定即放行」。
- `quality` 恒为 `"hq"`（实测约 320kbps mp3，无更高音质证据）；不声称无损/母带，不做逐曲码率验证。

## 设置与文档

- 新设置 `jianbinFallback`（switch，默认 `true`）：label「煎饼免费源兜底」；description 说明第三方免费源、mp3 约 320k、无需 Key 不耗 ChKSz 额度、仅作无版权/故障兜底。插入 `registration.settings` 中 `crossPlatformFallback` 之后、`smartCache` 之前。
- README 增加 v0.9.0 更新段与「煎饼免费兜底」小节（触发顺序、匹配限制、音质上限、第三方免责声明）；插件头 `@version 0.9.0`、更新 `@changelog`；`package.json` version → `0.9.0`。
- 重新构建 `dist/chksz.splayer-source.js`（byte 拷贝），跑 `npm run check:dist`、`npm run check:artifact`、`npm test`、`npm run check`。

## 测试计划（test/jianbin-fallback.test.js）

harness（test/plugin-host.js）：新增 `jianbinResponse`（兼容函数/对象）与 `jianbinRequests`；按 host `www.jbsou.cn` 且无 Range 头路由到煎饼桶（Range 探测仍进 `deliveryProbes`）；默认返回 `{status: 503, body: ""}` 保证既有 158 条测试行为不变。

1. `falls back to jianbin when the primary chksz path is unavailable`（wy，顺序 1）
2. `uses the jianbin qq id lookup when the tx primary fails`
3. `uses the jianbin kugou id lookup when the kg primary fails`
4. `tries jianbin id lookup before chksz cross-platform matching`
5. `tries chksz cross-platform before jianbin cross-type search`
6. `finds a kuwo match through jianbin when chksz cross-platform had none`（顺序 3）
7. `parses mk_visit from the landing page and sends it on the form search`
8. `refreshes mk_visit once after a search 403 and retries`
9. `cools jianbin down after a repeated 403 without tripping account error handling`
10. `jianbin fallback can be disabled without extra jbsou requests`
11. `rejects jianbin candidates whose title artist or version marker differs`
12. `rejects foreign or mismatched api.php urls`
13. `caps jianbin quality at hq and derives expiry from the signature time`
14. `stops jianbin after its shared request budget is exhausted`
15. `keeps chksz cross-platform behavior when jianbin is unavailable`（回归）
16. `does not run jianbin on account errors cancellation or pure delivery failures`（回归）

行为断言调用公开 `handlers.musicUrl`，并检查 `jianbinRequests` / `requests` 的路径序列与最终 URL；时间相关用受控 `now`，不等真实超时。

## 交付物

- `src/plugin.js`（通道 + 设置 + 版本头）
- `test/jianbin-fallback.test.js` + `test/plugin-host.js` 扩展
- `README.md`、`package.json`、`dist/chksz.splayer-source.js`

## 待定项（记录不阻塞）

- ChKSz 账户错误后是否仍走煎饼（免费救场）——本批保持终止语义。
- 煎饼歌词/封面兜底。
- 签名不足 25 分钟安全窗时的 `filter=id` 续签（本批缓存 TTL 5 分钟内，不会触发）。
- 主渠道阶段时间上限（8s）。
