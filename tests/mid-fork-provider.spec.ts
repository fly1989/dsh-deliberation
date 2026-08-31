import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  MidForkInProcessProvider,
  MidForkProjectionError,
  projectMidForkHistory,
  renderMidForkSnapshotContent,
} from '../src/mid-fork-provider.ts'
import * as midForkPlugin from '../src/mid-fork-provider.ts'
import {
  assertChildImageInputSupported,
  UnsupportedChildImageInputError,
} from '../src/child-image-input.ts'

function imageBlock(
  attachmentId: string,
  bytes = 1_024,
): Extract<ContentBlock, { type: 'image' }> {
  return {
    type: 'image',
    attachment: {
      attachmentId: attachmentId as never,
      mediaType: 'image/png',
      bytes,
      width: 32,
      height: 32,
    },
  }
}

function appendCompletedToolTurn(session: Session, turn: number): void {
  const callId = CallId(`call-${turn}`)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `question-${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: `private-rationale-${turn}` },
        { type: 'text', text: `visible-commitment-${turn}` },
        { type: 'tool-call', id: callId, name: 'inspect_fixture', arguments: `{"turn":${turn}}` },
      ],
      source: {
        provider: 'test-provider',
        model: 'test-model',
        replayState: { privateReplay: `replay-secret-${turn}` },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', {
    turn,
    step: 1,
    callId,
    name: 'inspect_fixture',
    arguments: `{"turn":${turn}}`,
  })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: `observable-result-${turn}` }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function recentSteps(recentSteps: number, mask: 'reasoning-only' | 'action-only' = 'reasoning-only') {
  return { window: { kind: 'recent-steps' as const, recentSteps }, mask }
}

describe('mid-fork history provider', () => {
  it('keeps an exact older prefix and removes only reasoning from the selected recent Steps', () => {
    const parent = Session.create(SessionId('mid-fork-parent'))
    appendCompletedToolTurn(parent, 1)
    appendCompletedToolTurn(parent, 2)
    appendCompletedToolTurn(parent, 3)
    const parentBefore = JSON.stringify(parent.events)

    const projection = projectMidForkHistory(
      parent.events,
      new Set(parent.surface.nodes),
      recentSteps(2),
    )

    expect(projection.projectedTurns).toBe(2)
    expect(projection.projectedSteps).toBe(2)
    expect(projection.omittedReasoningBlocks).toBe(2)
    expect(projection.projectedAssistantMessages).toBe(2)
    expect(projection.seed.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
    expect(projection.seed.some(event => event.type === 'turn/start' && event.data.turn === 2)).toBe(false)
    expect(projection.seed.map(event => event.seq)).toEqual(
      Array.from({ length: projection.seed.length }, (_, index) => index),
    )

    expect(projection.snapshot).not.toContain('question-1')
    expect(projection.snapshot).toContain('question-2')
    expect(projection.snapshot).toContain('question-3')
    expect(projection.snapshot).toContain('Decision action [callId=call-2]: inspect_fixture({"turn":2})')
    expect(projection.snapshot).toContain('Tool outcome [callId=call-2; status=success]')
    expect(projection.snapshot).toContain('observable-result-3')
    expect(projection.snapshot).toContain('visible-commitment-2')
    expect(projection.snapshot).not.toContain('private-rationale-2')
    expect(projection.snapshot).not.toContain('private-rationale-3')
    expect(projection.snapshot).not.toContain('replay-secret-2')
    expect(projection.snapshot).not.toContain('replay-secret-3')

    // The balanced seed must still be accepted by DSH as real session history.
    const child = Session.create(SessionId('mid-fork-child'), projection.seed)
    expect(child.deriveMessages().flatMap(message => message.content))
      .toContainEqual(expect.objectContaining({ type: 'text', text: 'question-1' }))
    expect(child.deriveMessages().flatMap(message => message.content))
      .not.toContainEqual(expect.objectContaining({ type: 'text', text: 'question-2' }))

    // Projection borrows the parent read-only; it is not rollback or destructive editing.
    expect(JSON.stringify(parent.events)).toBe(parentBefore)
    expect(parentBefore).toContain('private-rationale-3')
    expect(parentBefore).toContain('replay-secret-3')
  })

  it('keeps one multi-call response as one Step and correlates out-of-order outcomes by call id', () => {
    const parent = Session.create(SessionId('mid-fork-multi-call-parent'))
    const first = CallId('parallel-a')
    const second = CallId('parallel-b')
    parent.append('turn/start', { turn: 1 })
    parent.append('step/start', { turn: 1, step: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'inspect both candidates' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'private shared rationale' },
          { type: 'text', text: 'I will inspect both candidates.' },
          { type: 'tool-call', id: first, name: 'inspect', arguments: '{"candidate":"a"}' },
          { type: 'tool-call', id: second, name: 'inspect', arguments: '{"candidate":"b"}' },
        ],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    for (const [callId, candidate] of [[first, 'a'], [second, 'b']] as const) {
      parent.append('tool/call', {
        turn: 1, step: 1, callId, name: 'inspect', arguments: `{"candidate":"${candidate}"}`,
      })
    }
    // Parallel results are allowed to settle in an order different from the model response.
    for (const [callId, candidate] of [[second, 'b'], [first, 'a']] as const) {
      parent.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: `result-${candidate}` }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
    }
    parent.append('step/end', { turn: 1, step: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const projection = projectMidForkHistory(parent.events, new Set(parent.surface.nodes), recentSteps(1))
    expect(projection.snapshot.match(/Step 1 \(one complete model decision\):/gu)).toHaveLength(1)
    expect(projection.snapshot).toContain('Assistant visible content: I will inspect both candidates.')
    expect(projection.snapshot).toContain('Decision action [callId=parallel-a]: inspect({"candidate":"a"})')
    expect(projection.snapshot).toContain('Decision action [callId=parallel-b]: inspect({"candidate":"b"})')
    expect(projection.snapshot).toContain('Tool outcome [callId=parallel-b; status=success]: result-b')
    expect(projection.snapshot).toContain('Tool outcome [callId=parallel-a; status=success]: result-a')
    expect(projection.snapshot).not.toContain('private shared rationale')
  })

  it('projects a flat text-and-image user document without replay-only blocks', () => {
    const parent = Session.create(SessionId('mid-fork-image-parent'))
    const callId = CallId('image-call')
    const userImage = imageBlock('user-image', 1_000)
    const assistantImage = imageBlock('assistant-image', 2_000)
    const toolImage = imageBlock('tool-image', 3_000)
    parent.append('turn/start', { turn: 1 })
    parent.append('step/start', { turn: 1, step: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compare the screenshots' }, userImage],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'private visual interpretation' },
          { type: 'text', text: 'The second edge looks different.' },
          assistantImage,
          { type: 'tool-call', id: callId, name: 'inspect_image', arguments: '{}' },
        ],
        source: {
          provider: 'vision-provider',
          model: 'vision-model',
          replayState: { privateReplay: 'must-not-survive' },
        },
      }),
    }, { surfaceOp: 'append' })
    parent.append('tool/call', {
      turn: 1, step: 1, callId, name: 'inspect_image', arguments: '{}',
    })
    parent.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'pixel comparison complete' }, toolImage],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    parent.append('step/end', { turn: 1, step: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const projection = projectMidForkHistory(parent.events, new Set(parent.surface.nodes), {
      ...recentSteps(1),
      maxSnapshotImages: 20,
    })
    const projectedImages = projection.snapshotContent.filter(
      (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
    )

    expect(new Set(projection.snapshotContent.map(block => block.type))).toEqual(new Set(['text', 'image']))
    expect(projectedImages.map(block => block.attachment.attachmentId))
      .toEqual(['user-image', 'assistant-image', 'tool-image'])
    expect(projectedImages[0]?.attachment).not.toBe(userImage.attachment)
    expect(projection).toMatchObject({ projectedImages: 3, projectedImageBytes: 6_000 })
    expect(projection.snapshot).toBe(renderMidForkSnapshotContent(projection.snapshotContent))
    expect(projection.snapshot).toContain('[image #1 image/png 1000B]')
    expect(projection.snapshot).toContain('source: tool outcome')
    expect(projection.snapshot).toContain('callId: image-call')
    expect(projection.snapshot).not.toContain('private visual interpretation')
    expect(projection.snapshot).not.toContain('must-not-survive')
    expect(projection.snapshotContent.some(block =>
      block.type !== 'text' && block.type !== 'image')).toBe(false)

    const actionOnly = projectMidForkHistory(parent.events, new Set(parent.surface.nodes), {
      ...recentSteps(1, 'action-only'),
      maxSnapshotImages: 20,
    })
    expect(actionOnly.snapshotContent.flatMap(block =>
      block.type === 'image' ? [block.attachment.attachmentId] : []))
      .toEqual(['user-image', 'tool-image'])
    expect(actionOnly).toMatchObject({ projectedImages: 2, projectedImageBytes: 4_000 })
  })

  it('selects completed Steps only and excludes an in-flight caller Step', () => {
    const parent = Session.create(SessionId('mid-fork-open-parent'))
    appendCompletedToolTurn(parent, 1)
    parent.append('turn/start', { turn: 2 })
    parent.append('step/start', { turn: 2, step: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'active-caller-step-must-not-leak' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const projection = projectMidForkHistory(parent.events, new Set(parent.surface.nodes), recentSteps(1))
    expect(projection.projectedTurns).toBe(1)
    expect(projection.projectedSteps).toBe(1)
    expect(projection.seed).toHaveLength(0)
    expect(projection.snapshot).toContain('question-1')
    expect(projection.snapshot).not.toContain('active-caller-step-must-not-leak')
    expect(projection.snapshot).not.toContain('Turn state: open at masked-review checkpoint')

    const empty = Session.create(SessionId('mid-fork-empty-parent'))
    expect(() => projectMidForkHistory(
      empty.events,
      new Set(empty.surface.nodes),
      recentSteps(3),
    )).toThrow(expect.objectContaining({ code: 'NO_COMPLETED_STEP' }))
  })

  it('selects the last K Steps inside one Turn without replaying earlier same-Turn reasoning', () => {
    const parent = Session.create(SessionId('mid-fork-step-window-parent'))
    appendCompletedToolTurn(parent, 1)
    parent.append('turn/start', { turn: 2 })
    for (let step = 1; step <= 3; step += 1) {
      const callId = CallId(`turn-2-step-${step}`)
      parent.append('step/start', { turn: 2, step })
      parent.append('assistant/message', {
        turn: 2,
        step,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: `same-turn-private-${step}` },
            { type: 'text', text: `same-turn-visible-${step}` },
            { type: 'tool-call', id: callId, name: 'inspect', arguments: `{"step":${step}}` },
          ],
          source: { provider: 'test-provider', model: 'test-model' },
        }),
      }, { surfaceOp: 'append' })
      parent.append('tool/call', {
        turn: 2, step, callId, name: 'inspect', arguments: `{"step":${step}}`,
      })
      parent.append('tool/result', {
        turn: 2,
        step,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: `same-turn-result-${step}` }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      parent.append('step/end', { turn: 2, step })
    }
    parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const projection = projectMidForkHistory(
      parent.events,
      new Set(parent.surface.nodes),
      recentSteps(2),
    )

    expect(projection).toMatchObject({ projectedTurns: 1, projectedSteps: 2 })
    expect(projection.seed.some(event => event.type === 'turn/end' && event.data.turn === 1)).toBe(true)
    expect(projection.seed.some(event => event.type === 'turn/start' && event.data.turn === 2)).toBe(false)
    expect(projection.snapshot).not.toContain('same-turn-visible-1')
    expect(projection.snapshot).not.toContain('same-turn-result-1')
    expect(projection.snapshot).not.toContain('same-turn-private-1')
    expect(projection.snapshot).toContain('same-turn-visible-2')
    expect(projection.snapshot).toContain('same-turn-result-2')
    expect(projection.snapshot).toContain('same-turn-visible-3')
    expect(projection.snapshot).toContain('same-turn-result-3')
    expect(projection.snapshot).not.toContain('same-turn-private-2')
    expect(projection.snapshot).not.toContain('same-turn-private-3')
  })

  it('uses the unique open Turn as a structural window while keeping older Turns native', () => {
    const parent = Session.create(SessionId('mid-fork-current-turn-parent'))
    appendCompletedToolTurn(parent, 1)
    appendCompletedToolTurn(parent, 2)
    parent.append('turn/start', { turn: 3 })
    parent.append('step/start', { turn: 3, step: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'current-open-input' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('assistant/message', {
      turn: 3,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'reasoning', text: 'current-private-rationale' },
          { type: 'text', text: 'current-visible-claim' },
        ],
        source: { provider: 'test-provider', model: 'test-model' },
      }),
    }, { surfaceOp: 'append' })
    parent.append('step/end', { turn: 3, step: 1 })

    const projection = projectMidForkHistory(parent.events, new Set(parent.surface.nodes), {
      window: { kind: 'current-turn' },
      mask: 'reasoning-only',
    })

    expect(projection).toMatchObject({
      window: 'current-turn',
      mask: 'reasoning-only',
      projectedTurns: 1,
      projectedSteps: 1,
    })
    expect(projection.seed.some(event => event.type === 'turn/end' && event.data.turn === 2)).toBe(true)
    // A current-turn fork is a new child session, but its native seed still
    // contains every earlier completed Primary Turn unchanged.
    expect(projection.seed.some(event => event.type === 'turn/start' && event.data.turn === 1)).toBe(true)
    expect(JSON.stringify(projection.seed)).toContain('question-1')
    expect(JSON.stringify(projection.seed)).toContain('private-rationale-1')
    expect(JSON.stringify(projection.seed)).toContain('private-rationale-2')
    expect(projection.seed.some(event => event.type === 'turn/start' && event.data.turn === 3)).toBe(false)
    expect(projection.snapshot).toContain('current-open-input')
    expect(projection.snapshot).toContain('current-visible-claim')
    expect(projection.snapshot).not.toContain('question-2')
    expect(projection.snapshot).not.toContain('current-private-rationale')

    expect(() => projectMidForkHistory(parent.events.slice(0, -5), new Set(parent.surface.nodes), {
      window: { kind: 'current-turn' },
      mask: 'reasoning-only',
    })).toThrow(MidForkProjectionError)
  })

  it('offers action-only as an explicit stronger mask without changing actions or outcomes', () => {
    const parent = Session.create(SessionId('mid-fork-action-only-parent'))
    appendCompletedToolTurn(parent, 1)
    const projection = projectMidForkHistory(
      parent.events,
      new Set(parent.surface.nodes),
      recentSteps(1, 'action-only'),
    )

    expect(projection).toMatchObject({
      mask: 'action-only',
      projectedAssistantMessages: 0,
      omittedAssistantVisibleMessages: 1,
      omittedReasoningBlocks: 1,
    })
    expect(projection.snapshot).toContain('question-1')
    expect(projection.snapshot).toContain('Decision action [callId=call-1]')
    expect(projection.snapshot).toContain('Tool outcome [callId=call-1; status=success]')
    expect(projection.snapshot).not.toContain('visible-commitment-1')
    expect(projection.snapshot).not.toContain('private-rationale-1')
  })

  it('rejects an over-budget current Turn instead of silently truncating it', () => {
    const parent = Session.create(SessionId('mid-fork-budget-parent'))
    parent.append('turn/start', { turn: 7 })
    parent.append('step/start', { turn: 7, step: 1 })
    parent.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'x'.repeat(200) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('step/end', { turn: 7, step: 1 })

    let failure: unknown
    try {
      projectMidForkHistory(parent.events, new Set(parent.surface.nodes), {
        window: { kind: 'current-turn' },
        mask: 'reasoning-only',
        maxSnapshotChars: 80,
      })
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toBeInstanceOf(MidForkProjectionError)
    expect(failure).toMatchObject({
      code: 'PROJECTION_OVER_BUDGET',
      details: {
        window: 'current-turn',
        mask: 'reasoning-only',
        turn: 7,
        projectedSteps: 1,
        maxSnapshotChars: 80,
      },
    })
    expect((failure as MidForkProjectionError).details.snapshotChars).toBeGreaterThan(80)
  })

  it('rejects the whole suffix when its image count exceeds the configured limit', () => {
    const parent = Session.create(SessionId('mid-fork-image-limit-parent'))
    parent.append('turn/start', { turn: 9 })
    parent.append('step/start', { turn: 9, step: 1 })
    parent.append('user/message', createUserMessage({
      content: [imageBlock('limit-a', 100), imageBlock('limit-b', 200)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parent.append('step/end', { turn: 9, step: 1 })

    expect(() => projectMidForkHistory(parent.events, new Set(parent.surface.nodes), {
      window: { kind: 'current-turn' },
      mask: 'reasoning-only',
      maxSnapshotImages: 1,
    })).toThrow(expect.objectContaining({
      code: 'PROJECTION_IMAGE_LIMIT',
      details: expect.objectContaining({
        projectedImages: 2,
        projectedImageBytes: 300,
        maxSnapshotImages: 1,
      }),
    }))
  })

  it('gates the complete child input before agent creation and preserves attachment identity', async () => {
    const parentSession = Session.create(SessionId('mid-fork-vision-gate-parent'))
    const projectedImage = imageBlock('projected-image', 2_048)
    parentSession.append('turn/start', { turn: 1 })
    parentSession.append('step/start', { turn: 1, step: 1 })
    parentSession.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'inspect this image' }, projectedImage],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    parentSession.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'I inspected the image.' }],
        source: { provider: 'vision-provider', model: 'vision-model' },
      }),
    }, { surfaceOp: 'append' })
    parentSession.append('step/end', { turn: 1, step: 1 })
    parentSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const delivered: UserMessage[] = []
    const childSession = Session.create(SessionId('mid-fork-vision-gate-child'))
    const child = {
      id: childSession.header.id,
      session: childSession,
      followup(message: UserMessage) { delivered.push(message) },
      whenIdle: () => Promise.resolve(),
      cancel: () => undefined,
    } as unknown as Agent
    const create = vi.fn(async () => ({
      agent: child,
      dispose: () => Promise.resolve(),
    }))
    const parentCtx = {
      get: () => undefined,
      agents: { create },
    } as unknown as Context
    const parent = {
      id: parentSession.header.id,
      session: parentSession,
      options: { provider: 'vision-provider', model: 'vision-model' },
      ctx: parentCtx,
    } as unknown as Agent
    const request = {
      parent,
      prompt: [{ type: 'text', text: 'Return the sparse review packet.' }],
      signal: new AbortController().signal,
      maxDepth: 1,
      descriptor: {},
    } as unknown as ResolvedSubagentStartRequest
    const visionResolve = vi.fn(async () => ({
      provider: 'vision-provider',
      id: 'vision-model',
      name: 'Vision model',
      inputModalities: ['text', 'image'] as const,
    }))
    const visionCtx = {
      get: (service: string) => service === 'llm' ? { resolveModelInfo: visionResolve } : undefined,
    } as unknown as Context
    const visionProvider = new MidForkInProcessProvider(
      'mid-fork-vision',
      { kind: 'recent-steps', recentSteps: 1 },
      'reasoning-only',
      65_536,
      20,
      visionCtx,
    )

    const run = await visionProvider.start(request)
    await run.result
    await run.dispose()
    expect(create).toHaveBeenCalledTimes(1)
    expect(visionResolve).toHaveBeenCalledWith('vision-provider', 'vision-model', request.signal)
    const deliveredImages = delivered[0]?.content.filter(
      (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
    ) ?? []
    expect(deliveredImages).toHaveLength(1)
    expect(deliveredImages[0]?.attachment.attachmentId).toBe(projectedImage.attachment.attachmentId)

    const fallbackParent = { ...parent, options: {} } as Agent
    await expect(assertChildImageInputSupported(
      visionCtx,
      fallbackParent,
      undefined,
      [],
      [projectedImage],
      request.signal,
    )).resolves.toMatchObject({ images: 1 })
    await expect(assertChildImageInputSupported(
      visionCtx,
      fallbackParent,
      { provider: 'partial-provider-only' },
      [],
      [projectedImage],
      request.signal,
    )).rejects.toMatchObject({ code: 'IMAGE_ROUTE_UNRESOLVED' })

    const nonModelSeed = parentSession.events.slice(0, 2)
    await expect(assertChildImageInputSupported(
      visionCtx,
      fallbackParent,
      undefined,
      nonModelSeed,
      [projectedImage],
      request.signal,
    )).resolves.toMatchObject({ images: 1 })

    create.mockClear()
    const textCtx = {
      get: (service: string) => service === 'llm'
        ? {
            resolveModelInfo: vi.fn(async () => ({
              provider: 'vision-provider', id: 'vision-model', name: 'Text model', inputModalities: ['text'] as const,
            })),
          }
        : undefined,
    } as unknown as Context
    const textProvider = new MidForkInProcessProvider(
      'mid-fork-text',
      { kind: 'recent-steps', recentSteps: 1 },
      'reasoning-only',
      65_536,
      20,
      textCtx,
    )
    await expect(textProvider.start(request)).rejects.toMatchObject({
      name: 'UnsupportedChildImageInputError',
      code: 'IMAGE_INPUT_UNSUPPORTED',
    })
    expect(create).not.toHaveBeenCalled()

    const seedOnlySession = Session.create(SessionId('mid-fork-seed-image-parent'))
    seedOnlySession.append('turn/start', { turn: 1 })
    seedOnlySession.append('step/start', { turn: 1, step: 1 })
    seedOnlySession.append('user/message', createUserMessage({
      content: [imageBlock('seed-only-image')],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seedOnlySession.append('step/end', { turn: 1, step: 1 })
    seedOnlySession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    seedOnlySession.append('turn/start', { turn: 2 })
    seedOnlySession.append('step/start', { turn: 2, step: 1 })
    seedOnlySession.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'text-only selected suffix' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seedOnlySession.append('step/end', { turn: 2, step: 1 })
    seedOnlySession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const seedOnlyParent = { ...parent, id: seedOnlySession.header.id, session: seedOnlySession } as Agent
    await expect(textProvider.start({ ...request, parent: seedOnlyParent })).rejects
      .toBeInstanceOf(UnsupportedChildImageInputError)
    expect(create).not.toHaveBeenCalled()

    const assistantSeedSession = Session.create(SessionId('mid-fork-assistant-image-seed'))
    assistantSeedSession.append('turn/start', { turn: 1 })
    assistantSeedSession.append('step/start', { turn: 1, step: 1 })
    assistantSeedSession.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [imageBlock('assistant-seed-image')],
        source: { provider: 'vision-provider', model: 'vision-model' },
      }),
    }, { surfaceOp: 'append' })
    assistantSeedSession.append('step/end', { turn: 1, step: 1 })
    assistantSeedSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    assistantSeedSession.append('turn/start', { turn: 2 })
    assistantSeedSession.append('step/start', { turn: 2, step: 1 })
    assistantSeedSession.append('step/end', { turn: 2, step: 1 })
    assistantSeedSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const assistantSeedParent = {
      ...parent,
      id: assistantSeedSession.header.id,
      session: assistantSeedSession,
    } as Agent
    await expect(textProvider.start({ ...request, parent: assistantSeedParent })).rejects.toMatchObject({
      code: 'ASSISTANT_IMAGE_IN_SEED',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('validates configuration and registers as an inheriting subagent provider', async () => {
    expect(() => new MidForkInProcessProvider(
      ' ', { kind: 'recent-steps', recentSteps: 3 }, 'reasoning-only',
    )).toThrow(/providerName must be non-empty/u)
    expect(() => new MidForkInProcessProvider(
      'mid-fork', { kind: 'recent-steps', recentSteps: 0 }, 'reasoning-only',
    )).toThrow(/recentSteps must be a positive safe integer/u)
    expect(() => projectMidForkHistory([], new Set(), {
      window: { kind: 'recent-steps', recentSteps: 0 }, mask: 'reasoning-only',
    })).toThrow(/recentSteps must be a positive safe integer/u)
    expect(() => projectMidForkHistory([], new Set(), {
      window: { kind: 'recent-steps', recentSteps: 33 }, mask: 'reasoning-only',
    })).toThrow(/recentSteps must be no greater than 32/u)

    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(midForkPlugin, {
      providerName: 'masked-history',
      window: 'recent-steps',
      recentSteps: 4,
      mask: 'action-only',
      maxSnapshotChars: 5000,
      maxSnapshotImages: 7,
    })
    const registered = ctx.subagents.getProvider('masked-history')
    expect(registered).toBeInstanceOf(MidForkInProcessProvider)
    expect(registered?.inheritsParentContext).toBe(true)
    expect((registered as MidForkInProcessProvider).window).toEqual({ kind: 'recent-steps', recentSteps: 4 })
    expect((registered as MidForkInProcessProvider).mask).toBe('action-only')
    expect((registered as MidForkInProcessProvider).maxSnapshotChars).toBe(5000)
    expect((registered as MidForkInProcessProvider).maxSnapshotImages).toBe(7)
    expect(midForkPlugin.inject).toEqual(['subagents'])
  })

  it('registers a bounded recent-Step provider family and a separate current-Turn instance', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(midForkPlugin, {
      providerName: 'masked-step',
      window: 'recent-steps',
      maxRecentSteps: 4,
    })
    for (let recentSteps = 1; recentSteps <= 4; recentSteps += 1) {
      const registered = ctx.subagents.getProvider(`masked-step-${recentSteps}`)
      expect(registered).toBeInstanceOf(MidForkInProcessProvider)
      expect((registered as MidForkInProcessProvider).window)
        .toEqual({ kind: 'recent-steps', recentSteps })
      expect((registered as MidForkInProcessProvider).maxSnapshotChars).toBe(65_536)
      expect((registered as MidForkInProcessProvider).maxSnapshotImages).toBe(20)
    }
    expect(ctx.subagents.getProvider('masked-step')).toBeUndefined()

    const currentCtx = new Context()
    await currentCtx.plugin(SubagentRuntime)
    await currentCtx.plugin(midForkPlugin, {
      providerName: 'masked-current-turn',
      window: 'current-turn',
    })
    expect((currentCtx.subagents.getProvider('masked-current-turn') as MidForkInProcessProvider).window)
      .toEqual({ kind: 'current-turn' })
    expect(() => midForkPlugin.apply(currentCtx, {
      providerName: 'invalid-current-turn',
      window: 'current-turn',
      maxRecentSteps: 2,
    })).toThrow(/cannot configure recentSteps or maxRecentSteps/u)
    expect(() => midForkPlugin.apply(currentCtx, {
      providerName: 'too-many',
      window: 'recent-steps',
      maxRecentSteps: 33,
    })).toThrow(/maxRecentSteps must be no greater than 32/u)
  })
})
