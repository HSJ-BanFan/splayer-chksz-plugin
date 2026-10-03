# QQ Lite 兜底修复验收（v0.8.1）

基线：v0.8.0 / fb1aff1bd044c6d6ce2ca447e41a42d4f92c52df。
测试日期：2026-10-02（Asia/Shanghai）；真实播放解析在 23:53–23:55 进行。
修复分支：codex/fix-qq-lite-search。原始脱敏结果见 [JSON 记录](./qq-lite-validation.json)。

## 自动化验证

- 基线 119 项测试通过。
- 首轮回归在旧实现上出现 17 项预期失败：Lite 响应无法解析、业务失败被吞为无匹配、搜索错误误冷却按 mid 解析等。
- 追加边界测试发现并修正：搜索已冷却且公开搜索失败时丢失故障；宿主超时先于插件定时器返回时丢失跨平台超时语义。
- 最终 144 项测试通过；build、check、check:dist、check:artifact、git diff --check 均通过。
- 旧版“所有搜索均无结果”测试显式改为有效 Lite 空列表，避免将公开接口 503 当作正常无匹配。

## 真实请求验证

使用修改后的实际插件源码适配器，不拼接另一份搜索实现。搜索《说谎 林宥嘉》《晴天 周杰伦》《恋人未满 S.H.E》均 HTTP 200、外层/内层业务码 0，且命中录音室版本。完整 title 保留了其他候选的 Live 标记。

在 Node VM 中加载未做替换的修复源码，以真实 fetch 适配 splayer.request；保持默认配置，分别用新会话调用网易云来源 id=108390、歌名=说谎、歌手=林宥嘉、时长=4:24。

| 请求档位 | 实际链路 | 结果 |
| --- | --- | --- |
| hq | 网易云 exhigh/standard 404 → ChKSz QQ 搜索 404 → Lite 200 → 自动匹配 mid=000W95Fk3lAVxV → ChKSz 320k 200 | 返回 hq；Range 206，ID3 文件头；11.86 秒 |
| lossless | 网易云 lossless/exhigh/standard 404 → ChKSz QQ 搜索 404 → Lite 200 → 自动匹配相同 mid → ChKSz flac 200 | 返回 lossless；Range 206，fLaC 文件头；15.57 秒 |

两次成功后均未调用酷狗。Lite 单次实测约 0.3 秒。计时包含测试适配器为限频插入的等待；插件本身没有新增等待重试。

共 9 次 ChKSz 请求、5 次 QQ 公开搜索、2 次 Range 请求；ChKSz 请求开始时间至少相隔 3.5 秒，两组播放解析之间休息超过一分钟，无 429。API Key 只向 api.chksz.com 发送；记录未保存实际 Key、签名音频 URL、Cookie 登录凭据或歌词。

## 交付与边界

- 本地导入文件：dist/chksz.splayer-source.js（v0.8.1、API Level 2）。
- 不修改 SPlayer 主程序或已安装插件，不提交或推送 Git，不发布市场更新，不回复 Issue。
- Range 只验证地址交付；未操作播放器、未验证原生音频引擎完整播放，不能据此宣布全部宿主播放问题修复。
- QQ Lite 为第三方接口，后续失效时应报告业务错误并进入独立冷却，不承诺永久稳定。
