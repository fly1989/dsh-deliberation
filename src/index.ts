/**
 * Primary-controlled deliberation over isolated one-shot subagents. The model
 * supplies the incumbent, structured projection, and each branch focus; this
 * plugin applies a fixed role preset, selects the configured model route, runs
 * branches concurrently, and returns one role-specific result per branch.
 *
 * @module dsh-deliberation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolRestriction, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { installAutomaticReview } from './auto-review.ts'
import {
  assertChildImageInputSupported,
  completedTurnPrefix,
  isUnsupportedChildImageInputError,
} from './child-image-input.ts'
import {
  REVIEW_PACKET_VALUE_SCHEMA,
  ROLE_OUTPUT_SCHEMA,
  parseTextualReviewPacket,
  validReviewPacket,
} from './contracts.ts'
import type { ReviewPacket } from './contracts.ts'
import {
  DEFAULT_MAX_RECENT_STEPS,
  MAX_REGISTERED_RECENT_STEPS,
  MidForkProjectionError,
  recentStepProviderName,
} from './mid-fork-provider.ts'

const DEFAULT_BRANCH_TIMEOUT_MS = 600_000
const BRANCH_TIMEOUT_CODE = 'DELIBERATION_BRANCH_TIMEOUT'
const DEFAULT_AUTO_REVIEW_TIMEOUT_MS = 300_000

/** Cordis plugin name. */
export const name = 'tool-deliberation'
/** Services required by the deliberation tool. */
export const inject = ['subagents', 'systemPrompt', 'tools']

/** One deployment-approved model route that the Primary may select per branch. */
export interface DeliberationRouteConfig {
  /** Stable model-facing route name. */
  readonly name: string
  /** Model-facing explanation of this route's intended use. */
  readonly description: string
  /** Optional provider override; omission inherits the Primary's route. */
  readonly provider?: string
  /** Optional model override; omission inherits the Primary's model. */
  readonly model?: string
  /** Optional per-request output-token ceiling for this route. */
  readonly maxTokens?: number
}

/** One deployment-approved child tool boundary exposed through a stable alias. */
export interface DeliberationCapabilityProfileConfig {
  /** Stable model-facing capability name. */
  readonly name: string
  /** Model-facing explanation of what work this boundary permits. */
  readonly description: string
  /** Global tools retained inside the child; an empty list creates a reasoning-only child. */
  readonly allow?: string[]
  /** Global tools removed inside the child. */
  readonly deny?: string[]
}

/** Runtime-owned review configuration; no Primary tool decision is involved. */
export interface AutomaticReviewConfig {
  readonly enabled?: boolean
  readonly scope?: 'all-primary-turns' | 'tool-bearing-turns'
  /** Dedicated provider whose window/mask policy is deployment-owned. */
  readonly provider?: string
  readonly route?: string
  readonly capability?: string
  readonly publish?: 'updates-only' | 'all' | 'observe-only'
  readonly timeoutMs?: number
}

/** Deliberation tool configuration. */
export interface Config {
  /** Fresh-context one-shot subagent provider. */
  readonly freshProvider?: string
  /** Completed-prefix fork one-shot subagent provider. */
  readonly forkProvider?: string
  /** Prefix used by the recent-Step provider family: `${prefix}-1` through `${prefix}-N`. */
  readonly midForkProvider?: string
  /** Maximum Primary-selectable completed-Step window for manual masked-review. */
  readonly maxRecentSteps?: number
  /** Model-facing tool name. */
  readonly toolName?: string
  /** Maximum number of branches accepted by one call. */
  readonly maxBranches: number
  /** Maximum absolute delegation depth at which this plugin may start a branch. */
  readonly maxDepth: number
  /** Deployment-owned cancellation deadline; providers must honor the canonical AbortSignal. */
  readonly branchTimeoutMs?: number
  /** Deployment-approved model routes exposed to the Primary. */
  readonly routes: DeliberationRouteConfig[]
  /** Deployment-approved child tool boundaries exposed to the Primary. */
  readonly capabilityProfiles: DeliberationCapabilityProfileConfig[]
  /** Optional reasoning-masked review at the pre-turn-close barrier. */
  readonly autoReview?: AutomaticReviewConfig
  /** Emit safe lifecycle and execution breadcrumbs through the Harness logger. */
  readonly debug?: boolean
}

/** Loader schema for the opt-in deliberation tool. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
  midForkProvider: z.string().default('mid-fork-step'),
  maxRecentSteps: z.natural().min(1).max(MAX_REGISTERED_RECENT_STEPS).default(DEFAULT_MAX_RECENT_STEPS),
  toolName: z.string().default('deliberate'),
  maxBranches: z.natural().min(1).required(),
  maxDepth: z.natural().min(1).required(),
  branchTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_BRANCH_TIMEOUT_MS),
  routes: z.array(z.object({
    name: z.string().required(),
    description: z.string().required(),
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  })).required(),
  capabilityProfiles: z.array(z.object({
    name: z.string().required(),
    description: z.string().required(),
    // Preserve omission: an explicitly empty allowlist is the reasoning-only profile.
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  })).required(),
  autoReview: z.object({
    enabled: z.boolean().default(false),
    scope: z.union(['all-primary-turns', 'tool-bearing-turns'] as const).default('tool-bearing-turns'),
    provider: z.string(),
    route: z.string(),
    capability: z.string(),
    publish: z.union(['updates-only', 'all', 'observe-only'] as const).default('updates-only'),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_AUTO_REVIEW_TIMEOUT_MS),
  }),
  /** Opt-in only: never log prompts, provider payloads, or child content. */
  debug: z.boolean().default(false),
})

type DeliberationRole = 'independent-alternative' | 'trajectory-audit' | 'masked-review'

/** See the automatic-review counterpart for why a clean capture-less child
 * can arrive with `stopReason: error` from DSH's in-process driver. */
function childCompletedNormally(run: SubagentRun): boolean {
  const lastEnd = run.localAgent?.session.events.findLast(event => event.type === 'turn/end')
  return lastEnd?.type === 'turn/end' && lastEnd.data.reason.kind === 'completed'
}
type DeliberationHistory = 'fresh' | 'fork' | 'mid-fork'

interface DeliberationContextProjection {
  readonly observations: readonly string[]
  readonly constraints: readonly string[]
  readonly unknowns: readonly string[]
}

interface DeliberationBranchBase {
  readonly label: string
  readonly route: string
  readonly capability: string
  readonly focus: string
}

type DeliberationBranchRequest =
  | DeliberationBranchBase & {
    readonly role: 'independent-alternative' | 'trajectory-audit'
    readonly recentSteps?: never
  }
  | DeliberationBranchBase & {
    readonly role: 'masked-review'
    /** Primary-selected count of complete prior Steps to project without their reasoning blocks. */
    readonly recentSteps: number
  }

interface DeliberationRequest {
  readonly goal: string
  readonly incumbent: string
  readonly context: DeliberationContextProjection
  readonly branches: readonly DeliberationBranchRequest[]
}

type ResolvedAutomaticReview = {
  readonly enabled: false
  readonly scope: 'all-primary-turns' | 'tool-bearing-turns'
  readonly publish: 'updates-only' | 'all' | 'observe-only'
  readonly timeoutMs: number
} | {
  readonly enabled: true
  readonly scope: 'all-primary-turns' | 'tool-bearing-turns'
  readonly provider: string
  readonly route: string
  readonly capability: string
  readonly publish: 'updates-only' | 'all' | 'observe-only'
  readonly timeoutMs: number
}

interface ResolvedConfig {
  readonly freshProvider: string
  readonly forkProvider: string
  readonly midForkProvider: string
  readonly maxRecentSteps: number
  readonly toolName: string
  readonly maxBranches: number
  readonly maxDepth: number
  readonly branchTimeoutMs: number
  readonly routes: ReadonlyMap<string, DeliberationRouteConfig>
  readonly capabilityProfiles: ReadonlyMap<string, DeliberationCapabilityProfileConfig>
  readonly autoReview: ResolvedAutomaticReview
  readonly debug: boolean
}

const BRANCH_OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', required: true },
    role: {
      type: 'string',
      required: true,
      enum: ['independent-alternative', 'trajectory-audit', 'masked-review'],
    },
    history: { type: 'string', required: true, enum: ['fresh', 'fork', 'mid-fork'] },
    route: { type: 'string', required: true },
    capability: { type: 'string', required: true },
    runId: { type: 'string' },
    stopReason: { type: 'string', required: true },
    cleanup: { type: 'string', required: true, enum: ['completed', 'failed', 'not-started'] },
    historyWindow: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'recent-steps', required: true },
        requestedSteps: { type: 'integer', required: true },
        projectedSteps: { type: 'integer', required: true },
      },
    },
    packet: REVIEW_PACKET_VALUE_SCHEMA,
    diagnostic: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec

const DELIBERATION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    branches: { type: 'array', required: true, items: BRANCH_OUTCOME_SCHEMA },
  },
} as const satisfies ValueSchemaSpec

type BranchOutcome = InferValue<typeof BRANCH_OUTCOME_SCHEMA>
type DeliberationOutput = InferValue<typeof DELIBERATION_OUTPUT_SCHEMA>

const ROLE_DEFINITION: Record<DeliberationRole, {
  readonly history: DeliberationHistory
  readonly includeIncumbent: boolean
  readonly instruction: string
}> = {
  'independent-alternative': {
    history: 'fresh',
    includeIncumbent: false,
    instruction:
      'Construct one defensible answer, plan, or explanation from a materially different causal mechanism or '
      + 'assumption set. Do not manufacture novelty: no-defensible-alternative is a valid result. Separate direct '
      + 'observations from assumptions, and return no_update when no defensible alternative was found.',
  },
  'trajectory-audit': {
    history: 'fork',
    includeIncumbent: true,
    instruction:
      'Determine whether the observable completed trajectory and incumbent remain valid. Attempt concrete '
      + 'falsification, but do not assume an error exists. Report performed observations as observations and unperformed '
      + 'checks only as suggestions. If support fails, compress only the decision-relevant error or uncertainty.',
  },
  'masked-review': {
    history: 'mid-fork',
    includeIncumbent: false,
    instruction:
      'Re-read the recent suffix as behavioral evidence: observable inputs, chosen actions, tool outcomes, and visible '
      + 'state, without the original actor reasoning blocks or adapter replay state. Treat retained visible prose as the '
      + 'actor\'s claim rather than independent evidence. When the snapshot contains Image evidence #N, treat each image '
      + 'as first-class observable evidence; refer to its adjacent label only when it grounds an item, and use unknown rather '
      + 'than inventing unreadable details. Check whether the behavior and outcomes still support the continuation. '
      + 'Return no_update when there is no decision-relevant change; never manufacture an alternative frame.',
  },
}

const POLICY_ORDER = 116.75

/** Render policy against the configured registration name so schema and guidance cannot diverge. */
function policy(toolName: string): string {
  return `Use ${toolName} when a live semantic fork merits deliberate parallel evidence: independent-alternative explores an incumbent-blind fresh path, trajectory-audit falsifies the completed prefix, and masked-review re-reads a Primary-selected number of complete recent Steps without the actor's reasoning blocks. One Step is one model decision plus every tool call and result caused by that decision; the currently executing deliberate Step is excluded. Supply observations, constraints, and unknowns rather than conclusions disguised as facts. Choose only the branches, model routes, tool boundaries, and masked-review window that can change the continuation.

Every branch returns a sparse JSON packet. Each item states what it is and the child-reported certainty; certainty is not runtime verification. Same-model agreement is weak evidence, not verification. Keep final control, accept no_update results, and never treat a branch as rollback of Session history or external side effects.`
}

/** Reject empty strings at the model/config boundary where the type alone is insufficient. */
function requireText(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`tool-deliberation: ${field} must be non-empty`)
}

/** Validate a configured tool-name list without depending on tool registration order. */
function validateToolNames(values: readonly string[] | undefined, field: string): void {
  if (values === undefined) return
  const seen = new Set<string>()
  for (const value of values) {
    requireText(value, field)
    if (seen.has(value)) throw new Error(`tool-deliberation: ${field} contains duplicate tool "${value}"`)
    seen.add(value)
  }
}

/** Validate and detach deployment configuration used after plugin activation. */
function resolveConfig(config: Config): ResolvedConfig {
  const freshProvider = config.freshProvider ?? 'spawn'
  const forkProvider = config.forkProvider ?? 'fork'
  const midForkProvider = config.midForkProvider ?? 'mid-fork-step'
  const maxRecentSteps = config.maxRecentSteps ?? DEFAULT_MAX_RECENT_STEPS
  const toolName = config.toolName ?? 'deliberate'
  requireText(freshProvider, 'freshProvider')
  requireText(forkProvider, 'forkProvider')
  requireText(midForkProvider, 'midForkProvider')
  requireText(toolName, 'toolName')
  if (!Number.isSafeInteger(maxRecentSteps)
    || maxRecentSteps < 1
    || maxRecentSteps > MAX_REGISTERED_RECENT_STEPS) {
    throw new Error(
      `tool-deliberation: maxRecentSteps must be a positive safe integer no greater than ${MAX_REGISTERED_RECENT_STEPS}`,
    )
  }
  const midForkProviders = Array.from(
    { length: maxRecentSteps },
    (_, index) => recentStepProviderName(midForkProvider, index + 1),
  )
  const requiredProviders = [freshProvider, forkProvider, ...midForkProviders]
  if (new Set(requiredProviders).size !== requiredProviders.length) {
    throw new Error(
      'tool-deliberation: freshProvider, forkProvider, and every generated recent-Step provider name must be distinct',
    )
  }
  if (!Number.isSafeInteger(config.maxBranches) || config.maxBranches < 1) {
    throw new Error('tool-deliberation: maxBranches must be a positive safe integer')
  }
  if (!Number.isSafeInteger(config.maxDepth) || config.maxDepth < 1) {
    throw new Error('tool-deliberation: maxDepth must be a positive safe integer')
  }
  const branchTimeoutMs = config.branchTimeoutMs ?? DEFAULT_BRANCH_TIMEOUT_MS
  if (!Number.isSafeInteger(branchTimeoutMs)
    || branchTimeoutMs < 1
    || branchTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `tool-deliberation: branchTimeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    throw new Error('tool-deliberation: routes must contain at least one model route')
  }
  if (!Array.isArray(config.capabilityProfiles) || config.capabilityProfiles.length === 0) {
    throw new Error('tool-deliberation: capabilityProfiles must contain at least one capability profile')
  }

  const routes = new Map<string, DeliberationRouteConfig>()
  for (const route of config.routes) {
    requireText(route.name, 'route.name')
    requireText(route.description, `route "${route.name}" description`)
    if (!/^[a-z][a-z0-9-]*$/u.test(route.name)) {
      throw new Error(`tool-deliberation: route name "${route.name}" must be lower-kebab-case`)
    }
    if (routes.has(route.name)) {
      throw new Error(`tool-deliberation: duplicate route name "${route.name}"`)
    }
    if (route.provider !== undefined) requireText(route.provider, `route "${route.name}" provider`)
    if (route.model !== undefined) requireText(route.model, `route "${route.name}" model`)
    if (route.maxTokens !== undefined
      && (!Number.isSafeInteger(route.maxTokens) || route.maxTokens < 1)) {
      throw new Error(`tool-deliberation: route "${route.name}" maxTokens must be a positive safe integer`)
    }
    routes.set(route.name, { ...route })
  }

  const capabilityProfiles = new Map<string, DeliberationCapabilityProfileConfig>()
  for (const profile of config.capabilityProfiles) {
    requireText(profile.name, 'capabilityProfiles.name')
    requireText(profile.description, `capability profile "${profile.name}" description`)
    if (!/^[a-z][a-z0-9-]*$/u.test(profile.name)) {
      throw new Error(`tool-deliberation: capability profile name "${profile.name}" must be lower-kebab-case`)
    }
    if (capabilityProfiles.has(profile.name)) {
      throw new Error(`tool-deliberation: duplicate capability profile name "${profile.name}"`)
    }
    if (profile.allow === undefined && profile.deny === undefined) {
      throw new Error(`tool-deliberation: capability profile "${profile.name}" must configure allow and/or deny`)
    }
    validateToolNames(profile.allow, `capability profile "${profile.name}" allow`)
    validateToolNames(profile.deny, `capability profile "${profile.name}" deny`)
    const overlap = profile.allow?.find(tool => profile.deny?.includes(tool))
    if (overlap !== undefined) {
      throw new Error(`tool-deliberation: capability profile "${profile.name}" both allows and denies tool "${overlap}"`)
    }
    if (profile.allow?.includes(toolName)) {
      throw new Error(`tool-deliberation: capability profile "${profile.name}" cannot allow recursive tool "${toolName}"`)
    }
    capabilityProfiles.set(profile.name, {
      name: profile.name,
      description: profile.description,
      ...profile.allow === undefined ? {} : { allow: [...profile.allow] },
      ...profile.deny === undefined ? {} : { deny: [...profile.deny] },
    })
  }
  const autoReviewEnabled = config.autoReview?.enabled ?? false
  const autoReviewScope = config.autoReview?.scope ?? 'tool-bearing-turns'
  const autoReviewPublish = config.autoReview?.publish ?? 'updates-only'
  const autoReviewTimeoutMs = config.autoReview?.timeoutMs ?? DEFAULT_AUTO_REVIEW_TIMEOUT_MS
  if (!['all-primary-turns', 'tool-bearing-turns'].includes(autoReviewScope)) {
    throw new Error('tool-deliberation: autoReview.scope must be all-primary-turns or tool-bearing-turns')
  }
  if (!['updates-only', 'all', 'observe-only'].includes(autoReviewPublish)) {
    throw new Error('tool-deliberation: autoReview.publish must be updates-only, all, or observe-only')
  }
  if (!Number.isSafeInteger(autoReviewTimeoutMs)
    || autoReviewTimeoutMs < 1
    || autoReviewTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `tool-deliberation: autoReview.timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  let autoReview: ResolvedAutomaticReview
  if (autoReviewEnabled) {
    const provider = config.autoReview?.provider
    const route = config.autoReview?.route
    const capability = config.autoReview?.capability
    if (provider === undefined) throw new Error('tool-deliberation: autoReview.provider is required when enabled')
    if (route === undefined) throw new Error('tool-deliberation: autoReview.route is required when enabled')
    if (capability === undefined) throw new Error('tool-deliberation: autoReview.capability is required when enabled')
    requireText(provider, 'autoReview.provider')
    requireText(route, 'autoReview.route')
    requireText(capability, 'autoReview.capability')
    if (!routes.has(route)) {
      throw new Error(`tool-deliberation: autoReview route "${route}" is not configured`)
    }
    if (!capabilityProfiles.has(capability)) {
      throw new Error(`tool-deliberation: autoReview capability "${capability}" is not configured`)
    }
    autoReview = {
      enabled: true,
      scope: autoReviewScope,
      provider,
      route,
      capability,
      publish: autoReviewPublish,
      timeoutMs: autoReviewTimeoutMs,
    }
  } else {
    autoReview = {
      enabled: false,
      scope: autoReviewScope,
      publish: autoReviewPublish,
      timeoutMs: autoReviewTimeoutMs,
    }
  }
  return {
    freshProvider,
    forkProvider,
    midForkProvider,
    maxRecentSteps,
    toolName,
    maxBranches: config.maxBranches,
    maxDepth: config.maxDepth,
    branchTimeoutMs,
    routes,
    capabilityProfiles,
    autoReview,
    debug: config.debug ?? false,
  }
}

/** Emit opt-in breadcrumbs without logging prompts, tool payloads, or child content. */
function debugLog(ctx: Context, config: ResolvedConfig, message: string): void {
  if (!config.debug) return
  ctx.logger.info(`[tool-deliberation][debug] ${message}`)
}

/** Ensure a configured provider can enforce this tool's child isolation. */
function validateProvider(provider: SubagentProvider, history: DeliberationHistory): void {
  if (provider.inheritsParentContext !== (history !== 'fresh')) {
    throw new Error(
      `tool-deliberation: ${history} provider "${provider.name}" reports incompatible parent-history semantics`,
    )
  }
  for (const capability of ['outputSchema', 'depthLimit', 'toolFilter'] as const) {
    if (!provider.capabilities[capability]) {
      throw new Error(`tool-deliberation: provider "${provider.name}" lacks required ${capability} capability`)
    }
  }
}

/** Convert one configured route to the optional child override record. */
function routeOptions(route: DeliberationRouteConfig): AgentOptions | undefined {
  const options: AgentOptions = {
    ...route.provider === undefined ? {} : { provider: route.provider },
    ...route.model === undefined ? {} : { model: route.model },
    ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens },
  }
  return Object.keys(options).length === 0 ? undefined : options
}

/** Render one explicit Primary-owned projection without implying missing values are facts. */
function renderProjectionList(label: string, values: readonly string[]): string {
  const body = values.length === 0 ? '- none supplied' : values.map(value => `- ${value}`).join('\n')
  return `${label}:\n${body}`
}

function completedStepCount(agent: Agent): number {
  const ended = new Set(agent.session.events
    .filter(event => event.type === 'step/end')
    .map(event => `${event.data.turn}:${event.data.step}`))
  return agent.session.events.filter(event =>
    event.type === 'step/start' && ended.has(`${event.data.turn}:${event.data.step}`)).length
}

interface ResolvedHistoryWindow {
  readonly kind: 'recent-steps'
  readonly requestedSteps: number
  readonly projectedSteps: number
}

/** Build the only model-visible input added to one isolated branch. */
function branchPrompt(
  request: DeliberationRequest,
  branch: DeliberationBranchRequest,
  capability: DeliberationCapabilityProfileConfig,
  historyWindow?: ResolvedHistoryWindow,
): string {
  const role = ROLE_DEFINITION[branch.role]
  const incumbent = role.includeIncumbent
    ? `Primary incumbent:\n${request.incumbent}`
    : 'The Primary incumbent is deliberately omitted. Do not reconstruct or guess it.'
  const historyBoundary = role.history === 'fresh'
    ? 'You receive only this Primary-authored projection, not the parent conversation. Treat any desired answer or incumbent rationale accidentally embedded in the projection as an anchoring limitation.'
    : role.history === 'fork'
      ? 'You inherit completed Primary turns, but not private chain-of-thought or the current in-flight tool-call turn.'
      : `You inherit a balanced Primary prefix. Before this task, the provider adds a runtime-authored masked projection of ${historyWindow?.projectedSteps ?? 0} complete prior Primary Steps selected from the requested ${historyWindow?.requestedSteps ?? 0}. The active caller Step is excluded. Treat retained visible prose as the actor's claim rather than independent evidence; do not reconstruct omitted actor content.`
  return `You are one isolated ${branch.role} branch in a Primary-controlled deliberation round.

Decision question:\n${request.goal}

${incumbent}

${renderProjectionList('Supplied observations', request.context.observations)}

${renderProjectionList('User and system constraints', request.context.constraints)}

${renderProjectionList('Unresolved unknowns', request.context.unknowns)}

Branch focus:\n${branch.focus}

History boundary:\n${historyBoundary}

Deployment capability boundary:\n${capability.name}: ${capability.description}

Role instruction:\n${role.instruction}

Use only observable conversation events, supplied projection items, and actual tool results. Return only the JSON required by the output schema. Use status=no_update and omit items when nothing decision-relevant changed. Otherwise emit sparse observation, conclusion, assumption, unknown, possible_error, or suggestion items, each tagged certain, likely, or uncertain. Reserve certain for content directly established by supplied observations or actual tool results. Include only decision-relevant evidence and deltas; omit empty categories, reasoning transcripts, repeated task text, and generic caveats. Never claim access to hidden reasoning, token log probabilities, or a private filesystem workspace.`
}

/** Render only decision-relevant branch identity, execution outcome, and child packet. */
function renderDeliberationOutput(value: DeliberationOutput): ContentBlock[] {
  const modelFacing = {
    branches: value.branches.map(branch => ({
      label: branch.label,
      role: branch.role,
      stopReason: branch.stopReason,
      ...branch.historyWindow === undefined ? {} : { historyWindow: branch.historyWindow },
      ...branch.packet === undefined ? {} : { packet: branch.packet },
      ...branch.packet !== undefined || branch.diagnostic === undefined
        ? {}
        : { diagnostic: branch.diagnostic },
    })),
  }
  return [{ type: 'text', text: JSON.stringify(modelFacing) }]
}

/** Combine an operator profile with the plugin's non-recursion boundary. */
function capabilityFilter(
  profile: DeliberationCapabilityProfileConfig,
  toolName: string,
): ToolRestriction {
  return {
    ...profile.allow === undefined ? {} : { allow: profile.allow },
    deny: [...new Set([...profile.deny ?? [], toolName])],
  }
}

/** Preserve each branch's independent execution and cleanup outcomes. */
async function runBranch(
  ctx: Context,
  config: ResolvedConfig,
  parent: Agent,
  request: DeliberationRequest,
  branch: DeliberationBranchRequest,
  signal: AbortSignal,
): Promise<BranchOutcome> {
  const role = ROLE_DEFINITION[branch.role]
  const historyWindow: ResolvedHistoryWindow | undefined = branch.role === 'masked-review'
    ? {
        kind: 'recent-steps',
        requestedSteps: branch.recentSteps,
        projectedSteps: Math.min(branch.recentSteps, completedStepCount(parent), config.maxRecentSteps),
      }
    : undefined
  debugLog(
    ctx,
    config,
    `branch-start label=${JSON.stringify(branch.label)} role=${branch.role} history=${role.history} route=${branch.route} capability=${branch.capability}${historyWindow === undefined ? '' : ` requestedSteps=${historyWindow.requestedSteps} projectedSteps=${historyWindow.projectedSteps}`}`,
  )
  const base = {
    label: branch.label,
    role: branch.role,
    history: role.history,
    route: branch.route,
    capability: branch.capability,
    ...historyWindow === undefined ? {} : { historyWindow },
  } as const
  if (historyWindow?.projectedSteps === 0) {
    debugLog(ctx, config, `branch-skipped label=${JSON.stringify(branch.label)} reason=no-completed-step`)
    return {
      ...base,
      stopReason: 'no-completed-step',
      cleanup: 'not-started',
      diagnostic: 'No completed Primary Step was available for masked review.',
    }
  }
  using branchDeadline = deadline(signal, config.branchTimeoutMs, BRANCH_TIMEOUT_CODE)
  const branchSignal = branchDeadline.signal
  const route = config.routes.get(branch.route)
  /* v8 ignore next -- the model parameter schema is built from the same route map. */
  if (route === undefined) throw new Error(`tool-deliberation: unknown route "${branch.route}"`)
  const capability = config.capabilityProfiles.get(branch.capability)
  /* v8 ignore next -- the model parameter schema is built from the same capability map. */
  if (capability === undefined) throw new Error(`tool-deliberation: unknown capability "${branch.capability}"`)
  const provider = role.history === 'fresh'
    ? config.freshProvider
    : role.history === 'fork'
      ? config.forkProvider
      : recentStepProviderName(config.midForkProvider, historyWindow!.projectedSteps)
  const agentOptions = routeOptions(route)
  const prompt: ContentBlock[] = [{ type: 'text', text: branchPrompt(request, branch, capability, historyWindow) }]

  let run: SubagentRun
  try {
    if (role.history !== 'mid-fork') {
      await assertChildImageInputSupported(
        ctx,
        parent,
        agentOptions,
        role.history === 'fork' ? completedTurnPrefix(parent.session.events) : [],
        prompt,
        branchSignal,
      )
    }
    run = await ctx.subagents.start(provider, {
      label: `deliberation: ${branch.label}`,
      prompt,
      parent,
      signal: branchSignal,
      outputSchema: ROLE_OUTPUT_SCHEMA[branch.role],
      maxDepth: config.maxDepth,
      toolFilter: capabilityFilter(capability, config.toolName),
      ...agentOptions === undefined ? {} : { agentOptions },
    })
    debugLog(ctx, config, `branch-published label=${JSON.stringify(branch.label)} runId=${run.id}`)
  } catch (error: unknown) {
    if (isUnsupportedChildImageInputError(error)) {
      debugLog(
        ctx,
        config,
        `branch-start-skipped label=${JSON.stringify(branch.label)} reason=unsupported-content code=${error.code} images=${error.stats.images} imageBytes=${error.stats.imageBytes}`,
      )
      return {
        ...base,
        stopReason: 'unsupported-content',
        cleanup: 'not-started',
        diagnostic: error.message,
      }
    }
    if (error instanceof MidForkProjectionError) {
      const stopReason = error.code === 'PROJECTION_IMAGE_LIMIT'
        ? 'projection-image-limit'
        : error.code === 'PROJECTION_OVER_BUDGET'
          ? 'projection-over-budget'
          : error.code === 'NO_COMPLETED_STEP'
            ? 'no-completed-step'
            : 'invalid-history-window'
      const diagnostic = error.code === 'PROJECTION_IMAGE_LIMIT'
        ? 'The child was not started because the selected snapshot exceeds the configured image limit.'
        : error.code === 'PROJECTION_OVER_BUDGET'
          ? 'The child was not started because the selected snapshot exceeds the configured character budget.'
          : error.code === 'NO_COMPLETED_STEP'
            ? 'No completed Primary Step was available for masked review.'
            : 'The child was not started because the configured history window was unavailable.'
      debugLog(
        ctx,
        config,
        `branch-start-skipped label=${JSON.stringify(branch.label)} reason=${stopReason} code=${error.code}`,
      )
      return { ...base, stopReason, cleanup: 'not-started', diagnostic }
    }
    if (timeoutOf(branchSignal, BRANCH_TIMEOUT_CODE) !== undefined) {
      ctx.logger.warn(`tool-deliberation: branch "${branch.label}" timed out before publication`)
      debugLog(ctx, config, `branch-start-failed label=${JSON.stringify(branch.label)} reason=timeout`)
      return { ...base, stopReason: 'timeout', cleanup: 'not-started' }
    }
    ctx.logger.warn(`tool-deliberation: branch "${branch.label}" failed before publication`)
    debugLog(ctx, config, `branch-start-failed label=${JSON.stringify(branch.label)} reason=startup-error`)
    return { ...base, stopReason: 'startup-error', cleanup: 'not-started' }
  }

  let result: SubagentResult | undefined
  let stopReason = 'infrastructure-error'
  let completedNormally = false
  try {
    result = await run.result
    stopReason = result.stopReason
    completedNormally = childCompletedNormally(run)
    debugLog(
      ctx,
      config,
      `branch-result label=${JSON.stringify(branch.label)} stopReason=${result.stopReason} structured=${result.structured === undefined ? 'no' : 'yes'}`,
    )
  } catch {
    ctx.logger.warn(`tool-deliberation: branch "${branch.label}" result rejected`)
    debugLog(ctx, config, `branch-result-rejected label=${JSON.stringify(branch.label)}`)
  }

  let cleanup: BranchOutcome['cleanup'] = 'completed'
  try {
    await run.dispose()
  } catch {
    cleanup = 'failed'
    ctx.logger.warn(`tool-deliberation: branch "${branch.label}" cleanup failed`)
  }
  debugLog(ctx, config, `branch-cleanup label=${JSON.stringify(branch.label)} status=${cleanup}`)

  const timedOut = timeoutOf(branchSignal, BRANCH_TIMEOUT_CODE) !== undefined
  if (timedOut) stopReason = 'timeout'
  const structured = timedOut ? undefined : result?.structured as ReviewPacket | undefined
  // Prefer provider-owned structured capture. If the model ignored the
  // capture tool but returned one exact JSON packet as final text, use the
  // deliberately narrow compatibility fallback from the shared contract.
  const textual = !timedOut && structured === undefined
    ? parseTextualReviewPacket(result?.output)
    : undefined
  const packetCandidate = structured ?? textual
  const acceptedTextualFallback = textual !== undefined
    && result?.stopReason === 'error'
    && completedNormally
  const acceptedPacketLifecycle = !timedOut
    && (result?.stopReason === 'completed' || acceptedTextualFallback)
  const packet = acceptedPacketLifecycle
    && packetCandidate?.role === branch.role
    && validReviewPacket(packetCandidate)
    ? packetCandidate
    : undefined
  if (acceptedTextualFallback) stopReason = 'completed'
  if (acceptedPacketLifecycle && packet === undefined) {
    stopReason = packetCandidate === undefined ? 'missing-structured-result' : 'invalid-structured-result'
  }
  if (textual !== undefined) {
    debugLog(ctx, config, `branch-text-fallback label=${JSON.stringify(branch.label)}`)
  }
  return {
    ...base,
    runId: run.id,
    stopReason,
    cleanup,
    ...packet === undefined ? {} : { packet },
    ...timedOut || result?.diagnostic === undefined ? {} : { diagnostic: result.diagnostic },
  }
}

/** Register the model-facing tool once every role-bound history provider is available. */
function installTool(ctx: Context, config: ResolvedConfig): () => void {
  const routeNames = [...config.routes.keys()]
  const routeText = [...config.routes.values()]
    .map(route => `${route.name}: ${route.description}`)
    .join('; ')
  const capabilityNames = [...config.capabilityProfiles.keys()]
  const capabilityText = [...config.capabilityProfiles.values()]
    .map(profile => `${profile.name}: ${profile.description}`)
    .join('; ')
  const recentStepChoices = Array.from({ length: config.maxRecentSteps }, (_, index) => index + 1)
  const branchBaseProperties = {
    label: {
      type: 'string',
      required: true,
      description: 'Unique short label for this branch instance.',
    },
    route: {
      type: 'string',
      required: true,
      enum: routeNames,
      description: `Deployment-approved model route. ${routeText}`,
    },
    capability: {
      type: 'string',
      required: true,
      enum: capabilityNames,
      description: `Deployment-approved child tool boundary. ${capabilityText}`,
    },
    focus: {
      type: 'string',
      required: true,
      description: 'A narrow unresolved mechanism, assumption, invariant, or test for this role to examine; do not prescribe a desired conclusion.',
    },
  } as const
  const branchItems = {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...branchBaseProperties,
          role: { type: 'string', const: 'independent-alternative', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...branchBaseProperties,
          role: { type: 'string', const: 'trajectory-audit', required: true },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...branchBaseProperties,
          role: { type: 'string', const: 'masked-review', required: true },
          recentSteps: {
            type: 'integer',
            required: true,
            enum: recentStepChoices,
            description: `How many complete prior Primary Steps to reproject, from 1 through ${config.maxRecentSteps}. Choose the smallest window that contains the behavior under review. The active Step containing this tool call is never included.`,
          },
        },
      },
    ],
  } as const satisfies ValueSchemaSpec
  return ctx.tools.register(defineTool({
    name: config.toolName,
    description:
      'Open Primary-controlled isolated test-time reasoning branches at a live semantic fork. independent-alternative receives a fresh projection without the incumbent; trajectory-audit inherits the completed prefix and neutrally tries to falsify it; masked-review preserves an older prefix and reinterprets a Primary-selected number of complete recent Steps without the actor reasoning blocks. The Primary receives sparse JSON packets and retains final control. '
      + `Each branch receives a deployment-owned ${config.branchTimeoutMs}ms cancellation deadline. `
      + `Available model routes: ${routeText}. Available capability profiles: ${capabilityText}`,
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: 'The neutral exact decision, diagnosis, or next-step question this round must inform; keep the incumbent and desired answer in their dedicated fields rather than embedding them here.',
      },
      incumbent: {
        type: 'string',
        required: true,
        description: 'Your provisional current judgment or continuation before seeing branch results.',
      },
      context: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Primary-owned projection shared with both roles. Keep the incumbent and desired answer out of observations.',
        properties: {
          observations: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Observable facts, supplied facts, and concrete tool results relevant to the fork.',
          },
          constraints: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'User, system, safety, compatibility, and resource constraints.',
          },
          unknowns: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Unresolved questions or unsupported assumptions whose answers could change the result.',
          },
        },
      },
      branches: {
        type: 'array',
        required: true,
        description: `One through ${config.maxBranches} non-equivalent branch requests.`,
        items: branchItems,
      },
    },
    output: {
      schema: DELIBERATION_OUTPUT_SCHEMA,
      render: (_args, value) => renderDeliberationOutput(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${config.toolName} requires a calling Agent`)
      debugLog(
        ctx,
        config,
        `tool-call parent=${parent.id} branches=${args.branches.length} labels=${args.branches.map(branch => JSON.stringify(branch.label)).join(',')}`,
      )
      requireText(args.goal, 'goal')
      requireText(args.incumbent, 'incumbent')
      for (const [name, values] of Object.entries(args.context)) {
        values.forEach((value, index) => requireText(value, `context.${name}[${index}]`))
      }
      if (args.branches.length < 1 || args.branches.length > config.maxBranches) {
        throw new Error(`${config.toolName} requires 1 through ${config.maxBranches} branches`)
      }
      const labels = new Set<string>()
      for (const branch of args.branches) {
        requireText(branch.label, 'branch.label')
        requireText(branch.focus, `branch "${branch.label}" focus`)
        if (labels.has(branch.label)) {
          throw new Error(`${config.toolName} requires unique branch labels; duplicate "${branch.label}"`)
        }
        if (branch.role === 'masked-review') {
          if (!Number.isSafeInteger(branch.recentSteps)
            || branch.recentSteps < 1
            || branch.recentSteps > config.maxRecentSteps) {
            throw new Error(
              `${config.toolName}: masked-review recentSteps must be an integer from 1 through ${config.maxRecentSteps}`,
            )
          }
        } else if ('recentSteps' in branch) {
          throw new Error(`${config.toolName}: recentSteps is valid only for masked-review`)
        }
        labels.add(branch.label)
      }
      const request: DeliberationRequest = {
        goal: args.goal,
        incumbent: args.incumbent,
        context: {
          observations: [...args.context.observations],
          constraints: [...args.context.constraints],
          unknowns: [...args.context.unknowns],
        },
        branches: args.branches,
      }
      const branches = await Promise.all(args.branches.map(branch =>
        runBranch(ctx, config, parent, request, branch, exec.signal)))
      if (exec.signal.aborted) throw new Error('deliberation aborted')
      debugLog(ctx, config, `round-complete branches=${branches.length}`)
      return { branches }
    },
  }))
}

/** Mount the deliberation policy and follow configured provider lifecycle. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const modelPolicy = policy(resolved.toolName)
  let disposeTool: (() => void) | undefined

  debugLog(
    ctx,
    resolved,
    `apply tool=${resolved.toolName} freshProvider=${resolved.freshProvider} forkProvider=${resolved.forkProvider} midForkProviderPrefix=${resolved.midForkProvider} maxRecentSteps=${resolved.maxRecentSteps}`,
  )

  const midForkProviders = Array.from(
    { length: resolved.maxRecentSteps },
    (_, index) => recentStepProviderName(resolved.midForkProvider, index + 1),
  )
  const requiredProviders = [resolved.freshProvider, resolved.forkProvider, ...midForkProviders]

  const unmount = (): void => {
    const dispose = disposeTool
    disposeTool = undefined
    dispose?.()
    if (dispose !== undefined) debugLog(ctx, resolved, `tool-unmounted name=${resolved.toolName}`)
  }
  const maybeMount = (): void => {
    /* v8 ignore next -- provider names are unique; re-registration follows removal, which unmounts first. */
    if (disposeTool !== undefined) return
    const fresh = ctx.subagents.getProvider(resolved.freshProvider)
    const fork = ctx.subagents.getProvider(resolved.forkProvider)
    const missingMidFork = midForkProviders.filter(providerName =>
      ctx.subagents.getProvider(providerName) === undefined)
    if (fresh === undefined || fork === undefined || missingMidFork.length > 0) {
      debugLog(
        ctx,
        resolved,
        `waiting-for-providers fresh=${fresh === undefined ? 'missing' : 'ready'} fork=${fork === undefined ? 'missing' : 'ready'} missingMidFork=${missingMidFork.length}`,
      )
      return
    }
    validateProvider(fresh, 'fresh')
    validateProvider(fork, 'fork')
    for (const providerName of midForkProviders) {
      // Presence was checked as one atomic family immediately above.
      validateProvider(ctx.subagents.getProvider(providerName)!, 'mid-fork')
    }
    disposeTool = installTool(ctx, resolved)
    debugLog(ctx, resolved, `tool-mounted name=${resolved.toolName}`)
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (requiredProviders.includes(provider.name)) maybeMount()
  })
  ctx.on('subagent/provider-removed', (providerName) => {
    if (requiredProviders.includes(providerName)) unmount()
  })
  maybeMount()
  for (const providerName of requiredProviders) {
    if (ctx.subagents.getProvider(providerName) === undefined) {
      ctx.logger.info(`subagent provider "${providerName}" not registered yet; the "${resolved.toolName}" tool will register when it appears`)
    }
  }

  ctx.systemPrompt.section({
    name: `tool:${resolved.toolName}:policy`,
    order: POLICY_ORDER,
    text: context => ctx.tools.get(resolved.toolName, context.scope) === undefined ? '' : modelPolicy,
  })
  if (resolved.autoReview.enabled) {
    const route = resolved.routes.get(resolved.autoReview.route)
    const capability = resolved.capabilityProfiles.get(resolved.autoReview.capability)
    // resolveConfig() proves both names exist whenever automatic review is enabled.
    if (route === undefined || capability === undefined) {
      throw new Error('tool-deliberation: automatic review references unresolved deployment configuration')
    }
    installAutomaticReview(ctx, {
      pluginName: name,
      provider: resolved.autoReview.provider,
      toolName: resolved.toolName,
      maxDepth: resolved.maxDepth,
      timeoutMs: resolved.autoReview.timeoutMs,
      scope: resolved.autoReview.scope,
      publish: resolved.autoReview.publish,
      route,
      capability,
      debug: message => debugLog(ctx, resolved, message),
    })
  }
}
