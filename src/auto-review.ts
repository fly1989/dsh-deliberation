import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { parseTextualReviewPacket, ROLE_OUTPUT_SCHEMA, validReviewPacket } from './contracts.ts'
import type { MaskedReviewPacket } from './contracts.ts'
import { renderReviewPacket } from './render-packet.ts'
import { isUnsupportedChildImageInputError } from './child-image-input.ts'

const AUTO_REVIEW_TIMEOUT_CODE = 'DELIBERATION_AUTO_REVIEW_TIMEOUT'
const AUTO_REVIEW_SUMMARY_PREFIX = 'masked review checkpoint'

interface AutomaticReviewRoute {
  readonly provider?: string
  readonly model?: string
  readonly maxTokens?: number
}

interface AutomaticReviewCapability {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

export interface AutomaticReviewRuntimeConfig {
  readonly pluginName: string
  readonly provider: string
  readonly toolName: string
  readonly maxDepth: number
  readonly timeoutMs: number
  readonly scope: 'all-primary-turns' | 'tool-bearing-turns'
  readonly publish: 'updates-only' | 'all' | 'observe-only'
  readonly route: AutomaticReviewRoute
  readonly capability: AutomaticReviewCapability
  readonly debug?: (message: string) => void
}

function routeOptions(route: AutomaticReviewRoute): AgentOptions | undefined {
  const options: AgentOptions = {
    ...route.provider === undefined ? {} : { provider: route.provider },
    ...route.model === undefined ? {} : { model: route.model },
    ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens },
  }
  return Object.keys(options).length === 0 ? undefined : options
}

function capabilityFilter(capability: AutomaticReviewCapability, toolName: string): ToolRestriction {
  return {
    ...capability.allow === undefined ? {} : { allow: capability.allow },
    deny: [...new Set([...capability.deny ?? [], toolName])],
  }
}

function automaticReviewPrompt(turn: number): string {
  return `You are an isolated masked-review child automatically invoked at the stopping boundary of Primary turn ${turn}.

The history provider has preserved the balanced prefix before the current open Turn and supplied a deployment-configured masked snapshot of every complete Step in that Turn. An in-flight Step is never projected. Review only what the retained observable inputs, actions, outcomes, and any retained visible prose actually establish. Treat visible prose as the actor's claim rather than independent evidence, do not reconstruct omitted actor content, and do not assume an error or alternative exists. When the snapshot contains Image evidence #N, treat each image as first-class observable evidence; refer to its adjacent label only when it grounds an item, and use unknown rather than inventing unreadable details.

Return only the JSON object required by the output schema. Compare every candidate item with the retained snapshot and the Primary-visible history before publishing it. A restatement of a tool result, a successful command, a visible Primary conclusion, or “no fix is needed” is not a decision delta: if all candidates are such confirmations, return exactly {"role":"masked-review","status":"no_update"} and omit items. Use status=update only when at least one item adds a contradiction, an unobserved risk, a changed assumption, a materially different path, or a concrete next check that could change continuation. Otherwise emit sparse items: observation, conclusion, assumption, unknown, possible_error, or suggestion. Tag each item certain, likely, or uncertain; certain is reserved for content directly established by supplied observations or actual tool results. Include only decision-relevant evidence and deltas, omit empty categories, and do not include your reasoning transcript, the repeated task, or generic caveats. The Primary, not you, owns the final continuation.`
}

function projectionFailure(error: unknown): {
  readonly code: 'NO_OPEN_TURN' | 'NO_COMPLETED_STEP' | 'PROJECTION_OVER_BUDGET' | 'PROJECTION_IMAGE_LIMIT'
  readonly details: {
    readonly window: string
    readonly mask: string
    readonly turn?: number
    readonly requestedSteps?: number
    readonly projectedSteps?: number
    readonly snapshotChars?: number
    readonly maxSnapshotChars?: number
    readonly projectedImages?: number
    readonly projectedImageBytes?: number
    readonly maxSnapshotImages?: number
  }
} | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('details' in error)) return undefined
  const candidate = error as { code?: unknown; details?: unknown }
  if (candidate.code !== 'NO_OPEN_TURN'
    && candidate.code !== 'NO_COMPLETED_STEP'
    && candidate.code !== 'PROJECTION_OVER_BUDGET'
    && candidate.code !== 'PROJECTION_IMAGE_LIMIT') return undefined
  if (typeof candidate.details !== 'object' || candidate.details === null) return undefined
  const details = candidate.details as Record<string, unknown>
  if (details.window !== 'recent-steps' && details.window !== 'current-turn') return undefined
  if (details.mask !== 'reasoning-only' && details.mask !== 'action-only') return undefined
  if (details.turn !== undefined && (!Number.isSafeInteger(details.turn) || (details.turn as number) < 0)) return undefined
  if (details.requestedSteps !== undefined
    && (!Number.isSafeInteger(details.requestedSteps) || (details.requestedSteps as number) < 1)) return undefined
  if (details.projectedSteps !== undefined
    && (!Number.isSafeInteger(details.projectedSteps) || (details.projectedSteps as number) < 0)) return undefined
  if (details.snapshotChars !== undefined
    && (!Number.isSafeInteger(details.snapshotChars) || (details.snapshotChars as number) < 0)) return undefined
  if (details.maxSnapshotChars !== undefined
    && (!Number.isSafeInteger(details.maxSnapshotChars) || (details.maxSnapshotChars as number) < 1)) return undefined
  if (details.projectedImages !== undefined
    && (!Number.isSafeInteger(details.projectedImages) || (details.projectedImages as number) < 0)) return undefined
  if (details.projectedImageBytes !== undefined
    && (!Number.isSafeInteger(details.projectedImageBytes) || (details.projectedImageBytes as number) < 0)) return undefined
  if (details.maxSnapshotImages !== undefined
    && (!Number.isSafeInteger(details.maxSnapshotImages) || (details.maxSnapshotImages as number) < 1)) return undefined
  return {
    code: candidate.code,
    details: {
      window: details.window,
      mask: details.mask,
      ...typeof details.turn === 'number' ? { turn: details.turn } : {},
      ...typeof details.requestedSteps === 'number' ? { requestedSteps: details.requestedSteps } : {},
      ...typeof details.projectedSteps === 'number' ? { projectedSteps: details.projectedSteps } : {},
      ...typeof details.snapshotChars === 'number' ? { snapshotChars: details.snapshotChars } : {},
      ...typeof details.maxSnapshotChars === 'number' ? { maxSnapshotChars: details.maxSnapshotChars } : {},
      ...typeof details.projectedImages === 'number' ? { projectedImages: details.projectedImages } : {},
      ...typeof details.projectedImageBytes === 'number' ? { projectedImageBytes: details.projectedImageBytes } : {},
      ...typeof details.maxSnapshotImages === 'number' ? { maxSnapshotImages: details.maxSnapshotImages } : {},
    },
  }
}

function turnContainsToolCall(agent: Agent, turn: number): boolean {
  return agent.session.events.some(event => event.type === 'tool/call' && event.data.turn === turn)
}

function turnContainsManualMaskedReview(agent: Agent, turn: number, toolName: string): boolean {
  return agent.session.events.some(event => {
    if (event.type !== 'tool/call' || event.data.turn !== turn || event.data.name !== toolName) return false
    try {
      const args = JSON.parse(event.data.arguments) as unknown
      if (typeof args !== 'object' || args === null || !('branches' in args)) return false
      const branches = (args as { branches?: unknown }).branches
      return Array.isArray(branches) && branches.some(branch =>
        typeof branch === 'object' && branch !== null
        && (branch as { role?: unknown }).role === 'masked-review')
    } catch {
      return false
    }
  })
}

function turnContainsAutomaticCheckpoint(
  agent: Agent,
  turn: number,
  pluginName: string,
): boolean {
  let inTurn = false
  for (const event of agent.session.events) {
    if (event.type === 'turn/start' && event.data.turn === turn) inTurn = true
    if (!inTurn) continue
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === pluginName
      && event.data.source.form === 'notice'
      && event.data.source.summary.startsWith(AUTO_REVIEW_SUMMARY_PREFIX)) {
      return true
    }
    if (event.type === 'turn/end' && event.data.turn === turn) return false
  }
  return false
}

function renderAutomaticReview(packet: MaskedReviewPacket): string {
  return renderReviewPacket(packet)
}

/**
 * The in-process structured-output driver reports a clean child turn as
 * `error` when the model omitted the capture tool. Its local agent still keeps
 * the authoritative `turn/end { completed }` event; use that event to
 * distinguish this narrow compatibility case from a real child failure.
 */
function childCompletedNormally(run: SubagentRun): boolean {
  const lastEnd = run.localAgent?.session.events.findLast(event => event.type === 'turn/end')
  return lastEnd?.type === 'turn/end' && lastEnd.data.reason.kind === 'completed'
}

type AutomaticProviderReadiness =
  | { readonly kind: 'missing' }
  | { readonly kind: 'incompatible'; readonly reason: string }
  | { readonly kind: 'ready'; readonly provider: SubagentProvider }

function automaticProviderReadiness(ctx: Context, providerName: string): AutomaticProviderReadiness {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider === undefined) return { kind: 'missing' }
  if (!provider.inheritsParentContext) {
    return { kind: 'incompatible', reason: 'does not inherit parent context' }
  }
  for (const capability of ['outputSchema', 'depthLimit', 'toolFilter'] as const) {
    if (!provider.capabilities[capability]) {
      return { kind: 'incompatible', reason: `lacks ${capability}` }
    }
  }
  return { kind: 'ready', provider }
}

interface AutomaticReviewAttempt {
  /** Whether this stopping boundary should remain latched against another costly retry. */
  readonly retainAttempt: boolean
  readonly reviewed?: { readonly runId: string; readonly packet: MaskedReviewPacket }
}

async function runAutomaticReview(
  ctx: Context,
  config: AutomaticReviewRuntimeConfig,
  parent: Agent,
  turn: number,
  signal: AbortSignal,
): Promise<AutomaticReviewAttempt> {
  if (automaticProviderReadiness(ctx, config.provider).kind !== 'ready') {
    return { retainAttempt: false }
  }
  using reviewDeadline = deadline(signal, config.timeoutMs, AUTO_REVIEW_TIMEOUT_CODE)
  const options = routeOptions(config.route)
  let run: SubagentRun
  try {
    run = await ctx.subagents.start(config.provider, {
      label: `masked review: turn ${turn}`,
      prompt: [{ type: 'text', text: automaticReviewPrompt(turn) }],
      parent,
      signal: reviewDeadline.signal,
      outputSchema: ROLE_OUTPUT_SCHEMA['masked-review'],
      maxDepth: config.maxDepth,
      toolFilter: capabilityFilter(config.capability, config.toolName),
      ...options === undefined ? {} : { agentOptions: options },
    })
  } catch (error: unknown) {
    const projection = projectionFailure(error)
    if (projection !== undefined) {
      const details = projection.details
      if (projection.code === 'PROJECTION_OVER_BUDGET') {
        ctx.logger.warn(`tool-deliberation: automatic review skipped reason=projection-over-budget parentSessionId=${parent.session.header.id} turn=${details.turn ?? turn} window=${details.window} mask=${details.mask} projectedSteps=${details.projectedSteps ?? 'unknown'} snapshotChars=${details.snapshotChars ?? 'unknown'} maxSnapshotChars=${details.maxSnapshotChars ?? 'unknown'} projectedImages=${details.projectedImages ?? 0} projectedImageBytes=${details.projectedImageBytes ?? 0}`)
      } else if (projection.code === 'PROJECTION_IMAGE_LIMIT') {
        ctx.logger.warn(`tool-deliberation: automatic review skipped reason=projection-image-limit parentSessionId=${parent.session.header.id} turn=${details.turn ?? turn} window=${details.window} mask=${details.mask} projectedSteps=${details.projectedSteps ?? 'unknown'} projectedImages=${details.projectedImages ?? 'unknown'} projectedImageBytes=${details.projectedImageBytes ?? 'unknown'} maxSnapshotImages=${details.maxSnapshotImages ?? 'unknown'}`)
      } else if (projection.code === 'NO_COMPLETED_STEP') {
        ctx.logger.warn(`tool-deliberation: automatic review skipped reason=no-completed-step parentSessionId=${parent.session.header.id} turn=${turn} window=${details.window} mask=${details.mask}`)
      } else {
        ctx.logger.warn(`tool-deliberation: automatic review skipped reason=no-open-turn parentSessionId=${parent.session.header.id} turn=${turn} window=${details.window} mask=${details.mask}`)
      }
      return { retainAttempt: false }
    }
    if (isUnsupportedChildImageInputError(error)) {
      ctx.logger.warn(`tool-deliberation: automatic review skipped reason=unsupported-content code=${error.code} parentSessionId=${parent.session.header.id} turn=${turn} images=${error.stats.images} imageBytes=${error.stats.imageBytes}`)
      return { retainAttempt: false }
    }
    if (automaticProviderReadiness(ctx, config.provider).kind !== 'ready') {
      config.debug?.(`auto-review-provider-race parent=${parent.id} turn=${turn}`)
      return { retainAttempt: false }
    }
    const timedOut = timeoutOf(reviewDeadline.signal, AUTO_REVIEW_TIMEOUT_CODE) !== undefined
    ctx.logger.warn(`tool-deliberation: automatic review ${timedOut ? 'timed out' : 'failed'} before publication`)
    return { retainAttempt: true }
  }

  let result: SubagentResult | undefined
  let completedNormally = false
  try {
    result = await run.result
    completedNormally = childCompletedNormally(run)
  } catch {
    ctx.logger.warn('tool-deliberation: automatic review result rejected')
  } finally {
    try {
      await run.dispose()
    } catch {
      ctx.logger.warn('tool-deliberation: automatic review cleanup failed')
    }
  }
  if (timeoutOf(reviewDeadline.signal, AUTO_REVIEW_TIMEOUT_CODE) !== undefined) {
    ctx.logger.warn('tool-deliberation: automatic review timed out')
    return { retainAttempt: true }
  }
  const structured = result?.structured as MaskedReviewPacket | undefined
  // DSH's structured_output capture is the normal path. Some model routes
  // still emit the exact packet as final text despite the capture instruction;
  // accept only that strict fallback from a clean child turn and never
  // arbitrary prose. The in-process driver uses `error` for a capture-less
  // clean turn, so the local turn/end event is part of this exception.
  const textual = structured === undefined ? parseTextualReviewPacket(result?.output) : undefined
  const packet = structured ?? textual
  const acceptedStop = result?.stopReason === 'completed'
    || textual !== undefined && result?.stopReason === 'error' && completedNormally
  if (!acceptedStop
    || packet?.role !== 'masked-review'
    || !validReviewPacket(packet)) {
    ctx.logger.warn('tool-deliberation: automatic review returned no valid structured packet')
    return { retainAttempt: true }
  }
  if (textual !== undefined) config.debug?.(`auto-review-text-fallback parent=${parent.id} turn=${turn}`)
  return { retainAttempt: true, reviewed: { runId: run.id, packet } }
}

/** Install the hard stopping-boundary trigger for the lifetime of the Cordis fiber. */
export function installAutomaticReview(ctx: Context, config: AutomaticReviewRuntimeConfig): void {
  const attempted = new Set<string>()
  const running = new Set<string>()
  const keyOf = (agent: Agent, turn: number): string => `${agent.session.header.id}:${turn}`
  let disposeStoppingHook: (() => void) | undefined
  let readinessState: string | undefined

  const onTurnStopping = async ({
    agent,
    turn,
    signal,
  }: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> => {
    let key: string | undefined
    try {
      if (agent.session.header.origin === 'subagent') return
      if (config.scope === 'tool-bearing-turns' && !turnContainsToolCall(agent, turn)) return
      if (turnContainsManualMaskedReview(agent, turn, config.toolName)) return
      if (turnContainsAutomaticCheckpoint(agent, turn, config.pluginName)) return
      key = keyOf(agent, turn)
      if (attempted.has(key) || running.has(key)) return
      if (automaticProviderReadiness(ctx, config.provider).kind !== 'ready') return
      running.add(key)
      config.debug?.(`auto-review-start parent=${agent.id} turn=${turn}`)
      const attempt = await runAutomaticReview(ctx, config, agent, turn, signal)
      if (attempt.retainAttempt) attempted.add(key)
      const reviewed = attempt.reviewed
      if (reviewed === undefined || signal.aborted) return
      if (config.publish === 'observe-only') {
        config.debug?.(`auto-review-observed parent=${agent.id} turn=${turn} runId=${reviewed.runId} status=${reviewed.packet.status}`)
        return
      }
      if (config.publish === 'updates-only' && reviewed.packet.status === 'no_update') {
        config.debug?.(`auto-review-not-published parent=${agent.id} turn=${turn} runId=${reviewed.runId} status=no_update`)
        return
      }
      const text = renderAutomaticReview(reviewed.packet)
      agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: config.pluginName,
          form: 'notice',
          summary: boundContextSummary(
            `${AUTO_REVIEW_SUMMARY_PREFIX} · ${reviewed.packet.status} · ${reviewed.packet.items?.length ?? 0} items`,
          ),
        },
      }))
      config.debug?.(`auto-review-steered parent=${agent.id} turn=${turn} runId=${reviewed.runId} publish=${config.publish}`)
    } catch {
      // A lifecycle extension must never turn a review failure into a failed Primary turn.
      if (key !== undefined && automaticProviderReadiness(ctx, config.provider).kind === 'ready') {
        attempted.add(key)
      }
      ctx.logger.warn('tool-deliberation: automatic review contained an unexpected internal failure')
    } finally {
      if (key !== undefined) running.delete(key)
    }
  }

  const unmountStoppingHook = (): void => {
    const dispose = disposeStoppingHook
    disposeStoppingHook = undefined
    dispose?.()
  }

  const refreshProvider = (): void => {
    const readiness = automaticProviderReadiness(ctx, config.provider)
    const nextState = readiness.kind === 'incompatible'
      ? `${readiness.kind}:${readiness.reason}`
      : readiness.kind
    if (readiness.kind === 'ready') {
      disposeStoppingHook ??= ctx.on('agent/turn-stopping', onTurnStopping)
    } else {
      unmountStoppingHook()
    }
    if (nextState === readinessState) return
    readinessState = nextState
    if (readiness.kind === 'ready') {
      ctx.logger.info(`tool-deliberation: automatic review active with provider "${config.provider}"`)
    } else if (readiness.kind === 'missing') {
      ctx.logger.info(`tool-deliberation: automatic review waiting for provider "${config.provider}"`)
    } else {
      ctx.logger.warn(`tool-deliberation: automatic review inactive because provider "${config.provider}" ${readiness.reason}`)
    }
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === config.provider) refreshProvider()
  })
  ctx.on('subagent/provider-removed', (providerName) => {
    if (providerName === config.provider) refreshProvider()
  })
  refreshProvider()

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const key = `${session.header.id}:${event.data.turn}`
    attempted.delete(key)
    running.delete(key)
  })
}
