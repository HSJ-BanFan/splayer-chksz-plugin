# Spec: 兜底模块等价重构（2+3+4）

基线：codex/jianbin-fallback / f074f5e（v0.9.0）。目标：把 provider seam、matching 模块、fallback coordinator 抽出来，**行为与 0.9.0 完全一致**。单文件布局不变，不引入打包。

## 行为契约（pin）

1. `npm test` 现有 177 项全部保持绿，且**不得修改任何现有断言**；只允许扩展 test/plugin-host.js 的注入导出与新增测试文件。
2. 等价回放：`C:\Users\33308\AppData\Local\Temp\fallback-equivalence\equivalence.mjs` 对 12 个场景生成归一化 transcript；重构后输出必须与 baseline-0.9.0.json 完全一致（我会在验收时运行，delegate 不必运行）。
3. 逐条保持：日志字符串、错误码/错误文案、请求顺序与参数、缓存键、预算/时间常量、音质与 expire 计算、会话失效语义。

## 非目标

设置项增改（步骤 5）、熔断/storage 持久化（步骤 6）、物理拆文件/打包（步骤 7）、新 provider、落雪、版本号与 README 功能文案变更。README 仅允许补测试表格一行。

## 目标形状

### A. matching 模块（提取纯函数，行为不变）

把现有纯匹配逻辑提到顶层模块对象（单文件内）：

```js
const createTrackMatcher = () => ({
  descriptor(musicInfo),          // = getTrackDescriptor
  keyword(track),                 // = buildSearchKeyword
  stripTitleVariant(value),       // 煎饼 same 阶段 ID 形状不匹配时复用
  score(track, candidate, options),// = matchScore；jianbin cross 仍要求 === 2
});
```

保留内部实现（normaliseText / splitArtists / parseDurationSeconds / isVariantFallback 及正则常量）逐字等价；ChKSz 侧与 adapter 统一通过该模块调用。删除旧位置的一手实现，不允许新旧两份并存。

### B. Jianbin provider adapter

```js
const jianbinProvider = {
  id: "jianbin",
  name: "煎饼",
  stages: ["same", "cross"],
  enabled(state, task) -> boolean,   // same: jianbinFallback；cross: 再加 crossPlatformFallback 且有标题
  createState() -> { cookie: null, cookiePending: null },
  attempt(task, ctx) -> result | null, // 内部含 search → resolve → validate → strict probe
  classify(error) -> "service" | "candidate" | "terminal",
};
const fallbackProviders = [jianbinProvider];
```

约定：

- `attempt` 承担现 `resolveViaJianbin(stage)` 的全部职责（内部可拆 search/resolveByCandidate/validate 等私有函数）；same 阶段顺序=ID 直查→（ID 形状不符时）同类型歌名搜索；cross 阶段=crossTypes 顺序 + 严格匹配（`matcher.score(...) === 2`）。
- 状态：`state.fallback.jianbin = { cookie, cookiePending }`（getSession() 里初始化或惰性）；cookie 逻辑、TTL、403 刷新一次、名称与日志不变。
- 冷却：沿用 `channelCooldowns["jianbin"]` 与现有 cooldownMillis / Retry-After 语义，由 adapter 的失败处理函数执行（现 noteJianbinFailure）。
- 预算与时间：沿用现有 jianbin 预算（6/3）与阶段上限（4s/6s），共享方式不变；`ctx` 传 `{ state, deadline, budget, stageDeadline, attempted, ... }` 的等价物。
- 交付校验：沿用 URL 形状校验、严格 probe、缓存键 `jianbin:v1:<type>:<songid>`、quality "hq"、expire 公式。
- 日志与错误文案逐字保持（含“煎饼免费源已尝试”注记）。

### C. Fallback coordinator + 阶段表

```js
runFallbackStage(stage, { source, track, id }, ctx) -> result | null
```

- 按 `fallbackProviders` 注册顺序取 `stages.includes(stage)` 的 provider；`enabled(state, task)` 为假则跳过（不置 attempted）。
- `attempt` 返回结果即返回；抛错按 `classify` 处理：terminal 原样抛出（取消/总超时/跨平台限额/账户错误）；service → 记录冷却 + warn（现“煎饼免费源兜底失败：…”文案）；candidate → warn（现“煎饼候选（id）不可用：…”文案）；其余继续下一个 provider。
- 调用点：`resolveUncached` 与 `resolveCrossFallback` 中原 `resolveViaJianbin("same"/"cross")` 改为 coordinator 调用；ChKSz 跨平台仍在两阶段之间；`resolveViaJianbin` 迁移完即删，不留兼容壳。
- `appendJianbinNote` 语义保持：仅当至少一次 attempt 发生（attempted）时追加注记，文案不变。

### D. seam 证明（fake provider 测试）

- `test/plugin-host.js` 追加 `globalThis.__fallbackProviders` 导出并返回。
- 新增 `test/fallback-coordinator.test.js`：注入一个 fake provider，验证 (1) same/cross 阶段按注册顺序调用且 task/ctx 形状正确；(2) `enabled=false` 时跳过；(3) 返回结果被采纳；(4) classify service/candidate/terminal 三条分支行为；(5) 测试结束移除 fake，默认行为不受影响。
- 该测试是 seam 存在的唯一证明；协调器内不允许出现 provider 专属分支（jianbin 专属逻辑只能出现在 adapter 内）。

## 提交切片（每片绿）

1. `refactor: extract the track matching module`（A）
2. `refactor: extract the jianbin fallback provider`（B）
3. `refactor: add the fallback coordinator and stage table`（C + D + README 测试表一行）

每片结束运行 `npm test`；最后一片后额外 `npm run build`、`check:dist`、`check:artifact`、`check`。dist 必须重建提交。

## 验收（我执行）

- `npm test` 全绿（177 + 新增）；四项脚本检查通过。
- 等价 transcript 与 baseline 完全一致（byte-diff）。
- 抽查 diff：无 provider 专属分支泄漏到 coordinator；无新旧并存实现；无行为悄然变化（时间常量、预算、错误码）。
- 打开 stacked PR（base = codex/jianbin-fallback），未合并前不触碰已安装插件。
