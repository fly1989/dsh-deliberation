# DSH Deliberation 术语表

这份文档只解决一个问题：把 DSH、插件、工具、subagent、spawn、fork 这些容易混在一起的词拆开。

## 先记住四层

```text
DSH profile
    ↓ 加载
Plugin / Bundle
    ↓ 注册
Tool / Provider / System Prompt
    ↓ 运行
Primary + Child Subagent
    ↓ 产生
Branch Result
```

最重要的关系是：

```text
dsh-deliberation          = 插件包
deliberate                = 插件注册的模型工具
spawn / fork / mid-fork   = 创建 child 的运行时 Subagent provider
fresh / fork / mid-fork history = child 看哪些上下文
```

provider 名和 history 名有固定映射，但不是同一层概念；也不要把 Subagent provider 与模型厂商的 LLM provider 混在一起。

## DSH 和加载相关

### DSH

DeepSeek Harness。它负责把模型、工具、session、subagent、Web 或 headless 入口组合成一个 Agent Runtime。

### Profile

一套可启动的 DSH 配置，例如 `web` 或 `headless`。Profile 决定加载哪些 bundle、插件和用户 patch。

```text
web profile     = 浏览器 Web 入口 + base + 已安装插件
headless profile = 一次性命令行入口 + base + 已安装插件
```

### Bundle

一个可以向 DSH 配置树贡献 patch 的 npm 包。插件通常通过 bundle manifest 声明自己的 `cordis.patch.yml`。

### Plugin（插件）

一个安装和加载单元。插件可以注册：

- Tool
- Subagent Provider
- System Prompt
- Service
- Command
- UI 或其他运行时能力

插件不是一次调用。它在 DSH 启动时加载，并在运行期间提供能力。

本项目的插件是：

```text
dsh-deliberation
```

### Cordis / Patch

Cordis 是 DSH 使用的插件运行时和配置树机制。Patch 是对配置树进行插入、覆盖或调整的配置层。

`cordis.patch.yml` 不是 Primary 的 prompt；它告诉 DSH 启动时要挂载什么插件行。

## Primary、Tool 和 Prompt

### Primary

当前主 Agent，也就是负责直接处理用户任务、使用工具并做最终决定的模型会话。

```text
用户任务 → Primary → 工具 / 子 agent → Primary 最终决定
```

### Tool

Primary 可以调用的一个具体运行时能力。Tool 有名字、参数 schema、执行函数和返回结果。

当前插件注册的 Tool 名字是：

```text
deliberate
```

Primary 是否调用手动工具，由模型自己决定。可选自动路径可以在顶层 Primary 的 `agent/turn-stopping` 边界运行一次 `masked-review`，但 bundle 默认关闭；启用后不要求模型先调用工具。

### System Prompt / Policy

自动加入模型上下文的指导文字，告诉 Primary 什么时候适合调用工具。

当前 policy 的核心意思是：

```text
确定性工作、直接事实查询、普通委派 → 直接继续
答案、设计、诊断、计划或下一步仍存在 live semantic fork
                           ↓
不同机制/假设会改变结论，或可疑 checkpoint 支撑多个下游结论
                           ↓
在 Primary 自己收敛前调用 deliberate
```

Policy 不是执行动作。手动路径的执行动作是 Primary 发出的 `deliberate` tool call；自动路径由 runtime event listener 执行，不受这段 policy 控制。

### deliberate

本插件注册的专用 Tool。它不是普通的“帮我完成任务”的单个 subagent 委托，而是一轮有边界的多路径探索：

```text
Primary incumbent + 结构化 context
       ↓
independent-alternative / trajectory-audit / masked-review 按需并行运行
       ↓
角色标记 + 稀疏 structured JSON packet
       ↓
Primary 自己综合并决定下一步
```

## Subagent、Provider、Child

### Subagent

一个由 Primary 或 runtime 以 Primary 为 parent 启动的子 Agent 会话。它是运行对象，不一定等于某个 Tool。

普通 subagent 可以被派去完成一个具体任务；本插件则一次启动多个 subagent，分别承担不同的探索或审计职责。

### Subagent Provider

创建和管理 child 的运行时实现。Provider 决定 child 如何建立上下文、如何启动、如何结束以及支持哪些隔离能力。

当前插件配置的是：

```yaml
freshProvider: spawn
forkProvider: fork
midForkProvider: mid-fork-step
maxRecentSteps: 8
```

### spawn

一种 Subagent Provider。它用于启动不继承 parent history 的新 child，适合 `fresh` 探索。

在本插件中，`spawn` 的含义是：

```text
创建 child
提供专门的 branch prompt
不把 Primary 的历史作为 fresh branch 的输入
```

它不是操作系统的 `spawn()` 函数，也不是“自动复制完整聊天记录”。

### fork

另一种 Subagent Provider。它用于从当前 Primary 的可观察已完成轨迹建立 child，适合审计已有路径。

```text
Primary 已完成的对话 / 工具结果
                 ↓
              fork child
                 ↓
          审计早期假设和决策
```

它也不是 Git fork，也不是复制整个文件系统。

### mid-fork

本包实验性注册的第三种 Subagent Provider 实现。它从父 Session 的合法边界构造 child，并把“切哪段”与“遮什么”拆成两个配置轴：

- `window: recent-steps(K)`：Primary 为手动 `masked-review` 选择 K，runtime 只取最近 K 个同时有 `step/start` 和 `step/end` 的完整 Step；默认 bundle 允许 1–8；
- `window: current-turn`：更早完成的 Turn 全部原样 seed，只改写唯一 open Turn 中所有已完成 Step；bundle 的自动实例使用它；
- `mask: reasoning-only`：删除投影区的 reasoning；保留 user input、assistant visible content、tool outcome，以及这些可观察内容中的图片；
- `mask: action-only`：进一步删除 assistant visible content 和 assistant-origin 图片，但保留 user/tool-outcome 图片；仅作为评测对照臂。

```text
最早被选 Step 所在 Turn 之前的完整 prefix → child seed
被选 Step 的 input / assistant visible content / action / result（含保留的图片 attachment ref）→ 新 context
被选 Step 的 reasoning block / adapter replay state → 不进入 child
同 Turn 更早但未选中的 Step → 省略，避免原 reasoning 从 native seed 泄入
```

它不是 LLM provider，不新增模型 adapter，也不回滚父 Session 或外部状态。

### Parent / Child

```text
Primary = parent
探索或审计会话 = child
```

child 的结果返回给 parent，但 child 不拥有最终决定权。

### 递归分叉

child 再调用 `deliberate` 创建孙 agent。当前插件明确禁止这种行为，避免分支数量指数爆炸。

## Branch 和上下文

### Branch

一次 `deliberate` 调用中的一条隔离执行路径。默认最多 3 条 branch。自动 stopping-boundary review 固定只有 1 条 `masked-review`，不属于模型生成的 branch 数组。

每条 branch 都有自己的：

- `label`
- `role`
- `route`
- `capability`
- `focus`
- `recentSteps`（仅 `masked-review` 必填）

整个调用还带一份共享的 `context`，分成 `observations`、`constraints`、`unknowns`。`label` 只是该 branch 的稳定名称；真正决定行为和输出契约的是 `role`，窄任务由 `focus` 表达。

### fresh history

一种上下文模式，不等于 `spawn` provider 本身。

```text
fresh = child 只看到本 branch 投影出的 prompt
```

它用于减少 Primary 当前判断对 child 的锚定。

`fresh` 只保证 parent-history 隔离，不保证统计独立。使用相同模型、相同题目材料和 Primary 编写的 context/focus 时，不同 branch 仍可能产生相关错误。

### fork history

另一种上下文模式：child 可以看到 Primary 已完成的可观察对话和工具结果，但不会看到当前尚未完成的 `deliberate` tool-call turn。

```text
fork = 已完成 prefix + role-specific branch prompt
```

它用于审计，而不是从零探索。

### 重要区分：Provider 和 History

```text
spawn / fork / mid-fork-step-K = 运行时用什么 Subagent provider 创建 child
fresh / fork / mid-fork = child 看到什么历史边界
```

本插件默认把它们配成：

```text
fresh history → spawn provider
fork history  → fork provider
mid-fork history → Primary 选 K → mid-fork-step-K provider
```

但这是部署配置的对应关系，不是四个词的同义词。

### independent-alternative

独立替代角色。它自动绑定 `fresh` history、隐藏 incumbent，并要求 child 从不同的因果机制、假设集合、方案或下一步路径重新求解。它不是“必须反对 Primary”；没有可信替代时应明确说明。

它使用共享的稀疏 packet；找到替代时可返回 `conclusion`、`assumption`、`suggestion` 等 item，找不到决策增量时返回 `no_update`。

### trajectory-audit

轨迹审计角色。它自动绑定 `fork` history 并包含 incumbent。它对已完成 prefix 做最强的中性证伪：不预设一定有错；轨迹经受住检查时可以返回 `sound`，失败时才定位最早问题和受影响后缀。

它使用 `observation`、`possible_error`、`unknown` 和 `suggestion` 等 item 压缩审计结果；不会自动 reverse、回滚或强制 Primary 接受 verdict。

### masked-review

近期行为审查角色。它自动绑定 `mid-fork` history 并隐藏 incumbent。手动调用时 Primary 必须选择 `recentSteps=K`；child 看到较老的完整 prefix，以及 runtime 从最近 K 个已完成 Step 生成的 input/visible-content/action/result 投影，其中可观察图片保留原 attachment ref。当前 caller Step 被排除，投影内 reasoning block 被删除。可见解释仍是 actor claim，不应被当成独立证据。

它使用同一个稀疏 packet。没有发现足以改变决策的信息时返回 `no_update`，不要求硬造分歧或替代解释。

### incumbent

Primary 在分叉前的当前默认判断。

```text
incumbent = “我现在本来准备这样做”
```

它不是最终答案，只是给 branch 用来比较或挑战的当前基准。

### context

Primary 为这一轮分支共同编写的结构化事实投影：

- `observations`：已观察到的输入、工具结果和状态；
- `constraints`：用户约束、资源边界和不可违反的条件；
- `unknowns`：仍未解决、可能改变结论的问题。

它们必须是可观察材料，而不是隐藏 CoT。尤其对 `independent-alternative`，不要在 context 中换一种说法偷偷带入 incumbent、它的论证、期望答案或 sibling 结果。

### focus

Primary 给某条 branch 的窄任务。`role` 决定固定的认知职责和输出 schema，`focus` 只说明这一次应该把该角色用在哪个具体争点上。不要用 focus 重写一整套人格提示。

### Prefix

Primary 到当前时刻已经走过的路径：用户消息、模型决定、工具结果和状态变化。

```text
prefix = 当前轨迹的已完成前缀
```

Prefix 可能带来锚定：Primary 早期选了一个看似合理的方向，后续推理就一直围绕它展开。

### Trace

一次会话的可观察执行轨迹。它可以包含消息、工具调用、工具结果、状态变化和错误。

Trace 不等于隐藏 CoT。当前插件只允许 child 使用可观察事实。

### Context Projection

把 Primary 的部分信息按照 branch 目标重新组织成 child prompt。

```text
不是把所有上下文原样复制给 child
而是只投影完成该 branch 所需的信息
```

### Role preset

公开协议不再让 Primary 自由组合 `mode`、`history`、`includeIncumbent`，因为相互矛盾的组合会破坏实验边界。插件内部固定绑定：

```text
independent-alternative → fresh → 不注入 incumbent → 替代方案 schema
trajectory-audit        → fork  → 注入 incumbent   → 审计 schema
masked-review           → mid-fork-step-K → 不注入 incumbent → 近期行为审查 schema
```

这叫 role preset：Primary 仍决定何时调用、提供什么 context/focus，以及最终是否采用结果；插件负责守住可比较的分支边界。

## Route 和 Capability

### Route

一条部署允许使用的模型路由。它可以指定 provider、model 和 token ceiling。

当前默认 route：

```text
same = 继承 Primary 的模型和配置
```

以后可以增加 `strong` route，但那会把“多样性效果”和“更强模型效果”混在一起，测试时应单独比较。

### Capability Profile

child 可以使用哪些模型工具的白名单/黑名单。

当前提供：

```text
reason-only = 不继承模型工具，只根据投影上下文进行推理
read-only   = 只开放 read / grep / glob；显式启用 bundled 自动 review 时使用它
```

### read-only

只允许读取文件或观察状态，不允许修改工作区的 capability profile。

### Mutation Capability

会改变文件、数据库、浏览器状态或其他外部状态的能力，例如写文件、执行 shell、提交代码。

当前默认不把 mutation capability 给 deliberation child，因为多个 branch 共享工作目录时可能互相踩状态。

### Context 隔离 ≠ 文件系统隔离

child 看不到某些聊天内容，不代表它拥有私有工作目录。多个 in-process child 仍可能共享 Primary 的 cwd。

## 结果和边界

### Structured Review Packet

child 必须交付的稀疏 JSON：`role`、`status`，以及有新增信息时的 `items`。每个 item 只有 `kind`、`certainty`、`content`；不存在的类别不填。

它是压缩后的决策信息，不是 child 的完整 transcript。

### Epistemic label（认识状态标签）

`kind` 描述 observation、conclusion、assumption、unknown、possible_error 或 suggestion；`certainty` 描述 child 自报的 certain、likely 或 uncertain。Runtime 校验格式和长度，不把这些标签当成真实性认证。

### Transcript

完整消息和工具轨迹。当前插件不会把 child 原始 transcript 全量注入 Primary。

### Chain of Thought（CoT）

模型隐藏的内部推理过程。当前插件不读取、不要求 child 暴露，也不把它当作可验证证据。

### Logprob

模型对 token 的概率信息。现在很多模型 API 不返回 logprob，因此本插件不依赖它来计算 entropy。

### Entropy / 高熵点

本项目中的研究概念：多条非等价 continuation 仍可能改变答案、设计、诊断、计划或下一步。

当前没有自动 entropy detector。手动 `deliberate` 是否值得调用由 Primary 根据任务和 policy 判断；自动 `masked-review` 使用固定 `turn-stopping` checkpoint，但不宣称这个 checkpoint 就是高熵点。

### Barrier / Round

一次 `deliberate` 调用是同步 round：Primary 等待所有 branch settle 后再继续。

```text
启动多个 branch
        ↓
等待全部完成、失败或超时
        ↓
一次性把结果交给 Primary
```

### branchTimeoutMs

每条 branch 的独立墙钟时间上限。实验分支默认是 600000ms，也就是 10 分钟。

### maxBranches

一次 `deliberate` 最多允许创建多少条 branch。默认是 3。自动 review 固定只创建一个 child。

### maxDepth

child 允许继续委托的最大深度。当前默认是 1，并且 child 不能再次调用 `deliberate`。

## 一次完整调用

```text
用户任务
  ↓
Primary 形成 incumbent
  ↓
Primary 在自己收敛前识别 live semantic fork
  ↓
Primary 调用 deliberate Tool
  ↓
插件按 branch.role 取得固定 preset
  ↓
按 preset 启动 fresh / fork / mid-fork child
  ↓
child 按共享 context、专属 focus 和角色指令工作
  ↓
child 返回与角色匹配的 Structured Insight
  ↓
插件等待全部 branch settle
  ↓
Primary 综合证据，自己做最终决定
```

自动路径则不需要前面的 incumbent/tool-call 阶段：显式启用后，Primary 第一次准备结束合格 Turn 时，runtime 启动一个 current-turn `masked-review`。`publish: updates-only`（默认）只对 `status=update` 调用 `agent.steer()` 并让 Primary 运行 assimilation Step；`all` 也发布 `no_update`；`observe-only` 永不写父 inbox。

## 最容易混淆的五组词

| 容易混淆 | 正确区分 |
|---|---|
| Plugin / Tool | Plugin 是安装扩展包；Tool 是模型可调用的一个能力 |
| Subagent / deliberate | Subagent 是子 Agent；deliberate 是 Primary 可调用的多 child Tool；自动 review 可以不经过它直接启动一个 child |
| spawn / fresh | spawn 是 Provider；fresh 是上下文历史模式 |
| fork / fork history | fork 是 Provider；fork history 是 child 继承已完成 prefix 的模式 |
| System Prompt / Tool Call / Runtime hook | Prompt 只提供规则；Tool Call 是模型动作；`agent/turn-stopping` listener 是 runtime 强制动作 |
