/**
 * Experimental in-process subagent provider that preserves a balanced parent
 * prefix and re-projects a selected suffix as observable user context. Window
 * selection and masking are orthogonal so the same implementation can serve
 * Primary-selected recent-Step review, automatic current-Turn review, and
 * evaluation overlays without inventing new history semantics.
 *
 * @module dsh-deliberation/mid-fork-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { assertChildImageInputSupported } from './child-image-input.ts'

export const DEFAULT_MAX_RECENT_STEPS = 8
export const MAX_REGISTERED_RECENT_STEPS = 32
const DEFAULT_MAX_SNAPSHOT_CHARS = 65_536
export const DEFAULT_MAX_SNAPSHOT_IMAGES = 20

/** Cordis plugin name. */
export const name = 'subagent-mid-fork-in-process'
/** The provider registry is the only hard service dependency. */
export const inject = ['subagents']

export type MidForkMask = 'reasoning-only' | 'action-only'
export type MidForkWindow =
  | { readonly kind: 'recent-steps'; readonly recentSteps: number }
  | { readonly kind: 'current-turn' }

/** Experimental provider configuration. */
export interface Config {
  /** Provider name exposed through `ctx.subagents`. */
  readonly providerName?: string
  /** Structural suffix boundary; current-turn requires one unmatched open Turn. */
  readonly window?: 'recent-steps' | 'current-turn'
  /** Exact completed-Step window for one statically named provider. */
  readonly recentSteps?: number
  /** Register providerName-1 through providerName-N for Primary-selected windows. */
  readonly maxRecentSteps?: number
  /** Recent assistant content removed from the projected suffix. */
  readonly mask?: MidForkMask
  /** Hard character ceiling; overflow rejects before a child Session is created. */
  readonly maxSnapshotChars?: number
  /** Hard suffix-image ceiling; overflow rejects the complete projection. */
  readonly maxSnapshotImages?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('mid-fork-step'),
  window: z.union(['recent-steps', 'current-turn'] as const).default('recent-steps'),
  recentSteps: z.natural().min(1).max(MAX_REGISTERED_RECENT_STEPS),
  maxRecentSteps: z.natural().min(1).max(MAX_REGISTERED_RECENT_STEPS),
  mask: z.union(['reasoning-only', 'action-only'] as const).default('reasoning-only'),
  maxSnapshotChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  maxSnapshotImages: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

/** Safe machine-readable reasons for a projection that must not start a child. */
export type MidForkProjectionErrorCode =
  | 'NO_OPEN_TURN'
  | 'NO_COMPLETED_STEP'
  | 'PROJECTION_OVER_BUDGET'
  | 'PROJECTION_IMAGE_LIMIT'

/** A bounded projection failure carrying metadata but never projected content. */
export class MidForkProjectionError extends Error {
  constructor(
    readonly code: MidForkProjectionErrorCode,
    readonly details: {
      readonly window: MidForkWindow['kind']
      readonly mask: MidForkMask
      readonly turn?: number
      readonly requestedSteps?: number
      readonly projectedSteps?: number
      readonly snapshotChars?: number
      readonly maxSnapshotChars?: number
      readonly projectedImages?: number
      readonly projectedImageBytes?: number
      readonly maxSnapshotImages?: number
    },
  ) {
    super(code === 'NO_OPEN_TURN'
      ? 'mid-fork current-turn window requires one open parent turn'
      : code === 'NO_COMPLETED_STEP'
        ? 'mid-fork window requires at least one completed parent Step'
        : code === 'PROJECTION_OVER_BUDGET'
          ? 'mid-fork projected snapshot exceeds maxSnapshotChars'
          : 'mid-fork projected snapshot exceeds maxSnapshotImages')
    this.name = 'MidForkProjectionError'
  }
}

/** One deterministic history projection, exported for focused invariant tests. */
export interface MidForkProjection {
  /** Balanced parent prefix ending before the projected suffix. */
  readonly seed: readonly SessionEvent[]
  /** Debug rendering derived from `snapshotContent`; never sent independently. */
  readonly snapshot: string
  /** Authoritative model-facing suffix, restricted to one user message's text and images. */
  readonly snapshotContent: readonly MidForkSnapshotBlock[]
  /** Structural window used to select the suffix. */
  readonly window: MidForkWindow['kind']
  /** Assistant-content mask applied inside the suffix. */
  readonly mask: MidForkMask
  /** Actual number of turns represented in the snapshot. */
  readonly projectedTurns: number
  /** Actual number of complete model-decision Steps represented in the snapshot. */
  readonly projectedSteps: number
  /** Number of reasoning blocks omitted from assistant messages. */
  readonly omittedReasoningBlocks: number
  /** Number of assistant messages whose visible content was retained. */
  readonly projectedAssistantMessages: number
  /** Number of assistant messages whose visible prose action-only removed. */
  readonly omittedAssistantVisibleMessages: number
  /** Final snapshot length, measured in JavaScript string code units. */
  readonly snapshotChars: number
  /** Number of image references preserved from the projected suffix. */
  readonly projectedImages: number
  /** Sum of attachment-declared bytes for projected suffix images. */
  readonly projectedImageBytes: number
}

/** Blocks legal inside the synthetic child user message. */
export type MidForkSnapshotBlock = Extract<ContentBlock, { type: 'text' | 'image' }>

export interface MidForkProjectionOptions {
  readonly window: MidForkWindow
  readonly mask: MidForkMask
  readonly maxSnapshotChars?: number
  readonly maxSnapshotImages?: number
}

function requireProviderName(value: string): void {
  if (value.trim().length === 0) throw new Error('mid-fork providerName must be non-empty')
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`mid-fork ${field} must be a positive safe integer`)
  }
}

function requireRegisteredStepWindow(value: number, field: string): void {
  requirePositiveSafeInteger(value, field)
  if (value > MAX_REGISTERED_RECENT_STEPS) {
    throw new Error(`mid-fork ${field} must be no greater than ${MAX_REGISTERED_RECENT_STEPS}`)
  }
}

function validateOptions(options: MidForkProjectionOptions): void {
  if (options.window.kind === 'recent-steps') {
    requireRegisteredStepWindow(options.window.recentSteps, 'recentSteps')
  }
  if (options.mask !== 'reasoning-only' && options.mask !== 'action-only') {
    throw new Error('mid-fork mask must be reasoning-only or action-only')
  }
  if (options.maxSnapshotChars !== undefined) {
    requirePositiveSafeInteger(options.maxSnapshotChars, 'maxSnapshotChars')
  }
  if (options.maxSnapshotImages !== undefined) {
    requirePositiveSafeInteger(options.maxSnapshotImages, 'maxSnapshotImages')
  }
}

interface ContentInspection {
  readonly omittedReasoningBlocks: number
  readonly hasObservableContent: boolean
}

function inspectContent(blocks: readonly ContentBlock[]): ContentInspection {
  let omittedReasoningBlocks = 0
  let hasObservableContent = false
  for (const block of blocks) {
    switch (block.type) {
      case 'reasoning':
        omittedReasoningBlocks += 1
        break
      case 'text':
        hasObservableContent ||= block.text.length > 0
        break
      case 'image':
        hasObservableContent = true
        break
      case 'tool-call':
        // Authoritative tool/call events render the action exactly once.
        break
      case 'tool-result': {
        const nested = inspectContent(block.content)
        omittedReasoningBlocks += nested.omittedReasoningBlocks
        hasObservableContent ||= nested.hasObservableContent
        break
      }
      default:
        // The omission marker is observable even though the unknown block is not copied.
        hasObservableContent = true
    }
  }
  return { omittedReasoningBlocks, hasObservableContent }
}

interface SnapshotBuilder {
  readonly content: MidForkSnapshotBlock[]
  projectedImages: number
  projectedImageBytes: number
}

function appendText(builder: SnapshotBuilder, text: string): void {
  if (text.length === 0) return
  const previous = builder.content.at(-1)
  if (previous?.type === 'text') {
    previous.text += text
  } else {
    builder.content.push({ type: 'text', text })
  }
}

function appendImage(
  builder: SnapshotBuilder,
  block: Extract<ContentBlock, { type: 'image' }>,
  source: string,
  callId?: string,
): void {
  builder.projectedImages += 1
  builder.projectedImageBytes += block.attachment.bytes
  appendText(
    builder,
    `\n      Image evidence #${builder.projectedImages}\n      source: ${source}${callId === undefined ? '' : `\n      callId: ${callId}`}\n`,
  )
  builder.content.push({ type: 'image', attachment: { ...block.attachment } })
  appendText(builder, '\n')
}

/** Flatten nested message content into blocks legal in one synthetic user message. */
function appendObservableContent(
  builder: SnapshotBuilder,
  blocks: readonly ContentBlock[],
  imageSource: string,
  callId?: string,
): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'reasoning':
      case 'tool-call':
        break
      case 'text':
        appendText(builder, block.text)
        break
      case 'image':
        appendImage(builder, block, imageSource, callId)
        break
      case 'tool-result':
        appendObservableContent(builder, block.content, imageSource, callId ?? block.toolCallId)
        break
      default:
        appendText(
          builder,
          `[unsupported content block omitted: ${(block as { type?: unknown }).type ?? 'unknown'}]`,
        )
    }
  }
}

function appendLabeledContent(
  builder: SnapshotBuilder,
  label: string,
  blocks: readonly ContentBlock[],
  imageSource: string,
  callId?: string,
): void {
  appendText(builder, `    ${label}: `)
  appendObservableContent(builder, blocks, imageSource, callId)
  appendText(builder, '\n')
}

/** Derive diagnostics from the exact blocks sent to the child. */
export function renderMidForkSnapshotContent(content: readonly MidForkSnapshotBlock[]): string {
  let image = 0
  return content.map((block) => {
    if (block.type === 'text') return block.text
    image += 1
    return `[image #${image} ${block.attachment.mediaType} ${block.attachment.bytes}B]`
  }).join('')
}

function sourceLabel(message: Message): string {
  switch (message.source.kind) {
    case 'user':
      return 'User input'
    case 'tool':
      return `Tool result (${message.source.callId})`
    case 'model':
      return 'Model-origin observable context'
    case 'plugin':
      return `Injected context (${message.source.plugin})`
    default:
      return 'Observable message'
  }
}

function openTurn(events: readonly SessionEvent[]): number | undefined {
  const open = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn/start') open.add(event.data.turn)
    if (event.type === 'turn/end') open.delete(event.data.turn)
  }
  return open.size === 1 ? open.values().next().value : undefined
}

interface CompletedStep {
  readonly turn: number
  readonly step: number
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/** Return only atomically completed model decisions; an in-flight caller Step is never projected. */
function completedSteps(events: readonly SessionEvent[]): CompletedStep[] {
  const ended = new Set(events
    .filter((event): event is Extract<SessionEvent, { type: 'step/end' }> => event.type === 'step/end')
    .map(event => stepKey(event.data.turn, event.data.step)))
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'step/start' }> => event.type === 'step/start')
    .filter(event => ended.has(stepKey(event.data.turn, event.data.step)))
    .map(event => ({ turn: event.data.turn, step: event.data.step }))
}

function selectedSteps(
  events: readonly SessionEvent[],
  options: MidForkProjectionOptions,
): CompletedStep[] {
  const completed = completedSteps(events)
  if (options.window.kind === 'recent-steps') {
    return completed.slice(-options.window.recentSteps)
  }
  const turn = openTurn(events)
  if (turn === undefined) {
    throw new MidForkProjectionError('NO_OPEN_TURN', {
      window: options.window.kind,
      mask: options.mask,
    })
  }
  return completed.filter(step => step.turn === turn)
}

/**
 * Split the parent at a balanced Turn boundary and render only selected complete
 * Steps as neutral observable history. A native seed cannot end inside a Turn,
 * so when the earliest selected Step is not Step 1, earlier Steps in that same
 * Turn are omitted rather than replayed with their original reasoning.
 */
export function projectMidForkHistory(
  events: readonly SessionEvent[],
  activeSurfaceSeqs: ReadonlySet<number>,
  options: MidForkProjectionOptions,
): MidForkProjection {
  validateOptions(options)
  const selected = selectedSteps(events, options)
  if (selected.length === 0) {
    throw new MidForkProjectionError('NO_COMPLETED_STEP', {
      window: options.window.kind,
      mask: options.mask,
      ...options.window.kind === 'recent-steps'
        ? { requestedSteps: options.window.recentSteps, projectedSteps: 0 }
        : {},
    })
  }

  const selectedKeys = new Set(selected.map(step => stepKey(step.turn, step.step)))
  const selectedTurns = new Set(selected.map(step => step.turn))
  const firstSelectedTurn = selected[0]!.turn
  const cutIndex = events.findIndex(event =>
    event.type === 'turn/start' && event.data.turn === firstSelectedTurn)
  /* v8 ignore next -- selected turns came from turn/start events above. */
  const safeCutIndex = cutIndex < 0 ? events.length : cutIndex
  const seed = events.slice(0, safeCutIndex)
  const suffix = events.slice(safeCutIndex)
  const retained = options.mask === 'reasoning-only'
    ? 'observable inputs, assistant-visible content, actions, and tool outcomes while omitting assistant reasoning blocks and adapter replay state'
    : 'observable inputs, actions, and tool outcomes while omitting assistant reasoning blocks, assistant-visible prose, and adapter replay state'
  const builder: SnapshotBuilder = { content: [], projectedImages: 0, projectedImageBytes: 0 }
  appendText(
    builder,
    `<mid-fork-suffix window="${options.window.kind}" mask="${options.mask}" projected-turns="${selectedTurns.size}" projected-steps="${selected.length}"${options.window.kind === 'recent-steps' ? ` requested-steps="${options.window.recentSteps}"` : ''}>\n`
      + `Runtime projection: the balanced native prefix stops before the Turn containing the earliest selected Step. Only the selected complete Steps are rendered below. The rows preserve ${retained}. Read them as behavioral evidence; retained tool arguments may still contain the original actor's framing.\n`,
  )
  let omittedReasoningBlocks = 0
  let projectedAssistantMessages = 0
  let omittedAssistantVisibleMessages = 0
  let currentTurn: number | undefined
  let currentStep: string | undefined
  let renderedTurn: number | undefined

  for (const event of suffix) {
    switch (event.type) {
      case 'turn/start':
        currentTurn = event.data.turn
        currentStep = undefined
        break
      case 'step/start': {
        currentStep = stepKey(event.data.turn, event.data.step)
        if (!selectedKeys.has(currentStep)) break
        if (renderedTurn !== event.data.turn) {
          appendText(builder, `\nTurn ${event.data.turn}:\n`)
          renderedTurn = event.data.turn
        }
        appendText(builder, `  Step ${event.data.step} (one complete model decision):\n`)
        break
      }
      case 'user/message': {
        if (currentStep === undefined || !selectedKeys.has(currentStep) || !activeSurfaceSeqs.has(event.seq)) break
        const inspection = inspectContent(event.data.content)
        omittedReasoningBlocks += inspection.omittedReasoningBlocks
        if (inspection.hasObservableContent) {
          appendLabeledContent(builder, sourceLabel(event.data), event.data.content, sourceLabel(event.data))
        } else {
          appendText(builder, `    ${sourceLabel(event.data)}: (empty)\n`)
        }
        break
      }
      case 'assistant/message': {
        if (!selectedKeys.has(stepKey(event.data.turn, event.data.step)) || !activeSurfaceSeqs.has(event.seq)) break
        const inspection = inspectContent(event.data.message.content)
        omittedReasoningBlocks += inspection.omittedReasoningBlocks
        if (!inspection.hasObservableContent) break
        if (options.mask === 'reasoning-only') {
          projectedAssistantMessages += 1
          appendLabeledContent(
            builder,
            'Assistant visible content',
            event.data.message.content,
            'assistant visible content',
          )
        } else {
          omittedAssistantVisibleMessages += 1
        }
        break
      }
      case 'tool/call':
        if (selectedKeys.has(stepKey(event.data.turn, event.data.step))) {
          appendText(
            builder,
            `    Decision action [callId=${event.data.callId}]: ${event.data.name}(${event.data.arguments})\n`,
          )
        }
        break
      case 'tool/result': {
        if (!selectedKeys.has(stepKey(event.data.turn, event.data.step)) || !activeSurfaceSeqs.has(event.seq)) break
        const inspection = inspectContent(event.data.message.content)
        omittedReasoningBlocks += inspection.omittedReasoningBlocks
        const result = event.data.message.content.find(block => block.type === 'tool-result')
        const status = result?.type === 'tool-result' && result.isError ? 'error' : 'success'
        const callId = event.data.message.source.callId
        if (inspection.hasObservableContent) {
          appendLabeledContent(
            builder,
            `Tool outcome [callId=${callId}; status=${status}]`,
            event.data.message.content,
            'tool outcome',
            callId,
          )
        } else {
          appendText(builder, `    Tool outcome [callId=${callId}; status=${status}]: (empty)\n`)
        }
        break
      }
      case 'step/end':
        if (currentStep === stepKey(event.data.turn, event.data.step)) currentStep = undefined
        break
      case 'turn/end':
        if (selectedTurns.has(event.data.turn)) appendText(builder, `    Turn end: ${event.data.reason.kind}\n`)
        currentTurn = undefined
        currentStep = undefined
        break
      default:
        break
    }
  }
  if (currentTurn !== undefined && selectedTurns.has(currentTurn)) {
    appendText(builder, '    Turn state: open at masked-review checkpoint\n')
  }
  appendText(builder, '\n</mid-fork-suffix>')
  const snapshotContent = builder.content
  const snapshot = renderMidForkSnapshotContent(snapshotContent)
  if (options.maxSnapshotImages !== undefined && builder.projectedImages > options.maxSnapshotImages) {
    throw new MidForkProjectionError('PROJECTION_IMAGE_LIMIT', {
      window: options.window.kind,
      mask: options.mask,
      ...options.window.kind === 'current-turn' ? { turn: selected[0]!.turn } : {},
      ...options.window.kind === 'recent-steps' ? { requestedSteps: options.window.recentSteps } : {},
      projectedSteps: selected.length,
      projectedImages: builder.projectedImages,
      projectedImageBytes: builder.projectedImageBytes,
      maxSnapshotImages: options.maxSnapshotImages,
    })
  }
  if (options.maxSnapshotChars !== undefined && snapshot.length > options.maxSnapshotChars) {
    throw new MidForkProjectionError('PROJECTION_OVER_BUDGET', {
      window: options.window.kind,
      mask: options.mask,
      ...options.window.kind === 'current-turn' ? { turn: selected[0]!.turn } : {},
      ...options.window.kind === 'recent-steps' ? { requestedSteps: options.window.recentSteps } : {},
      projectedSteps: selected.length,
      snapshotChars: snapshot.length,
      maxSnapshotChars: options.maxSnapshotChars,
      projectedImages: builder.projectedImages,
      projectedImageBytes: builder.projectedImageBytes,
    })
  }
  return {
    seed,
    snapshot,
    snapshotContent,
    window: options.window.kind,
    mask: options.mask,
    projectedTurns: selectedTurns.size,
    projectedSteps: selected.length,
    omittedReasoningBlocks,
    projectedAssistantMessages,
    omittedAssistantVisibleMessages,
    snapshotChars: snapshot.length,
    projectedImages: builder.projectedImages,
    projectedImageBytes: builder.projectedImageBytes,
  }
}

/** Provider implementation built on DSH's public shared in-process driver. */
export class MidForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }
  readonly inheritsParentContext = true

  constructor(
    readonly name: string,
    readonly window: MidForkWindow,
    readonly mask: MidForkMask,
    readonly maxSnapshotChars?: number,
    readonly maxSnapshotImages?: number,
    private readonly runtimeContext?: Context,
  ) {
    requireProviderName(name)
    validateOptions({
      window,
      mask,
      ...maxSnapshotChars === undefined ? {} : { maxSnapshotChars },
      ...maxSnapshotImages === undefined ? {} : { maxSnapshotImages },
    })
  }

  async start(request: ResolvedSubagentStartRequest) {
    const projection = projectMidForkHistory(
      request.parent.session.events,
      new Set(request.parent.session.surface.nodes),
      {
        window: this.window,
        mask: this.mask,
        ...this.maxSnapshotChars === undefined ? {} : { maxSnapshotChars: this.maxSnapshotChars },
        ...this.maxSnapshotImages === undefined ? {} : { maxSnapshotImages: this.maxSnapshotImages },
      },
    )
    const prompt: ContentBlock[] = [
      ...projection.snapshotContent,
      ...request.prompt,
    ]
    await assertChildImageInputSupported(
      this.runtimeContext ?? request.parent.ctx,
      request.parent,
      request.agentOptions,
      projection.seed,
      prompt,
      request.signal,
    )
    return startInProcessRun({ ...request, prompt }, { seed: [...projection.seed] })
  }
}

/** Stable provider name selected by the Primary's bounded recentSteps argument. */
export function recentStepProviderName(providerPrefix: string, recentSteps: number): string {
  requireProviderName(providerPrefix)
  requireRegisteredStepWindow(recentSteps, 'recentSteps')
  return `${providerPrefix}-${recentSteps}`
}

export function apply(ctx: Context, config: Config): void {
  const providerName = config.providerName ?? 'mid-fork-step'
  const windowKind = config.window ?? 'recent-steps'
  const mask = config.mask ?? 'reasoning-only'
  const maxSnapshotChars = config.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS
  const maxSnapshotImages = config.maxSnapshotImages ?? DEFAULT_MAX_SNAPSHOT_IMAGES
  requireProviderName(providerName)

  if (windowKind === 'current-turn') {
    if (config.recentSteps !== undefined || config.maxRecentSteps !== undefined) {
      throw new Error('mid-fork current-turn window cannot configure recentSteps or maxRecentSteps')
    }
    ctx.subagents.registerProvider(new MidForkInProcessProvider(
      providerName,
      { kind: 'current-turn' },
      mask,
      maxSnapshotChars,
      maxSnapshotImages,
      ctx,
    ))
    return
  }

  if (config.recentSteps !== undefined && config.maxRecentSteps !== undefined) {
    throw new Error('mid-fork recent-steps config must choose recentSteps or maxRecentSteps, not both')
  }
  if (config.recentSteps !== undefined) {
    ctx.subagents.registerProvider(new MidForkInProcessProvider(
      providerName,
      { kind: 'recent-steps', recentSteps: config.recentSteps },
      mask,
      maxSnapshotChars,
      maxSnapshotImages,
      ctx,
    ))
    return
  }

  const maxRecentSteps = config.maxRecentSteps ?? DEFAULT_MAX_RECENT_STEPS
  requireRegisteredStepWindow(maxRecentSteps, 'maxRecentSteps')
  for (let recentSteps = 1; recentSteps <= maxRecentSteps; recentSteps += 1) {
    ctx.subagents.registerProvider(new MidForkInProcessProvider(
      recentStepProviderName(providerName, recentSteps),
      { kind: 'recent-steps', recentSteps },
      mask,
      maxSnapshotChars,
      maxSnapshotImages,
      ctx,
    ))
  }
}
