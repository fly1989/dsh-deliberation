# dsh-deliberation

[English](README.md) | 简体中文

一个非官方 DeepSeek Harness 插件：提供有界、由 Primary 控制的 deliberation，以及可选的 reasoning-masked review。

> **状态：实验预览版。** Runtime、失败隔离和协议边界已有测试；目前没有配对 benchmark 能证明它提高正确率或推理成本回报，因此自动审查默认关闭。

插件提供两条相关能力：

| 能力 | 触发方式 | 实际作用 |
| --- | --- | --- |
| `deliberate` 工具 | Primary 主动调用 | 并行运行 1–3 个有界 alternative、audit 或 masked-review child，返回紧凑 JSON packet |
| 自动 masked review | 可选的 `agent/turn-stopping` hook | 不带当前工具 Turn 已记录的 reasoning 重新复审，只向 Primary 发布决策相关增量 |

child 只提供证据、不确定项、可能错误与下一步检查，不投票、不选择 winner，也不替代 Primary。

## 五分钟启动

### 环境要求

- Node.js `22.19+` 或 `24+`
- `pnpm` 已加入 `PATH`（`dsh plugin` 底层把安装参数转发给 pnpm）
- 已能正常使用 DeepSeek Harness Web profile，并已配置模型凭据

先检查：

```powershell
node --version
pnpm --version
npx @deepseek-ai/dsh --version
```

### 安装正式发布包

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-deliberation@0.1.0
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

添加、移除或更新 Bundle 后，必须重启正在运行的 Web。配置 dump 应同时出现：

```text
subagent-mid-fork-step-family-in-process
subagent-mid-fork-current-turn-in-process
tool-deliberation
```

请从希望作为 Agent workspace 的目录启动 Web。

### 发布前测试本地 checkout

```powershell
git clone https://github.com/fly1989/dsh-deliberation.git
cd dsh-deliberation
npm ci
npm run release:check

# 最新 DSH 会先把 . 锚定到当前 checkout，再进入 profile 目录。
npx @deepseek-ai/dsh plugin --profile web add .
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

本地安装是 link。修改 TypeScript 后要重新 build；修改 Bundle 成员或编译代码后要重启 runtime：

```powershell
npm run build
```

## 第一次手动测试

插件注册的模型工具名是 `deliberate`。工具可用不等于模型必然调用，第一次 smoke 请用明确任务：

```text
检查当前 workspace 并诊断失败的校验，暂时不要修改文件。
先用只读工具得到一条具体观察，然后调用 deliberate：
一个 trajectory-audit 分支和一个 masked-review 分支，后者复审最近一个
已完成 Step。route 使用 same；audit 使用 read-only；masked review 使用
reason-only。拿到 packet 后，选择成本最低的鉴别性检查并正常继续。
```

预期流程：

1. Primary 至少完成一个含工具的 Step。
2. Web 出现通用 `deliberate` tool card。
3. 每个分支创建独立 child Session；child transcript 不进入 Primary context。
4. 工具结果为每个成功分支返回一份紧凑 packet。
5. Primary 自己判断是否采用。

## 开启自动 masked review

自动审查必须显式启用。仓库提供了一份完整的 DSH config-row replacement：

```powershell
$reviewPatch = (Resolve-Path .\examples\auto-review.patch.yml).Path
npx @deepseek-ai/dsh --profile web --patch $reviewPatch --dump-config
npx @deepseek-ai/dsh --profile web --patch $reviewPatch
```

该示例启用：

```yaml
autoReview:
  enabled: true
  scope: tool-bearing-turns
  provider: mid-fork-current-turn
  route: same
  capability: read-only
  publish: updates-only
  timeoutMs: 300000
```

若要永久启用，把 [`examples/auto-review.patch.yml`](examples/auto-review.patch.yml) 中完整的 `tool-deliberation` 配置行复制到该 Web profile 的 `cordis.patch.yml`。DSH patch 会替换目标行的整个 `config`，不会深度合并嵌套字段，所以不要只写半段 `autoReview`。普通 profile patch 修改支持热重载；安装或移除插件 Bundle 仍需重启。

收集 shadow eval 时建议先用 `publish: observe-only`：child 会运行并持久化，但绝不写入 Primary inbox。

## 三种角色

| 角色 | 历史 | 是否看 incumbent | 适合做什么 |
| --- | --- | --- | --- |
| `independent-alternative` | fresh / `spawn` | 否 | 寻找一个实质不同的机制或策略 |
| `trajectory-audit` | completed prefix / `fork` | 是 | 证伪当前轨迹，并定位最早可疑决策 |
| `masked-review` | 更老的 native prefix + recent-Step snapshot | 否 | 不看选中 Step 的 recorded reasoning，重新审视可观察行动与结果 |

手动 `masked-review` 必须填写 `recentSteps`，范围为 `1..maxRecentSteps`（默认上限 8）。一个 Step 是“一次已完成模型决策 + 该 response 引起的全部 tool call/result”；并行工具仍属于同一个 Step。正在执行 `deliberate` 的 active Step 不在窗口内。

自动路径使用 `window: current-turn`：更早完整 Turn 保持 native history，正在 stopping 的 Turn 内所有完整 Step 被投影成 reasoning-masked snapshot。

## 返回 packet

child 只返回结构化决策信息，不返回 hidden reasoning 或完整 transcript：

```json
{
  "role": "masked-review",
  "status": "update",
  "items": [
    { "kind": "possible_error", "certainty": "likely", "content": "..." },
    { "kind": "unknown", "certainty": "uncertain", "content": "..." },
    { "kind": "suggestion", "certainty": "likely", "content": "..." }
  ]
}
```

- `status`：`update` 或 `no_update`
- `kind`：`observation`、`conclusion`、`assumption`、`unknown`、`possible_error`、`suggestion`
- `certainty`：`certain`、`likely`、`uncertain`

`certainty` 是 child 自报，不是事实认证。真实 timeout、abort、child error、非法 packet 或 role 不匹配都不会发布 packet。只有 child Session 能证明 Turn 正常结束时，才允许使用严格的 final-text JSON fallback。

## 配置参考

### 手动工具配置

| 字段 | Bundle 值 | 含义 |
| --- | ---: | --- |
| `freshProvider` | `spawn` | `independent-alternative` 使用的 provider |
| `forkProvider` | `fork` | `trajectory-audit` 使用的 provider |
| `midForkProvider` | `mid-fork-step` | recent-Step provider family 前缀 |
| `maxRecentSteps` | `8` | Primary 可选的最大 K |
| `maxBranches` | `3` | 一次调用最多几个分支 |
| `maxDepth` | `1` | child delegation 的绝对深度上限 |
| `branchTimeoutMs` | `600000` | 每个手动分支独立的墙钟超时 |
| `routes` | `same` | 暴露给 Primary 的部署许可模型路线 |
| `capabilityProfiles` | `reason-only`、`read-only` | 暴露给 Primary 的 child 工具边界 |
| `debug` | `false` | 只记录安全生命周期 breadcrumb，不记录 prompt 或 child 内容 |

### 自动审查配置

| 字段 | 可选值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` / `true` | 是否挂载 stopping-boundary policy |
| `scope` | `tool-bearing-turns` / `all-primary-turns` | 哪些顶层 Primary Turn 可以触发 |
| `provider` | 默认 `mid-fork-current-turn` | 部署者控制的 history projection |
| `route` | 默认 `same` | child provider/model 路线 |
| `capability` | Bundle 默认 `read-only` | child 工具上限 |
| `publish` | `updates-only` / `all` / `observe-only` | 哪些 packet 可以进入 Primary inbox |
| `timeoutMs` | `300000` | 自动 child 墙钟超时 |

### History projection provider

| 字段 | Bundle 值 | 含义 |
| --- | ---: | --- |
| `window` | `recent-steps` 或 `current-turn` | snapshot 选择方式 |
| `mask` | `reasoning-only` | 删除 reasoning/replay state；`action-only` 仅作评测对照 |
| `maxSnapshotChars` | `65536` | 整体 snapshot 文本预算；超限完整 skip，不截断 |
| `maxSnapshotImages` | `20` | projected suffix 图片上限 |

route 和 capability 是 allowlist，不负责注册缺失能力。可移植的 `same` 继承 Primary 模型，不代表模型族独立；`read-only` 请求 `read/grep/glob`，但 profile 没有暴露这些工具时会安全退化到接近 reason-only。

## 安全与 runtime 边界

- child 永远看不到 `deliberate`；`maxDepth` 防止递归分叉。
- 手动 sibling 并行执行、独立失败。
- reasoning masking 从不修改 append-only Parent Session。
- in-process child 共享 workspace；tool filter 不等于文件系统、进程或凭据隔离。
- Bundle 不提供 mutation-capable child，也不能回滚文件、命令、数据库或网络副作用。
- 含图审查只在最终 child route 明确支持 image input 时启动，否则创建 child 前直接 skip。
- `turn-stopping` 是稳定 checkpoint，不是 token entropy detector。
- 同模型一致只是弱证据；child 是提案生成器，不是外部事实核查器。
- 每次自动尝试都会增加一次 child LLM call；发布 update 还会增加一个 Primary assimilation Step。

## 常见问题

### Web 找不到 `deliberate`

安装 Bundle 后重启 Web，再检查：

```powershell
npx @deepseek-ai/dsh plugin --profile web why dsh-deliberation
npx @deepseek-ai/dsh --profile web --dump-config
```

### 模型没有调用 `deliberate`

安装只让工具可用，不会强制模型调用。请先用上面的明确 smoke prompt。自动审查是另一条 runtime 路径，除非配置启用，否则不会运行。

### 自动 child 跑了，但 Primary 没显示更新

`updates-only` 下，合法的 `no_update` 本来就不会生成 parent notice 或 assimilation Step。协议调试可临时用 `publish: all`；shadow eval 用 `observe-only`。

### 从 Git 安装时 pnpm 拒绝运行 build

Git 源码依赖会执行 `prepare`，pnpm 10 可能要求 profile 的 `pnpm-workspace.yaml` 先声明构建许可。优先安装正式 npm 包；若必须装 Git，请复制 pnpm 错误中给出的精确 `allowBuilds` key，加入 profile 后重新安装。

### pnpm 提示缺少 DSH peer dependencies

DSH profile 有意设置 `autoInstallPeers: false`。树外插件把 Host API 声明为 peer，而 DSH launcher 会通过 profile fallback 提供同一套 Cordis/DSH 实例。因此 `plugin add` 时出现 peer warning 属于预期行为；不要在插件里再安装第二份 Cordis。请用 `--dump-config` 和一次真实 Web boot 验证兼容性。

## 开发与发布检查

```powershell
npm ci
npm run release:check
```

release check 会依次完成类型检查、全部测试、production build 和 npm tarball dry run。当前目标版本线是 DSH `0.1.1-rc.2`；Harness 仍处于 developer preview，每次升级后都应重跑 smoke。

## 深入文档

- [Runtime 完整流程](docs/FLOW.zh-CN.md)
- [Cordis / Harness / 源码映射](docs/CORDIS-HARNESS-MAPPING.zh-CN.md)
- [研究假设、论文、本地实验与评测计划](docs/MASKED-REVIEW-RESEARCH-NOTES.zh-CN.md)
- [Reasoning-masked fork 实现说明](docs/REASONING-MASKED-FORK-EXPERIMENT.zh-CN.md)
- [术语表](docs/TERMS.zh-CN.md)
- [待定与明确不支持内容](docs/DEFERRED.zh-CN.md)

MIT。本项目与 DeepSeek 没有从属或背书关系。
