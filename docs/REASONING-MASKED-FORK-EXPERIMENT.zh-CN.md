# Reasoning-masked fork 实验说明

本文描述 `experiment/reasoning-masked-fork` 的核心实验：不要求模型暴露 hidden CoT，也不在 provider 原生消息中硬删 `reasoning_content`；runtime 在合法 Session 边界上重建 child context，让 child 保留 Primary 的可见文字、行为与环境反馈，但不继承近期显式 reasoning block。

## 1. 研究假设

Primary 可能已经采样出一个高概率解释，并在后续 reasoning 中不断降低主观不确定性。仅靠 prompt 让它“意识到分叉并主动调用工具”，会漏掉它自己没有感知到的盲点。

本实验押注的是一个更弱、也更可测的主张：

> 对同一条已发生的 observable trajectory，保留 visible text、action 和 result，只遮蔽近期显式 reasoning block，再做一次隔离采样，有时能让模型找到 Primary 原采样没有覆盖的解释或错误。

这不是“恢复真实思维”，也不是“熵测量”。它只是一次 context intervention。

## 2. 三种 history boundary

```text
fresh：     不继承父 Session，只看调用方投影
fork：      继承一个完整、协议平衡的父 Session prefix
mid-fork：  继承较老的完整 prefix；把选中的近期完整 Step 重写为 observable snapshot
```

`mid-fork` 对应 `masked-review` 角色。同一实现有两个正交轴：

```text
window = recent-steps(K) | current-turn
mask   = reasoning-only  | action-only
```

bundle 的手动配置注册 `recent-steps(1...8) + reasoning-only` provider family；Primary 每次为 `masked-review` 选择 K。自动实例使用 `current-turn + reasoning-only`。下图是自动实例：

```text
Primary Session

Turn 1 ─ Turn 2 ─ Turn 3 ─ Turn 4（正在 stopping，尚未 turn/end）
  └──────── exact balanced seed ────────┘  │
                                           └─ current-turn window
                                       ↓ runtime projection
                               user/plugin inputs
                               assistant visible prose
                               assistant tool calls
                               tool results
                               no recent reasoning

Child Session

[exact older seed]
        ↓
[reasoning-masked observable snapshot]
        ↓
[masked-review task]
```

当前 stopping boundary 的 open Turn 中，所有已经 `step/end` 的完整 Step 会进入 snapshot，更早完成的 Turn 不受固定 K 影响。若 snapshot 超过字符上限或 20 张 suffix 图片，provider 会在创建 child 前完整跳过，绝不截断或丢图后让 child 对残缺轨迹下结论。

手动 K 是模型参数，不是部署写死的 Turn 数。一次模型 response 即一个 Step；即便该 response 含多个并行 tool call，仍只算一个 Step。当前调用 `deliberate` 的 Step 尚未结束，因此排除。若请求 K 大于现有完整 Step 数，runtime 使用实际数量并把 requested/projected 两个值返回；没有完整 Step 则不创建 child。

## 3. 为什么必须在 Subagent provider 做

Prompt 只能请求“忽略前面的解释”，不能让已经进入 request messages、adapter replay state 或 KV prefix 的内容消失。`SubagentProvider` 才负责 child 的 seed/context construction。

本包因此有两个 Cordis 入口：

| 包入口 | Cordis plugin | 作用 |
| --- | --- | --- |
| `dsh-deliberation/mid-fork-provider` | `subagent-mid-fork-in-process` | 同一入口按配置注册手动 `mid-fork-step-1...8` family 与自动 `mid-fork-current-turn` 实例 |
| `dsh-deliberation` | `tool-deliberation` | 注册手动工具、policy 和自动 stopping-boundary review |

这里的 `mid-fork provider` 是历史构造 provider，不是 DeepSeek/OpenAI 这种 LLM provider。它最终仍使用配置 route 指定或继承的模型。

对应源码：

- [`src/mid-fork-provider.ts`](../src/mid-fork-provider.ts)：选切口、生成 snapshot、启动共享 in-process child driver；
- [`src/auto-review.ts`](../src/auto-review.ts)：监听 stopping boundary、运行 child，并按 publication policy 决定是否 `steer`；
- [`src/contracts.ts`](../src/contracts.ts)：三类 child 的输出协议与最小硬校验；
- [`src/index.ts`](../src/index.ts)：配置、手动 `deliberate`、角色 preset 和插件装配。

## 4. 保留与删除矩阵

| 数据 | 较老 prefix | projected snapshot | 原因 |
| --- | --- | --- | --- |
| user message | 原样 seed | 保留 | 任务输入是可观察事实 |
| plugin injected context | 原样 seed | 保留并标来源 | 属于模型当时收到的输入 |
| assistant reasoning block | 原样 seed | 删除并计数 | 正是要局部移除的 actor rationale |
| assistant visible prose/final explanation | 原样 seed | 保留 | reasoning-only 干预不猜测哪些公开文字属于解释或自我辩护；child 将其视为 actor claim |
| assistant tool call | 原样 seed | 从权威 `tool/call` event 保留 | 保留实际选择的 action |
| tool result/error | 原样 seed | 保留 | 保留环境反馈 |
| image | 按原生 message role 留在 seed | 只保留 attachment ref 浅拷贝并标记来源 | 不读 bytes、不转 base64；reasoning-only 保留可观察图片，action-only 删除 assistant-origin 图片 |
| provider/model replay state | 原样 seed | 删除 | 不把近期私有 replay 带入 child |
| 当前 stopping Turn | 自动实例不进旧 seed | 按上述规则投影全部已完成 Step | 让审查覆盖刚发生的完整行为，同时排除 in-flight Step |

`action-only` 使用同一表，但会额外删除 projected snapshot 中的 assistant visible prose；tool arguments 和 tool results 仍保留。它是更强的干预与评测对照，不是默认方案。

较老 prefix 仍可能含早期 reasoning 和 bias。这是局部干预，不是无历史的新 agent。

## 5. 为什么不直接删一条 assistant message 的 reasoning

原生历史里的 assistant message 可能同时承载 reasoning、text、tool call、provider/model provenance 和 replay state。支持 thinking + tool call 的 adapter 可能要求这些字段成对回放。只删 reasoning、保留其余原生结构，既可能协议非法，也无法证明 KV cache 真正对应“同一状态但没有解释”。

当前实现使用两段合法输入：

1. 只在完整边界保留旧 seed；
2. 把之后的事件递归投影为一条新的普通 user-context snapshot，其中只含扁平的 `text` / `image` blocks；原始 `tool-call` / `tool-result` wrapper 不回放。

完整 child 输入只要含图，provider 就在 child Session 创建前检查最终 route 的模型目录声明。能力未知、明确不支持 image、adapter 查询失败，或 native seed 出现 assistant-role image 时，整次 review 返回安全的 `unsupported-content`；不会自动 caption、换模型或塞图片占位符。

因此即使模型完全不返回 reasoning log，实验仍然有变化：近期原生 assistant replay 被 observable snapshot 取代，但 assistant 可见文字仍被保留。变化仍可能来自 provenance、位置、压缩或措辞，不能被宣称为纯粹的“去 CoT 因果效应”。

## 6. 自动触发时序

```text
Primary Step 完成
  ↓ step/end 已进入 Session
ReactLoopAgent 准备停止 Turn
  ↓ emit agent/turn-stopping
auto-review listener
  ├─ child session?                         → skip
  ├─ scope=tool-bearing 且本 Turn 无 tool? → skip
  ├─ 已手动 masked-review?                  → skip
  ├─ 已有 checkpoint / 已尝试?              → skip
  └─ ctx.subagents.start('mid-fork-current-turn', ...)
         ↓ one-shot child LLM call
         ↓ structured_output packet
         ↓ dispose child run
  ↓
publication policy
  ├─ updates-only + update → agent.steer(plugin notice)
  ├─ updates-only + no_update → 不写父 inbox
  ├─ all → agent.steer(plugin notice)
  └─ observe-only → 不写父 inbox
  ↓ 若发布
同一个 Primary Turn 再运行一个 assimilation Step
  ↓
第二次 turn-stopping 被 attempted/checkpoint 门挡住
  ↓
turn/end
```

这不是 `agent/pre-step` 的“每 K Step 猜一次”，也不是拦截每个 mutation tool。选择 `turn-stopping` 的理由是：

- Session 已包含刚结束 Step 的完整可观察事件；
- Primary 已形成候选 continuation，review 有对象可审；
- `steer` 是 Harness 已有的同 Turn 继续机制，但只有 publication policy 选中结果时才使用；
- 一次 Turn 只需一个确定 checkpoint，不需要定义“关键决定”或 token entropy。

代价也很明确：它发生得晚，偏向 review/repair，而不是在每个内部 semantic fork 之前扩展搜索；Web 还可能已经显示 draft。

## 7. 返回为何要分信息类型和确定度

child 能做的是探索和压缩，不能保证每条内容正确。输出因此采用一个稀疏 item 数组，而不是要求每个角色填满一套问卷：

| 轴 | 枚举 | 含义 |
| --- | --- | --- |
| `kind` | `observation` / `conclusion` / `assumption` / `unknown` / `possible_error` / `suggestion` | 这条内容在决策中扮演什么角色 |
| `certainty` | `certain` / `likely` / `uncertain` | child 对该条内容的自报确定程度 |

没有某类内容就不创建 item；没有决策增量就返回 `status: no_update` 并省略 `items`。`validReviewPacket()` 校验 role、枚举、非空字符串、重复项、item 数量和总字符数，但不能验证自然语言真实性。`certain` 只是 child claim，最终仍由 Primary 判断。

## 8. 能力和安全边界

自动审查默认关闭；显式启用 bundled 配置时，child 使用 `read-only`：`read`、`grep`、`glob`。这允许 coding trace 审查代码文本，却不能执行测试。因此“运行测试”只能作为 `suggestion`，不能伪装成 `observation`。

不开放 write/edit/bash 的原因不是保守文案，而是 in-process child 共享 Primary 的持久 cwd。没有私有 workspace 时，逆向实验一旦 mutation，就可能直接改变 Primary 正在使用的环境，破坏“可丢弃分支”契约。

逐 branch 可写实验需要 Harness/workspace seam：独立 worktree、overlay filesystem、事务或可验证 rollback。当前插件没有假装实现它。

## 9. A/B/C/D 实验

先测 history intervention 是否有增益，再测自动触发的总效果：

| 组 | 机制 |
| --- | --- |
| A | 无插件 / Primary 单轨迹 |
| B | 手动 `trajectory-audit`，完整 fork |
| C | 手动 `masked-review`，mid-fork |
| D | stopping-boundary 自动 `masked-review` + 按 publication policy 决定是否 Primary assimilation |

优先使用有真实 action/result、已知 ground truth、且存在诱导性错误 prefix 的 coding/debugging trace。指标至少包括：

- correction rate；
- false diversion rate（原轨迹正确时是否硬造错误）；
- useful decision delta；
- evidence grounding；
- Primary adoption quality；
- task success / tests passed；
- child latency、总 token、timeout rate；
- draft 被 review 后改变的比例，以及改变是否正确。

不要把“调用率”当最终能力指标。自动路径理论上每个合格 Turn 都调用；真正要测的是净任务收益是否覆盖额外成本和误导。

## 10. 必须承认的结论

- 这是充分挖掘既有模型能力的 sampling/runtime 方法，不会突破模型完全不具备的知识或推理能力。
- Primary 和 child 使用同模型时，相关错误仍可能很强；一致不等于验证。
- stopping boundary 是稳定触发点，不是高熵点的语义证明。
- 删除近期 rationale 可能减少锚定，也可能删除真正有用的信息；净效应必须实验。
- child packet 可能错误，schema 只能让不确定性更显式。
- 每次自动审查尝试都会增加一次 child 推理；只有发布 packet 时才增加 Primary assimilation Step。
- 任何已经发生的文件、数据库、网络或其他外部副作用都不会被撤销。

这套设计最诚实的定位是：**一次 runtime 强制、历史受控、结果可丢弃的第二次审视，而不是事实裁判、自动 rollback 或“模型潜能必然提升器”。**
