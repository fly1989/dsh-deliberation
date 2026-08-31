# `dsh-deliberation`：Cordis、DSH Harness 与源码对照

这不是另一份使用说明，而是一张“同一段代码在三层系统里分别叫什么”的地图：

```text
Cordis：负责插件生命周期、依赖注入、作用域、事件和清理
        ↓
DSH Harness：把这些基础能力组织成 tools / systemPrompt / agents / subagents
        ↓
dsh-deliberation：组合这些服务，提供 deliberate tool + stopping-boundary masked review
```

版本背景：本文按 DSH 0.1.x 的公开 plugin/subagent/tool seam 撰写，当前 CI 使用 `@deepseek-ai/cordis 4.0.1` 与 DSH `0.1.1-rc.2` 验证。DSH 仍处于 developer preview，升级到更新的 0.1.x 后请重新运行检查；源码路径示例只用于说明概念，不假设读者的本地目录结构。

## 1. 先记住三层，不要把它们混成一个“插件”

| 层 | 原始概念 | 在本项目中的实际对象 | 它回答的问题 |
| --- | --- | --- | --- |
| Cordis | `Context`、plugin、`Fiber`、`inject`、event、effect/disposer | `apply(ctx, config)` 接收到的 `ctx`，以及由 loader 创建的插件 fiber | 这段代码挂在哪个作用域？依赖何时可用？卸载时谁清理？ |
| DSH Harness | `ToolRuntime`、`SystemPrompt`、`Agent`、`SubagentRuntime`、provider | `ctx.tools`、`ctx.systemPrompt`、`exec.agent`、`ctx.subagents` | 模型能看到什么？如何创建 child？如何取消和收集结果？ |
| 本插件 | provider 选择、branch prompt、自动 checkpoint、结构化结果、同步 barrier | `src/index.ts`、`src/auto-review.ts`、`src/mid-fork-provider.ts` | 手动或 runtime 何时启动 child，child 看到什么，结果如何回到 Primary？ |

一句话：**Cordis 不知道什么是 deliberation；DSH 只提供 lifecycle seam；本插件把这些 seam 拼成一个模型工具和一个固定 stopping-boundary runtime review。**

## 2. 从 `cordis.patch.yml` 到一个 Cordis plugin

本项目的 [`cordis.patch.yml`](../cordis.patch.yml) 是一个 DSH Profile Bundle 的 patch 层，不是 Cordis 核心 API 的另一种写法：

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
        autoReview:
          enabled: false
          provider: mid-fork-current-turn
          route: same
          capability: read-only
          publish: updates-only
        # ...
```

真实启动链是：

```text
DSH profile / bundle manifest
  ↓ 读取 dsh.bundle.patch
cordis.patch.yml 的 entry list
  ↓ Loader 组装最终插件树
Cordis Context.plugin(dsh-deliberation, config)
  ↓ 创建一个 Fiber 和该 Fiber 的子 Context
分别为两个 mid-fork 配置实例与 tool-deliberation 调用 apply(ctx, config)
```

DSH 中 bundle 的 manifest 约定是：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

因此要区分三个容易重名的字段：

| 字段 | 所属层 | 在本项目中的值 | 含义 |
| --- | --- | --- | --- |
| patch `id` | DSH Loader entry | `subagent-mid-fork-step-family-in-process` / `subagent-mid-fork-current-turn-in-process` / `tool-deliberation` | 配置行在最终 plugin tree 中的稳定 entry id；同一 plugin 可以出现多个配置实例 |
| patch `name` | DSH Loader entry | `dsh-deliberation/mid-fork-provider` / `dsh-deliberation` | Loader 要加载的包 export/module 名 |
| `export const name` | Cordis plugin 元数据 | provider 入口为 `subagent-mid-fork-in-process`；主入口为 `tool-deliberation` | 模块声明的 Cordis plugin 名称；它不必等于每个 patch entry 的 `id` |

两个 provider entry 都指向同一个 plugin 入口；第一行按配置注册 recent-Step provider family，第二行注册 current-turn 单实例。entry `id` 与模块导出的 Cordis plugin `name` 是不同字段。**不能据此推断所有 DSH 插件都这样命名。**

DSH 原始实现可对照：

- bundle 契约：`../../dsh/deepseek-harness/packages/bundle/README.md`
- Profile、patch 和 Loader：`../../dsh/deepseek-harness/packages/boot/app-boot/README.md`
- Cordis 基础 Quick Start：`../node_modules/@deepseek-ai/cordis/README.md`

## 3. 插件入口：源码对应的 Cordis 概念

源码：[`src/index.ts`](../src/index.ts)

### 3.1 `name`、`inject`、`Config`

```ts
export const name = 'tool-deliberation'
export const inject = ['subagents', 'systemPrompt', 'tools']
export const Config = z.object({ /* ... */ })
```

| 源码 | Cordis 原始概念 | DSH 对应 | 重要含义 |
| --- | --- | --- | --- |
| `name` | plugin descriptor 的稳定名称 | Loader/诊断中看到的插件名 | 只是插件身份，不是 model-facing tool 名称 |
| `inject` | plugin 的依赖声明 | 需要 `SubagentRuntime`、`SystemPrompt`、`ToolRuntime` 三个 service | Cordis 会在 plugin callback 运行前检查依赖是否可解析 |
| `Config` | plugin config schema | `cordis.patch.yml` 中 `config` 的运行时校验与默认值 | 部署者决定 provider、route、能力边界和预算；模型不能改这层 |

`inject` 不是 TypeScript import 的替代品，而是 Cordis 的**运行时依赖顺序**。本插件虽然 import 了这些 service 的类型，但真正运行时从 `ctx` 读取：

```ts
ctx.subagents
ctx.systemPrompt
ctx.tools
```

### 3.2 `apply(ctx, config)`

```ts
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  // 注册事件、尝试挂载工具、贡献 system prompt section
}
```

这在 Cordis 里是**函数式 plugin callback**：

```ts
await root.plugin(plugin, config)
// plugin(ctx, config) 在它自己的 Fiber context 中运行
```

本插件没有继承 `Service`，也没有创建新的 `ctx.deliberation` service。它是一个“消费已有服务、注册工具和 prompt section”的普通 plugin。这样做对应 DSH 的设计：功能若只是 model-facing tool 和生命周期 glue，就不必人为新增一个长期 service。

同一个包里的 [`src/mid-fork-provider.ts`](../src/mid-fork-provider.ts) 也是函数式 plugin，但只声明：

```ts
export const inject = ['subagents']
```

它消费 `SubagentRuntime`，向其内部 registry 注册一个 `MidForkInProcessProvider`。它没有新增 `ctx.midFork` service，也没有新增 LLM adapter。

### 3.3 `Context` 不是业务状态对象

Cordis 的 `Context` 是一个带作用域的依赖解析代理：读取 `ctx.tools` 时解析当前 scope 可见的 service；创建 child context 不会修改父 context。

在本插件里：

```ts
ctx.tools.register(...)          // 向当前 Cordis scope 注册工具
ctx.systemPrompt.section(...)    // 向当前 scope 贡献一段 prompt
ctx.subagents.start(...)         // 通过 Harness service 创建 child
```

这里的 `ctx` 本身不保存 `goal`、`incumbent` 或 branch 结果。一次调用的请求数据只在 `execute`、`runBranch` 的局部 Promise 链中流动；这也是为什么一次 `deliberate` 结束后不会留下一个全局“当前分支状态”。

### 3.4 `inject` 的底层运行时，不是 TypeScript 魔法

DSH service 包里的 `declare module '@deepseek-ai/cordis' { interface Context { ... } }` 只是 TypeScript declaration merging：让编辑器和编译器知道 `ctx.subagents` 的类型。真正决定 `apply()` 何时运行的是 Cordis 导出的 `inject` 元数据。

```text
ctx.plugin(plugin, config)
  ↓ RegistryService.plugin()
Inject.resolve(plugin.inject)
  ↓
new Fiber(parentCtx, config, dependencyMap, runtime)
  ↓
Fiber._checkImpl(name)：从 Reflect service store 读取实现
  ↓
Fiber._refresh()
  ├─ 少一个依赖 → epoch = INACTIVE，callback 不执行
  └─ 全部存在 → epoch = :providerFiberUid:...
                     ↓
                Fiber._reload()
                     ↓
              Config 校验 + apply(ctx, config)
```

`ToolRuntime`、`SystemPrompt`、`SubagentRuntime` 都继承 Cordis `Service`。`Service` constructor 最终调用 `ctx.reflect.provide(name, instance)`；Reflect store 写入实现后 `notify([name])`，所有 inject 了这个名字的 Fiber 都重新 `_checkImpl()` / `_refresh()`。Service 被卸载时 disposer 删除实现并再次 notify，于是依赖 Fiber 自动 unload；同名 service 重新出现后 epoch 改变，Fiber 再 reload。

因此依赖图是运行时响应式图，不是 Loader 只做一次静态拓扑排序。Context 本身还是 Proxy：运行中的 plugin 若读取未声明 inject 的 service，会收到 `cannot get property "..." without inject`；若声明了但当前 inactive，则是 `cannot get required service "..." in inactive context`。

## 4. Fiber、作用域和清理：为什么注册后不用手动记全局表

Cordis 的 `Fiber` 是一次 plugin activation 的生命周期对象：它有自己的 context、依赖状态、effects 和 disposer。plugin 被卸载时，fiber 会反向执行这些清理。

本插件使用的三个 API 都是 effect-scoped：

| 源码 | Cordis 语义 | DSH 语义 |
| --- | --- | --- |
| `ctx.on('subagent/provider-added', handler)` | 注册 Fiber 所属的事件 listener | 监听 DSH SubagentRuntime provider registry 的 live event |
| `ctx.tools.register(...)` 返回的 `disposeTool` | 注册一个带 disposer 的 effect | 从 `ToolRuntime` 移除 `deliberate` schema 和 executor |
| `ctx.systemPrompt.section(...)` 返回的 disposer | 注册一个带 disposer 的 effect | 从 `SystemPrompt` assembly 移除 policy section |

所以 `apply` 不需要把 listener 放进一个手写数组，也不需要在模块级维护“是否已加载”的全局状态。Fiber unload 会兜底清掉它们；`unmount()` 只是 provider 被移除时的**提前、显式清理**。

```text
Fiber active
  ├─ provider-added / removed listener
  ├─ deliberate tool registration（如果三个 provider 已就绪）
  └─ tool:deliberate:policy section

provider removed
  └─ unmount() → disposeTool()

plugin/Fiber disposed
  └─ Cordis 反向 dispose 所有剩余 effect 和 listener
```

这解释了一个常见现象：**插件安装成功不等于 tool 已注册。**插件 fiber 可以已经 active，但如果 `spawn`、`fork` 或 `mid-fork` 尚未进入 `ctx.subagents`，`maybeMount()` 会先等待；provider 出现时由 event 再尝试挂载。

这里有两张图：Cordis 只保证 `ctx.subagents` 这个 service 存在；`spawn`/`fork`/`mid-fork` 是该 service 内部 registry 的三条记录，因此还必须靠 `provider-added/removed` event 做第二层 gating。

## 5. `systemPrompt.section`：Cordis effect 如何变成模型指令

源码：

```ts
ctx.systemPrompt.section({
  name: `tool:${resolved.toolName}:policy`,
  order: 116.75,
  text: context => ctx.tools.get(resolved.toolName, context.scope) === undefined ? '' : modelPolicy,
})
```

三层对应关系：

| 代码里的东西 | Cordis | DSH Harness |
| --- | --- | --- |
| `ctx.systemPrompt` | 当前 context 解析出的 service | `SystemPrompt` assembly registry |
| `.section({...})` | Fiber-scoped effect，返回 disposer | 注册一个有序 `PromptSection` |
| `order: 116.75` | 只是传给 service 的数据 | DSH 约定的 tool guidance 区间（100–199）中的一个位置 |
| `text(context) => ...` | service 在 assembly 时调用的 provider | 每个 agent scope 重新判断该 tool 是否可见 |

它带来的模型输入是：

```text
Harness identity
→ persona
→ 其他插件 section
→ tool-deliberation policy（116.75）
→ 可见 tool schemas
```

`policy()` 是**软门槛**：它告诉 Primary 何时在自己收敛前识别 live semantic fork、如何投影 `context`/`focus`，以及三个 role preset 各自负责什么。它不是 Cordis guard，也不是 `tools/pre-execute` 的硬拒绝逻辑。真正的硬约束在下面这些位置：

- tool 参数 schema 和 `execute` 中的 `maxBranches`、非空字段检查；
- `resolveConfig` 的部署配置检查；
- provider capability 检查；
- child `maxDepth`、`toolFilter`、`outputSchema`；
- 每 branch 的 deadline 和 parent `AbortSignal`。

DSH 原始 service：`../../dsh/deepseek-harness/packages/core/system-prompt/README.md`。

## 6. `ctx.tools.register(defineTool(...))`：一个 Cordis effect 里的 DSH Tool

源码核心：

```ts
return ctx.tools.register(defineTool({
  name: config.toolName,
  description: '...',
  parameters: { goal, incumbent, context, branches },
  output: {
    schema: DELIBERATION_OUTPUT_SCHEMA,
    render: (_args, value) => renderDeliberationOutput(value),
  },
  isConcurrencySafe: () => true,
  async execute(args, exec) { /* ... */ },
}))
```

| 源码字段 | DSH Harness 原始概念 | 运行时效果 |
| --- | --- | --- |
| `defineTool` | `dsh-tools` 的 typed tool definition helper | 生成并校验 model-facing 参数 schema |
| `name` / `description` | `ToolSchema` | 进入 Primary 的模型请求 |
| `parameters` | 参数 schema | 模型必须产生 `goal`、`incumbent`、结构化 `context` 和带 `role`/`focus` 的 `branches[]` |
| `output.schema` | canonical tool output contract | ToolRuntime 校验 `execute` 返回的 JSON value |
| `output.render` | model-facing content renderer | 把完整结构化值投影成紧凑文本；不是重新生成事实 |
| `execute(args, exec)` | ToolRuntime 的执行体 | Primary 这次 tool call 的真实工作发生在这里 |
| `exec.agent` | 当前调用的 `Agent` handle | 作为 child 的 `parent`，用于 lineage 和授权关系 |
| `exec.signal` | ToolRuntime 的 caller-owned cancellation signal | 父 turn 取消时，所有 branch 都收到取消 |
| `isConcurrencySafe` | ToolRuntime 的并发安全分类 | 声明该 tool 自身可被调度器并行；不等同于 branch 内部的 barrier |

### 6.1 Tool、plugin、skill 的边界

```text
Cordis plugin
  └─ ctx.tools.register(...) ──> model-facing tool: deliberate

model 调用 deliberate
  └─ execute(...) ──> ctx.subagents.start(...) ──> child agents
```

- **plugin** 是 runtime composition：加载、注册、监听、清理。
- **tool** 是模型可以生成的一个调用协议：schema + execute + output。
- **skill**（如果部署启用）是给模型的任务说明/资源模板；它不会创建 Cordis Fiber、不会创建 child，也不会提供 `toolFilter`。

因此 `deliberate` 既不是“第二个主循环”，也不是 skill；它是由 plugin 注册出来的普通 DSH Tool。另一个自动路径不是这个 Tool 偷偷自调用，而是 plugin 注册的 `agent/turn-stopping` listener 直接调用 SubagentRuntime。

### 6.2 为什么 canonical value 和 Primary 看到的 JSON 不完全相同

本插件的 canonical value 是：

```text
{ branches: [{ runId, stopReason, packet, history, route, capability, ... }] }
```

`output.schema` 保证程序接收的 value 完整且可校验；`output.render` 生成 Primary 看到的紧凑 JSON，只保留 branch label、role、外层 `stopReason` 和内层 packet，不把 runId、route、capability、cleanup 等运行元数据都灌进模型上下文。packet 自己的 `status` 只表示 `update | no_update`，不会与执行状态混在一起。这对应 DSH `ToolExecutionResult` 的 value/content 分离：

```text
execute 返回 value
  ↓ ToolRuntime 校验、冻结 canonical value
output.render(value)
  ↓
tool/result 的 model-facing content
```

所以 Primary 看到的是一个更小的、确定性序列化 JSON view，而不是包含全部 runtime 元数据的 canonical value。Child 的原始 assistant transcript、隐藏 CoT 和 logprob 不会因为 renderer 存在而自动进入 parent。

DSH 原始 service：`../../dsh/deepseek-harness/packages/core/tools/README.md`。

## 7. `runBranch`：从 DSH Subagent seam 到一个 child

源码核心：

```ts
run = await ctx.subagents.start(provider, {
  label: `deliberation: ${branch.label}`,
  prompt: [{ type: 'text', text: branchPrompt(...) }],
  parent,
  signal: branchSignal,
  outputSchema: ROLE_OUTPUT_SCHEMA[branch.role],
  maxDepth: config.maxDepth,
  toolFilter: capabilityFilter(...),
  ...agentOptions,
})
```

这里不是本插件直接 `new Agent()`，而是调用 DSH 定义的 provider seam：

| 本插件字段 | DSH `SubagentRuntime` 概念 | 具体含义 |
| --- | --- | --- |
| `ctx.subagents.start` | named one-shot delegation API | 由 provider 决定 child 在进程内、进程外或其他 transport 中如何运行 |
| `provider` | `SubagentProvider` registry key | 本配置选 `spawn`、`fork`、`mid-fork-step-K` 或 `mid-fork-current-turn`；不是模型名 |
| `parent` | explicit parent `Agent` | 建立 child session lineage 和父子关系；不是把 parent transcript 自动作为 prompt |
| `label` | one-shot child 的 durable display label | 用于日志/会话识别，不参与推理 |
| `prompt` | child 的 user message | 手动路径使用 `branchPrompt`；自动路径使用固定 `automaticReviewPrompt` |
| `agentOptions` | child Agent route override | 可覆盖 provider、model、maxTokens；必须来自部署允许的 route |
| `signal` | one-shot start 的 canonical cancellation | 启动前取消会回滚未发布 child；发布后取消 run 的剩余工作 |
| `outputSchema` | structured final result capability | 要求 child 不能只给普通文本，而要提交匹配 schema 的结构化值 |
| `maxDepth` | delegation depth guard | 防止 child 再通过 deliberation 递归扩张 |
| `toolFilter` | child-scoped tool visibility/restriction | 控制 schema、lookup、执行面；不是权限/文件系统隔离的总安全边界 |

### 7.1 `spawn`、`fork`、`mid-fork` 和 history 不是同一层

本插件把两层明确对应起来，但它们仍不是同一个词：

| role preset | provider 层 | history / anchoring 层 |
| --- | --- | --- |
| `independent-alternative` | `freshProvider`，默认 `spawn` | 不给 child seed、不注入 incumbent；child 没有 Primary 的 completed conversation turns |
| `trajectory-audit` | `forkProvider`，默认 `fork` | provider 用 Primary 最后一个已完成 turn 之前的平衡 prefix 创建 child，并显式注入 incumbent；当前 in-flight tool call 不在 seed 中 |
| `masked-review`（手动） | `midForkProvider` family，默认 `mid-fork-step-K` | Primary 必填 `recentSteps=K`；选择最近 K 个完整 Step，当前 caller Step 排除；旧的平衡 prefix 是 seed，被选 Step 以 input/visible-text/action/result snapshot 重投影，不注入 incumbent，不保留 reasoning block |
| `masked-review`（自动） | `autoReview.provider`，bundle 为 `mid-fork-current-turn` | 更早完成的 Turn 全部保留为 native seed，只把唯一 open Turn 内全部完整 Step 重投影；超出 snapshot 字符/图片上限时在 child 创建前跳过 |

同一 provider 实现把 `window`（`recent-steps` / `current-turn`）与 `mask`（`reasoning-only` / `action-only`）正交配置。手动配置一次注册 `1...maxRecentSteps` 的有界 family；工具把 Primary 选择的 K 映射到对应成员。bundle 都使用 `reasoning-only`；`action-only` 只作为评测 overlay，不是产品默认。

该 provider 不把 suffix 伪造成原始 assistant/tool replay，而是编译为一条只含 `text/image` 的 user message。图片复用 durable attachment ref；完整 child input 含图时，`src/child-image-input.ts` 会在 `agents.create` 前按 `agentOptions → parent.options → 最近 model source` 解析 route，并要求 `ctx.get('llm')?.resolveModelInfo()` 显式声明 image input。它是可选服务检查：text-only 输入不让主插件硬依赖 `llm`。

`validateProvider()` 检查的是 provider 的 `inheritsParentContext` 是否和这层语义一致。它不是在运行时凭字符串猜测 provider 行为，而是要求 provider 自己声明 capability。

DSH 原始实现可对照：

- provider seam：`../../dsh/deepseek-harness/packages/subagent/subagent/README.md`
- spawn/fork/mid-fork 共享 child driver：`../../dsh/deepseek-harness/packages/subagent/subagent-in-process-driver/README.md`
- 本包的 mid-fork 实现：[`src/mid-fork-provider.ts`](../src/mid-fork-provider.ts)

### 7.2 `outputSchema` 实际怎样进入 child

本插件只把 schema 传给 `ctx.subagents.start`。child 侧的共享 in-process driver 才会做下面的事：

```text
outputSchema
  ↓ attachStructuredRuntime(childCtx, schema)
child scope 注册 structured_output tool
  + order=190 的 structured-output system prompt
  + tools/result capture/guard
  ↓
child model 调用 structured_output
  ↓
SubagentResult.structured
```

所以要区分：

- `deliberate`：本插件注册在 Primary scope 的模型工具；
- `structured_output`：DSH child driver 为本次 structured delegation 临时注册在 child scope 的运行时工具。

后者不是默认显示在 Primary 的工具列表里，也不是另一个长期插件。

## 8. 能力边界：`capabilityFilter` 到底限制了什么

```ts
function capabilityFilter(profile, toolName) {
  return {
    ...profile.allow,
    deny: [...profile.deny ?? [], toolName],
  }
}
```

它做了两件事：

1. 使用部署者配置的 `allow`/`deny` 选择 child 可见的全局工具；
2. 无论配置如何，都额外 deny 当前 `deliberate`，防止递归分叉爆炸。

这对应 DSH `ToolRuntime.restrict()` / subagent `toolFilter` 的**模型面和执行面组合限制**。但它不等于：

- 私有 checkout；
- 独立文件系统；
- 更高的宿主权限；
- 事实正确性证明；
- 统计意义上的独立采样。

当前 in-process child 仍继承 Primary 的持久 `cwd`。默认 bundle 提供 `reason-only` 和仅含 `read`/`grep`/`glob` 的 `read-only`；自动 review 默认关闭，显式启用时使用 `read-only`。需要 mutation 时必须另行准备不会互相踩踏的 workspace。

## 9. 超时、取消、结果和清理的真实归属

```ts
using branchDeadline = deadline(signal, config.branchTimeoutMs, BRANCH_TIMEOUT_CODE)
const branchSignal = branchDeadline.signal
```

这段不是新的 Cordis Fiber，也不是 provider 自己的 retry。它是本插件在一次 Tool execution 内增加的**branch 级 AbortSignal deadline**。

一次 branch 的所有权可以这样看：

```text
branch 未发布
  provider owns setup
  signal abort → provider rollback → plugin 只返回 not-started

branch 已发布
  plugin owns SubagentRun
  await run.result
  finally await run.dispose()
```

源码里的对应关系：

| 源码 | DSH/Harness 语义 |
| --- | --- |
| `deadline(parentSignal, ms, code)` | 组合 parent cancellation 与 branch wall-clock budget |
| `timeoutOf(branchSignal, code)` | 只判断是否为本插件定义的 timeout；不把内部 abort reason传给模型 |
| `run.result` | `SubagentResult`：`structured`、`stopReason`、安全 `diagnostic` |
| `run.dispose()` | caller-owned one-shot run teardown；等待 child 资源 quiesce |
| `Promise.all(branches)` | 本插件的同步 round barrier；所有 sibling settle 后才返回 parent tool result |
| `catch { ... }` | 失败隔离和安全降级；不把 provider 内部 payload 直接塞进 Primary |

`Promise.all` 是本插件的 orchestration 选择，不是“Cordis 自动并发”。Cordis 只负责 plugin/Fiber 级生命周期；branch 并发、超时和 barrier 是 `execute` 内的业务控制流。

## 10. 稀疏 JSON packet 的完整回流链

以一个 `independent-alternative` branch 为例：

```text
Primary 生成 deliberate tool/call
  ↓ DSH ToolRuntime 校验 goal / incumbent / context / branches
tool-deliberation.execute()
  ↓ branchPrompt() 生成 child user message
ctx.subagents.start('spawn', request)
  ↓ DSH in-process driver 创建 child Agent + child scope
child model 推理
  ↓ child 调用 structured_output
SubagentRun.result.structured = ReviewPacket
  ↓ runBranch 转成 BranchOutcome
deliberate.execute() 返回 { branches: [...] }
  ↓ dsh-tools 校验 DELIBERATION_OUTPUT_SCHEMA
output.render()
  ↓ ContentBlock.text（紧凑 JSON）
Primary 收到 tool/result
  ↓
Primary 自己综合、验证、继续、修正或放弃 incumbent
```

本插件的 schema 对应压缩后的决策信息，不是 CoT：

| 字段 | 作用 | 不是 |
| --- | --- | --- |
| `role` | 该 packet 来自哪个固定 child 角色 | 由 child 自由篡改的 history boundary |
| `status` | `update` 或 `no_update` | winner 投票 |
| `items[].kind` | observation / conclusion / assumption / unknown / possible_error / suggestion | 真实性认证 |
| `items[].certainty` | child 自报的 certain / likely / uncertain | 校准后的概率 |
| `items[].content` | 一句压缩后的决策相关内容 | hidden CoT 或完整 transcript |

## 11. 一次调用中，谁在什么上下文里工作

| 阶段 | Cordis 对象 | DSH 对象 | 本项目代码 |
| --- | --- | --- | --- |
| 配置加载 | root context / Loader fiber | Profile bundle entry | `cordis.patch.yml` |
| mid-fork 注册 | inject 了 `subagents` 的 provider fiber | `SubagentRuntime.registerProvider` | `src/mid-fork-provider.ts` |
| 插件启动 | `ctx.plugin` 创建 fiber 和 child context | `tools`、`systemPrompt`、`subagents` service 可解析 | `apply`、`resolveConfig` |
| 等 provider | 当前 fiber 的 event listener | `subagent/provider-added/removed` | `maybeMount`、`unmount` |
| Primary 组 prompt | service scope | `SystemPrompt.assemble` + ToolRuntime schemas | `policy` section + `defineTool` |
| Primary 调 tool | tool execution context | `ToolRuntime.execute`, `exec.agent`, `exec.signal` | `execute` |
| 自动 stopping review | plugin event listener | `agent/turn-stopping`、`Agent.steer` | `src/auto-review.ts` |
| 创建 child | DSH 内部 child scope/fiber（由 provider/AgentLoop 创建） | `SubagentRuntime.start`、`AgentHandle` | `runBranch` |
| child 运行 | child 的 Cordis scope | Agent loop、LLM、filtered tools、structured runtime | `branchPrompt` 只负责投影输入 |
| child 结束 | child Fiber/AgentHandle teardown | `SubagentRun.result` + `dispose` | `runBranch` 收集和清理 |
| 回到 Primary | parent tool result 或同 Turn steer effect | value/content split / Inbox continuation | `renderDeliberationOutput` / `renderAutomaticReview` |

这张表里最容易误读的一行是“创建 child”：本插件没有自己创建 Cordis `Context` 或直接构造 `Agent`。**DSH provider 才是 child 生命周期的 owner；本插件是 caller，拿到 `SubagentRun` 后负责等待并 dispose。**

## 12. 目前明确没有发生的事情

下面这些不是隐藏实现，而是当前边界：

- 没有调用 token logprob，也没有从模型响应计算 entropy；自动路径使用固定 stopping checkpoint，不声称该点就是语义高熵点。
- 没有 `agent/pre-step` hook 接管每个 Step；自动模式默认关闭。显式启用后在合格 Turn 的 `agent/turn-stopping` 尝试一次 `masked-review`，且只有 publication policy 选中的 packet 才通过 `steer` 让 Primary 继续一个 Step。
- 没有自动投票、winner、排序或多数决；branch 结果是 evidence proposal。
- 没有把任何 `suggestion` item 解释成 `Agent.cancel`、session 截断或外部 rollback。
- `mid-fork` 只改变 child seed/context；它不删除 parent event，也不撤销近期工具副作用。
- 没有后台 sidecar；`Promise.all` 是当前 tool call 内的同步 barrier。
- 没有把 `fresh` 宣称成统计独立；同模型、同题目和 Primary-authored context/focus 仍可能共享 bias。
- 没有把 `toolFilter` 宣称成 filesystem sandbox；自动 review 的 read-only 只开放 `read`、`grep`、`glob`。
- 没有让 child 调用本工具；`capabilityFilter` 永久 deny `deliberate`，并配合 `maxDepth` 防递归。
- 没有新增一个名为 `deliberation` 的 Cordis service；本项目只消费 DSH 已有 service 并注册一个 tool。

## 13. 读源码时的最短路线

如果你只想快速理解实现，按这个顺序读：

1. [`cordis.patch.yml`](../cordis.patch.yml)：看 DSH 如何把两个包入口放进 profile。
2. [`src/mid-fork-provider.ts`](../src/mid-fork-provider.ts)：看新 provider 如何切 seed 和投影近期 suffix。
3. [`src/contracts.ts`](../src/contracts.ts)：看三类 structured packet 和硬校验。
4. [`src/auto-review.ts`](../src/auto-review.ts)：看 stopping listener、child run 和 `steer`。
5. [`src/index.ts`](../src/index.ts)：依次搜 `apply`、`installTool`、`runBranch`、`branchPrompt`、`renderBranchOutcome`。
6. [`docs/FLOW.zh-CN.md`](FLOW.zh-CN.md)：再把源码映射回界面和完整时间线。

对应的 DSH 原始契约按这个顺序看：

1. `packages/core/system-prompt/README.md`：section 和 prompt assembly。
2. `packages/core/tools/README.md`：ToolRuntime、output value/content、restrict 和 cancellation。
3. `packages/subagent/subagent/README.md`：provider seam、one-shot run、capability 和 ownership。
4. `packages/subagent/subagent-in-process-driver/README.md`：spawn/fork/mid-fork child 如何共享创建流程、structured output 如何 capture。
5. `packages/core/agent/README.md`：Agent handle、agent scope、factory 和 disposal。

## 最后只记住这句话

**Cordis 提供“插件如何活着”；DSH Harness 提供 Agent、Tool、Prompt、Session event 和 Subagent seam；`dsh-deliberation` 把这些 seam 组合成手动多分支工具，以及每个合格 Primary Turn 一次的 reasoning-masked review，最终控制仍交还 Primary。**
