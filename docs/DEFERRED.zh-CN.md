# 待定事项

本文记录评审中提出、但当前实验分支明确不实现或不在 runtime 内实现的事项。逐 branch 超时、可配置 window/mask 的 mid-fork provider、可选 stopping-boundary 自动 review、稀疏 JSON packet、失败隔离和紧凑 renderer 已实现，不再列入本表；下面各项不代表承诺或排期。

## 可用性与展示

| 项目 | 当前决定 | 以后需要回答的问题 |
| --- | --- | --- |
| `/deliberate` 显式触发 | 待定 | 如何让用户强制发起一次 Primary-controlled round，同时仍由 Primary 编写 incumbent、结构化 context 和各 branch focus。 |
| `presentCall` / `presentResult` | 待定 | 通用 card 应展示哪些 branch 摘要，且不改变模型看到的结果契约。 |
| 可点击的 `runId` | 待定 | 当前通用 Tool presentation 没有 session-link 字段；需要客户端能力或独立 UI companion。 |
| 可直接运行的 strong route 示例配置 | 待定 | README 只有说明性占位写法；公共默认配置不能假设 provider、model 或凭据，以后只考虑绑定实际部署的可替换 example patch。 |
| 自动 review 专用 UI / 隐藏 draft | 待定 | 当前 Web 可能先显示 stopping 前的 draft；只靠插件 event hook 无法改变 presentation/commit 语义。 |

## 研究与产品层

| 项目 | 当前决定 | 原因 |
| --- | --- | --- |
| 自动 entropy/logprob detector | 暂不做 | 模型通常不返回 token log，且会改变 Primary 控场的设计。 |
| 异步 sidecar 与跨 Turn 事后注入 | 暂不做 | 当前同步 stopping hook 在同一 Turn `steer`；跨 Turn sidecar 会引入结果过期、顺序和取消语义。 |
| 投票、排序或自动 winner | 暂不做 | branch 返回的是 evidence proposal，最终判断属于 Primary。 |
| 可视化 branch editor | 暂不做 | 属于 Web 产品层，不是 runtime v1 的必要协议。 |
| `recover` 语义恢复 branch | 实验分支 | 需要先验证模型能否稳定选择可观察 checkpoint，并避免把重新推导误写成真实 rollback。 |
| 任意历史节点的物理 fork/truncate | 暂不做 | DSH fork 只提供已完成 turn prefix，隐藏 thinking step 不可见；实验 recover 也只做语义重新推导。 |
| 自动副作用 rollback | 暂不做 | 文件、数据库和外部服务需要各自的事务或补偿协议，不能由 reasoning plugin 统一假装撤销。 |
| 每个 branch 的私有 workspace | 暂不做 | 需要 Subagent/workspace seam 支持，tool filter 不能伪装成文件系统隔离。 |
| Web route/capability 配置表单 | 暂不做 | 当前实验阶段继续使用 profile patch。 |
| packet 自报 certainty 与自然语言真实性校准 | 暂不做 | 当前 schema 只校验 kind/certainty/content 的形状与边界，不能证明模型分类或推导可靠。 |
| 配对 benchmark / eval runner | 独立工作流；效果宣称门槛 | 固定 traces、四条实验臂、指标采集与任务调度不应伪装成 runtime 开关；没有配对数据时只能声称本插件可运行对照，不能声称提高正确率或 ROI。 |

## 已知工程折衷

| 项目 | 当前事实 | 可能的后续方向 |
| --- | --- | --- |
| recent-Step provider family | DSH 的公开 `SubagentStartRequest` 没有 per-start history option；当前预注册 `mid-fork-step-1...N`，再把 Primary 的 `recentSteps=K` 映射到一个 provider。功能正确，但会增加 registry/config 条目。 | 若 Harness 增加有类型的 per-start provider options，收敛成一个 provider；不要用隐藏 prompt metadata 绕过 seam。 |
| 字符预算不是 token 预算 | `maxSnapshotChars` 可稳定阻止超大投影，却不能精确代表不同 tokenizer 的 token 数。 | 由 model adapter 提供 tokenizer/budget seam 后再按 token 计；当前不伪造精确 token 数。 |
| provider 取消依赖契约 | timeout 会触发 canonical `AbortSignal`，内置 in-process driver 会响应；若第三方 provider 违反取消契约并永久悬挂，插件无法从 JavaScript 里物理杀掉它。 | 真正的强制墙钟需要可终止的进程/worker transport，或 Harness 对 provider cancellation 加强契约与监控。 |
| 手动与自动生命周期重复 | `runBranch` 与 `runAutomaticReview` 都实现 start/result/validate/dispose；当前协议正确，但维护时可能漂移。 | 抽一个不改变 model-facing contract 的 one-shot runner，并保留两条触发/发布策略。 |
| Step 窗口必须在 Turn 边界切 native seed | DSH seed 不能合法停在半个 Turn。若最早选中的是 Turn 中部 Step，该 Turn 更早的未选 Step 会完全省略，不能作为 native history 保留。 | 这是当前投影语义，不应宣传成“只删恰好 K 个 reasoning block”；未来需要 Harness 原生 masked replay 才能更细。 |
| tool arguments 可能带 actor framing 或敏感值 | reasoning mask 不等于数据脱敏；arguments 是实际 action 的一部分，默认保留。 | 部署者应在工具层做 secret redaction/摘要；不能让本插件猜测任意参数语义。 |
| 视觉门不是视觉正确性证明 | runtime 保留 attachment ref，并在含图 child 创建前要求最终 route 显式声明 image input；它不读取图片、不做 OCR，也不能证明模型真正理解了图。模型目录或 route 在 preflight 后仍可能变化，最终 adapter 始终是协议权威。 | 用 Vision-Exp live smoke 和配对 eval 验证语义质量；不要自动 caption、自动换视觉模型或把占位符当证据。 |
| 未发布自动 review 的跨进程幂等性 | `no_update` 和 `observe-only` 不写父 inbox；同进程由 `attempted` 防重，重启后可能重跑。 | 若要 exactly-once，需要独立 durable checkpoint store，不能用会唤醒 Primary 的 `inject/steer` 伪造。 |

## 不作为待办

- 不为增加代码量而添加空洞 runtime invariant。Subagent seam 已拥有 child 生命周期，本插件没有第二份可审计状态。
- `POLICY_ORDER = 116.75` 当前用于把 deliberation policy 放在普通 subagent guidance 与 child reporting 之间；这不是功能缺陷，最多补充来源说明。
- 默认 bundle 为手动分支提供 `reason-only` 和 `read-only`；自动 review 默认关闭，显式启用时固定声明 current-turn provider、`read-only` 和 `updates-only`。这些配置都不授予 mutation capability。
