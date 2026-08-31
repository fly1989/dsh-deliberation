# `dsh-deliberation`：从 cfg 到 Primary 修订的完整流程

本文按真实运行顺序解释当前版本。它同时包含：

1. Primary 自主调用的模型工具 `deliberate`；
2. runtime 在 `agent/turn-stopping` 强制运行的一次 `masked-review`。

这两条路径共用 Subagent runtime、history provider、route/capability 和结构化输出协议，但触发者不同。

## 1. 总图

```text
pnpm dsh web / dsh web
  ↓
Loader compose profile + bundle layers + cordis.patch.yml
  ↓
Cordis 创建 Context / Fiber，等待 inject services
  ↓
mid-fork-provider.apply(ctx)
  ├─ ctx.subagents.registerProvider('mid-fork-step-1' ... 'mid-fork-step-8')
  └─ ctx.subagents.registerProvider('mid-fork-current-turn')
  ↓
tool-deliberation.apply(ctx, config)
  ├─ 注册 systemPrompt policy
  ├─ spawn/fork/完整 recent-Step provider family 齐全后注册 deliberate tool
  └─ 注册 agent/turn-stopping 自动审查 listener
  ↓
Web / Headless 创建 Primary Agent
  ↓
┌──────────────────────────────┬─────────────────────────────────┐
│ 模型自主路径                  │ runtime 强制路径                 │
│ Primary tool_call deliberate │ Primary 第一次准备结束 Turn      │
│       ↓                      │       ↓ agent/turn-stopping      │
│ 1~3 个 role child 并行        │ 1 个固定 masked-review child     │
│       ↓                      │       ↓                         │
│ tool/result 回到 Primary      │ plugin notice 经 steer 注入      │
└──────────────────────────────┴─────────────────────────────────┘
                              ↓
                     Primary 再判断与继续
```

## 2. cfg 不是 prompt

[`cordis.patch.yml`](../cordis.patch.yml) 是 DSH bundle layer。它声明运行时要挂载的 Cordis plugin rows：

```yaml
- insert:
    - id: subagent-mid-fork-step-family-in-process
      name: dsh-deliberation/mid-fork-provider
      config:
        providerName: mid-fork-step
        window: recent-steps
        maxRecentSteps: 8
        mask: reasoning-only
        maxSnapshotChars: 65536
        maxSnapshotImages: 20
    - id: subagent-mid-fork-current-turn-in-process
      name: dsh-deliberation/mid-fork-provider
      config:
        providerName: mid-fork-current-turn
        window: current-turn
        mask: reasoning-only
        maxSnapshotChars: 65536
        maxSnapshotImages: 20
    - id: tool-deliberation
      name: dsh-deliberation
      config:
        freshProvider: spawn
        forkProvider: fork
        midForkProvider: mid-fork-step
        maxRecentSteps: 8
        maxBranches: 3
        maxDepth: 1
        branchTimeoutMs: 600000
        routes: [...]
        capabilityProfiles: [...]
        autoReview:
          enabled: false
          scope: tool-bearing-turns
          provider: mid-fork-current-turn
          route: same
          capability: read-only
          publish: updates-only
          timeoutMs: 300000
```

这里：

- `id` 是 compose graph 中这一行 plugin instance 的稳定身份；
- `name` 是 Loader 要 import 的包入口；
- `config` 是 Cordis 校验后传给该入口 `apply(ctx, config)` 的部署配置；
- `spawn/fork/mid-fork-step-K` 是 Subagent provider registry key，不是 LLM 名称；
- `same` 是本插件暴露的 route alias；
- `read-only` 是本插件暴露的 capability alias。

这些配置不会逐字进入模型 prompt。只有 policy 文本、tool schema、branch prompt 和自动 review notice 会成为模型输入。

## 3. Cordis 为什么会按正确顺序运行

主入口导出：

```ts
export const inject = ['subagents', 'systemPrompt', 'tools']
```

含义不是 TypeScript “自动 new 三个对象”，而是：只有当前 Cordis Context 中这三个 Service 都可用，主插件 Fiber 才能执行 `apply()`。

```text
SubagentRuntime  ──provide──> ctx.subagents ───┐
SystemPrompt     ──provide──> ctx.systemPrompt ├─> tool-deliberation Fiber active
ToolRuntime      ──provide──> ctx.tools ───────┘
```

`mid-fork-provider` 只 inject `subagents`，因为它只需把一个 provider object 注册进 SubagentRuntime。

还要第二道门：`spawn`、`fork` 和 `mid-fork-step-1...N` 是 `ctx.subagents` 内部 Map 的条目，不是独立 Cordis Service。主插件因此监听：

```text
subagent/provider-added
subagent/provider-removed
```

只有 fresh、fork 和配置范围内的整个 recent-Step provider family 都存在、并声明支持 `outputSchema`、`depthLimit`、`toolFilter` 时，`maybeMount()` 才向 `ctx.tools` 注册 `deliberate`。family 任一成员消失时工具随之卸载，避免 schema 允许 K、执行时对应 provider 却不存在。

## 4. `apply()` 实际注册了什么

入口是 [`src/index.ts`](../src/index.ts) 的 `apply(ctx, config)`：

```text
resolveConfig(config)
  ├─ 校验 provider 名、route、capability
  ├─ 校验 timeout / maxDepth / maxBranches
  └─ autoReview 启用时强制显式 provider/route/capability
  ↓
maybeMount()
  └─ installTool() → ctx.tools.register(defineTool(...))
  ↓
ctx.systemPrompt.section(...)
  └─ 只在该 Agent scope 能看到 deliberate 时装入 policy
  ↓
installAutomaticReview()
  ├─ ctx.on('agent/turn-stopping', ...)
  └─ ctx.on('session/event', ...)
```

因此“plugin 已加载”和“模型调用了 tool”是四件不同的事：

1. bundle row 被 compose；
2. Cordis Fiber 依赖满足并运行 `apply()`；
3. `deliberate` tool 在当前 Agent scope 可见；
4. Primary 模型真的生成 `tool/call`。

自动审查只需要前两件事和自己显式配置的 provider；默认 bundle 使用 `mid-fork-current-turn`，不等待 Primary 生成 `deliberate` call。

## 5. Primary、Turn 和 Step

一个用户输入通常开启一个 Turn。Turn 内可以有多个 Step：

```text
turn/start
  ↓
step/start
LLM response
  ├─ 有 tool call → tool/call → tool/result → step/end → 下一 Step
  └─ 无 tool call → step/end → 准备停止 Turn
                                  ↓ agent/turn-stopping
                                  ↓ 若无人 steer
                               turn/end
```

自动 review listener 就在 `step/end` 已提交、`turn/end` 尚未提交的缝隙运行。这里的 Session 对 child 来说是自洽的：旧 seed 截在完整边界，当前 open Turn 只作为文本 snapshot，不冒充 provider 原生 replay。

## 6. 手动 `deliberate` 路径

Primary 看到两样内容：

- `policy(toolName)` 生成的简短使用边界；
- `defineTool()` 生成的参数 schema。

模型可以继续不调用；一旦生成 `deliberate` call：

```text
ToolRuntime.execute('deliberate')
  ↓ exec.agent = 当前 Primary
校验 goal / incumbent / context / branches
  ↓
每个 role 固定映射 history 和 incumbent visibility
  ├─ independent-alternative → spawn / fresh / no incumbent
  ├─ trajectory-audit        → fork / full prefix / incumbent
  └─ masked-review           → Primary 选择 recentSteps=K
                               → mid-fork-step-K / masked suffix / no incumbent
  ↓
Promise.all(runBranch(...))
  ↓ 每支独立 deadline、route、toolFilter、outputSchema
ctx.subagents.start(provider, request)
  ↓
child one-shot Agent → structured_output
  ↓ dispose()
  ↓
renderBranchOutcome() 生成紧凑 model-facing 文本
  ↓
tool/result 返回 Primary
```

某支 startup、result 或 cleanup 失败只产生安全 diagnostic；内部 exception payload 不进入 Primary。成功 sibling 仍会返回。

## 7. 自动 `masked-review` 路径

实现位于 [`src/auto-review.ts`](../src/auto-review.ts)：

```text
agent/turn-stopping({ agent, turn, signal })
  ↓
guard
  ├─ agent.session.header.origin === 'subagent' → skip
  ├─ scope=tool-bearing 且当前 Turn 无 tool     → skip
  ├─ 当前 Turn 手动调用过 masked-review         → skip
  ├─ Session 已含 checkpoint marker             → skip
  └─ attempted Set 已有 agent:turn              → skip
  ↓
ctx.subagents.start('mid-fork-current-turn', {
  parent: agent,
  outputSchema: masked-review schema,
  maxDepth,
  toolFilter: read-only + deny deliberate,
  agentOptions: selected route
})
  ↓
child LLM call + structured_output
  ↓
validate compact packet + dispose run
  ↓
publication policy
  ├─ updates-only + update → render + agent.steer(plugin notice)
  ├─ updates-only + no_update → 不写父 inbox
  ├─ all → render + agent.steer(plugin notice)
  └─ observe-only → 不写父 inbox
```

只有 publication policy 选择发布时才调用 `steer()`。它不创建新用户 Turn，而是向当前 Agent inbox 注入 continuation message，使 loop 在同一个 Turn 再跑一个 Step。`no_update` 在默认 `updates-only` 下不会续步；`observe-only` 也绝不写父 inbox。

为什么同时需要两道幂等门：

- `attempted Set` 在当前进程中立即挡住所有模式的重入；
- 只有已发布 notice 才进入父 Session，成为可从 durable history 识别的 marker。

未发布的 `no_update` 和 observe-only 只有 child Session 记录；进程恢复后允许重跑。当前契约是同一 live runtime 内最多一次，不承诺跨进程 exactly-once。child 的跨进程可见性还依赖部署启用 Session persistence。

## 8. `mid-fork` 如何构造 child

实现位于 [`src/mid-fork-provider.ts`](../src/mid-fork-provider.ts)：

```text
读取 parent.session.events
  ↓
按 provider config 选择 window
  ├─ recent-steps(K) → 最近 K 个同时具有 step/start + step/end 的完整 Step
  └─ current-turn → 唯一尚无 turn/end 的 open Turn 中全部完整 Step
  ↓
找到最早被选 Step 所在 Turn
  ↓
该 Turn 之前 → 作为完整、平衡 native seed
被选 Steps → projectMidForkHistory()；同 Turn 更早但未选的 Steps 省略
  ├─ 保留 user/plugin message
  ├─ reasoning-only 保留 assistant visible prose
  ├─ action-only 删除 assistant visible prose
  ├─ 保留 tool/call arguments
  ├─ 保留 tool/result content/error
  ├─ 递归提取图片并浅拷贝原 attachment ref
  └─ 删除 reasoning blocks 和 adapter replay state
  ↓
编译成唯一 snapshotContent，只含扁平 text/image blocks
  ↓
若 snapshot 超过 maxSnapshotChars 或 20 张 suffix 图片 → 创建 child 前完整 skip
  ↓
扫描完整 child input：foldSurface(seed) + snapshotContent + reviewTask
  ↓ 含图时
解析最终 child route，并要求 resolveModelInfo 明确包含 image input
  ├─ 未知/不支持/查询失败 → unsupported-content，不创建 child
  └─ native seed 含 assistant-role image → unsupported-content
  ↓
startInProcessRun({ seed, prompt: [...snapshotContent, ...reviewTask] })
```

手动 bundle 注册 `mid-fork-step-1...8` provider family；Primary 在 `masked-review.recentSteps` 里选择 K，runtime 再把 K 压到实际完整 Step 数，并把 requested/projected 两个值返回。当前正在调用 `deliberate` 的 Step 没有 `step/end`，不会进入窗口。自动实例是 current-turn/reasoning-only；action-only 仅供评测 overlay。Projection 元数据会统计省略量、snapshot 字符数、图片数和 attachment 声明字节数，但 omission 计数与图片 id 不进入 debug 文本。debug snapshot 由同一份 `snapshotContent` 派生，不维护第二套可能漂移的投影。Snapshot 会标记 open checkpoint，防止 child 把投影误认成原生 replay。一个 Step 对应一次模型决策；同一 response 的多个 tool call 保持在同一个 Step 下，tool result 通过 `callId` 关联，不能把并行结果的完成顺序误当成决策顺序。

## 9. route 与 capability

route 决定 child 的模型覆盖：

```text
route.same → 不传 provider/model/maxTokens override → 继承 Primary
route.strong → 只有部署者配置了真实 provider/model 才存在
```

capability 决定 child 的模型工具面：

```text
reason-only → allow: []
read-only   → allow: [read, grep, glob]
所有 profile → 额外 deny 当前 deliberate 名称
```

`toolFilter` 是 child scope 的工具约束，不是操作系统 sandbox。read-only child 与 Primary 仍共享 cwd；只是它没有 write/edit/bash 工具。任何 mutation 实验都需要独立 workspace seam。

还要区分“allowlist 中有名字”和“profile 真注册了工具”。allowlist 只会从当前全局工具集合中保留匹配项，不会创建工具。标准 Headless profile 注册 `read/grep/glob`；某些 Web profile 会禁用 `tool-fs` 和 `tool-fs-search`，此时 child 安全降级为没有文件工具，而不是获得额外权限。

## 10. structured output 与 Primary context

协议定义在 [`src/contracts.ts`](../src/contracts.ts)。child 最终必须调用 child-scope 的 `structured_output`，提交对应 role schema。模型没有直接把长篇 transcript塞回 Primary。

Primary 收到的是 JSON，不是 Runtime 再总结的一篇散文：

```json
{
  "role": "masked-review",
  "status": "update",
  "items": [
    { "kind": "possible_error", "certainty": "likely", "content": "..." },
    { "kind": "unknown", "certainty": "uncertain", "content": "..." }
  ]
}
```

没有新增信息时省略 `items`，只返回 `status: no_update`。Runtime 能验证 role、枚举、数量、长度、非空内容和重复项；不能验证 `certainty` 或自然语言内容真实。

## 11. Web 和 Headless 的可见结果

### 手动路径

Web 使用通用 tool card：`deliberate` call → result → Primary 后续文本。当前没有专用 branch editor 或可点击 runId card。

### 自动路径

Primary 的第一版 assistant draft 可能已经被 Web surface 展示；随后 Session 中出现 plugin notice，Primary 生成修订 Step。插件没有 presentation hook 去隐藏第一版。

Headless 同样遵循 Session event 顺序，只是没有 Web card。child session 独立持久化，Primary 只吃 compact packet。

## 12. 调试断点顺序

理解全链路时建议按以下顺序：

1. Loader/profile compose：确认 bundle rows 进入最终 config；
2. [`src/index.ts`](../src/index.ts) `apply()`：确认 Cordis Fiber 已激活；
3. `maybeMount()` / `installTool()`：确认三个 provider 和 tool registration；
4. Harness `ReactLoopAgent.run()` 的 `agent/turn-stopping` emit；
5. [`src/auto-review.ts`](../src/auto-review.ts) listener；
6. [`src/mid-fork-provider.ts`](../src/mid-fork-provider.ts) `start()` 与 projection；
7. DSH in-process Subagent driver：确认 child Agent/options/tool filter；
8. child `structured_output`；
9. `agent.steer()` 后 Primary 下一 Step；
10. Session `turn/end`。

调试时重点看 `agent.session.events`，不要只看模型当前 prompt 字符串。Session event 才是 turn/step/tool/action 的权威轨迹。

## 13. 当前没有做什么

- 不读取 logprob，不计算 token entropy；
- 不在每 K Step 自动启动，也不定义“关键 mutation”分类器；
- 不投票、排序、选择 winner；
- 不自动 rollback Session 或外部副作用；
- 不保证 child fact 正确或同模型真正独立；
- 不给 child mutation 工具或私有 workspace；
- 不隐藏 Web 已显示的 draft；
- 不把 child 原始 transcript 或 hidden CoT 注入 Primary。

一句话：**Cordis 负责让插件和 Service 正确存活；Harness 提供 Agent lifecycle、Session、Tool 和 Subagent seam；本插件提供手动 deliberation，并可在显式启用后于 stopping boundary 做一次历史受控审查，再把有界 JSON packet 交还 Primary。**
