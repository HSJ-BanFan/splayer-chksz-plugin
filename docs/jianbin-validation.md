# 煎饼免费兜底验收（v0.9.0）

基线：v0.8.2 / 94f0c0c。测试日期：2026-10-14（Asia/Shanghai）。分支：codex/jianbin-fallback。

## 自动化验证

- 基线 158 项测试通过；新增 19 项煎饼测试后共 177 项通过。
- `npm run build`、`check:dist`、`check:artifact`、`check` 全部通过；产物与源码字节一致。
- 既有 ChKSz 行为不变：跨平台预算、请求序列、账户错误终止语义均有回归测试覆盖。

## 真实请求验证

在 Node VM 中按 `test/plugin-host.js` 的宿主契约加载真实源码，用 `fetch` 实现 `splayer.request`。ChKSz 侧模拟上游 503（不调用真实 ChKSz，不消耗任何 Key 额度），煎饼与 CDN 全部为真实网络请求。

| 场景 | 实际链路 | 结果 |
| --- | --- | --- |
| QQ（tx）晴天 | ChKSz QQ 503 → 煎饼 `filter=id`（mid `0039MnYb0qxYhV`）→ api.php → kugou/QQ CDN | 返回 hq；Range 206，`audio/mpeg`，ID3 文件头 |
| 酷狗（kg）晴天 | ChKSz 酷狗 503 → 煎饼 `filter=id`（hash `B3A52A…A818B7`）→ api.php → CDN | 返回 hq；Range 206，`audio/mpeg`，ID3 文件头 |
| 网易云无版权路径 | 煎饼 `filter=id` 返回 404 空结果 → ChKSz 跨平台失败 → 煎饼跨类型（kuwo 优先）严格匹配《晴天》→ api.php | 返回 hq；Range 206，`audio/mpeg`，ID3 文件头 |

每个场景使用独立会话，避免冷却串扰。播放地址是 `www.jbsou.cn/api.php` 签名地址，播放时由宿主跟随 302 到平台 CDN；签名按签发时间 +1700 秒估算有效期，上报 `expire` 预留 60 秒安全窗。

真网实测修正了三处 mock 测不出的问题：

- 搜索 POST 必须携带 `X-Requested-With: XMLHttpRequest`，否则站点返回 200 HTML 而不是 JSON。
- 站点返回的 `url` 字段是相对地址 `api.php?...`，需要按站点根拼接后再校验与返回。
- 搜索无命中时站点返回 HTTP 200 + 业务码 404（`data` 为空字符串）；这是空结果而不是服务故障，不能触发通道冷却。不存在的 ID 还会回显 name/artist 为空的占位条目，该条目也必须被拒绝。

## 真机播放验证（安装后的 SPlayer）

环境：SPlayer-Next 1.1.0（Windows），本机安装的插件脚本已替换为本次构建（SHA-1 `8878d436…`，与 PR 产物一致）。通过应用本地 MCP 派发曲目，间隔约 6 秒采样两次 `get_now_playing` / `get_playback_status`，再按时间戳关联主日志与原生音频引擎日志。

| 用例 | 曲目 | 插件路由 | 原生引擎实际加载 | 采样 |
| --- | --- | --- | --- | --- |
| 无版权（wy） | 说谎 / 林宥嘉（网易云 `108390`，官方无版权） | 煎饼跨类型命中酷我 `kw id=614564`；同类型网易云候选被严格体检判定为 HTML 页面并拒绝 | `https://www.jbsou.cn/api.php?get=url&type=kw…` | 16744 → 22674ms，播放中 |
| QQ（tx） | 晴天 / 周杰伦（`0039MnYb0qxYhV`） | 煎饼 QQ ID 直查 | `…type=qq…` | 47281 → 53342ms，播放中 |
| 酷狗（kg） | 晴天 / 周杰伦（`b3a52a…`） | 煎饼酷狗 ID 直查 | `…type=kg…` | 235 → 6295ms，播放中 |
| 酷狗（kg） | 最伟大的作品 / 周杰伦 | 煎饼酷狗 ID 直查 | `…type=kg…` | 444 → 6374ms，播放中 |
| 酷狗（kg） | Anti-Hero / Taylor Swift | 煎饼酷狗 ID 直查 | `…type=kg…` | 0 → 5877ms，播放中 |
| 酷狗（kg） | 圣诞星 / 周杰伦 | 煎饼酷狗 ID 直查 | `…type=kg…` | 235 → 6295ms，播放中 |

测试期间 ChKSz 上游出现真实 503（“上游连续失败，链路正在熔断恢复”），未人为注入故障；插件按设计先试煎饼同类型、再试 ChKSz 跨平台、最后煎饼跨类型，全部用例由煎饼交付。原生日志中六次加载均为 `www.jbsou.cn/api.php` 地址，未见解码错误。

边界：采样为 6 秒窗口的播放推进与引擎加载记录，不是整曲完整性验证，也未确认实际出声（本机音量 0.2）；每条链路只覆盖一首或数首样本。测试为加载新版脚本重启了应用，测试曲目加入了播放队列，最终停留在暂停状态。

## 交付与边界

- 本地导入文件：`dist/chksz.splayer-source.js`（v0.9.0、API Level 2）。
- 记录未保存 ChKSz Key、签名播放地址、Cookie 或其它凭据；测试未调用真实 ChKSz 接口。
- 解析层、CDN 交付层与安装后宿主播放均已验证；真机样本为短窗口采样，不等同于整曲完整性验收。
- 煎饼是第三方免费服务，可用性、音质和合法性不受本项目控制；插件固定上报 `hq`（约 320k mp3），不冒充无损或母带。
