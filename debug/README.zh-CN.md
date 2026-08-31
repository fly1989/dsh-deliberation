# dsh-deliberation 本地 Debug Lab

这个目录不是新的 DSH plugin，也不是新的 bundle。它只提供：

1. 一个把 `debug: true` 打开的 patch overlay；
2. 一张从 `pnpm dsh web` 到 child 返回结果的源码地图；
3. 一套区分“插件没加载”“模型没调用”“child 失败”的操作步骤。

## 0. 先记住：这条链不是一次函数调用

```text
pnpm dsh web
  ↓
Loader 读取 profile / bundle / --patch
  ↓
Cordis 创建 root Context 和 plugin Fiber
  ↓
Loader 调用每个 plugin 的 apply(ctx, config)
  ↓
dsh-deliberation 等 spawn/fork provider
  ↓
ctx.tools.register() 注册 deliberate
  ↓
Web 创建 Primary Agent（创建会话时才发生）
  ↓
AgentLoop 组装 system prompt + tool schemas
  ↓
模型决定是否生成 deliberate tool call
  ↓
ToolRuntime 调用 execute(args, exec)
  ↓
ctx.subagents.start() 创建 one-shot child
  ↓
child 用 structured_output 交付 insight
  ↓
runBranch() 等待结果并 dispose()
  ↓
renderer 将结构化 value 投影成 tool/result 文本
  ↓
Primary 收到结果并继续自己的 loop
```

没有 Web 会话时，前半段仍然会运行；没有模型请求时，后半段不会运行。这不是故障，而是 Agent 按需创建和按需执行的结果。

## 1. Debug overlay 怎么用

先在 plugin checkout 构建一次：

```powershell
cd dsh-deliberation
npm run build
```

如果还没有把本地 bundle 加进 Web profile，只做一次：

```powershell
cd ..\dsh\deepseek-harness
pnpm dsh plugin --profile web add ..\..\dsh-deliberation
```

### 1.1 只看配置，不启动 Runtime

从 Harness checkout 执行：

```powershell
pnpm dsh --profile web --patch ..\..\dsh-deliberation\debug\cordis.patch.yml --dump-config
```

你应该能看到 `tool-deliberation` 行以及 `debug: true`。

这一步只做配置组合：

- 不创建 root Runtime；
- 不执行 `apply()`；
- 不注册 provider listener；
- 不注册 `deliberate` tool。

所以在这里打 `apply()` 断点不会命中。

### 1.2 启动 Web Runtime，但不创建会话

```powershell
pnpm dsh web --patch ..\..\dsh-deliberation\debug\cordis.patch.yml --no-open
```

这一步会执行插件生命周期，即使你还没有创建具体 Agent：

```text
apply()
  → 等 provider
  → maybeMount()
  → installTool()
```

终端应出现类似的 debug breadcrumbs：

```text
[tool-deliberation][debug] apply tool=deliberate freshProvider=spawn forkProvider=fork
[tool-deliberation][debug] tool-mounted name=deliberate
```

如果看到：

```text
waiting-for-providers fresh=missing fork=ready
```

说明插件本身已经加载，只是 `spawn` 尚未进入 `ctx.subagents`。

## 2. 需要断点时怎么启动

不要在浏览器 DevTools 里调服务端源码。想用 Chrome DevTools 调 Node 侧，在 Harness checkout 执行：

```powershell
node --inspect-brk=9229 --import tsx/esm apps/cli/src/bin.ts web --patch ..\..\dsh-deliberation\debug\cordis.patch.yml --no-open
```

然后打开：

```text
chrome://inspect
```

点击 Node 进程的 `inspect`。

### 2.1 本插件断点地图

源码文件：[`../src/index.ts`](../src/index.ts)

| 函数 | 什么时候命中 | 命中说明 |
| --- | --- | --- |
| `apply(ctx, config)` | Web Runtime 加载 plugin 时 | Cordis 已创建本插件 Fiber，开始注册生命周期资源 |
| `maybeMount()` | plugin 启动、provider-added 时 | 检查 `spawn` 和 `fork` 是否都可用 |
| `installTool()` | 两个 provider 都通过 capability 检查时 | 将 `deliberate` 注册到 DSH ToolRuntime |
| `ctx.systemPrompt.section()` | `apply()` 里注册；section 文本在 prompt assembly 时求值 | 把 policy 放入 Primary 的 system prompt |
| `execute(args, exec)` | Primary 真正生成 `deliberate` tool call 后 | ToolRuntime 开始执行一次 deliberation round |
| `runBranch()` | 每个 branch 一次 | 选择 provider、route、capability、deadline 并启动 child |
| `branchPrompt()` | child 启动前 | 形成 child 唯一主动输入的 context projection |
| `renderDeliberationOutput()` | 所有 branch settle 后 | 将 canonical value 变成 Primary 可读的 `ContentBlock` |

## 3. 看到日志后应该怎么判断

### 情况 A：什么日志都没有

```text
没有 apply
```

先查：

1. `--dump-config` 是否真的有 `dsh-deliberation` bundle 和 `tool-deliberation` row；
2. 当前命令是否使用了同一个 `web` profile；
3. 本地 plugin 是否重新 `npm run build`；
4. Web Runtime 是否真的重启过。

### 情况 B：有 `apply`，没有 `tool-mounted`

说明 Cordis plugin 已运行，但依赖没齐：

```text
apply
  → waiting-for-providers
```

检查 DSH base profile 是否提供 `spawn`、`fork`，以及 provider 是否声明 `outputSchema`、`depthLimit`、`toolFilter`。

### 情况 C：有 `tool-mounted`，没有 `tool-call`

这通常不是插件执行错误，而是：

> Primary 没有选择生成 `deliberate`。

插件注册成功只表示模型“可以看到这个工具”，不表示模型一定会调用它。

### 情况 D：有 `tool-call`，没有 `branch-start`

检查：

- `branches` 是否为空或超过 `maxBranches`；
- `label` 是否重复；
- `goal`、`incumbent`、`context`、`focus` 是否为空或格式错误；
- route/capability 是否在 overlay 白名单里。

### 情况 E：有 `branch-start`，但没有 `branch-published`

child 在 provider 启动或发布前失败。继续看：

```text
branch-start-failed ... reason=startup-error
```

这时查 provider、`maxDepth`、`toolFilter` 和 structured-output capability。

### 情况 F：有 `branch-published`，但没有正常结果

继续看：

```text
branch-result
branch-result-rejected
branch-cleanup
```

重点是 child 是否返回了符合该 role 专属 output schema 的结构化值、`insight.kind` 是否与 role 一致，以及是否触发 branch timeout。

## 4. 每一个阶段对应 DSH 哪段源码

### 4.1 Loader 和 Profile patch

```text
dsh 命令入口
  → apps/cli/src/bin.ts
  → apps/cli/src/profile-boot.ts
  → compose bundle patches + profile patch + --patch overlays
```

关键 DSH 文件：

- `apps/cli/src/args.ts`：解析 `--profile`、`--patch`、`--dump-config`；
- `apps/cli/src/profile-boot.ts`：组合 patch 层并启动 profile；
- `packages/boot/app-boot/README.md`：Profile、bundle、patch、Loader 契约。

这里还没有 Primary，也没有模型。只是决定“最终要加载哪些 plugin entry”。

### 4.2 Cordis Context 和 Fiber

```text
最终 entry list
  → Cordis Loader
  → Context.plugin()
  → plugin Fiber
  → apply(ctx, config)
```

本地 Cordis 源码：

- `node_modules/@deepseek-ai/cordis/src/context.ts`：Context 和 service resolve；
- `node_modules/@deepseek-ai/cordis/src/fiber.ts`：Fiber、effect、disposer、unload；
- `node_modules/@deepseek-ai/cordis/src/service.ts`：命名 service 的注册。

本插件只消费 `ctx` 上已有的 DSH service，没有创建新的 `deliberation` service。

### 4.3 本插件启动和挂载

```text
src/index.ts
  apply()
    ├─ resolveConfig()
    ├─ ctx.on('subagent/provider-added')
    ├─ ctx.on('subagent/provider-removed')
    ├─ maybeMount()
    └─ ctx.systemPrompt.section(...)
```

对应 DSH service：

| 本插件代码 | DSH service |
| --- | --- |
| `ctx.subagents.getProvider()` | `SubagentRuntime` provider registry |
| `ctx.subagents` events | `subagent/provider-added`、`subagent/provider-removed` |
| `ctx.tools.register()` | `ToolRuntime` |
| `ctx.systemPrompt.section()` | `SystemPrompt` |

### 4.4 Primary Agent 组装请求

Primary Agent 创建和 Agent loop 不在本插件里：

- `packages/core/agent/src/`：Agent handle、registry、scope；
- `packages/core/agent-loop/src/`：每 step 的 loop、request、tool call；
- `packages/core/system-prompt/src/`：sections、tool schemas、prompt assembly；
- `packages/core/tools/src/`：参数校验、tool execute、output render。

运行顺序是：

```text
AgentLoop
  → systemPrompt.assemble(agent scope)
  → ToolRuntime 提供 deliberate schema
  → LLM request
```

所以 Web 页面加载完成，不代表 `deliberate` 已被模型调用；它只代表宿主 runtime 已经可以提供这个能力。

### 4.5 `execute()` 和 child

本插件：

```text
src/index.ts
  installTool()
    └─ execute(args, exec)
         ├─ 校验 Primary 参数
         ├─ Promise.all(branches.map(runBranch))
         └─ 返回 branches[]
```

DSH child 侧：

- `packages/subagent/subagent/src/`：`ctx.subagents.start()` 的 provider seam、request/result、ownership；
- `packages/subagent/subagent-in-process-driver/src/`：spawn/fork 的 Agent 创建、structured output、取消、dispose；
- `packages/core/agent/src/`：child Agent handle 和 child scope。

本插件不直接 `new Agent()`。它是 caller；provider/driver 才负责创建和拥有 child 生命周期。

## 5. Web Runtime 和浏览器 DevTools 的边界

`dsh-deliberation` 是 Host/Node plugin，不是 browser client plugin：

```text
Node 进程
  ├─ Cordis
  ├─ AgentLoop
  ├─ ToolRuntime
  ├─ SubagentRuntime
  └─ dsh-deliberation  ← 在这里打 Node 断点

浏览器
  └─ Web UI / client plugins  ← 在这里看页面、Network、SSE、UI 错误
```

`pnpm run dev:web` 主要监听和重建 DSH 浏览器 client bundle。修改本插件的 `src/index.ts` 后，可靠循环是：

```text
npm run build（dsh-deliberation）
  ↓
重启 dsh web
```

如果只修改 Profile 的 `cordis.patch.yml`，DSH 的 user patch watcher 通常可以重组配置；但新增/替换本地 plugin 包时，直接重启最容易判断。

## 6. 一次最小真实验证

启动带 debug overlay 的 Web：

```powershell
pnpm dsh web --patch ..\..\dsh-deliberation\debug\cordis.patch.yml --no-open
```

创建 Web session 后先发送一个**链路 smoke 请求**。这一步故意明确要求调用，用来验证 plumbing，不用于评估模型能否自主触发：

```text
我们即将决定线上解析故障的第一项排查动作：先修改 parser，还是先验证输入规范。
在形成最终建议前调用 deliberate。把当前判断保持为 provisional，提供可观察事实、约束和未知项；运行一个 independent-alternative 和一个 trajectory-audit，均使用 reason-only，不要修改文件。收到结果后由你综合并作答。
```

观察顺序：

```text
tool-mounted
  → tool-call
  → branch-start
  → branch-published
  → branch-result
  → branch-cleanup
  → round-complete
```

如果只看到 `tool-mounted`，但看不到 `tool-call`，先不要改 `runBranch`；模型还没有调用工具。

## 7. 修改代码后的最小循环

```text
改 src/index.ts
  ↓
npm run typecheck
  ↓
npm test
  ↓
npm run build
  ↓
重启 dsh web
  ↓
重新观察 debug breadcrumbs
```

日志只打印：

- provider 是否 ready；
- tool 是否 mounted；
- branch label/role/history/route/capability；
- runId、stopReason、structured 是否存在、cleanup 状态。

它不会打印 branch prompt、模型原文、API key、隐藏推理或 provider 原始 payload。

## 最后只按这四个断点理解本插件

```text
apply       = 插件有没有活起来？
installTool = deliberate 有没有注册？
execute     = Primary 有没有调用？
runBranch   = child 有没有真正启动？
```

先把这四个问题逐个打通，再去研究 Cordis 的其他插件。你不需要先理解 DSH 全仓库，才能修改这一个 plugin。
