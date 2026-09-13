# ChKSz 音源 · SPlayer-Next 音源插件

[![CI](https://github.com/HSJ-BanFan/splayer-chksz-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/HSJ-BanFan/splayer-chksz-plugin/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Plugin](https://img.shields.io/badge/SPlayer--Next-source%20plugin-07c160.svg)](https://github.com/SPlayer-Dev/SPlayer-Next)

> **让 SPlayer-Next 把网易云音乐、QQ 音乐、酷狗音乐的歌放出来 —— 超清母带、Hi-Res、无损、320k，能拿多好拿多好；网易云没版权的歌，自动去别的平台找同一首。**

一个可导入 [SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) 的原生 `source` 音源插件，基于 [ChKSz API](https://api.chksz.com/) 解析网易云（`wy`）、QQ 音乐（`tx`）、酷狗（`kg`）三平台的播放地址，并在内置歌词、封面没命中时兜底。

---

## 它解决什么问题

| 你遇到的 | 插件怎么做 |
| --- | --- |
| 会员歌曲、Hi-Res 歌曲放不出来 | 按 ChKSz 原生档位逐级解析，`hi-res` 直达超清母带 / master |
| 网易云**没版权**的歌点了没反应 | 按歌名、歌手、时长去 QQ 音乐和酷狗找同一首，改用那边的地址播放 |
| 服务端给了地址，播放器却打不开 | **交付体检**：返回前先确认地址真能拉流，打不开就自动降一档 |
| 额度被浪费光，连续听几首就全挂 | 智能请求复用 + 429 限流冷却 + 上游通道熔断，停止无效请求 |
| 歌词、封面缺失 | 三平台歌词（含翻译、罗马音）与封面兜底 |

## 30 秒上手

1. 下载 [`dist/chksz.splayer-source.js`](./dist/chksz.splayer-source.js)（或从 [插件市场](https://github.com/SPlayer-Dev/plugins) 安装）
2. 打开 SPlayer-Next → **设置 → 插件管理 → 本地导入**，选择该文件
3. 在插件卡片里粘贴 **ChKSz API Key**（到 <https://api.chksz.com/login> 获取，`chksz_` 开头）
4. 回搜索页，播放网易云 / QQ 音乐 / 酷狗歌曲即可

> 插件不会改变 SPlayer-Next 的解析顺序：官方接口先解析，官方拿不到完整地址时才轮到本插件。详见 [何时会走插件](#何时会走插件)。

## 支持范围

| SPlayer 来源 | ChKSz 接口 | 平台 |
| --- | --- | --- |
| `wy` | `/api/163_music` | 网易云音乐 |
| `tx` | `/api/qq_music` | QQ 音乐（按 `mid` 解析） |
| `kg` | `/api/kugou_music` | 酷狗音乐（按 `id` 解析） |

支持 `lq` / `sq` / `hq` / `lossless` / `hi-res` 五种 SPlayer 音质等级，映射到 ChKSz 原生参数：

| SPlayer 音质 | 网易云 `level` | QQ / 酷狗 `size` |
| --- | --- | --- |
| `hi-res` | `jymaster`（超清母带） | `master` |
| `lossless` | `lossless` | `flac` |
| `hq` / `sq` | `exhigh` | `320k` |
| `lq` | `standard` | `128k` |

接口文档：[网易云音乐](https://api.chksz.com/docs/163_music.html) · [QQ 音乐](https://api.chksz.com/docs/qq_music.html) · [酷狗音乐](https://api.chksz.com/docs/kugou_music.html)

## 音质：默认取最好，交付自验兜底

默认按**最佳音质**解析：`hi-res` 先取网易云的 `jymaster`（超清母带）、QQ/酷狗的 `master`，逐档向下直到命中。

但"服务端返回了地址"不等于"这个地址能播"——SPlayer-Next 在播放失败时**只会换音源、不会降音质**（[`src/core/player/index.ts`](https://github.com/SPlayer-Dev/SPlayer-Next/blob/dev/src/core/player/index.ts) 的重试状态只记录要跳过的音源，音质档位全程不变）。所以插件自己补上这一层：**拿到地址后先取前几个字节确认真的能拉流**，打不开就继续降一档。

```text
请求 hi-res
  └─ 母带档 → 拿到地址 → 交付体检（Range: bytes=0-3，CDN 请求，不消耗 ChKSz 额度）
       ├─ 可访问（2xx）        → 返回，音质最好
       └─ 被拒 / 打不开 / 超时 → 降一档重试（宿主永远不会做的事）
```

- 体检结果按地址缓存 5 分钟；`verifyDelivery` 关闭后直接返回解析结果。
- 老版本宿主若不支持自定义请求头或二进制响应，体检按"无法判定"处理，**不会因此降级**。

### 音质是怎么定的

「音质」在三层里含义不同，而且**不是一一对应**：

| 层 | 取值 | 谁说了算 |
| --- | --- | --- |
| SPlayer 逻辑音质 | `lq` `sq` `hq` `lossless` `hi-res` | 播放器界面 |
| ChKSz 原生档位 | 网易云 `level`：`standard` `exhigh` `lossless` `hires` `jyeffect` `sky` `jymaster`；QQ / 酷狗 `size`：`128k` `320k` `flac` `hires` `master` | 接口文档 |
| CDN 实际交付 | 编码与码率（实测 128 / 320 kbps MP3、962 kbps FLAC、5667 kbps FLAC） | 响应体 `level`/`bitrate` 与文件头 |

映射是多对一的：`hq` 与 `sq` 共用 `exhigh` / `320k`；`hi-res` 对应 `jymaster`（网易云）/ `master`（QQ、酷狗）/ `hires` / `sky` / `jyeffect` 五个不同事实。因此：

- **请求**档位由 SPlayer 音质按上面的映射表决定；
- **上报**的 `quality` 取自响应体里服务端实际交付的档位（`level` / `bitrate` / `format`），响应体没有该字段时才退回请求档位。实测请求 `hires` 时服务端会静默返回 `lossless`（`br` 与 lossless 完全一致），此时插件上报 `lossless`，不会把已经降级的地址标成 `hi-res`；
- 网易云的 `sky` / `jyeffect` 两档插件不使用；由于 `hq` / `sq` 共用一个原生档位，`sq` 请求成功时上报 `hq`，这是能给出的最精确答案；
- 接口文档声明「服务端不做别名或降级映射」，但实测存在静默降级，所以不要用请求档位推断实际交付的档位。

### 可播放优先（可选）

母带档实测交付 192kHz/24-bit FLAC，单曲 46–150MB（同一位歌手 6 首里 4 首是母带档，最大一首 150MB）。网络或设备吃不下这么大的文件时，打开 **`playableFirst`**（默认关闭）：

```text
hires → lossless → exhigh → standard → jymaster（母带档兜底）
```

其它档位全部不可用时仍会回头尝试母带档；想换回母带优先就关掉它。

## 网易云无版权歌曲的跨平台兜底

当网易云对一首歌在各音质都返回 `404：Music URL not found, song may be unavailable at this quality level` 时，插件进入跨平台兜底：

1. 用 `去掉版本标记的歌名 + 第一位歌手` 在 ChKSz 的 QQ 音乐点歌接口搜索（例如《世界末日(Live) 周杰伦》会以《世界末日 周杰伦》搜索，避免版本后缀压低命中率；关键词最长 60 个字符，超出时只保留歌名）；
2. ChKSz 的 QQ 搜索返回 `404`、`5xx`、网络失败或没有结果时，改用 **QQ 音乐公开搜索接口** 找同一首歌的 `mid`（不经过 ChKSz，不消耗额度），仍按下面的规则匹配；
3. 在结果中挑选歌名相同、歌手有交集、时长相差不超过 20 秒的候选；
4. 用候选的 `mid` 交给 ChKSz 按原音质等级解析（同样支持音质降级）；
5. QQ 音乐没有匹配时，再用同样的规则尝试酷狗（按 `id` 解析）。

候选歌名必须在规范化后相同（忽略大小写、空白和标点）。这里有一个**单向**的宽松匹配：如果**原曲自己的标题带版本标记**（如 `My jealousy (Original ver.)`、`世界末日(Live)`），而候选是干净标题（`My jealousy`），则视为同一首歌；反向不成立——原曲标题干净时，带 `(Live)`、`(Remix)` 等标记的候选仍会被拒绝，避免用别的版本顶替原曲。

如果原曲带歌手信息，候选也必须提供至少一位规范化后完全相同的歌手；若原曲带时长，候选时长相差不得超过 20 秒，QQ 音乐还必须以详情接口返回的 `interval` 参与校验。匹配成功时在 SPlayer 日志中记录改用的平台；两个平台都没有匹配时抛出 `CHKSZ_TRACK_UNAVAILABLE`。

时间与请求预算：整个 `musicUrl` 解析共享约 18 秒；默认跨平台阶段每个平台最多探测 3 个候选，共享最多 8 次 ChKSz 请求和 10 秒。省配额模式将候选上限改为每个平台 1 个、请求上限改为 4 次；缓存命中不计入网络请求数。

> 跨平台能否成功取决于 ChKSz 的 QQ 音乐与酷狗通道是否可用：实测出现过 QQ 音乐搜索接口对**任何关键词**（含官方文档示例）都返回 `404 未找到匹配的歌曲`、酷狗持续返回 `502/503` 的情况，而 QQ 按 `mid` 解析仍然正常。因此插件在 ChKSz 搜索失败时改用 QQ 音乐公开搜索拿 `mid`，再交给 ChKSz 解析；同一平台的 ChKSz 搜索对 3 个不同关键词连续 `404` 会进入 2 分钟搜索冷却，期间直接走公开搜索，不再浪费额度。酷狗没有备用搜索，通道故障时只能等服务端恢复。两条路都失败时插件抛出 `CHKSZ_CROSS_PLATFORM_UNAVAILABLE` 并列出各平台的真实状态，不会把服务端故障伪装成"没搜到这首歌"。

## 省配额配置

| 配置 | 默认 | 行为与取舍 |
| --- | --- | --- |
| 智能请求复用（`smartCache`） | 开启 | 合并相同并发播放请求，复用有效地址、搜索结果和元数据，短暂跳过明确不可用的音质 |
| 交付体检（`verifyDelivery`） | 开启 | 返回地址前取前几个字节确认能拉流（CDN 请求，不消耗 ChKSz 额度）；打不开就降一档 |
| 可播放优先（`playableFirst`） | 关闭 | 默认母带优先；打开后先取 `hires`、无损等通用档位，把网易云母带/音效档排到最后 |
| 省配额模式（`economyMode`） | 关闭 | 只试目标音质与标准音质；跨平台每个平台最多一个候选，总共最多四次实际请求 |
| 允许为歌词和封面额外请求（`metadataFallback`） | 开启 | 关闭后只返回已有缓存里的歌词和封面，不再为这些动作单独调用接口 |
| 网易云无版权时改用 QQ 音乐 / 酷狗（`crossPlatformFallback`） | 开启 | 关闭后不搜索替代平台，减少请求但也减少可播放的歌曲 |
| ChKSz 搜索不可用时改用 QQ 音乐公开搜索（`directSearchFallback`） | 开启 | ChKSz 的 QQ 搜索失败或无结果时，用 QQ 音乐公开接口找 `mid` 再交给 ChKSz 解析；不消耗 ChKSz 额度，但依赖第三方公开接口 |

更重视额度时，可打开省配额模式并关闭歌词/封面额外请求。省配额模式会跳过 `hires`、无损等中间探测档位，也可能跳过可播放的后续候选；它是显式取舍，不是"同样效果但保证更省"。

**智能请求复用的边界**

- 播放地址只有包含明确、有效的到期时间才缓存；在到期前 30 秒失效，最长保留 5 分钟。没有有效期的地址只合并并发请求，不用于后续播放缓存。
- 按接口、平台 ID 和原生音质区分缓存，不会把低音质地址冒充高音质。网易云与 QQ/酷狗的 ID 不混用。
- 明确表示"该音质不可用"的 404 只记住 60 秒；网络故障、取消、普通 404 和账号/额度错误不缓存为歌曲不可用。
- 网易云整条音质阶梯都返回"该音质不可用"时，按歌曲记住 5 分钟（省配额模式不记）；期间同一首歌直接进入跨平台匹配，不再重跑阶梯。
- 命中 `429` 会按 `Retry-After` 进入限流冷却（没有该响应头时按 60 秒，最长 15 分钟）。冷却期内直接返回 `CHKSZ_RATE_LIMITED` 且**不发出任何请求**。
- 某个平台返回 `502`/`503`/`504` 视为该平台上游故障，进入通道冷却：有 `Retry-After` 时按它（最长 15 分钟），否则 2 分钟；冷却期内跨平台匹配跳过该平台。
- 同一平台的 ChKSz 搜索对 3 个不同关键词连续返回 `404` 视为搜索通道故障，进入 2 分钟搜索冷却；有备用搜索的平台改走备用搜索，没有的跳过该平台。
- 搜索结果缓存 5 分钟、空搜索结果缓存 60 秒（公开搜索的结果同样如此）；跨平台仍执行歌名、歌手、时长匹配，不把搜索命中直接当作可播放。
- 歌词、封面等元数据最多复用 5 分钟；QQ/酷狗同时请求歌词和封面时共享详情请求。音频 URL 的有效期独立检查，元数据缓存不会延长其有效期。
- 每张缓存表及在途请求表最多 128 项，只存于插件内存；重载插件或更换 Key、相关配置后失效。

若 CDN 地址提前失效或需要立即重新探测，可关闭"智能请求复用"后重试；重新开启会建立新缓存。插件不预解析整个歌单，也不会为了刷新缓存主动发起后台请求。

## 常见问题

**为什么有些歌还是放不出来？**
三类原因：① 网易云没版权，而 ChKSz 的酷狗通道当前不可用、QQ 音乐公开搜索也没找到同一首歌（插件会明确报 `CHKSZ_CROSS_PLATFORM_UNAVAILABLE` 或 `CHKSZ_TRACK_UNAVAILABLE`）；② 额度受限（返回 `CHKSZ_HTTP_429`，等一分钟再试）；③ 地址本身可拉流、但客户端解码失败——插件拿到的是完全正常的响应，这种情况插件日志不会报错。

**怎么判断一首歌到底有没有经过插件？**
看 SPlayer 主日志（`app-data/logs/<日期>.log`）里带 `[plugin:chksz.splayer-source]` 的行：解析成功会有一行 `《歌名》已由 ChKSz 网易云解析，交付音质 …`，失败会有 `resolveUrl rejected`。两种都没有，说明官方接口已经给出可用地址、宿主根本没调用插件，此时播放失败与插件无关，请改看 `app-data/logs/native/audio-engine.<日期>.log` 里的解码记录。

**为什么显示的音质和我选的不一样？**
ChKSz 会静默降级（例如请求 `hires` 实际给 `lossless`），插件按**服务端实际交付**的档位上报告诉你真相，而不是照抄你选的档位。

**会不会很费额度？**
免费额度实测约 20 请求/分钟。一首无版权歌在"网易云阶梯 + 跨平台探测"下最多十余次请求，因此插件内置了缓存、限流冷却和通道熔断。可打开省配额模式进一步压低。

**API Key 安全吗？**
Key 只保存在 SPlayer 本机设置里，插件不会输出到日志或错误信息（已做脱敏）。请不要把 Key 提交到 Git、写进脚本、放进公开链接或截图。

**这个插件是 Navidrome 服务器吗？需要配置媒体源吗？**
都不是。它不替换 SPlayer 的搜索源，只负责给已有的三平台曲目提供播放地址，因此不需要在"媒体源配置"里添加 Navidrome。

## 解析流程

```text
SPlayer 内置搜索结果
        ↓
source key: wy / tx / kg
        ↓
本插件读取本地 API Key
        ↓
调用 ChKSz 对应解析接口（+ 交付体检）
        ↓
返回 { url, quality, expire? }
```

### 何时会走插件

SPlayer-Next 的解析顺序由宿主决定，插件无法改变：官方接口先解析；取得完整、非试听的地址就直接播放，只有官方接口返回不可用、仅 VIP 或仅试听时才调用音源插件。因此"非会员但有版权"并不是是否调用插件的判断条件：关键是官方接口是否返回了可用的完整地址。如果官方已返回低音质完整地址，插件不会被调用，也就无法升级音质。参见 [SPlayer 音源解析实现](https://github.com/SPlayer-Dev/SPlayer-Next/blob/dev/src/services/audioSource.ts)。

插件按这个顺序设计：它只在被调用时才发起 ChKSz 请求，成功会写一行 `已由 … 解析` 的日志。日志里没有任何 `[plugin:chksz.splayer-source]` 行，说明这首歌根本没经过插件。

### 在 SPlayer-Next 中安装（手动配置 Key）

如果插件卡片没有显示配置按钮，可以在 SPlayer-Next DevTools 控制台中执行下面的命令（把占位符替换为你自己的 Key）：

```js
await window.api.plugins.setSetting(
  "chksz.splayer-source",
  "apiKey",
  "chksz_你的个人Key",
);
```

SPlayer 的插件设置保存在本机，修改设置后无需重新导入插件。

## 错误处理

插件会检查 HTTP 状态和 JSON 响应体中的 `code`，并转换为 SPlayer 插件错误。HTTP 状态或响应体 `code` 在 `400`–`599` 时使用 `CHKSZ_HTTP_<code>`，其他非 `200` 响应体代码使用 `CHKSZ_API_<code>`；HTTP 成功但没有播放地址时使用 `CHKSZ_NO_URL`：

| 错误码 | 含义 |
| --- | --- |
| `CHKSZ_HTTP_401` | Key 缺失、无效或登录失效 |
| `CHKSZ_HTTP_402` | 额度耗尽；附响应头里的免费 / 付费剩余额度 |
| `CHKSZ_HTTP_403` | 访问被禁止 |
| `CHKSZ_HTTP_429` | 超过速率限制，并显示 `Retry-After` 和剩余额度 |
| `CHKSZ_HTTP_503` | 服务暂不可用 |
| `CHKSZ_RATE_LIMITED` | 处于限流冷却期，未发出请求，附带剩余秒数 |
| `CHKSZ_DELIVERY_UNUSABLE` | 整条阶梯的地址都通不过交付体检 |
| `CHKSZ_TRACK_UNAVAILABLE` | 至少一个平台真正搜索过，但没有匹配到同一首歌 |
| `CHKSZ_CROSS_PLATFORM_UNAVAILABLE` | 所有目标平台都因上游故障没能完成搜索 |
| `CHKSZ_NETWORK_ERROR` / `CHKSZ_REQUEST_TIMEOUT` / `CHKSZ_RESOLUTION_TIMEOUT` | 网络异常 / 单次请求超时 / 整体解析超时 |
| `CHKSZ_CROSS_PLATFORM_LIMIT` | 跨平台兜底达到请求或时间上限 |
| `CHKSZ_CONFIG_MISSING` / `CHKSZ_CONFIG_INVALID` / `CHKSZ_CONFIG_CHANGED` | Key 缺失 / 格式错误 / 解析途中配置变化 |

错误和日志会隐藏 API Key。插件不会对 `401`、`402`、`403`、`429` 无限重试。三个平台仅对明确表示音质不可用的 `404` 尝试较低音质，逻辑降级顺序为 `hi-res` → `lossless` → `hq` → `sq` → `lq`；由于 ChKSz 将 `hq` 和 `sq` 映射到同一个原生音质，相同的 API 音质不会重复请求。

## 当前限制

- SPlayer-Next 必须支持原生插件 API；如果应用版本过旧导致插件加载失败，请先升级 SPlayer-Next。
- ChKSz 返回的播放地址可能有时效；没有明确到期时间、已过缓存期或关闭智能复用时，重新解析仍需调用 API。
- 实际接口请求可能消耗 ChKSz 配额，请避免批量预解析；智能复用只能减少重复请求，不能改变服务端计费规则。
- 跨平台匹配按歌名、歌手和时长判断，仍可能匹配到现场版、翻唱或不同混音；匹配错误时可关闭开关并反馈歌曲 ID。
- 跨平台依赖 ChKSz 的 QQ 音乐与酷狗通道。QQ 搜索通道故障时插件会改用 QQ 音乐公开搜索，但按 `mid` 解析仍需 ChKSz；酷狗通道整体不可用（`502/503`）时无版权歌曲只能等服务端恢复。
- QQ 音乐公开搜索是第三方接口，可能随时变动或限流；它失败时插件退回 ChKSz 的原始错误，不影响其余流程。
- ChKSz 免费额度实测限制约 20 请求/分钟。连续试听多首无版权歌会触发限流；插件会用限流冷却与通道熔断止损，但仍建议连续失败时等待一分钟再试。
- 网易云返回的播放地址本身可拉流时，插件不保证其容器与声明一致（实测出现 `Content-Type: audio/mpeg` 的 FLAC）。这类播放失败发生在客户端解码阶段，插件日志不会报错。
- 仅使用你有权访问和播放的音乐，并遵守 ChKSz、音乐平台及当地法律法规。

## 开发与测试

需要 Node.js 20 或更高版本。入口是 `src/plugin.js` —— 一个不依赖 npm 包的单文件脚本，便于直接导入 SPlayer-Next。

```powershell
npm test          # 97 项测试（Node 内置 test runner + 模拟 splayer 宿主）
npm run build     # 把入口复制为导入产物 dist\chksz.splayer-source.js
npm run check     # 语法检查
npm run check:dist / check:artifact   # 源码与产物字节一致 / 产物可加载
```

| 测试文件 | 覆盖 |
| --- | --- |
| `test/plugin.test.js` | 请求参数、音质映射、歌词解析、错误处理 |
| `test/cross-platform.test.js` | 网易云无版权歌曲的跨平台匹配 |
| `test/quota-routing.test.js` | 实际请求数、缓存失效、配置切换、并发复用、省配额模式 |
| `test/upstream-resilience.test.js` | 429 限流冷却、上游通道熔断、"服务端故障 vs 未匹配" |
| `test/delivery-probe.test.js` | 交付体检：降级、缓存、关闭、宿主不支持时放行 |

## 发布到 SPlayer 插件市场

官方市场投稿入口是 [SPlayer-Dev/plugins 新建插件 Issue](https://github.com/SPlayer-Dev/plugins/issues/new?template=new-plugin.yml)。投稿时选择 `source`，填写 `chksz.splayer-source`，上传 `dist\chksz.splayer-source.js`，并确认自己对脚本内容和合法性负责。机器人校验通过后会自动创建 Pull Request，维护者审核通过后才会进入市场。

## 许可与免责声明

本项目代码采用 [MIT 许可证](./LICENSE)。本项目是社区插件，与 SPlayer-Next、ChKSz、网易云音乐、QQ 音乐和酷狗音乐均无官方隶属或背书关系；音乐内容和 ChKSz API 的使用需遵守相应平台的服务条款及当地法律法规。

<sub>关键词：SPlayer-Next 插件 · 音源插件 · source plugin · 网易云音乐 · QQ 音乐 · 酷狗音乐 · 超清母带 jymaster · Hi-Res · 无损音乐 lossless · FLAC · 播放地址解析 · 无版权歌曲跨平台匹配 · ChKSz API · music source plugin · NetEase Cloud Music · QQMusic · Kugou · JavaScript</sub>
