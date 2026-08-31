# Masked Review：研究假设、设计边界与待验证问题

本文记录 `dsh-deliberation` 当前关于 reasoning masking、触发、历史投影、KV cache、child 返回和评测的已知事实与研究假设。它是研究设计说明，不是效果声明。

> **文档定位**：这是本项目的研究主文档。README 负责安装与公开契约，`FLOW.zh-CN.md` 负责运行时流程，`REASONING-MASKED-FORK-EXPERIMENT.zh-CN.md` 负责投影实现细节；关于“为什么做、目前知道什么、还不知道什么、怎样证伪”的内容统一以本文为准。

本文使用以下证据标签，避免把设计直觉写成事实：

| 标签 | 含义 |
| --- | --- |
| **协议事实** | 可由公开 API/DSH 契约或当前源码直接确认 |
| **外部研究** | 论文或研究报告在其特定模型、任务与实验条件下得到的结果 |
| **本地观察** | 本项目 smoke case 中实际出现的行为；不能外推为总体效果 |
| **研究假设** | 当前机制希望检验、但尚未被配对评测证明的主张 |
| **实现事实** | 当前版本确实实现的行为，不等于它已带来性能收益 |

## 1. 当前研究问题

Primary 在一次长 Turn 中可能经历：

```text
多个候选解释
↓
reasoning 内部探索、排除与收敛
↓
选择工具和行动
↓
根据结果继续维护已选择的路径
```

研究问题不是“怎样让 child 阅读 Primary 的完整解释后再评价一次”，而是：

> 在保留目标、可见消息、工具行动和工具结果的前提下，遮蔽 Primary 当前 Turn 或最近若干完整 Step 中已记录的 reasoning，是否能让一个新采样重新发现原轨迹没有采用的解释、错误或鉴别性检查？

该机制不会创造模型原本不具备的知识。它尝试减少特定推理轨迹对后续采样的路径依赖，激发模型在当前 case 中没有被采到的已有能力。

## 2. 已确认的协议事实

### 2.1 DeepSeek reasoning passback

DeepSeek thinking mode 的同一个工具循环中，assistant 产生：

```text
reasoning R1
tool call C1
```

工具执行得到 `O1` 后，下一次请求必须回传：

```text
assistant: reasoning R1 + tool call C1
tool: O1
```

这是同一条工具推理链的协议连续性要求。遗漏工具调用 Turn 的 `reasoning_content` 会导致官方 API 拒绝请求。参见：

- <https://api-docs.deepseek.com/guides/thinking_mode/>
- <https://api-docs.deepseek.com/guides/tool_calls/>

因此：

```text
继续 Primary 原工具循环：不能删除该循环要求回传的 reasoning
启动新的 review child：可以不向 child 提供 Primary 最近 reasoning
```

如果 review child 自己调用工具，它自己的 reasoning 仍应在 child 的工具循环中正常回传。Masked review 遮蔽的是继承自 Primary 的近期 reasoning，不是关闭 child thinking。

### 2.2 Session 与 child projection

历史投影不得修改 Primary 的 append-only Session。正确流程是：

```text
读取 parent.session.events
↓
选定一个平衡的旧 prefix
↓
把近期事件投影为新 snapshot
↓
用 prefix + snapshot 启动独立 child
```

Primary 原始事件、工具调用和结果均不删除、不重写。

### 2.3 KV cache

KV cache 依赖 token prefix 一致性。以下任一内容在前部发生变化，都可能使复用从首个变化 token 起失效：

- model/provider route；
- System Prompt、persona、section 内容或顺序；
- 可见 tool schema 集合或顺序；
- 旧消息 prefix；
- 图片及其他请求级输入。

因此把 review 规则放入一个不同的 child System Prompt，通常会牺牲 Parent → Child 的 prefix cache 复用。把规则作为最后一个新 User Prompt，可以保留更多相同 prefix，但工具过滤仍可能改变 tool schema，继续影响 cache。

Cache miss 主要影响输入计算、延迟和成本；只有请求超过 context window 才是硬失败。它不等于模型能力自动下降。

### 2.4 Thinking mode 的采样旋钮

DeepSeek 官方 thinking mode 当前不使用 `temperature`、`top_p`、`presence_penalty` 和 `frequency_penalty`。不能依赖调高温度稳定地产生分支多样性。更可靠的干预变量是：

- history projection；
- mask depth；
- task framing；
- model route；
- capability/tool boundary。

## 3. 当前核心假设

以下均为待评测假设，不是已证明事实。

### H1：reasoning 是搜索和收敛工作区

后训练可能让模型学会在 reasoning tokens 中探索候选、排除路径并形成行动。我们不知道任何闭源模型的完整 reward recipe，因此不能断言“训练明确奖励更少 tool call”或“熵必然单调下降”。当前观察更谨慎地表述为：

> 模型行为与一种对额外工具调用、延迟和无效探索具有成本敏感性的策略相容；在一次推理后段，模型通常比前段表现得更已承诺。

reasoning 可能先扩大候选集合，再在停止边界前收敛。我们关心的是停止边界附近的路径依赖，不主张整个 reasoning 过程的熵单调减少。

### H2：回放 reasoning 会加强路径连续性

把近期 reasoning 原样传给后续采样，会让后续模型更容易继续维护已经选择的解释。遮蔽它可能改变条件分布，使模型重新考虑当前可观察状态。

### H3：Primary 主动触发存在盲点悖论

如果 Primary 已经意识到某个关键假设可能错误，它往往能够自己重新检查。最有价值的 case 可能恰好是 Primary 没意识到自己站在错误分支上，所以完全依赖自发 tool call 会漏掉目标 case。

### H4：内部 reasoning 会降低外部 deliberation 的调用倾向

模型可能已经在 reasoning 中顺序考虑了几个方案，因此认为不需要再调用一个外部并行推理工具。准备输出答案时，主观不确定性通常已经下降；tool-use policy 看到的是收敛后的状态，而不是 reasoning 早期的分歧。

### H5：同模型一致是弱信号，分歧是更强的风险信号

同模型、相近 prompt 的多个 child 一致，可能只是共享偏差。Context intervention 后出现结论分歧不证明 child 正确，但说明当前决定对推理路径或信息边界敏感，值得进一步验证。

### H6：child 是潜能放大器，不是事实验证器

child 可以重新采样已有能力；它不能创造模型未知的事实。需要外部事实时，仍应调用读取、搜索、实验或其他可观察工具。

### H7：Primary 的停止边界可能已经越过一次“内部置信转折”

这是解释主动调用率偏低的一个**研究假设**：模型在 reasoning 内部完成探索、筛选和局部验证后，进入准备输出或调用工具的状态；此时当前路径已经占据较高条件概率。再要求它主动调用一个“重新探索”工具，相当于要求已经收敛的策略重新承认分叉仍然存在。

这能解释两个本地现象，但尚不能证明其因果关系：

1. Prompt 明确写了 `deliberate`，Primary 仍常常直接完成任务；
2. 一旦 runtime 在独立 checkpoint 启动 masked review，child 偶尔能发现 Primary 没有报告为“不确定”的问题。

它不意味着模型“知道自己错了却故意不调用”，也不意味着所有未调用都来自训练偏差。更普通的解释同样存在：工具描述不够相关、额外调用有成本、任务本身很简单、模型没有能力发现问题，或调用策略没有在训练分布中学会这种工具。

### “think 在消熵”到底可以严谨地说到哪一步

“熵”至少可能指四种不同对象，不能混为一谈：

| 对象 | 可操作定义 | 当前黑箱 runtime 能否直接看到 |
| --- | --- | --- |
| token predictive entropy | 某一步 next-token 分布的熵 `H(p_t)=-Σp_t log p_t` | 通常不能；需要 logits/logprobs |
| answer entropy | 对同一问题多次 rollout 后，最终答案分布的熵 | 可以通过多次采样近似 |
| semantic/path entropy | 多条轨迹在解释、行动或状态转移上的分歧程度 | 可以用结构化对照近似，但依赖聚类/判别 |
| verbalized uncertainty | 模型文字里自报的“可能、确定、不确定” | 能看到，但不等于校准后的概率 |

因此，当前最稳妥的表述是：

> Autoregressive reasoning 持续把已经生成的 token 变成下一步的条件。它常常表现为先探索、后承诺，但没有一般定理保证 token entropy、答案熵或路径熵沿 reasoning 单调下降。

近期工作提供了两类互补证据：

- *Unveiling the Entropy Dynamics of Chain-of-Thought Reasoning* 报告了部分模型/任务中从高熵探索区向高置信区转变的两阶段模式；这支持“置信转折点”作为可测假设，但该结果依赖模型分布与探针，不能直接套到没有 logprob 的 DSH 会话。
- *The Potential of CoT for Reasoning: A Closer Look at Trace Dynamics* 观察到推理潜势会出现回退、尖峰、岔路和 lucky guess，反对把长 reasoning 描述成平滑、单调的消熵过程。

更直观地说，一段 reasoning 可能出现：

```text
候选从 2 个扩成 5 个          → 路径熵上升
发现一个关键工具结果           → 答案熵下降
意识到旧假设不成立、重新分叉    → 局部熵再次上升
选择一个行动并准备停止          → 当前路径承诺增强
```

Masked review 不需要证明上述全过程。它只测试一个更小的反事实问题：

> 如果不把 Primary 最近记录的 reasoning/replay state 作为 child 的条件前缀，而保留可观察的目标、行动与结果，child 的结论或下一步检查会不会改变？

### 当模型不返回 reasoning log 时，研究主张如何变化

当前许多模型/API 不返回完整 reasoning，或者只返回摘要。公开 CoT 也不保证忠实反映真实内部计算；Anthropic 的 faithfulness 研究显示，模型的可见 reasoning 可能遗漏实际影响答案的信息。因此必须区分：

```text
模型内部隐藏计算状态
≠ API 返回的 reasoning_content
≠ assistant visible prose
≠ tool action / observable result
```

如果 provider 没有返回 reasoning block，本插件无法“删除真实 CoT”。这时 mid-fork 仍可通过以下干预改变 child 的条件分布：

- 不继承 adapter replay state；
- 将选定 suffix 重投影为只含可观察证据的 snapshot；
- 改变 history window、route 或 capability；
- 让 child 在独立 Session 中重新采样。

但此时实验不能再归因为“移除了 CoT”，只能称为 **history/context intervention**。这个降级口径是必须承认的事实，不是实现缺陷可以完全消除的。

### 不直接测 entropy，改测 context sensitivity

黑箱条件下，与其假装计算一个不存在的“高熵分数”，更可行的是对同一 checkpoint 做受控干预：

```text
完整历史
reasoning-only mask
action-only mask
更深/更浅窗口
相同/更强 route
```

若结论在这些视图下稳定，说明它对当前上下文处理相对不敏感；若发生翻转，说明它处在一个值得外部验证的风险区。这里的分歧是**敏感性信号**，不是哪个分支正确的证明。

## 4. History projection 的精确定义

### 4.1 `reasoning-only`：目标默认方案

手动路径由 Primary 选择的最近 K 个完整 Step 中（自动路径则是当前 open Turn 的全部完整 Step）：

| 内容 | 处理 |
| --- | --- |
| user message | 保留 |
| assistant `reasoning` block | 删除 |
| assistant 可见 `text` block | 保留 |
| tool call 名称和 arguments | 保留 |
| tool result | 保留 |
| plugin 注入的可见约束 | 保留 |

它删除的是明确标记为 `reasoning` 的内容，不尝试用 NLP 判断哪些可见文字属于“解释”“结论”或“自我辩护”。

由于 DeepSeek 工具历史有 reasoning passback 约束，近期事件可以转换为新的观察快照，而不是把删过字段的原 assistant/tool 消息直接重放。

### 4.2 `action-only`：更强的实验干预

被选中的完整 Step 中保留：

```text
用户目标和约束
tool call
tool arguments
tool result
```

删除：

```text
assistant reasoning
assistant 可见正文
assistant 阶段性解释和结论
```

它已作为 `mask: action-only` 的可配置对照实现，但不是 bundle 默认。默认仍是 `reasoning-only`，两者必须在评测中作为不同干预变量报告。

### 4.3 `fresh-state`：全局重导方案

child 不继承对话推理轨迹，只接收一个显式、可验证的当前任务状态，例如：

```text
原始用户目标
仍有效约束
当前工作区/测试/外部状态的可观察摘要
尚未解决的问题
```

它删除：

```text
旧 reasoning
旧 assistant prose
导致当前状态的行动顺序
Primary 的 incumbent 和自我解释
```

`fresh-state` 不是从 Session 自动可靠提取的“真实 world state”。如果状态摘要由 Primary 编写，会重新引入 Primary bias；如果由 runtime 构造，则需要领域化 projection 或工具观测。因此它目前是实验方向，不是默认能力。

### 4.4 Tool arguments 和 results

在 `reasoning-only` 与 `action-only` 中，tool arguments 和 tool results 都是已发生行为的一部分，应默认保留。它们可能包含意图或解释，但这不构成 `reasoning-only` 的协议泄漏，因为该实验只遮蔽显式 reasoning block。

长度限制、secret redaction 和过大结果摘要属于通用安全/上下文治理问题，应与 reasoning masking 分开处理。

## 5. `deliberate`、`masked-review` 与触发器

当前概念模型保持一个模型工具：

```text
deliberate
├─ independent-alternative → fresh provider
├─ trajectory-audit        → fork provider
└─ masked-review           → mid-fork provider（硬绑定）
```

`masked-review` 是 `deliberate` 的一种 role，不是第二个产品。它必须使用 mid-fork history policy；模型不应组合出 `masked-review + fresh/fork`。

同一种 masked-review 能力可以有多个触发入口：

```text
Primary 主动 tool call
用户显式命令（尚未实现）
可选 runtime checkpoint（实验，默认关闭）
```

触发入口与执行能力应共享同一个 Runner。自动触发不是第二种 review 算法，只是绕过低调用率的一种实验入口。

## 6. 触发方案及取舍

### 6.1 只强化 Primary Prompt

在 Primary policy 中提示：结束复杂、工具驱动的 Turn 前，如果近期行动依赖未验证假设，可以调用 `deliberate(masked-review)`。

优点：

- 没有额外 inference；
- 不调用时不产生任何 Session 事件；
- Primary 保持完整控制。

缺点：

- 仍依赖 Primary 意识到风险；
- 过去实测表明模型可能在 reasoning 后认为自己已经完成探索；
- 无法捕获 Primary 完全无感知的盲点。

这是正式默认应采用的软触发方式，但不能声称解决了盲点。

### 6.2 Turn-stopping gate child

在 Primary 准备停止时，运行一个 child，只判断是否值得执行 masked review；若返回 skip，不向 Parent Session 注入任何内容。

优点：

- skip 时 Parent Session 干净；
- gate 可以使用与 Primary 不同的信息投影。

缺点：

- 每个 eligible Turn 仍然支付一次 child inference 和等待时间；
- gate 可能错过同样的盲点；
- 若 gate=yes 后再运行 review，会产生两次 child inference；
- 若再让 Primary决定是否调用，可能增加第三次 inference。

### 6.3 Automatic masked review + bounded publication

在 checkpoint 直接运行一次完整 masked review。child 合法完成后，Runtime 按独立 publication policy 处理已压缩 JSON packet：`updates-only` 只发布 `status=update`，`all` 连 `no_update` 也发布，`observe-only` 永不触碰 Primary inbox。

相较 gate→review，它用一次 inference 完成审查，避免再启动一个判断模型。Runtime 只负责安全、shape、长度和引用边界，不替 Primary 判断发现是否“值得看”；最终相关性和行动选择仍属于 Primary。

三种模式都支付固定 child inference；只有实际发布时才增加 Parent steer 和 assimilation Step。因此它只适合作为显式实验模式，不适合作为安装默认。部署包含 Session persistence 时，session-backed Subagent seam 会保存 child Session，调试界面或 child 列表可能看见它。

发布格式是确定性的单行 JSON，不把 child transcript 或 Runtime 二次总结灌进 Parent：

```json
{
  "role": "masked-review",
  "status": "update",
  "items": [
    { "kind": "conclusion", "certainty": "likely", "content": "..." },
    { "kind": "assumption", "certainty": "uncertain", "content": "..." },
    { "kind": "possible_error", "certainty": "likely", "content": "..." },
    { "kind": "suggestion", "certainty": "likely", "content": "..." }
  ]
}
```

`items` 是稀疏数组：没有某类信息就不填；没有任何 decision delta 时返回 `{ "role": "masked-review", "status": "no_update" }`。Runtime 限制枚举、非空内容和重复项，只对完整 Primary-facing packet 设置 10000 字符的上界；不再给单项或 item 数量设置独立上限。格式错误、timeout 或内部错误不得把 provider payload 注入 Primary。

当前产品式 opt-in 默认是 `updates-only`。这不是 Runtime 再做一次自然语言相关性判断，而是执行 packet 自己声明的 `status`：任何不确定但决策相关的信息都应使用 `update + unknown/possible_error`；真正的 `no_update` 不值得为一句“没有增量”再支付 Primary Step。`all` 保留为严格 treatment，`observe-only` 保留为 shadow eval。

### 6.4 强制 review

每个顶层 Turn 停止前都运行 review，并总是向 Primary 注入结果。

它可以消除触发自选择偏差，适合作为评测 treatment；延迟、token 和 no_update 污染使它不适合产品默认。

### 当前结论

```text
正式默认：autoReview.enabled = false，使用精简 Primary policy
实验 A：observe-only shadow review，不影响 Primary
实验 B：automatic masked review，默认只发布 update packet
实验 C：all-primary-turns 强制 treatment，用于测量上限
```

## 7. Review window（K）的选择

Runtime 可以直接从 `parent.session.events` 统计：

- 当前总 Turn 数；
- 每个 Turn 的 step 数；
- tool-bearing Turn/Step；
- 最近 mutation/tool call 的位置；
- 当前是否处于 open Turn stopping boundary。

Primary 不需要先知道 Session 有多少 Step。手动 `masked-review` 在 tool schema 中选择 `recentSteps=K`，Runtime 返回并使用：

```text
projectedSteps = min(requestedSteps, availableCompletedSteps, maxRecentSteps)
```

还应记录实际投影范围，而不是让 Primary 猜测。

### 7.0 自动路径不应默认固定 K

手动路径让 Primary 在有界范围内明确选择 K；不再由部署固定成最近 3 个 Turn。自动路径拥有一个自然结构边界：当前即将结束的 open Turn，因此不复用手动 K。

建议区分：

```text
手动 deliberate(masked-review)
→ Primary-owned recentSteps=K（bundle 上限 8）
→ runtime 压到实际完整 Step 数

自动 shadow review
→ 默认 mask 当前 open Turn 的全部 Steps
→ 当前 Turn 无论包含 1 个还是 50 个工具 Step，都不依赖固定 Turn 数
```

若任务跨多个用户 Turn，自动路径可以向前扩展到最近一个显式 review/checkpoint，或使用 token-budgeted balanced window；不能可靠识别“继续”“接着改”等语义目标边界时，不应假装一个启发式结果是正确窗口。跨 Turn 的第一版应由手动 K 或显式 checkpoint 处理。

自动窗口需要同时满足：

```text
包含当前用户输入
包含当前 Turn 内完整 tool-call/result 配对
切点是可重放的平衡边界
投影请求不超过 review token budget
```

若完整当前 Turn 或手动 Step 窗口已超过 `maxSnapshotChars` 或 20 张 projected image，实现会在创建 child 前明确 skip，并记录安全的 window/mask/turn/Step 数/长度/图片计数与 attachment 声明字节元数据；不会静默截断早期行动或丢图后再让 child 对不完整轨迹给出强结论。投影的唯一事实源是扁平 `snapshotContent`（只含 `text/image`）；debug 字符串从它派生，不复制第二套序列化逻辑。

视觉门扫描的是 native seed 的有效 Surface 与完整合成 prompt。只要含图，就必须解析最终 child route 并从模型目录得到显式 image-input 声明；未知、text-only、查询失败和 native assistant-role image 都在 `agents.create` 前 skip。这个门只保证请求不会明知非法或缺证据仍运行，不能证明视觉模型对图片理解正确。

### 7.0.1 Turn 内必须保留 Step 与并行调用批次

一个 Turn 可以包含多个 LLM Steps；一个 Step 的单次 LLM response 又可以由一段 reasoning 产生多个 tool calls。Reasoning-only projection 不能把这些调用错误地表示成多次独立决策。

应按以下结构投影：

```text
Turn T
  Step S
    Assistant visible text
    Decision batch produced by one LLM response
      call A: tool + arguments
      call B: tool + arguments
    Outcomes keyed by callId
      A → result/error
      B → result/error
```

该 Step 中只移除 assistant `reasoning` block。可见 text、整个 tool-call batch 和所有结果均保留。结果必须通过 `callId` 映射回调用；并行结果的完成事件顺序不能被误解为决策顺序。

当前实现已按 Step 保留单次模型决策批次，并在每条 action/outcome 上稳定显示 `callId`；reasoning-only 保留 visible text，action-only 才显式删除 visible text。并行结果的落盘顺序不会被描述成模型决策顺序。

### 7.1 让 Primary 选择 N

简单、无额外 inference，但选择可能受 Primary 当前轨迹影响。可以提供默认值，Primary 仅在确有理由时覆盖。

### 7.2 让 child 选择 N

child 必须先获得历史结构才能选择窗口。若给完整内容，会提前暴露待遮蔽 reasoning；若只给 Turn/tool/token 元数据，则需要一次 gate inference，再运行正式 review。它复杂且昂贵，不应作为第一版默认。

### 7.3 Runtime 自适应窗口

候选规则包括：

- 最近固定 K 个完整 Step；
- 从最近一次用户目标变化开始；
- 从最近一次 mutation tool 开始；
- 最近 K 个 tool-bearing Steps；
- 在 configured token budget 内取最大的平衡窗口。

这是比 child 选择 N 更可预测的工程方向，但哪条规则最有效仍需评测。

### 7.4 Mask-depth ensemble

在不考虑 token 成本的研究模式下，不选择唯一 K，而是并行执行：

```text
K=1
K=3
K=since-last-mutation 对应的完整 Step 数
```

不同深度的结论分歧本身就是“路径敏感性”信号。该方案避免窗口选择器成为新的单点失败。

K 增大不必然增加总输入 token：更多旧 reasoning 被快照过滤，可能反而缩短输入；但 cut 提前会减少可复用 KV prefix，并改变更多历史条件。长 Session 的主要成本来自整个保留 prefix，而不只是 K。

## 8. System Prompt 与 User Prompt

### 8.1 Cache-aligned 研究模式

目标是尽量只改变 history projection：

```text
保持与 Primary 相同的 System Prompt/persona
把 review instruction 放在最后一个新 User Prompt
使用相同 model route
```

这样更容易把结果变化归因于 reasoning mask，也更有机会复用切点以前的 cache。可见 tool schema 若被 capability filter 改变，仍会造成额外 cache 失效。

### 8.2 Reviewer-persona 能力模式

目标是最大化审查质量：

```text
使用专门 reviewer persona/System Prompt
可切换 strong model route
允许只读验证工具
```

这可能获得更大行为差异，但同时改变了 history、persona、tools 和 model，无法把提升单独归因于 masking，且 Parent → Child cache 很可能无法复用。

### 8.3 推荐的动态 User Prompt

不告诉 child“删掉了 N 段 reasoning”，只声明它可使用的证据边界：

```text
Your available evidence consists of the user goal, visible messages,
observable actions, and resulting outcomes. Judge whether those observations
support the continuation. Do not invent motivations that are not present.
```

不要加入 omission 数量、Primary incumbent 或 Primary 对可疑节点的完整解释。

## 9. Child 结果与 Parent History

手动调用：

```text
assistant/tool-call: deliberate(role=masked-review)
child session 独立运行
tool/result: 压缩后的 structured packet
Primary 下一 Step 使用结果
```

自动触发：

```text
agent/turn-stopping
child session 独立运行
若需要发布：plugin-origin checkpoint + agent.steer()
Primary 同一 Turn 继续一个 Step
```

自动路径不得伪造模型没有产生的 assistant tool call。Parent 只接收压缩 packet；`runId` 留在 runtime lifecycle/debug 信息，不进入 model-facing packet。child transcript/reasoning 保留在 child Session，不注入 Parent。

当前 automatic 模式由独立 publication policy 控制：`updates-only` 是 opt-in 缺省，只发布 `status=update`；`all` 连 `no_update` 也发布；`observe-only` 只保留 child run，不触碰父 inbox。Runtime 不再做第二次自然语言相关性判断。

## 10. Epistemic 标签

当前 packet 使用两个正交轴：

```text
kind      = observation | conclusion | assumption | unknown | possible_error | suggestion
certainty = certain | likely | uncertain
```

这些首先是 child 自报状态。Runtime 可以验证枚举、role、非空字段、重复项、数量和总长度；不能验证 content 是否准确、推导是否成立，或 `certain` 是否真的确定。因此 Primary 必须把标签理解为“child 如何分类自己的压缩结果”，而不是事实认证。

## 11. 当前 branch 的已知问题

### 已在可用 baseline 修复

1. 默认 bundle 已关闭 auto review，并把 opt-in 缺省 scope 收窄为 `tool-bearing-turns`。
2. mid-fork 已改成 `reasoning-only` 投影：保留 assistant visible text，只删除显式 reasoning block 与 adapter replay state。
3. Snapshot 不再向 child 显示 omission 计数；统计只保留在 runtime projection metadata。
4. 同一个 LLM response 的多个 tool call 保持在同一个 Step/decision batch 下，乱序 tool result 通过 `callId` 关联。
5. 文档已把“删除 recorded reasoning block”与“干预模型内部 hidden state”分开。
6. `window` 与 `mask` 已成为正交 provider 配置；自动路径使用唯一 open Turn，手动路径由 Primary 选择最近 K 个完整 Step。
7. 所有 snapshot 超预算都会在 child 创建前 skip；`action-only` 已能作为评测 overlay 使用，但不是 bundle 默认。
8. 当前 caller Step 由 `step/end` 完整性门排除；同一 response 的并行 tool calls 仍是一个 Step。
9. 手动与自动路径都先验收 child 生命周期、再验收 packet；真实 `error`、`aborted`、timeout 即使携带形状合法的 partial packet 也不会发布。唯一兼容例外是 Session 的 `turn/end=completed` 已证明正常结束、但模型把严格 JSON 写进 final text 而未调用 `structured_output`。

### `experiment/compact-review-packet` 已处理

1. Runtime validator 已镜像 role/status/item 枚举，并补上非空、去重、item 数量、单项长度与总长度约束。
2. 自动与手动结果已共享同一 packet contract；自动路径使用确定性 JSON renderer，手动路径只额外保留 branch label/role/stopReason。
3. 现有 packet 已改为紧凑、稀疏、带 epistemic level 的 JSON。
4. 自动 publication 已拆成 updates-only/all/observe-only；默认 no_update 不再续跑 Primary。

### 仍待工程整理

1. 手动 branch 与自动 review 仍重复实现 start/timeout/result/validate/dispose；应抽成共享 one-shot runner，但不改变 model-facing 协议。

### 可以优化，但需要实验或 API 取舍

1. DSH 的 start seam 仍没有 per-run history option；当前以 `mid-fork-step-1...N` 命名 provider family 映射 Primary 的 K。它不改 core，但增加 registry/config 心智负担；未来若 Harness 提供原生 per-start options，应收敛成一个 provider。
2. 当前 packet 已很薄；仍需用 eval 决定 10000-char 总上限是否恰当。
3. 若未来重新加入 source hint，只能校验引用存在性，不能自动证明自然语言证据关系。
4. Web profile 的可见 read/grep/glob 能力与 `read-only` capability 配置可能不一致。
5. `same` route 适合隔离 history 变量；`strong` route 适合性能模式，两者不应混成一个效果主张。
6. Tool result 的长度治理和敏感信息治理需要独立于 masking 处理。
7. Parent draft 在 Web 上是否先展示，需要宿主 UI/Agent Loop 的 pre-publication 能力才能彻底改变。

### 暂不解决或当前无法由本插件保证

1. 读取、删除或控制模型从未返回的 hidden reasoning。
2. 直接修改或复用模型服务内部 KV cache；插件只能保持或破坏请求 prefix 一致性。
3. 完美检测“高熵点”“关键决定”或 Primary 自己没有意识到的盲点。
4. 证明同模型多个 child 的一致意见等于事实。
5. 自动验证自然语言 claim 的语义真实性。
6. 自动投票、选择 winner 或让 child 绕过 Primary 作最终决定。
7. 回滚 Primary 已产生的文件、命令、网络或其他外部副作用。
8. 用 tool filter 代替 workspace、进程或凭据隔离。
9. 在没有 benchmark 的情况下声称 masked review 提高正确率或具有正 ROI。
10. 推断 DeepSeek 或其他闭源模型完整的 RL/reward recipe。

## 12. 之前 DeepSeek case 的暂定结论

已有实验支持的不是“每次都应该调用”，而是：

```text
一旦真正运行独立 audit，child 有时能抓到 Primary 未覆盖的真实错误，
并扩展设计面；但 Primary 自主触发率低，同模型一致也不能当作事实证明。
```

因此当前结论是：

- `deliberate`/audit 机制值得保留；
- 模型自发调用不能作为唯一触发保障；
- 所有 Turn 强制运行尚无 ROI 证据；
- 最适合的 case 是高错误代价、长工具轨迹、多个耦合断言和存在可执行验证手段的任务；
- 教科书问题、纯文本改写和主要依赖外部事实的问题不应仅靠子 Agent 分支解决。

## 13. 新研究方向：Context Intervention Ensemble

不提前预测高熵，而是在同一 checkpoint 对 context 做多个受控干预：

```text
View A：full fork，完整 reasoning，作为控制组
View B：reasoning-only mask
View C：action-only mask
View D：fresh-state projection（仅概念方向，当前没有 runtime world-state extractor 或配置臂）
```

可再改变 mask depth 和 model route。最终不投票，而是压缩：

```text
跨视图稳定的结论
只在完整 reasoning 下成立的结论
mask 后翻转的决策
最早出现分歧的节点
最便宜的鉴别性检查
```

这把“是否高熵”改写成一个黑箱可观测问题：

> 当前结论是否对 history projection、mask depth 或 model route 敏感？

分歧不证明错误，但可以成为升级验证的信号。该方向最贴近“在不扩展基础模型知识边界的前提下，系统性激发未采样能力”的原始目标。

## 14. 评测门槛

至少比较：

```text
Baseline：无 review
Masked-same：同模型 reasoning-only review
Action-only：同模型 action-only review
Masked-strong：强模型 reasoning-only review
```

需要同时记录：

- benchmark pass rate；
- baseline 正确但 review 导致改错的 regression rate；
- child `no_update` 比例；
- 决策相关分歧率；
- 输入、输出和 reasoning token；
- KV cache read tokens；
- 墙钟延迟和 timeout；
- structured packet 格式失败率；
- Primary 是否实际采用 child 建议。

在这些数据出现前，最诚实的定位仍然是：

> 一个用于测试 history intervention、路径敏感性和独立重采样的研究 runtime，而不是已证明有效的默认 Agent 能力。

## 15. 相关工作：它们支持什么，不支持什么

下表不是为了给插件“贴论文标签”，而是把设计中的每个判断放回已有证据边界。

| 工作 | 与本项目相关的结果 | 不能据此推出 |
| --- | --- | --- |
| **Self-Consistency** (Wang et al., 2022) | 多采样不同 CoT 并聚合答案，说明单条 greedy trace 可能漏掉模型已有的正确路径 | 同模型多数票必然正确；也没有处理有副作用的 Agent 轨迹 |
| **Tree of Thoughts** (Yao et al., 2023) | 显式维护候选 thought、评估并回溯，说明 test-time search 可超越单链推理 | 任意任务都值得建搜索树；也不解决外部状态回滚 |
| **Let's Verify Step by Step** (Lightman et al., 2023) | 过程监督能定位中间错误，支持“只看最终答案不足以审计复杂轨迹” | 未训练的 child 自报 `certainty` 就是可靠 verifier |
| **Self-Refine** (Madaan et al., 2023) / **Reflexion** (Shinn et al., 2023) | 反馈、反思与记忆可以驱动后续改进 | 同一次模型调用后的自评天然无偏，或无需外部反馈 |
| **LLMs Cannot Self-Correct Reasoning Yet** (Huang et al., ICLR 2024) | 在没有可靠外部反馈时，intrinsic self-correction 可能不升反降 | 所有自我纠错都无效；有工具证据、过程 verifier 或新采样时结论不同 |
| **Scaling LLM Test-Time Compute Optimally** (Snell et al., 2024) | test-time compute 的最优分配依赖题目难度、模型和 verifier；不是越多越好 | auto review 应默认在每个 Turn 打开 |
| **DeepSeek-R1** (Guo et al., 2025) / **s1** (Muennighoff et al., 2025) | 后训练和 inference-time budget 能诱发更长的探索、反思与修正行为 | 闭源模型的具体 reward 必然惩罚 tool call，或 reasoning 熵单调下降 |
| **Thought Anchors** (Bogdan et al., 2025) | 对 reasoning 句子做反事实干预后，少数规划/回溯片段会显著改变后续 rollout | API 返回的每段 CoT 都忠实，或简单删除最近 N 段一定改善结果 |
| **Sample, Scrutinize and Scale** (2025) | 跨样本比较能暴露单条 trace 中更难自查的错误 | 只要两个 child 同意就可当事实证明 |
| **Learning to Self-Correct through Chain-of-Thought Verification** (2025) | 稳定的顺序纠错依赖经过训练、具有准确性的 CoT verifier | 通用 same-model child 已经具备等价 verifier 能力 |
| **Reasoning Models Don't Always Say What They Think** (Anthropic, 2025) | 可见 CoT 对实际影响答案的信息可能不忠实或不完整 | 删除返回的 reasoning 等于删除模型内部全部偏差来源 |
| **CoT Potential** / **Entropy Dynamics** (2026 preprints) | 前者显示推理轨迹存在非单调回退与尖峰；后者在部分设置发现探索到置信的相变模式 | 已经存在可跨模型复用的单一 entropy threshold |

这些工作共同支持一个较窄、但足够有价值的方向：

> 单条 trace 不是模型能力的完整表达；额外 test-time compute 只有在采样边界、证据和计算分配合理时才可能有收益。`dsh-deliberation` 的贡献是把这种对照实验接到 Agent 的 Session/Tool Runtime 上，而不是提出一个已证明更强的新推理算法。

## 16. 当前本地实验记录

以下均为**本地观察**，不是 benchmark。记录它们是为了保存机制演化的因果链，而不是用几个成功例子证明总体效果。

### 16.1 支付 / lease / idempotency 轨迹审计

任务包含 worker lease、ACK、重试、幂等键和扣款正确性。Primary 已经形成一套事故分析后，运行独立 alternative/audit 分支。

child 提供的有效增量包括：

- 指出某个 double-charge failure window 不应从 Primary 认定的后段开始：旧 worker 在 lease 过期后仍可能继续，新的 worker 先扣、旧 worker 后扣，窗口可从更早状态成立；
- 扩展出“同一 idempotency key、不同 payload”导致拒绝或卡死的设计面；
- 提出 refund 后重新扣款与旧 key 映射的冲突；
- 发现仅用 per-database 自增 task id 时跨租户不唯一的风险；
- 在一个点上纠正了 Primary 的“自我修正”：Primary 想把风险窗口终点提前到状态提交，但在当时给定的 ACK 门控重投语义下，child 认为终点仍是 ACK。

该 case 支持的是“独立路径有时能产生 decision delta”，不是“child 已验证所有事实”。限制同样明显：

- alternative 与 audit 使用相同基础模型，共享系统性偏差；
- 简报里包含了 Primary 已知的一个疑点，造成锚定，不能把随后的一致当作独立发现；
- provider 对幂等键/退款的具体语义没有通过文档或实验验证；
- 没有 baseline 重复采样，因此不能估计发现这些问题的概率提升。

### 16.2 日志计数修复 smoke：有用审计与冗余 update

任务要求修复日志 severity 计数。原实现对整行使用 `line.count()`，导致 WARNING 正文里的单词 `ERROR` 被额外计数。masked review 在只读观察后正确定位了这一根因，并建议只解析时间戳后的第一个方括号标签。

修复后，`check.py`、主脚本和 `verify.py` 均通过，输出与预期一致。这个 smoke 同时暴露了三个协议问题：

1. child 在 Primary 已经看见同样的通过结果后，仍把“测试全部通过”标成 `update`；这推动 prompt 明确：复述已知事实、确认成功、没有改变下一步动作，都应返回 `no_update`。
2. 一次有价值的反例建议因为过紧的 packet 字符限制被整包丢弃；这说明“要求简洁”不能实现成拍脑袋的小上限。当前改为只保留较大的总包边界（10,000 chars），再由 prompt 约束压缩。
3. 某些 provider 会把严格 JSON 输出到 final text，而不是宿主捕获的 `structured_output`；当前实现增加了严格、整包 JSON fallback，但仍只接受 schema 合法的 packet。

这个 case 验证了 child 能看到 action/result snapshot、packet 能被解析和发布；它没有证明 review 比 Primary 多发现了最终必须修复的错误，因为根因随后也被主路径掌握。

### 16.3 两 Turn 配置任务 smoke：Session 与 publication plumbing

第二个测试使用含读、写、验证的配置任务，并连续执行两个 Primary Turn。观察到：

- Primary Session 保持完整，原事件没有被 mid-fork 删除或改写；
- 每次 review 都创建新的 child Session，而不是把第二轮叠加进第一轮 child；
- 先前已完成 Turn 作为 native seed 保留，当前 open Turn 的已完成 Step 被投影为 reasoning-masked snapshot；
- child 默认只读，没有修改 Primary workspace；
- `status=update` 的 packet 经 `steer()` 进入 Primary 的后续 assimilation Step；
- 最终检查脚本通过。

这验证的是 Session 隔离、窗口语义和发布链路。它不验证 masked review 对任务成功率的净贡献。

### 16.4 多模态投影：目前只有契约测试

当前实现的 reasoning-only snapshot 只合成 `text` 与 `image` block，图片保留原 attachment 引用；若最终 child route 不支持 image、suffix 图片超过预算，或能力无法确认，则在启动 child 前 skip，而不是把图片变成占位文本后假装完成审计。

目前这部分只有单元/预检层证据：能保证请求形状与失败边界更合法，不能声称 child 对图片判断正确。发布说明必须把 live paired vision eval 留为未完成项。

### 16.5 最新 Harness 组合 smoke

在独立安装的 DeepSeek Harness `0.1.1-rc.2` Web profile 中，以本地 link 安装当前插件后运行 `--dump-config`，可以看到：

- `mid-fork-step` recent-steps provider；
- `mid-fork-current-turn` provider；
- `tool-deliberation`；
- `autoReview.enabled=false`、`scope=tool-bearing-turns`、`publish=updates-only`。

这说明 npm/bundle metadata 和 Cordis patch 在该版本能完成 profile composition。它不是完整 live E2E：尚未在这个隔离 profile 中重新跑一遍真实模型、child、publication 和 verifier 全链路，因此 release compatibility 仍应写成“smoke-tested”，不能写成“fully supported”。

### 16.6 当前实验结论

可以确认：

- 插件能在不修改 Parent Session 的情况下启动受控 history projection；
- child 生命周期、超时、失败隔离、只读默认和选择性 publication 已经可运行；
- 某些案例中 child 产生了 Primary 原轨迹没有覆盖的有效问题；
- `no_update` 分类、窗口深度、route 和审计收益仍未校准。

不能确认：

- masked review 提高总体 benchmark pass rate；
- same-model review 的收益大于 token/延迟成本；
- reasoning-only 一定优于 full fork、action-only 或 fresh projection；
- 默认开启 auto review 会提高 coding Agent 的成功率；
- child 自报的 `certainty=certain` 具有统计校准意义。

## 17. 可证伪的下一步实验

### 17.1 核心配对设计

对同一批冻结任务、相同初始 workspace 和相同模型配置，至少运行：

| 实验臂 | 目的 |
| --- | --- |
| Baseline | 单条 Primary，不审查 |
| Full-fork same | 额外采样但不 mask，分离“多算一次”的收益 |
| Masked-same | 同模型 reasoning-only，测 history intervention 增量 |
| Action-only same | 更强去锚定对照，同时测信息损失 |
| Masked-strong | 分离 route 能力与 mask 的贡献 |
| Observe-only | 记录 child 判断但不影响 Primary，用于测 counterfactual adoption/regression |

每个任务必须记录固定 seed 能否复现、child 是否启动、packet status、Primary 是否采纳、最终 verifier、token、cache、延迟和 timeout。不能只挑 `update` 成功案例展示。

### 17.2 关键指标与失败判据

除了 pass rate，至少报告：

```text
correction rate       baseline 错、review 后对
false-diversion rate  baseline 对、review 后错
no-update rate        child 没有决策增量
adoption precision    Primary 采纳的建议中最终有益的比例
unique-delta rate     child 真正新增而非复述的比例
cost per correction   每多修正一个任务消耗的 token / 时间
```

下列任一结果都应促使机制收缩，而不是继续补 prompt：

- Masked-same 与 full-fork 无显著差异：说明收益主要来自额外采样，而不是 mask；
- false-diversion 抵消 correction：不适合作为默认 publication；
- `no_update` 极低且多数只是复述：packet policy 没有学会 decision delta；
- action-only 明显更差：去锚定同时删除了必要语义；
- strong route 收益远大于 history 差异：产品价值主要是模型路由，而非 mid-fork；
- 简单启发式或一次只读 verifier 以更低成本达到同等结果：应优先使用简单方案。

### 17.3 关于触发的实验

不要先训练一个虚假的“高熵分类器”。先比较三个可执行触发面：

1. 用户显式 `/deliberate` 或手动 tool call；
2. `tool-bearing-turns` 的 current-turn shadow/updates-only review；
3. consequential mutation 前的 runtime checkpoint（未来实验，必须避免递归和连续触发）。

理想目标不是最高调用率，而是在给定预算下最大化 `correction - λ·false_diversion - μ·cost`。这也解释了为什么当前公开 bundle 默认关闭 auto review：在 λ、μ 和真实任务分布未知时，默认开启只保证增加成本，不保证增加效用。

## 18. 研究与产品边界

当前最诚实的产品定义是：

> **Primary-controlled deliberation + opt-in masked review runtime。** Primary 保留最终控制权；child 独立探索、压缩 decision-relevant delta，不投票、不直接修改主轨迹、不被当作事实裁判。

它有继续存在的必要，前提不是“模型没有能力”，而是下面这个较弱假设成立：

> 模型能力在单次采样中没有被稳定、完整地表达；改变最近历史的可见性、采样路线或验证工具，可能使另一条已有能力路径被采到。

该假设与 self-consistency、search、test-time scaling 和过程验证工作相容，但插件的具体收益必须由自己的 Agent 轨迹评测给出。若 paired eval 最终显示 mask 没有增量，项目仍可保留 `deliberate` 作为显式对照工具，同时删除或冻结 auto masked-review；这也是一个有效、可证伪的研究结果。

## 19. 参考资料

### 推理搜索、验证与自我修正

- Wang et al. (2022), [Self-Consistency Improves Chain of Thought Reasoning in Language Models](https://arxiv.org/abs/2203.11171)
- Yao et al. (2023), [Tree of Thoughts: Deliberate Problem Solving with Large Language Models](https://arxiv.org/abs/2305.10601)
- Lightman et al. (2023), [Let's Verify Step by Step](https://arxiv.org/abs/2305.20050)
- Madaan et al. (2023), [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651)
- Shinn et al. (2023), [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- Huang et al. (ICLR 2024), [Large Language Models Cannot Self-Correct Reasoning Yet](https://openreview.net/forum?id=IkmD3fKBPQ)
- Snell et al. (2024), [Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters](https://arxiv.org/abs/2408.03314)
- Guan et al. (2025), [Sample, Scrutinize and Scale: Effective Inference-Time Search by Scaling Verification](https://arxiv.org/abs/2502.01839)
- (ICML 2025), [Learning to Self-Correct through Chain-of-Thought Verification](https://openreview.net/forum?id=AbO4lCvlo3)

### Reasoning 训练、轨迹与可见 CoT 的边界

- Guo et al. (2025), [DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning](https://arxiv.org/abs/2501.12948)
- Muennighoff et al. (2025), [s1: Simple Test-Time Scaling](https://arxiv.org/abs/2501.19393)
- Bogdan et al. (2025), [Thought Anchors: Which LLM Reasoning Steps Matter?](https://arxiv.org/abs/2506.19143)
- Anthropic (2025), [Reasoning Models Don't Always Say What They Think](https://www.anthropic.com/research/reasoning-models-dont-say-think)
- Bachmann et al. (2026 preprint), [The Potential of CoT for Reasoning: A Closer Look at Trace Dynamics](https://arxiv.org/abs/2602.14903)
- He et al. (2026 preprint), [Think Twice Before You Write—an Entropy-based Decoding Strategy to Enhance LLM Reasoning](https://arxiv.org/abs/2604.00018)
- Xu et al. (ICML 2026), [Unveiling the Entropy Dynamics of Chain-of-Thought Reasoning](https://arxiv.org/abs/2606.02020)
- Hariri et al. (2026 preprint), [Test-Time Scaling in Reasoning LLMs: Inference Regimes, Evaluation, and Reproducibility](https://arxiv.org/abs/2608.04001)

### Runtime 协议

- DeepSeek, [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- DeepSeek, [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)
