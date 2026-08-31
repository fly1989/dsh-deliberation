import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { CallId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
} from '@deepseek-ai/dsh-subagent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as deliberation from '../src/index.ts'
import {
  MAX_REVIEW_PACKET_CHARS,
  parseTextualReviewPacket,
  validReviewPacket,
} from '../src/contracts.ts'
import {
  MidForkInProcessProvider,
  MidForkProjectionError,
  recentStepProviderName,
} from '../src/mid-fork-provider.ts'
import { UnsupportedChildImageInputError } from '../src/child-image-input.ts'

const SIGNAL = new AbortController().signal

function imageBlock(attachmentId: string): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: attachmentId as never,
      mediaType: 'image/png',
      bytes: 1_024,
      width: 32,
      height: 32,
    },
  }
}

interface TestConfig {
  freshProvider?: string
  forkProvider?: string
  midForkProvider?: string
  maxRecentSteps?: number
  toolName?: string
  maxBranches: number
  maxDepth: number
  branchTimeoutMs?: number
  routes: Array<{
    name: string
    description: string
    provider?: string
    model?: string
    maxTokens?: number
  }>
  capabilityProfiles: Array<{
    name: string
    description: string
    allow?: string[]
    deny?: string[]
  }>
  autoReview?: {
    enabled?: boolean
    scope?: 'all-primary-turns' | 'tool-bearing-turns'
    provider?: string
    route?: string
    capability?: string
    publish?: 'updates-only' | 'all' | 'observe-only'
    timeoutMs?: number
  }
}

const BASE_CONFIG: TestConfig = {
  freshProvider: 'fresh',
  forkProvider: 'fork',
  midForkProvider: 'mid-fork-step',
  maxRecentSteps: 4,
  maxBranches: 4,
  maxDepth: 1,
  branchTimeoutMs: 10_000,
  routes: [
    { name: 'same', description: 'Inherit the Primary route.' },
    {
      name: 'strong',
      description: 'Use a stronger correction route.',
      provider: 'strong-provider',
      model: 'strong-model',
      maxTokens: 2048,
    },
  ],
  capabilityProfiles: [
    {
      name: 'reason-only',
      description: 'Use no inherited model-facing tools.',
      allow: [],
    },
    {
      name: 'evidence-only',
      description: 'Use only the deployment-approved evidence reader.',
      allow: ['fixture_read'],
      deny: ['fixture_write'],
    },
  ],
}

const BASE_CONTEXT = {
  observations: ['The supplied fixture reproduces the disputed behavior.'],
  constraints: ['Do not mutate production state.'],
  unknowns: ['Which mechanism best explains the observation?'],
}

function parentAgent(): Agent {
  const session = Session.create(SessionId('deliberation-parent'))
  return {
    id: session.header.id,
    session,
    options: { provider: 'fixture-provider', model: 'fixture-model' },
  } as unknown as Agent
}

function stoppingParent(id = 'automatic-parent'): { agent: Agent; steered: UserMessage[] } {
  const session = Session.create(SessionId(id))
  const steered: UserMessage[] = []
  const agent = {
    id: session.header.id,
    session,
    options: { provider: 'fixture-provider', model: 'fixture-model' },
    steer(message: UserMessage) {
      steered.push(message)
    },
  } as unknown as Agent
  return { agent, steered }
}

function appendStoppingStep(agent: Agent, turn: number, withTool = false): void {
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Review this completed Primary step.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'anchoring rationale' },
        { type: 'text', text: 'anchoring conclusion' },
      ],
      source: { provider: 'fixture-provider', model: 'fixture-model' },
    }),
  }, { surfaceOp: 'append' })
  if (withTool) {
    const callId = CallId('observed-call')
    agent.session.append('tool/call', {
      turn, step: 1, callId, name: 'fixture_read', arguments: '{}',
    })
  }
  agent.session.append('step/end', { turn, step: 1 })
}

function appendCompletedPrimaryTurns(agent: Agent, count: number): void {
  for (let turn = 1; turn <= count; turn += 1) {
    appendStoppingStep(agent, turn, true)
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

function appendDeliberateCall(
  agent: Agent,
  turn: number,
  role: 'independent-alternative' | 'trajectory-audit' | 'masked-review',
  focus = 'Review the current path.',
): void {
  agent.session.append('tool/call', {
    turn,
    step: 1,
    callId: CallId(`deliberate-${turn}-${role}`),
    name: 'deliberate',
    arguments: JSON.stringify({ branches: [{ role, focus }] }),
  })
}

function alternativeInsight(conclusion: string) {
  return {
    role: 'independent-alternative' as const,
    status: 'update' as const,
    items: [
      { kind: 'conclusion' as const, certainty: 'likely' as const, content: conclusion },
      {
        kind: 'suggestion' as const,
        certainty: 'likely' as const,
        content: 'Compare the alternative mechanism against the observable fixture ordering.',
      },
    ],
  }
}

function auditInsight(conclusion: string) {
  return {
    role: 'trajectory-audit' as const,
    status: 'update' as const,
    items: [
      { kind: 'observation' as const, certainty: 'certain' as const, content: conclusion },
      {
        kind: 'unknown' as const,
        certainty: 'uncertain' as const,
        content: 'The fixture does not establish whether production traffic preserves the same ordering.',
      },
    ],
  }
}

function maskedInsight(conclusion: string) {
  return {
    role: 'masked-review' as const,
    status: 'update' as const,
    items: [
      { kind: 'possible_error' as const, certainty: 'likely' as const, content: conclusion },
      {
        kind: 'assumption' as const,
        certainty: 'uncertain' as const,
        content: 'The current parser explanation is not established by the retained behavior alone.',
      },
      {
        kind: 'suggestion' as const,
        certainty: 'likely' as const,
        content: 'Verify dependency latency before patching the parser.',
      },
    ],
  }
}

function completedChildAgent(id = 'completed-fallback-child'): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return {
    id: session.header.id,
    session,
    options: { provider: 'fixture-provider', model: 'fixture-model' },
  } as unknown as Agent
}

function insightFor(request: ResolvedSubagentStartRequest) {
  const schema = JSON.stringify(request.outputSchema)
  if (schema.includes('trajectory-audit')) return auditInsight(request.label ?? 'unlabelled')
  if (schema.includes('masked-review')) return maskedInsight(request.label ?? 'unlabelled')
  return alternativeInsight(request.label ?? 'unlabelled')
}

function provider(
  name: string,
  inheritsParentContext: boolean,
  requests: ResolvedSubagentStartRequest[],
  settle: (request: ResolvedSubagentStartRequest) => SubagentResult | Promise<SubagentResult>,
  localAgent?: Agent,
): SubagentProvider {
  return {
    name,
    inheritsParentContext,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    async start(request) {
      requests.push(request)
      const childNumber = requests.length
      return {
        id: SessionId(`${name}-child-${childNumber}`),
        localAgent,
        result: Promise.resolve(settle(request)),
        dispose: () => Promise.resolve(),
      }
    },
  }
}

function registerMidFork(
  ctx: Context,
  requests: ResolvedSubagentStartRequest[] = [],
  settle: (request: ResolvedSubagentStartRequest) => SubagentResult | Promise<SubagentResult>
    = request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
  name = 'mid-fork-step',
  localAgent?: Agent,
) {
  return ctx.subagents.registerProvider(provider(name, true, requests, settle, localAgent))
}

function registerMidForkFamily(
  ctx: Context,
  requests: ResolvedSubagentStartRequest[] = [],
  settle: (request: ResolvedSubagentStartRequest) => SubagentResult | Promise<SubagentResult>
    = request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
  prefix = 'mid-fork-step',
  maxRecentSteps = BASE_CONFIG.maxRecentSteps ?? 4,
  localAgent?: Agent,
) {
  const disposers = Array.from({ length: maxRecentSteps }, (_, index) =>
    registerMidFork(ctx, requests, settle, recentStepProviderName(prefix, index + 1), localAgent))
  return () => disposers.forEach(dispose => dispose())
}

function registerAutoMidFork(
  ctx: Context,
  requests: ResolvedSubagentStartRequest[] = [],
  settle: (request: ResolvedSubagentStartRequest) => SubagentResult | Promise<SubagentResult>
    = request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
) {
  return registerMidFork(ctx, requests, settle, 'mid-fork-current-turn')
}

async function setup(
  settle: (request: ResolvedSubagentStartRequest) => SubagentResult | Promise<SubagentResult>
    = request => ({
      output: [{ type: 'text', text: 'RAW_CHILD_TRANSCRIPT_MUST_NOT_ENTER_PRIMARY' }],
      stopReason: 'completed',
      structured: insightFor(request),
    }),
  localAgent?: Agent,
) {
  const ctx = await bareContext()
  const freshRequests: ResolvedSubagentStartRequest[] = []
  const forkRequests: ResolvedSubagentStartRequest[] = []
  const midForkRequests: ResolvedSubagentStartRequest[] = []
  ctx.subagents.registerProvider(provider('fresh', false, freshRequests, settle, localAgent))
  ctx.subagents.registerProvider(provider('fork', true, forkRequests, settle, localAgent))
  registerMidForkFamily(ctx, midForkRequests, settle, 'mid-fork-step', BASE_CONFIG.maxRecentSteps ?? 4, localAgent)
  const fiber = await ctx.plugin(deliberation, BASE_CONFIG)
  return { ctx, fiber, freshRequests, forkRequests, midForkRequests }
}

async function bareContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  return ctx
}

function execute(
  ctx: Context,
  args: unknown,
  over: { agent?: Agent | undefined; signal?: AbortSignal } = {},
) {
  const agent = 'agent' in over ? over.agent : parentAgent()
  return ctx.tools.execute({
    signal: over.signal ?? SIGNAL,
    callId: CallId('deliberation-call'),
    name: 'deliberate',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function value(result: Awaited<ReturnType<typeof execute>>): { branches: Array<Record<string, unknown>> } {
  if (result.isError) throw new Error('expected a successful deliberation result')
  return result.value as unknown as { branches: Array<Record<string, unknown>> }
}

describe('tool-deliberation', () => {
  it('validates sparse epistemic packets without forcing empty categories', () => {
    expect(validReviewPacket({ role: 'masked-review', status: 'no_update' })).toBe(true)
    expect(validReviewPacket({ role: 'masked-review', status: 'no_update', items: [] })).toBe(false)
    expect(validReviewPacket({ role: 'masked-review', status: 'update' })).toBe(false)
    expect(validReviewPacket({
      role: 'masked-review',
      status: 'update',
      items: [{ kind: 'possible_error', certainty: 'uncertain', content: 'A compact concern.' }],
    })).toBe(true)
    expect(validReviewPacket({
      role: 'masked-review',
      status: 'update',
      items: [{ kind: 'suggestion', certainty: 'likely', content: 'x'.repeat(2_000) }],
    })).toBe(true)

    const packetAtLimit = {
      role: 'masked-review',
      status: 'update',
      items: [{ kind: 'suggestion', certainty: 'likely', content: '' }],
    } as const
    const packetOverhead = JSON.stringify(packetAtLimit).length
    const contentAtLimit = 'x'.repeat(MAX_REVIEW_PACKET_CHARS - packetOverhead)
    const exactLimitPacket = {
      ...packetAtLimit,
      items: [{ ...packetAtLimit.items[0], content: contentAtLimit }],
    }
    expect(JSON.stringify(exactLimitPacket)).toHaveLength(MAX_REVIEW_PACKET_CHARS)
    expect(validReviewPacket(exactLimitPacket)).toBe(true)
    expect(validReviewPacket({
      ...exactLimitPacket,
      items: [{ ...exactLimitPacket.items[0], content: `${contentAtLimit}x` }],
    })).toBe(false)
    expect(validReviewPacket({
      role: 'masked-review',
      status: 'update',
      items: Array.from({ length: 20 }, (_, index) => ({
        kind: 'unknown', certainty: 'uncertain', content: `unknown-${index}`,
      })),
    })).toBe(true)
    expect(validReviewPacket({
      role: 'masked-review',
      status: 'update',
      items: [
        { kind: 'unknown', certainty: 'uncertain', content: 'duplicate' },
        { kind: 'assumption', certainty: 'likely', content: ' DUPLICATE ' },
      ],
    })).toBe(false)

    const textual = JSON.stringify(maskedInsight('Recovered from an exact final-text packet.'))
    expect(parseTextualReviewPacket([
      { type: 'reasoning', text: 'private child reasoning must never be published' },
      { type: 'text', text: textual },
    ])).toEqual(
      maskedInsight('Recovered from an exact final-text packet.'),
    )
    expect(parseTextualReviewPacket([{ type: 'text', text: `Here is the packet: ${textual}` }])).toBeUndefined()
    expect(parseTextualReviewPacket([
      { type: 'text', text: textual },
      imageBlock('review-image'),
    ])).toBeUndefined()
  })

  it('exposes a Primary-owned policy and deployment-approved branch schema', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'deliberate')
    expect(schema?.description).toContain('Primary-controlled')
    expect(JSON.stringify(schema)).toContain('same')
    expect(JSON.stringify(schema)).toContain('strong')
    expect(JSON.stringify(schema)).toContain('reason-only')
    expect(JSON.stringify(schema)).toContain('evidence-only')
    expect(JSON.stringify(schema)).not.toContain('strong-provider')
    expect(JSON.stringify(schema)).not.toContain('strong-model')
    expect(JSON.stringify(schema)).not.toContain('fixture_read')
    expect(JSON.stringify(schema)).not.toContain('fixture_write')
    expect(JSON.stringify(schema)).not.toContain('chain-of-thought')
    expect(ctx.tools.executionMode({
      signal: SIGNAL,
      callId: CallId('deliberation-mode'),
      name: 'deliberate',
      arguments: {
        goal: 'Choose.',
        incumbent: 'A.',
        context: BASE_CONTEXT,
        branches: [{
          label: 'alternative',
          role: 'independent-alternative',
          route: 'same',
          capability: 'reason-only',
          focus: 'Find a distinct causal mechanism.',
        }],
      },
    })).toEqual({ kind: 'parallel' })

    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Use deliberate when a live semantic fork')
    expect(prompt).toContain('sparse JSON packet')
    expect(prompt).toContain('only the branches, model routes, tool boundaries, and masked-review window that can change the continuation')
    expect(prompt).toContain('independent-alternative')
    expect(prompt).toContain('trajectory-audit')
    expect(prompt).toContain('masked-review')
    expect(prompt).toContain('Primary-selected number of complete recent Steps')
    expect(prompt).toContain('currently executing deliberate Step is excluded')
    expect(prompt).toContain('Same-model agreement is weak evidence')
    expect(prompt).toContain('Every branch returns a sparse JSON packet')
    expect(JSON.stringify(schema)).toContain('independent-alternative')
    expect(JSON.stringify(schema)).toContain('trajectory-audit')
    expect(JSON.stringify(schema)).toContain('masked-review')
    expect(JSON.stringify(schema)).toContain('recentSteps')
    expect(JSON.stringify(schema)).toContain('from 1 through 4')
    expect(JSON.stringify(schema)).not.toContain('includeIncumbent')
    expect(JSON.stringify(schema)).not.toContain('"history":')
    expect(JSON.stringify(schema)).not.toContain('recover')
    expect(deliberation.name).toBe('tool-deliberation')
    expect(deliberation.inject).toEqual(['subagents', 'systemPrompt', 'tools'])
    expect('default' in deliberation).toBe(false)
  })

  it('runs fresh, forked-audit, and masked-review roles while preserving Primary control', async () => {
    const { ctx, freshRequests, forkRequests, midForkRequests } = await setup()
    const parent = parentAgent()
    appendCompletedPrimaryTurns(parent, 2)
    const result = await execute(ctx, {
      goal: 'Choose the next debugging action.',
      incumbent: 'Patch the parser first.',
      context: {
        observations: ['The parser fails only after an acknowledgement timeout.'],
        constraints: ['Do not mutate production state.'],
        unknowns: ['Whether parsing or acknowledgement ordering is causal.'],
      },
      branches: [
        {
          label: 'independent-search',
          role: 'independent-alternative',
          route: 'strong',
          capability: 'reason-only',
          focus: 'Search for a materially different failure mechanism.',
        },
        {
          label: 'trajectory-audit',
          role: 'trajectory-audit',
          route: 'same',
          capability: 'evidence-only',
          focus: 'Test the acknowledgement invariant without presuming it failed.',
        },
        {
          label: 'masked-review',
          role: 'masked-review',
          route: 'same',
          capability: 'reason-only',
          recentSteps: 2,
          focus: 'Reinterpret the completed action and tool-result suffix without its actor rationale.',
        },
      ],
    }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(freshRequests).toHaveLength(1)
    expect(forkRequests).toHaveLength(1)
    expect(midForkRequests).toHaveLength(1)
    const fresh = freshRequests[0]!
    const fork = forkRequests[0]!
    const midFork = midForkRequests[0]!
    expect(fresh.parent).toBe(parent)
    expect(fork.parent).toBe(parent)
    expect(midFork.parent).toBe(parent)
    expect(fresh.maxDepth).toBe(1)
    expect(fresh.toolFilter).toEqual({ allow: [], deny: ['deliberate'] })
    expect(fork.toolFilter).toEqual({ allow: ['fixture_read'], deny: ['fixture_write', 'deliberate'] })
    expect(fresh.agentOptions).toEqual({
      provider: 'strong-provider', model: 'strong-model', maxTokens: 2048,
    })
    expect(fork.agentOptions).toBeUndefined()
    expect(fresh.outputSchema).toBeDefined()
    expect(fork.outputSchema).toBeDefined()
    expect(midFork.outputSchema).toBeDefined()
    expect(JSON.stringify(fresh.outputSchema)).toContain('independent-alternative')
    expect(JSON.stringify(fork.outputSchema)).toContain('trajectory-audit')
    expect(JSON.stringify(midFork.outputSchema)).toContain('masked-review')
    expect(JSON.stringify(midFork.outputSchema)).toContain('possible_error')
    expect(JSON.stringify(midFork.outputSchema)).toContain('certainty')
    expect(JSON.stringify(midFork.outputSchema)).toContain('no_update')
    expect(JSON.stringify(midFork.outputSchema)).not.toContain('traceDelta')

    const freshPrompt = fresh.prompt[0]
    const forkPrompt = fork.prompt[0]
    const midForkPrompt = midFork.prompt[0]
    const freshPromptText = freshPrompt?.type === 'text' ? freshPrompt.text : ''
    const forkPromptText = forkPrompt?.type === 'text' ? forkPrompt.text : ''
    const midForkPromptText = midForkPrompt?.type === 'text' ? midForkPrompt.text : ''
    expect(freshPromptText).toContain('Primary incumbent is deliberately omitted')
    expect(freshPromptText).not.toContain('Patch the parser first')
    expect(freshPromptText).not.toContain('independent-search')
    expect(freshPromptText).toContain('Supplied observations')
    expect(freshPromptText).toContain('The parser fails only after an acknowledgement timeout.')
    expect(freshPromptText).toContain('You receive only this Primary-authored projection')
    expect(freshPromptText).toContain('reason-only: Use no inherited model-facing tools.')
    expect(freshPromptText).toContain('Do not manufacture novelty')
    expect(freshPromptText).not.toContain('observable completed trajectory and incumbent')
    expect(forkPromptText).not.toContain('Branch label:')
    expect(forkPromptText).toContain('Patch the parser first')
    expect(forkPromptText).toContain('do not assume an error exists')
    expect(forkPromptText).toContain('performed observations as observations')
    expect(forkPromptText).toContain('You inherit completed Primary turns')
    expect(forkPromptText).toContain('private filesystem workspace')
    expect(midForkPromptText).toContain('Primary incumbent is deliberately omitted')
    expect(midForkPromptText).not.toContain('Patch the parser first')
    expect(midForkPromptText).toContain('balanced Primary prefix')
    expect(midForkPromptText).toContain('do not reconstruct omitted actor content')
    expect(midForkPromptText).toContain('Image evidence #N')
    expect(midForkPromptText).toContain('use unknown rather than inventing unreadable details')
    expect(midForkPromptText).toContain('2 complete prior Primary Steps selected from the requested 2')
    expect(midForkPromptText).toContain('Return only the JSON required by the output schema')

    const structured = value(result)
    expect(structured.branches.map(branch => branch.label)).toEqual(['independent-search', 'trajectory-audit', 'masked-review'])
    expect(structured.branches.every(branch => typeof branch.runId === 'string')).toBe(true)
    expect(structured.branches[2]?.runId).toBe('mid-fork-step-2-child-1')
    expect(structured.branches).toMatchObject([
      { role: 'independent-alternative', history: 'fresh', route: 'strong', capability: 'reason-only', stopReason: 'completed', cleanup: 'completed' },
      { role: 'trajectory-audit', history: 'fork', route: 'same', capability: 'evidence-only', stopReason: 'completed', cleanup: 'completed' },
      {
        role: 'masked-review',
        history: 'mid-fork',
        route: 'same',
        capability: 'reason-only',
        historyWindow: { kind: 'recent-steps', requestedSteps: 2, projectedSteps: 2 },
        stopReason: 'completed',
        cleanup: 'completed',
      },
    ])
    const modelFacing = JSON.parse(text(result)) as { branches: Array<Record<string, unknown>> }
    expect(modelFacing.branches).toMatchObject([
      { label: 'independent-search', role: 'independent-alternative', stopReason: 'completed' },
      { label: 'trajectory-audit', role: 'trajectory-audit', stopReason: 'completed' },
      { label: 'masked-review', role: 'masked-review', stopReason: 'completed' },
    ])
    expect(text(result)).toContain('"kind":"possible_error"')
    expect(text(result)).toContain('"certainty":"uncertain"')
    expect(text(result)).not.toContain('"runId"')
    expect(text(result)).not.toContain('"history"')
    expect(text(result)).not.toContain('Primary incumbent')
    expect(text(result)).not.toContain('RAW_CHILD_TRANSCRIPT_MUST_NOT_ENTER_PRIMARY')
  })

  it('forces one runtime-owned masked review at the Primary stopping boundary', async () => {
    const ctx = await bareContext()
    const freshRequests: ResolvedSubagentStartRequest[] = []
    const forkRequests: ResolvedSubagentStartRequest[] = []
    const midForkRequests: ResolvedSubagentStartRequest[] = []
    ctx.subagents.registerProvider(provider('fresh', false, freshRequests, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    })))
    ctx.subagents.registerProvider(provider('fork', true, forkRequests, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    })))
    registerAutoMidFork(ctx, midForkRequests, request => ({
      output: [{ type: 'text', text: 'RAW_AUTOMATIC_CHILD_TRANSCRIPT' }],
      stopReason: 'completed',
      structured: maskedInsight('The observable trace needs one more check.'),
    }))
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'all-primary-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })
    const { agent, steered } = stoppingParent()
    appendStoppingStep(agent, 1)

    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })

    expect(freshRequests).toHaveLength(0)
    expect(forkRequests).toHaveLength(0)
    expect(midForkRequests).toHaveLength(1)
    expect(midForkRequests[0]).toMatchObject({
      parent: agent,
      maxDepth: 1,
      toolFilter: { allow: [], deny: ['deliberate'] },
    })
    expect(JSON.stringify(midForkRequests[0]?.outputSchema)).toContain('masked-review')
    const automaticPrompt = midForkRequests[0]?.prompt[0]
    const automaticPromptText = automaticPrompt?.type === 'text' ? automaticPrompt.text : ''
    expect(automaticPromptText).toContain('Image evidence #N')
    expect(automaticPromptText).toContain('use unknown rather than inventing unreadable details')
    expect(automaticPromptText).toContain('A restatement of a tool result, a successful command, a visible Primary conclusion')
    expect(automaticPromptText).toContain('{"role":"masked-review","status":"no_update"}')
    expect(automaticPromptText).toContain('a concrete next check that could change continuation')
    expect(steered).toHaveLength(1)
    const injected = steered[0]!
    expect(injected.source).toMatchObject({
      kind: 'plugin', plugin: 'tool-deliberation', form: 'notice',
    })
    const injectedText = injected.content[0]?.type === 'text' ? injected.content[0].text : ''
    expect(JSON.parse(injectedText)).toEqual(maskedInsight('The observable trace needs one more check.'))
    expect(injectedText).not.toContain('runId')
    expect(injectedText).not.toContain('turn')
    expect(injectedText).not.toContain('RAW_AUTOMATIC_CHILD_TRANSCRIPT')

    // The in-process attempt latch prevents a second child before the durable
    // steering message is admitted by AgentLoop as the next Step.
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(midForkRequests).toHaveLength(1)
  })

  it('publishes an exact textual masked-review packet when the child skips structured_output', async () => {
    const ctx = await bareContext()
    const requests: ResolvedSubagentStartRequest[] = []
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    const packet = maskedInsight('The exact final text contains a usable review delta.')
    ctx.subagents.registerProvider(provider(
      'mid-fork-current-turn', true, requests, () => ({
        output: [
          { type: 'reasoning', text: 'private child reasoning' },
          { type: 'text', text: JSON.stringify(packet) },
        ],
        // DSH's in-process structured driver uses `error` when the child
        // completes without calling structured_output.
        stopReason: 'error',
      }),
      completedChildAgent('text-fallback-auto-child'),
    ))
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'all-primary-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })
    const { agent, steered } = stoppingParent('text-fallback-parent')
    appendStoppingStep(agent, 1)

    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })

    expect(requests).toHaveLength(1)
    expect(steered).toHaveLength(1)
    const notice = steered[0]!
    expect(notice.source).toMatchObject({ kind: 'plugin', plugin: 'tool-deliberation', form: 'notice' })
    const noticeText = notice.content[0]?.type === 'text' ? notice.content[0].text : ''
    expect(JSON.parse(noticeText)).toEqual(packet)
  })

  it('clamps a Primary-selected Step window to completed history and skips an empty history safely', async () => {
    const { ctx, midForkRequests } = await setup()
    const parent = parentAgent()
    appendCompletedPrimaryTurns(parent, 2)
    const branch = {
      label: 'bounded-mask',
      role: 'masked-review' as const,
      route: 'same',
      capability: 'reason-only',
      recentSteps: 4,
      focus: 'Review every completed decision currently available.',
    }
    const result = await execute(ctx, {
      goal: 'Check the recent trajectory.',
      incumbent: 'Continue.',
      context: BASE_CONTEXT,
      branches: [branch],
    }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(midForkRequests).toHaveLength(1)
    expect(value(result).branches[0]).toMatchObject({
      runId: 'mid-fork-step-2-child-1',
      historyWindow: { kind: 'recent-steps', requestedSteps: 4, projectedSteps: 2 },
      stopReason: 'completed',
    })
    expect(midForkRequests[0]?.prompt[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('2 complete prior Primary Steps selected from the requested 4'),
    })

    const emptyParent = parentAgent()
    const emptyResult = await execute(ctx, {
      goal: 'Check the recent trajectory.',
      incumbent: 'Continue.',
      context: BASE_CONTEXT,
      branches: [{ ...branch, label: 'empty-mask', recentSteps: 2 }],
    }, { agent: emptyParent })
    expect(emptyResult.isError).toBe(false)
    expect(midForkRequests).toHaveLength(1)
    expect(value(emptyResult).branches[0]).toMatchObject({
      historyWindow: { kind: 'recent-steps', requestedSteps: 2, projectedSteps: 0 },
      stopReason: 'no-completed-step',
      cleanup: 'not-started',
    })
  })

  it('refuses an image-bearing fork on a text-only child route before provider start', async () => {
    const ctx = await bareContext()
    await ctx.plugin(LlmRuntime)
    const resolveModelInfo = vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({
      provider: 'fixture-provider',
      id: 'fixture-model',
      name: 'Fixture text model',
      inputModalities: ['text'],
    })
    const freshRequests: ResolvedSubagentStartRequest[] = []
    const forkRequests: ResolvedSubagentStartRequest[] = []
    ctx.subagents.registerProvider(provider('fresh', false, freshRequests, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    })))
    ctx.subagents.registerProvider(provider('fork', true, forkRequests, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    })))
    registerMidForkFamily(ctx)
    await ctx.plugin(deliberation, BASE_CONFIG)

    const parent = parentAgent()
    parent.session.append('turn/start', { turn: 1 })
    parent.session.append('step/start', { turn: 1, step: 1 })
    parent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Inspect this evidence.' }, imageBlock('fork-image')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.session.append('step/end', { turn: 1, step: 1 })
    parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const result = await execute(ctx, {
      goal: 'Audit the completed visual trajectory.',
      incumbent: 'Continue.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'visual-audit',
        role: 'trajectory-audit',
        route: 'same',
        capability: 'reason-only',
        focus: 'Check whether the visual evidence supports the continuation.',
      }],
    }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(resolveModelInfo).toHaveBeenCalledWith('fixture-provider', 'fixture-model', expect.any(AbortSignal))
    expect(forkRequests).toHaveLength(0)
    expect(value(result).branches[0]).toMatchObject({
      stopReason: 'unsupported-content',
      cleanup: 'not-started',
      diagnostic: expect.stringContaining('does not support image input'),
    })
  })

  it('reports a manual masked-review image-limit refusal without creating a child', async () => {
    const ctx = await bareContext()
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(new MidForkInProcessProvider(
      'mid-fork-step-1',
      { kind: 'recent-steps', recentSteps: 1 },
      'reasoning-only',
      65_536,
      1,
      ctx,
    ))
    await ctx.plugin(deliberation, { ...BASE_CONFIG, maxRecentSteps: 1 })

    const parent = parentAgent()
    parent.session.append('turn/start', { turn: 1 })
    parent.session.append('step/start', { turn: 1, step: 1 })
    parent.session.append('user/message', createUserMessage({
      content: [imageBlock('first-image'), imageBlock('second-image')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.session.append('step/end', { turn: 1, step: 1 })
    parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const result = await execute(ctx, {
      goal: 'Review the visual decision.',
      incumbent: 'Continue.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'visual-mask',
        role: 'masked-review',
        route: 'same',
        capability: 'reason-only',
        recentSteps: 1,
        focus: 'Check the visible evidence without the prior rationale.',
      }],
    }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(value(result).branches[0]).toMatchObject({
      stopReason: 'projection-image-limit',
      cleanup: 'not-started',
      diagnostic: expect.stringContaining('configured image limit'),
    })
  })

  it('runs a no_update review without continuing the Primary under updates-only', async () => {
    const ctx = await bareContext()
    const requests: ResolvedSubagentStartRequest[] = []
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    registerAutoMidFork(ctx, requests, () => ({
      output: [], stopReason: 'completed', structured: { role: 'masked-review', status: 'no_update' },
    }))
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'all-primary-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })
    const subject = stoppingParent('no-update-parent')
    appendStoppingStep(subject.agent, 1)

    await agentEvents(ctx, subject.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })

    expect(requests).toHaveLength(1)
    expect(subject.steered).toHaveLength(0)
    expect(subject.agent.session.events.some(event =>
      event.type === 'user/message' && event.data.source.kind === 'plugin')).toBe(false)

    // The live-process latch still prevents another child at the same stopping boundary.
    await agentEvents(ctx, subject.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(requests).toHaveLength(1)
  })

  it('mounts the automatic hook only while its configured provider is ready', async () => {
    const ctx = await bareContext()
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    registerMidForkFamily(ctx)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => warnings.push(String(message))) as typeof ctx.logger.warn
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'all-primary-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })
    const requests: ResolvedSubagentStartRequest[] = []
    const first = stoppingParent('auto-provider-late')
    appendStoppingStep(first.agent, 1)

    await agentEvents(ctx, first.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    await agentEvents(ctx, first.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(requests).toHaveLength(0)
    expect(warnings.join('\n')).not.toContain('provider "mid-fork-current-turn" is unavailable')

    const disposeIncompatible = ctx.subagents.registerProvider(provider(
      'mid-fork-current-turn', false, requests,
      request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    await agentEvents(ctx, first.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(requests).toHaveLength(0)
    expect(warnings.filter(message => message.includes('does not inherit parent context'))).toHaveLength(1)
    disposeIncompatible()

    const disposeProvider = registerAutoMidFork(ctx, requests)
    await agentEvents(ctx, first.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(requests).toHaveLength(1)

    disposeProvider()
    const absentAgain = stoppingParent('auto-provider-removed')
    appendStoppingStep(absentAgain.agent, 1)
    await agentEvents(ctx, absentAgain.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(requests).toHaveLength(1)

    registerAutoMidFork(ctx, requests)
    const restored = stoppingParent('auto-provider-restored')
    appendStoppingStep(restored.agent, 1)
    await agentEvents(ctx, restored.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(requests).toHaveLength(2)
  })

  it('does not consume the stopping boundary on projection or image preflight skips', async () => {
    const ctx = await bareContext()
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    registerMidForkFamily(ctx)
    const accepted: ResolvedSubagentStartRequest[] = []
    const ordinary = provider('mid-fork-current-turn', true, accepted, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    }))
    let starts = 0
    ctx.subagents.registerProvider({
      ...ordinary,
      async start(request) {
        starts += 1
        if (starts === 1) {
          throw new MidForkProjectionError('PROJECTION_OVER_BUDGET', {
            window: 'current-turn',
            mask: 'reasoning-only',
            turn: 1,
            projectedSteps: 1,
            snapshotChars: 70_000,
            maxSnapshotChars: 65_536,
          })
        }
        if (starts === 2) {
          throw new UnsupportedChildImageInputError('IMAGE_INPUT_UNSUPPORTED', {
            images: 1,
            imageBytes: 1_024,
            assistantSeedImages: 0,
          })
        }
        return ordinary.start(request)
      },
    })
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'all-primary-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })
    const subject = stoppingParent('retryable-preflight-skip')
    appendStoppingStep(subject.agent, 1)

    await agentEvents(ctx, subject.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    await agentEvents(ctx, subject.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    await agentEvents(ctx, subject.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })

    expect(starts).toBe(3)
    expect(accepted).toHaveLength(1)
    expect(subject.steered).toHaveLength(1)
  })

  it('supports all and observe-only as explicit evaluation publication modes', async () => {
    for (const [publish, packet, expectedSteers] of [
      ['all', { role: 'masked-review', status: 'no_update' }, 1],
      ['observe-only', maskedInsight('Shadow-only decision delta.'), 0],
    ] as const) {
      const ctx = await bareContext()
      const requests: ResolvedSubagentStartRequest[] = []
      ctx.subagents.registerProvider(provider(
        'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
      ))
      ctx.subagents.registerProvider(provider(
        'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
      ))
      registerAutoMidFork(ctx, requests, () => ({ output: [], stopReason: 'completed', structured: packet }))
      await ctx.plugin(deliberation, {
        ...BASE_CONFIG,
        autoReview: {
          enabled: true,
          scope: 'all-primary-turns',
          provider: 'mid-fork-current-turn',
          route: 'same',
          capability: 'reason-only',
          publish,
          timeoutMs: 10_000,
        },
      })
      const subject = stoppingParent(`publication-${publish}`)
      appendStoppingStep(subject.agent, 1)

      await agentEvents(ctx, subject.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })

      expect(requests).toHaveLength(1)
      expect(subject.steered).toHaveLength(expectedSteers)
      if (publish === 'all') {
        const content = subject.steered[0]?.content[0]
        expect(content?.type === 'text' ? JSON.parse(content.text) : undefined).toEqual(packet)
      } else {
        expect(subject.agent.session.events.some(event =>
          event.type === 'user/message' && event.data.source.kind === 'plugin')).toBe(false)
      }
    }
  })

  it('applies tool-bearing scope and suppresses only real manual or durable masked reviews', async () => {
    const ctx = await bareContext()
    const midForkRequests: ResolvedSubagentStartRequest[] = []
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    registerAutoMidFork(ctx, midForkRequests)
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'tool-bearing-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })

    const noTool = stoppingParent('scope-no-tool')
    appendStoppingStep(noTool.agent, 1)
    await agentEvents(ctx, noTool.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(midForkRequests).toHaveLength(0)

    const withTool = stoppingParent('scope-with-tool')
    appendStoppingStep(withTool.agent, 1, true)
    await agentEvents(ctx, withTool.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(midForkRequests).toHaveLength(1)
    expect(withTool.steered).toHaveLength(1)

    const falseAnchor = stoppingParent('manual-false-anchor')
    appendStoppingStep(falseAnchor.agent, 1)
    appendDeliberateCall(falseAnchor.agent, 1, 'independent-alternative', 'Compare masked-review semantics.')
    await agentEvents(ctx, falseAnchor.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(midForkRequests).toHaveLength(2)

    const manualMasked = stoppingParent('manual-masked')
    appendStoppingStep(manualMasked.agent, 1)
    appendDeliberateCall(manualMasked.agent, 1, 'masked-review')
    await agentEvents(ctx, manualMasked.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(midForkRequests).toHaveLength(2)

    const durable = stoppingParent('durable-marker')
    appendStoppingStep(durable.agent, 1, true)
    durable.agent.session.append('step/start', { turn: 1, step: 2 })
    durable.agent.session.append('user/message', withTool.steered[0]!, { surfaceOp: 'append' })
    durable.agent.session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Assimilated the checkpoint.' }],
        source: { provider: 'fixture-provider', model: 'fixture-model' },
      }),
    }, { surfaceOp: 'append' })
    durable.agent.session.append('step/end', { turn: 1, step: 2 })
    await agentEvents(ctx, durable.agent).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(midForkRequests).toHaveLength(2)
  })

  it('contains malformed packets and steering failures at the lifecycle boundary', async () => {
    for (const mode of ['malformed', 'steer-throws'] as const) {
      const ctx = await bareContext()
      const requests: ResolvedSubagentStartRequest[] = []
      ctx.subagents.registerProvider(provider(
        'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
      ))
      ctx.subagents.registerProvider(provider(
        'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
      ))
      registerAutoMidFork(ctx, requests, request => ({
        output: [],
        stopReason: 'completed',
        structured: mode === 'malformed' ? { role: 'masked-review', status: 'update' } : insightFor(request),
      }))
      const warnings: string[] = []
      ctx.logger.warn = ((message: unknown) => warnings.push(String(message))) as typeof ctx.logger.warn
      await ctx.plugin(deliberation, {
        ...BASE_CONFIG,
        autoReview: {
          enabled: true,
          scope: 'all-primary-turns',
          provider: 'mid-fork-current-turn',
          route: 'same',
          capability: 'reason-only',
          timeoutMs: 10_000,
        },
      })
      const subject = stoppingParent(`contained-${mode}`)
      appendStoppingStep(subject.agent, 1)
      if (mode === 'steer-throws') {
        subject.agent.steer = (() => { throw new Error('private steering failure') }) as Agent['steer']
      }

      await expect(agentEvents(ctx, subject.agent).serial(
        'agent/turn-stopping', { turn: 1, signal: SIGNAL },
      )).resolves.toBeUndefined()
      expect(requests).toHaveLength(1)
      expect(warnings.join('\n')).not.toContain('private steering failure')
      if (mode === 'malformed') {
        expect(subject.steered).toHaveLength(0)
        expect(warnings.join('\n')).toContain('no valid structured packet')
      } else {
        expect(warnings.join('\n')).toContain('contained an unexpected internal failure')
      }
    }
  })

  it('contains automatic-review failure and never recurses into a child session', async () => {
    const ctx = await bareContext()
    const freshRequests: ResolvedSubagentStartRequest[] = []
    const forkRequests: ResolvedSubagentStartRequest[] = []
    const midForkRequests: ResolvedSubagentStartRequest[] = []
    ctx.subagents.registerProvider(provider('fresh', false, freshRequests, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    })))
    ctx.subagents.registerProvider(provider('fork', true, forkRequests, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    })))
    registerAutoMidFork(ctx, midForkRequests, () => Promise.reject(new Error('private provider payload')))
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => warnings.push(String(message))) as typeof ctx.logger.warn
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'all-primary-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })
    const { agent, steered } = stoppingParent('failing-auto-parent')
    appendStoppingStep(agent, 1)

    await expect(agentEvents(ctx, agent).serial(
      'agent/turn-stopping', { turn: 1, signal: SIGNAL },
    )).resolves.toBeUndefined()
    expect(midForkRequests).toHaveLength(1)
    expect(steered).toHaveLength(0)
    expect(warnings.join('\n')).toContain('automatic review result rejected')
    expect(warnings.join('\n')).not.toContain('private provider payload')

    const child = {
      id: SessionId('masked-child'),
      session: { header: { origin: 'subagent' }, events: [] },
    } as unknown as Agent
    await agentEvents(ctx, child).serial('agent/turn-stopping', { turn: 1, signal: SIGNAL })
    expect(midForkRequests).toHaveLength(1)
  })

  it('reports a bounded current-turn projection skip without starting or steering a child', async () => {
    const ctx = await bareContext()
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    ctx.subagents.registerProvider({
      ...provider('mid-fork-current-turn', true, [], () => ({ output: [], stopReason: 'completed' })),
      start: () => Promise.reject(new MidForkProjectionError('PROJECTION_OVER_BUDGET', {
        window: 'current-turn',
        mask: 'reasoning-only',
        turn: 4,
        snapshotChars: 70_000,
        maxSnapshotChars: 65_536,
      })),
    })
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => warnings.push(String(message))) as typeof ctx.logger.warn
    await ctx.plugin(deliberation, {
      ...BASE_CONFIG,
      autoReview: {
        enabled: true,
        scope: 'all-primary-turns',
        provider: 'mid-fork-current-turn',
        route: 'same',
        capability: 'reason-only',
        timeoutMs: 10_000,
      },
    })
    const subject = stoppingParent('projection-budget-parent')
    appendStoppingStep(subject.agent, 4)

    await agentEvents(ctx, subject.agent).serial('agent/turn-stopping', { turn: 4, signal: SIGNAL })

    expect(subject.steered).toHaveLength(0)
    expect(warnings.join('\n')).toContain('reason=projection-over-budget')
    expect(warnings.join('\n')).toContain('parentSessionId=projection-budget-parent')
    expect(warnings.join('\n')).toContain('turn=4')
    expect(warnings.join('\n')).toContain('snapshotChars=70000')
    expect(warnings.join('\n')).toContain('maxSnapshotChars=65536')
  })

  it('renders a compact decision packet while retaining the complete structured value', async () => {
    const { ctx } = await setup(() => ({
      output: [],
      stopReason: 'completed',
      structured: {
        role: 'trajectory-audit',
        status: 'update',
        items: [
          {
            kind: 'observation',
            certainty: 'certain',
            content: 'The observable acknowledgement is absent.',
          },
          {
            kind: 'possible_error',
            certainty: 'likely',
            content: 'The retry decision may rely on an unsupported acknowledgement assumption.',
          },
          {
            kind: 'unknown',
            certainty: 'uncertain',
            content: 'It is unknown whether the retry was persisted.',
          },
          {
            kind: 'suggestion',
            certainty: 'likely',
            content: 'Read the persisted acknowledgement state before mutation.',
          },
        ],
      },
      diagnostic: 'safe completed-run diagnostic',
    }))
    const result = await execute(ctx, {
      goal: 'Choose whether to continue.',
      incumbent: 'Continue.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'invariant-check', role: 'trajectory-audit', route: 'same',
        capability: 'reason-only', focus: 'Check the acknowledgement invariant.',
      }],
    })

    const rendered = text(result)
    expect(JSON.parse(rendered)).toEqual({
      branches: [{
        label: 'invariant-check',
        role: 'trajectory-audit',
        stopReason: 'completed',
        packet: {
          role: 'trajectory-audit',
          status: 'update',
          items: [
            { kind: 'observation', certainty: 'certain', content: 'The observable acknowledgement is absent.' },
            { kind: 'possible_error', certainty: 'likely', content: 'The retry decision may rely on an unsupported acknowledgement assumption.' },
            { kind: 'unknown', certainty: 'uncertain', content: 'It is unknown whether the retry was persisted.' },
            { kind: 'suggestion', certainty: 'likely', content: 'Read the persisted acknowledgement state before mutation.' },
          ],
        },
      }],
    })
    expect(rendered).not.toContain('fork-child-1')
    expect(rendered).not.toContain('safe completed-run diagnostic')
    expect(value(result).branches[0]).toMatchObject({
      runId: 'fork-child-1',
      diagnostic: 'safe completed-run diagnostic',
      packet: { role: 'trajectory-audit', status: 'update' },
    })
  })

  it('rejects a structured result whose role does not match the requested branch', async () => {
    const { ctx } = await setup(() => ({
      output: [],
      stopReason: 'completed',
      structured: auditInsight('Wrong role contract.'),
    }))
    const result = await execute(ctx, {
      goal: 'Find an independent alternative.',
      incumbent: 'Candidate A.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'alternative', role: 'independent-alternative', route: 'same',
        capability: 'reason-only', focus: 'Construct candidate B.',
      }],
    })

    expect(result.isError).toBe(false)
    expect(value(result).branches[0]).toMatchObject({
      role: 'independent-alternative',
      stopReason: 'invalid-structured-result',
    })
    expect(value(result).branches[0]).not.toHaveProperty('packet')
    expect(text(result)).not.toContain('Wrong role contract.')
  })

  it('accepts an exact textual packet for a manual branch when structured_output is absent', async () => {
    const packet = maskedInsight('Manual masked review recovered from final text.')
    const { ctx } = await setup(() => ({
      output: [
        { type: 'reasoning', text: 'private child reasoning' },
        { type: 'text', text: JSON.stringify(packet) },
      ],
      stopReason: 'error',
    }), completedChildAgent('text-fallback-manual-child'))
    const parent = parentAgent()
    appendCompletedPrimaryTurns(parent, 1)
    const result = await execute(ctx, {
      goal: 'Re-read the completed action.',
      incumbent: 'Continue the current path.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'text-fallback',
        role: 'masked-review',
        route: 'same',
        capability: 'reason-only',
        recentSteps: 1,
        focus: 'Review the completed action without its actor reasoning.',
      }],
    }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(value(result).branches[0]).toMatchObject({
      label: 'text-fallback',
      role: 'masked-review',
      stopReason: 'completed',
      packet,
    })
  })

  it.each(['error', 'aborted'] as const)(
    'does not publish a structured packet from a manual branch with stopReason=%s',
    async (stopReason) => {
      const packet = maskedInsight(`Partial packet from ${stopReason}.`)
      const { ctx } = await setup(() => ({
        output: [],
        stopReason,
        structured: packet,
      }), completedChildAgent(`structured-${stopReason}-manual-child`))
      const parent = parentAgent()
      appendCompletedPrimaryTurns(parent, 1)
      const result = await execute(ctx, {
        goal: 'Reject partial child output.',
        incumbent: 'Continue only from a completed review.',
        context: BASE_CONTEXT,
        branches: [{
          label: `structured-${stopReason}`,
          role: 'masked-review',
          route: 'same',
          capability: 'reason-only',
          recentSteps: 1,
          focus: 'Return a packet but fail the branch lifecycle.',
        }],
      }, { agent: parent })

      expect(result.isError).toBe(false)
      expect(value(result).branches[0]).toMatchObject({
        label: `structured-${stopReason}`,
        stopReason,
      })
      expect(value(result).branches[0]).not.toHaveProperty('packet')
      expect(text(result)).not.toContain(`Partial packet from ${stopReason}.`)
    },
  )

  it('does not publish an exact textual packet when the errored child did not complete normally', async () => {
    const packet = maskedInsight('Untrusted packet from a genuinely failed child.')
    const { ctx } = await setup(() => ({
      output: [{ type: 'text', text: JSON.stringify(packet) }],
      stopReason: 'error',
    }))
    const parent = parentAgent()
    appendCompletedPrimaryTurns(parent, 1)
    const result = await execute(ctx, {
      goal: 'Reject a failed textual fallback.',
      incumbent: 'Continue only from a completed review.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'failed-text-fallback',
        role: 'masked-review',
        route: 'same',
        capability: 'reason-only',
        recentSteps: 1,
        focus: 'Emit exact JSON without completing the child turn.',
      }],
    }, { agent: parent })

    expect(result.isError).toBe(false)
    expect(value(result).branches[0]).toMatchObject({
      label: 'failed-text-fallback',
      stopReason: 'error',
    })
    expect(value(result).branches[0]).not.toHaveProperty('packet')
    expect(text(result)).not.toContain('Untrusted packet from a genuinely failed child.')
  })

  it('starts sibling branches concurrently before waiting for either result', async () => {
    let arrivals = 0
    const bothStarted = Promise.withResolvers<undefined>()
    const { ctx } = await setup(async (request) => {
      arrivals += 1
      if (arrivals === 2) bothStarted.resolve(undefined)
      await bothStarted.promise
      return { output: [], stopReason: 'completed', structured: insightFor(request) }
    })
    const result = await execute(ctx, {
      goal: 'Compare two live candidates.',
      incumbent: 'Candidate A.',
      context: BASE_CONTEXT,
      branches: [
        { label: 'fresh', role: 'independent-alternative', route: 'same', capability: 'reason-only', focus: 'Find B.' },
        { label: 'fork', role: 'trajectory-audit', route: 'same', capability: 'reason-only', focus: 'Audit A.' },
      ],
    })
    expect(result.isError).toBe(false)
    expect(arrivals).toBe(2)
  })

  it('keeps successful siblings when another branch fails before publication', async () => {
    const ctx = await bareContext()
    const requests: ResolvedSubagentStartRequest[] = []
    ctx.subagents.registerProvider(provider('fresh', false, requests, request => ({
      output: [], stopReason: 'completed', structured: insightFor(request),
    })))
    ctx.subagents.registerProvider({
      ...provider('fork', true, [], () => ({ output: [], stopReason: 'completed' })),
      start: () => Promise.reject(new Error('secret provider payload must stay in logs')),
    })
    registerMidForkFamily(ctx)
    await ctx.plugin(deliberation, BASE_CONFIG)

    const result = await execute(ctx, {
      goal: 'Check a candidate.',
      incumbent: 'Candidate A.',
      context: BASE_CONTEXT,
      branches: [
        { label: 'survivor', role: 'independent-alternative', route: 'same', capability: 'reason-only', focus: 'Find B.' },
        { label: 'broken', role: 'trajectory-audit', route: 'same', capability: 'reason-only', focus: 'Audit A.' },
      ],
    })

    expect(result.isError).toBe(false)
    expect(value(result)).toMatchObject({ branches: [
      { label: 'survivor', stopReason: 'completed', cleanup: 'completed' },
      { label: 'broken', stopReason: 'startup-error', cleanup: 'not-started' },
    ] })
    expect(text(result)).not.toContain('secret provider payload')
  })

  it('times out branches independently, preserves successful siblings, and cleans published runs', async () => {
    const ctx = await bareContext()
    let disposedRuns = 0
    ctx.subagents.registerProvider({
      name: 'fresh',
      inheritsParentContext: false,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      async start(request) {
        const label = request.label ?? 'unknown'
        if (label.includes('startup-timeout')) {
          return new Promise<never>((_resolve, reject) => {
            const rejectAfterCleanup = () => { reject(new Error('private startup timeout payload')) }
            if (request.signal.aborted) rejectAfterCleanup()
            else request.signal.addEventListener('abort', rejectAfterCleanup, { once: true })
          })
        }
        return {
          id: SessionId(`fresh-${label}`),
          localAgent: undefined,
          result: new Promise<SubagentResult>((resolve) => {
            const settleAborted = () => {
              const packet = insightFor(request)
              resolve({
                output: [{ type: 'text', text: JSON.stringify(packet) }],
                stopReason: 'aborted',
                structured: packet,
                diagnostic: 'private running timeout payload',
              })
            }
            if (request.signal.aborted) settleAborted()
            else request.signal.addEventListener('abort', settleAborted, { once: true })
          }),
          dispose: () => {
            disposedRuns += 1
            return Promise.resolve()
          },
        }
      },
    })
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({
        output: [], stopReason: 'completed', structured: insightFor(request),
      }),
    ))
    registerMidForkFamily(ctx)
    await ctx.plugin(deliberation, { ...BASE_CONFIG, branchTimeoutMs: 50 })

    const result = await execute(ctx, {
      goal: 'Keep useful work while bounding slow branches.',
      incumbent: 'Wait for every branch forever.',
      context: BASE_CONTEXT,
      branches: [
        {
          label: 'startup-timeout', role: 'independent-alternative', route: 'same',
          capability: 'reason-only', focus: 'Hang before publication.',
        },
        {
          label: 'running-timeout', role: 'independent-alternative', route: 'same',
          capability: 'reason-only', focus: 'Hang after publication.',
        },
        {
          label: 'survivor', role: 'trajectory-audit', route: 'same',
          capability: 'reason-only', focus: 'Return useful evidence immediately.',
        },
      ],
    })

    expect(result.isError).toBe(false)
    expect(value(result)).toMatchObject({ branches: [
      { label: 'startup-timeout', stopReason: 'timeout', cleanup: 'not-started' },
      { label: 'running-timeout', stopReason: 'timeout', cleanup: 'completed' },
      { label: 'survivor', stopReason: 'completed', cleanup: 'completed' },
    ] })
    expect(disposedRuns).toBe(1)
    expect(value(result).branches[1]).not.toHaveProperty('packet')
    expect(text(result)).not.toContain('private startup timeout payload')
    expect(text(result)).not.toContain('private running timeout payload')
  })

  it('rejects malformed rounds and calls without a Primary Agent', async () => {
    const { ctx, freshRequests, forkRequests, midForkRequests } = await setup()
    const base = {
      goal: 'Choose.',
      incumbent: 'A.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'one', role: 'independent-alternative', route: 'same', capability: 'reason-only',
        focus: 'Find B.',
      }],
    }
    expect((await execute(ctx, base, { agent: undefined })).isError).toBe(true)
    expect(text(await execute(ctx, { ...base, goal: ' ' }))).toContain('goal must be non-empty')
    expect(text(await execute(ctx, { ...base, incumbent: '' }))).toContain('incumbent must be non-empty')
    expect(text(await execute(ctx, {
      ...base,
      context: { ...BASE_CONTEXT, observations: [''] },
    }))).toContain('context.observations[0] must be non-empty')
    expect(text(await execute(ctx, { ...base, branches: [] }))).toContain('requires 1 through 4 branches')
    expect(text(await execute(ctx, {
      ...base,
      branches: Array.from({ length: 5 }, (_, index) => ({
        ...base.branches[0], label: `branch-${index}`,
      })),
    }))).toContain('requires 1 through 4 branches')
    expect(text(await execute(ctx, {
      ...base,
      branches: [{ ...base.branches[0], label: ' ' }],
    }))).toContain('branch.label must be non-empty')
    expect(text(await execute(ctx, {
      ...base,
      branches: [{ ...base.branches[0], focus: '' }],
    }))).toContain('focus must be non-empty')
    expect(text(await execute(ctx, {
      ...base,
      branches: [base.branches[0], base.branches[0]],
    }))).toContain('unique branch labels')
    for (const branches of [
      [{
        label: 'missing-window', role: 'masked-review', route: 'same', capability: 'reason-only',
        focus: 'Review recent behavior.',
      }],
      [{
        label: 'oversized-window', role: 'masked-review', route: 'same', capability: 'reason-only',
        recentSteps: 5, focus: 'Review recent behavior.',
      }],
      [{ ...base.branches[0], recentSteps: 1 }],
    ]) {
      expect((await execute(ctx, { ...base, branches })).isError).toBe(true)
    }
    expect(freshRequests).toHaveLength(0)
    expect(forkRequests).toHaveLength(0)
    expect(midForkRequests).toHaveLength(0)
  })

  it('tracks provider lifecycle without leaving a stale tool or policy', async () => {
    const ctx = await bareContext()
    await ctx.plugin(deliberation, BASE_CONFIG)
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(false)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Use deliberate when a live semantic fork')

    const freshRequests: ResolvedSubagentStartRequest[] = []
    const forkRequests: ResolvedSubagentStartRequest[] = []
    const disposeFresh = ctx.subagents.registerProvider(provider(
      'fresh', false, freshRequests,
      request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(false)
    disposeFresh()
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(false)
    const disposeFreshReplacement = ctx.subagents.registerProvider(provider(
      'fresh', false, freshRequests,
      request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    const disposeFork = ctx.subagents.registerProvider(provider(
      'fork', true, forkRequests,
      request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(false)
    const disposeMidFork = registerMidForkFamily(ctx)
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(true)
    const unrelated = ctx.subagents.registerProvider(provider(
      'unrelated', false, [], () => ({ output: [], stopReason: 'completed' }),
    ))
    unrelated()
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(true)

    disposeFork()
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(false)
    expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Use deliberate when a live semantic fork')
    ctx.subagents.registerProvider(provider(
      'fork', true, forkRequests,
      request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(true)
    disposeFreshReplacement()
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(false)
    disposeMidFork()
  })

  it('fails loud for unsafe route and provider configuration', async () => {
    const invalidConfigs: Array<[TestConfig, RegExp]> = [
      [{ ...BASE_CONFIG, freshProvider: ' ' }, /freshProvider must be non-empty/u],
      [{ ...BASE_CONFIG, forkProvider: '' }, /forkProvider must be non-empty/u],
      [{ ...BASE_CONFIG, midForkProvider: '' }, /midForkProvider must be non-empty/u],
      [{ ...BASE_CONFIG, toolName: ' ' }, /toolName must be non-empty/u],
      [{ ...BASE_CONFIG, freshProvider: 'same-provider', forkProvider: 'same-provider' }, /must be distinct/u],
      [{ ...BASE_CONFIG, forkProvider: 'same-provider-1', midForkProvider: 'same-provider' }, /must be distinct/u],
      [{ ...BASE_CONFIG, maxRecentSteps: 0 }, /maxRecentSteps must be a positive safe integer/u],
      [{ ...BASE_CONFIG, maxRecentSteps: 33 }, /maxRecentSteps must be a positive safe integer/u],
      [{ ...BASE_CONFIG, maxBranches: 0 }, /maxBranches must be a positive safe integer/u],
      [{ ...BASE_CONFIG, maxBranches: Number.MAX_SAFE_INTEGER + 1 }, /maxBranches must be a positive safe integer/u],
      [{ ...BASE_CONFIG, maxDepth: 0 }, /maxDepth must be a positive safe integer/u],
      [{ ...BASE_CONFIG, maxDepth: 1.5 }, /maxDepth must be a positive safe integer/u],
      [{ ...BASE_CONFIG, branchTimeoutMs: 0 }, /branchTimeoutMs must be a positive safe integer/u],
      [{ ...BASE_CONFIG, branchTimeoutMs: 2_147_483_648 }, /branchTimeoutMs must be a positive safe integer/u],
      [{ ...BASE_CONFIG, routes: null as never }, /routes must contain at least one/u],
      [{ ...BASE_CONFIG, routes: [] }, /routes must contain at least one/u],
      [{ ...BASE_CONFIG, routes: [{ name: '', description: 'empty name' }] }, /route.name must be non-empty/u],
      [{ ...BASE_CONFIG, routes: [{ name: 'same', description: ' ' }] }, /description must be non-empty/u],
      [{ ...BASE_CONFIG, routes: [{ name: 'Strong Model', description: 'bad name' }] }, /lower-kebab-case/u],
      [{ ...BASE_CONFIG, routes: [
        { name: 'same', description: 'first' }, { name: 'same', description: 'second' },
      ] }, /duplicate route name/u],
      [{ ...BASE_CONFIG, routes: [{ name: 'same', description: 'route', provider: '' }] }, /provider must be non-empty/u],
      [{ ...BASE_CONFIG, routes: [{ name: 'same', description: 'route', model: ' ' }] }, /model must be non-empty/u],
      [{ ...BASE_CONFIG, routes: [{ name: 'same', description: 'route', maxTokens: 0 }] }, /maxTokens must be a positive safe integer/u],
      [{
        ...BASE_CONFIG,
        routes: [{ name: 'same', description: 'route', maxTokens: Number.MAX_SAFE_INTEGER + 1 }],
      }, /maxTokens must be a positive safe integer/u],
      [{ ...BASE_CONFIG, capabilityProfiles: null as never }, /capabilityProfiles must contain at least one/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [] }, /capabilityProfiles must contain at least one/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: '', description: 'empty name', allow: [] }] }, /capabilityProfiles.name must be non-empty/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: 'reason-only', description: ' ', allow: [] }] }, /description must be non-empty/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: 'Reason Only', description: 'bad name', allow: [] }] }, /lower-kebab-case/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [
        { name: 'reason-only', description: 'first', allow: [] },
        { name: 'reason-only', description: 'second', allow: [] },
      ] }, /duplicate capability profile name/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: 'unbounded', description: 'missing filter' }] }, /must configure allow and\/or deny/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: 'bad-tool', description: 'blank tool', allow: [' '] }] }, /allow must be non-empty/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: 'duplicates', description: 'duplicate tool', deny: ['write', 'write'] }] }, /contains duplicate tool/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: 'contradiction', description: 'overlap', allow: ['read'], deny: ['read'] }] }, /both allows and denies/u],
      [{ ...BASE_CONFIG, capabilityProfiles: [{ name: 'recursive', description: 'recursion', allow: ['deliberate'] }] }, /cannot allow recursive tool/u],
      [{ ...BASE_CONFIG, autoReview: { enabled: true } }, /autoReview.provider is required when enabled/u],
      [{
        ...BASE_CONFIG,
        autoReview: { enabled: true, provider: 'mid-fork-current-turn' },
      }, /autoReview.route is required when enabled/u],
      [{
        ...BASE_CONFIG,
        autoReview: { enabled: true, provider: 'mid-fork-current-turn', route: 'same' },
      }, /autoReview.capability is required when enabled/u],
      [{
        ...BASE_CONFIG,
        autoReview: {
          enabled: true, provider: 'mid-fork-current-turn', route: 'missing', capability: 'reason-only',
        },
      }, /autoReview route "missing" is not configured/u],
      [{
        ...BASE_CONFIG,
        autoReview: {
          enabled: true, provider: 'mid-fork-current-turn', route: 'same', capability: 'missing',
        },
      }, /autoReview capability "missing" is not configured/u],
      [{
        ...BASE_CONFIG,
        autoReview: { enabled: false, publish: 'sometimes' as never },
      }, /autoReview.publish must be updates-only, all, or observe-only/u],
      [{ ...BASE_CONFIG, autoReview: { enabled: true, timeoutMs: 0 } }, /autoReview.timeoutMs must be a positive safe integer/u],
      [{ ...BASE_CONFIG, autoReview: { enabled: true, timeoutMs: 2_147_483_648 } }, /autoReview.timeoutMs must be a positive safe integer/u],
    ]
    for (const [config, pattern] of invalidConfigs) {
      const invalid = await bareContext()
      expect(() => { deliberation.apply(invalid, config) }).toThrow(pattern)
    }

    const ctx = await bareContext()
    ctx.subagents.registerProvider({
      ...provider('fresh', false, [], () => ({ output: [], stopReason: 'completed' })),
      capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    })
    ctx.subagents.registerProvider(provider(
      'fork', true, [], () => ({ output: [], stopReason: 'completed' }),
    ))
    registerMidForkFamily(ctx)
    await expect(ctx.plugin(deliberation, BASE_CONFIG)).rejects.toThrow(/lacks required outputSchema/u)
  })

  it('validates every provider history role and required capability', async () => {
    for (const [history, inherits] of [['fresh', true], ['fork', false], ['mid-fork', false]] as const) {
      const ctx = await bareContext()
      const fresh = provider('fresh', history === 'fresh' ? inherits : false, [], () => ({
        output: [], stopReason: 'completed',
      }))
      const fork = provider('fork', history === 'fork' ? inherits : true, [], () => ({
        output: [], stopReason: 'completed',
      }))
      ctx.subagents.registerProvider(fresh)
      ctx.subagents.registerProvider(fork)
      for (let recentSteps = 1; recentSteps <= (BASE_CONFIG.maxRecentSteps ?? 4); recentSteps += 1) {
        ctx.subagents.registerProvider(provider(
          recentStepProviderName('mid-fork-step', recentSteps),
          history === 'mid-fork' ? inherits : true,
          [],
          () => ({ output: [], stopReason: 'completed' }),
        ))
      }
      await expect(ctx.plugin(deliberation, BASE_CONFIG)).rejects.toThrow(/incompatible parent-history semantics/u)
    }

    for (const capability of ['outputSchema', 'depthLimit', 'toolFilter'] as const) {
      const ctx = await bareContext()
      const capabilities = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
      capabilities[capability] = false
      ctx.subagents.registerProvider({
        ...provider('fresh', false, [], () => ({ output: [], stopReason: 'completed' })),
        capabilities,
      })
      ctx.subagents.registerProvider(provider(
        'fork', true, [], () => ({ output: [], stopReason: 'completed' }),
      ))
      registerMidForkFamily(ctx)
      await expect(ctx.plugin(deliberation, BASE_CONFIG)).rejects.toThrow(new RegExp(`required ${capability}`, 'u'))
    }
  })

  it('reports result, structured-output, diagnostic, and cleanup failures independently', async () => {
    const ctx = await bareContext()
    const requests: ResolvedSubagentStartRequest[] = []
    const irregular: SubagentProvider = {
      name: 'fresh',
      inheritsParentContext: false,
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      async start(request) {
        requests.push(request)
        const label = request.label ?? 'unknown'
        let result: Promise<SubagentResult>
        if (label.includes('result-reject')) {
          result = Promise.reject(new Error('private result failure'))
        } else if (label.includes('missing')) {
          result = Promise.resolve({ output: [], stopReason: 'completed' })
        } else if (label.includes('diagnostic')) {
          result = Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'safe bounded diagnostic' })
        } else {
          result = Promise.resolve({ output: [], stopReason: 'completed', structured: alternativeInsight(label) })
        }
        return {
          id: SessionId(`irregular-${label}`),
          localAgent: undefined,
          result,
          dispose: label.includes('cleanup-reject')
            ? () => Promise.reject(new Error('private cleanup failure'))
            : () => Promise.resolve(),
        }
      },
    }
    ctx.subagents.registerProvider(irregular)
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({
        output: [], stopReason: 'completed', structured: insightFor(request),
      }),
    ))
    registerMidForkFamily(ctx)
    await ctx.plugin(deliberation, BASE_CONFIG)
    const branch = (label: string) => ({
      label, role: 'independent-alternative', route: 'same', capability: 'reason-only',
      focus: `Exercise ${label}.`,
    })
    const result = await execute(ctx, {
      goal: 'Classify independent branch outcomes.',
      incumbent: 'Continue the Primary path.',
      context: BASE_CONTEXT,
      branches: [branch('result-reject'), branch('missing'), branch('diagnostic'), branch('cleanup-reject')],
    })
    expect(result.isError).toBe(false)
    expect(value(result)).toMatchObject({ branches: [
      { label: 'result-reject', stopReason: 'infrastructure-error', cleanup: 'completed' },
      { label: 'missing', stopReason: 'missing-structured-result', cleanup: 'completed' },
      { label: 'diagnostic', stopReason: 'error', cleanup: 'completed', diagnostic: 'safe bounded diagnostic' },
      { label: 'cleanup-reject', stopReason: 'completed', cleanup: 'failed' },
    ] })
    expect(text(result)).not.toContain('private result failure')
    expect(text(result)).not.toContain('private cleanup failure')
  })

  it('turns caller cancellation into one failed deliberation result after branch cleanup', async () => {
    const ctx = await bareContext()
    const ready = Promise.withResolvers<undefined>()
    const hanging = provider('fresh', false, [], request => new Promise<SubagentResult>((resolve) => {
      ready.resolve(undefined)
      request.signal.addEventListener('abort', () => {
        resolve({ output: [], stopReason: 'aborted' })
      }, { once: true })
    }))
    ctx.subagents.registerProvider(hanging)
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
    ))
    registerMidForkFamily(ctx)
    await ctx.plugin(deliberation, BASE_CONFIG)
    const controller = new AbortController()
    const running = execute(ctx, {
      goal: 'Cancel this round.',
      incumbent: 'Wait.',
      context: BASE_CONTEXT,
      branches: [{
        label: 'hanging', role: 'independent-alternative', route: 'same', capability: 'reason-only',
        focus: 'Wait for cancellation.',
      }],
    }, { signal: controller.signal })
    await ready.promise
    controller.abort()
    const result = await running
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('deliberation aborted')
  })

  it('resolves direct-apply provider and tool defaults', async () => {
    const ctx = await bareContext()
    ctx.subagents.registerProvider(provider(
      'spawn', false, [], request => ({
        output: [], stopReason: 'completed', structured: insightFor(request),
      }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({
        output: [], stopReason: 'completed', structured: insightFor(request),
      }),
    ))
    registerMidForkFamily(
      ctx,
      [],
      request => ({ output: [], stopReason: 'completed', structured: insightFor(request) }),
      'mid-fork-step',
      8,
    )
    deliberation.apply(ctx, {
      maxBranches: 1,
      maxDepth: 1,
      routes: [{ name: 'same', description: 'Use the inherited route.' }],
      capabilityProfiles: [{ name: 'reason-only', description: 'Use no inherited tools.', allow: [] }],
    })
    expect(ctx.tools.schemas().some(schema => schema.name === 'deliberate')).toBe(true)
  })

  it('keeps a custom tool registration name aligned with its policy', async () => {
    const ctx = await bareContext()
    ctx.subagents.registerProvider(provider(
      'fresh', false, [], request => ({
        output: [], stopReason: 'completed', structured: insightFor(request),
      }),
    ))
    ctx.subagents.registerProvider(provider(
      'fork', true, [], request => ({
        output: [], stopReason: 'completed', structured: insightFor(request),
      }),
    ))
    registerMidForkFamily(ctx)
    deliberation.apply(ctx, { ...BASE_CONFIG, toolName: 'consider_paths' })
    expect(ctx.tools.schemas().some(schema => schema.name === 'consider_paths')).toBe(true)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Use consider_paths when a live semantic fork')
    expect(prompt).not.toContain('Use deliberate when a live semantic fork')
    const result = await ctx.tools.execute({
      signal: SIGNAL,
      callId: CallId('custom-deliberation-call'),
      name: 'consider_paths',
      arguments: { goal: 'Choose.', incumbent: 'A.', context: BASE_CONTEXT, branches: [] },
      agent: parentAgent(),
    })
    expect(text(result)).toContain('consider_paths requires 1 through 4 branches')
    expect(text(result)).not.toContain('deliberate requires')
  })
})
