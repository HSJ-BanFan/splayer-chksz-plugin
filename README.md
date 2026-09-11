# SPlayer-Next ChKSz 音源插件

本项目是社区插件，与 SPlayer-Next、ChKSz、网易云音乐、QQ 音乐和酷狗音乐均无官方隶属或背书关系。

这是一个可导入 SPlayer-Next 的原生 `source` 插件，使用 ChKSz API 为 SPlayer-Next 的网易云、QQ 音乐和酷狗歌曲解析播放地址，并在内置歌词/封面没有命中时提供兜底。

## 依赖项目

本插件依赖 [SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) 提供插件运行环境及音源接口。

## 支持范围

| SPlayer 来源 | ChKSz 接口 | 说明 |
| --- | --- | --- |
| `wy` | `/api/163_music` | 网易云音乐 |
| `tx` | `/api/qq_music` | QQ 音乐，通过 `mid` 解析 |
| `kg` | `/api/kugou_music` | 酷狗音乐，通过 `id` 解析 |

支持 `lq`、`sq`、`hq`、`lossless`、`hi-res` 五种 SPlayer 音质等级。三个平台若明确返回“该音质不可用”的 404，都会按音质从高到低降级；网易云在所有音质都不可用（通常是无版权歌曲）时，还会按歌名、歌手和时长在 QQ 音乐、酷狗中匹配同一首歌并改用其播放地址。其他错误不会自动重试，也不会在日志中输出 API Key。

音质会按 ChKSz 接口的原生参数映射：

| SPlayer 音质 | 网易云 `level` | QQ / 酷狗 `size` |
| --- | --- | --- |
| `hi-res` | `jymaster` | `master` |
| `lossless` | `lossless` | `flac` |
| `hq` / `sq` | `exhigh` | `320k` |
| `lq` | `standard` | `128k` |

对应接口文档：[网易云音乐](https://api.chksz.com/docs/163_music.html)、[QQ 音乐](https://api.chksz.com/docs/qq_music.html)、[酷狗音乐](https://api.chksz.com/docs/kugou_music.html)。

## 构建

需要 Node.js 20 或更高版本：

```powershell
cd D:\02_Dev\Projects\splayer-chksz-plugin
npm test
npm run build
npm run check
```

构建产物是：

```text
dist\chksz.splayer-source.js
```

## 在 SPlayer-Next 中安装

1. 打开 **设置 → 插件管理 → 本地导入**。
2. 选择 `dist\chksz.splayer-source.js`。
3. 启用插件，点击插件卡片上的配置按钮。
4. 在 `ChKSz API Key` 中粘贴个人 Key。
5. 按需调整 `网易云无版权时改用 QQ 音乐 / 酷狗` 开关（默认开启）。
6. 回到搜索页，搜索并播放网易云、QQ 音乐或酷狗歌曲。

如果插件卡片没有显示配置按钮，可以在 SPlayer-Next DevTools 控制台中执行下面的命令（把占位符替换为你自己的 Key）：

```js
await window.api.plugins.setSetting(
  "chksz.splayer-source",
  "apiKey",
  "chksz_你的个人Key",
);
```

Key 需要从 <https://api.chksz.com/login> 获取，格式应以 `chksz_` 开头。

项目源码和构建产物都不包含 Key。不要把 Key 提交到 Git、写入脚本、放进公开链接、日志或截图；也不要把 SPlayer 本地插件配置文件分享给他人。SPlayer 的插件设置会保存在本机，修改设置后无需重新导入插件。

本项目代码采用 MIT 许可证；音乐内容和 ChKSz API 的使用仍需遵守相应平台、接口服务条款及当地法律法规。

## 解析流程

```text
SPlayer 内置搜索结果
        ↓
source key: wy / tx / kg
        ↓
本插件读取本地 API Key
        ↓
调用 ChKSz 对应解析接口
        ↓
返回 { url, quality, expire? }
```

这个插件不是 Navidrome 服务器，因此不需要在“媒体源配置”页面添加 Navidrome。它也不替换 SPlayer 的搜索源，只负责给已有的三平台曲目提供播放地址。

### 何时会走插件

SPlayer-Next 先用内置官方接口解析播放地址，只有官方接口拿不到完整地址（无版权、仅 VIP 可听、只能试听等）时才会调用音源插件。因此非会员且有版权的网易云歌曲不会经过本插件，其音质由 SPlayer 内置接口和账号权限决定，这不是插件能改变的。

### 网易云无版权歌曲

网易云对无版权歌曲在所有音质都会返回 `404：Music URL not found, song may be unavailable at this quality level`。插件在把 `hi-res → lossless → hq → sq → lq` 全部试完后，会依次：

1. 用 `歌名 + 第一位歌手` 在 ChKSz 的 QQ 音乐点歌接口搜索；
2. 在结果中挑选歌名相同、歌手有交集、时长相差不超过 20 秒的候选；
3. 用候选的 `mid` 按原音质等级解析（同样支持音质降级）；
4. QQ 音乐没有匹配时，再用同样的规则尝试酷狗（按 `id` 解析）。

匹配成功时 `quality` 为实际取到的音质，并在 SPlayer 日志中记录改用的平台。两个平台都没有匹配时抛出 `CHKSZ_TRACK_UNAVAILABLE`，错误信息包含歌名和网易云的原始错误。跨平台匹配至少会进行一次搜索和一次解析；当搜索结果包含多个同名候选，插件会逐个解析并用详情中的时长再次校验，因此额外额度消耗会随候选数量和音质降级次数增加。不希望消耗额度时可在插件配置中关闭该开关。

由于跨平台匹配依赖 SPlayer 传入的歌名、歌手和时长，通过 DevTools 手动调用 `resolveUrl` 时需要在 `musicInfo` 中附带 `name`、`singer`、`interval` 字段，否则只会执行网易云的音质降级。

## 错误处理

插件直接把 ChKSz 的 HTTP 错误和 `msg` 转换为 SPlayer 插件错误：

- `401`：Key 缺失、无效或登录失效；
- `402`：额度耗尽；
- `403`：访问被禁止；
- `429`：超过速率限制，并显示 `Retry-After`；
- `503`：服务暂不可用。

插件不会对 `401`、`402`、`403`、`429` 无限重试；`429` 也不会在插件内部自动等待重试。三个平台仅对明确表示音质不可用的 `404` 尝试较低音质，逻辑降级顺序为 `hi-res` → `lossless` → `hq` → `sq` → `lq`；由于 ChKSz 将 `hq` 和 `sq` 映射到同一个原生音质（网易云 `exhigh`，QQ 音乐和酷狗 `320k`），相同的 API 音质不会重复请求。跨平台匹配过程中遇到 `401`、`402`、`403`、`429` 会立即停止并原样抛出；其他匹配失败只记录警告并继续尝试下一个平台。

## 当前限制

- SPlayer-Next 必须支持原生插件 API；如果应用版本过旧导致插件加载失败，请先升级 SPlayer-Next。
- ChKSz 返回的播放地址可能有时效，SPlayer 重新解析时会再次调用 API。
- API 每次解析都会消耗 ChKSz 配额，请避免批量预解析；网易云无版权歌曲的跨平台匹配会额外消耗配额。
- 跨平台匹配按歌名、歌手和时长判断，仍可能匹配到现场版、翻唱或不同混音；匹配错误时可关闭开关并反馈歌曲 ID。
- 仅使用你有权访问和播放的音乐，并遵守 ChKSz、音乐平台及当地法律法规。

## 发布到 SPlayer 插件市场

官方市场投稿入口是 [SPlayer-Dev/plugins 新建插件 Issue](https://github.com/SPlayer-Dev/plugins/issues/new?template=new-plugin.yml)。投稿时选择 `source`，填写 `chksz.splayer-source`，上传 `dist\chksz.splayer-source.js`，并确认自己对脚本内容和合法性负责。机器人校验通过后会自动创建 Pull Request，维护者审核通过后才会进入市场。

## 开发

入口文件为 `src/plugin.js`，它是一个不依赖 npm 包的单文件脚本，便于直接导入 SPlayer-Next。`npm run build` 只将入口复制为导入产物；`test/plugin.test.js` 使用 Node 内置测试模块和模拟的 `splayer` 宿主验证请求参数、音质映射、歌词解析和错误处理；`test/cross-platform.test.js` 覆盖网易云无版权歌曲的跨平台匹配。
