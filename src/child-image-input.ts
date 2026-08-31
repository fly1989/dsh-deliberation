/**
 * Image admission for one-shot child input. The check runs before provider
 * publication and treats unknown model capability as unsupported so a review
 * cannot silently replace missing visual evidence with text.
 *
 * @module dsh-deliberation/child-image-input
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Safe reason codes for image-bearing child input rejected before publication. */
export type ChildImageInputErrorCode =
  | 'ASSISTANT_IMAGE_IN_SEED'
  | 'IMAGE_ROUTE_UNRESOLVED'
  | 'IMAGE_ROUTE_UNVERIFIED'
  | 'IMAGE_CAPABILITY_UNKNOWN'
  | 'IMAGE_INPUT_UNSUPPORTED'

/** Counts derived only from durable attachment metadata; image bytes are never read. */
export interface ChildImageInputStats {
  readonly images: number
  readonly imageBytes: number
  readonly assistantSeedImages: number
}

/** A safe pre-publication refusal that never carries adapter payloads or image ids. */
export class UnsupportedChildImageInputError extends Error {
  constructor(
    readonly code: ChildImageInputErrorCode,
    readonly stats: ChildImageInputStats,
  ) {
    super(code === 'ASSISTANT_IMAGE_IN_SEED'
      ? 'The child was not started because native seed history contains an assistant-role image.'
      : code === 'IMAGE_ROUTE_UNRESOLVED'
        ? 'The child was not started because its exact model route could not be resolved for image input.'
        : code === 'IMAGE_ROUTE_UNVERIFIED'
          ? 'The child was not started because its exact model route could not be verified for image input.'
          : code === 'IMAGE_CAPABILITY_UNKNOWN'
            ? 'The child was not started because its exact model route does not declare whether image input is supported.'
            : 'The child was not started because its exact model route does not support image input.')
    this.name = 'UnsupportedChildImageInputError'
  }
}

/** Narrow an unknown startup error to the plugin's safe image refusal. */
export function isUnsupportedChildImageInputError(
  error: unknown,
): error is UnsupportedChildImageInputError {
  return error instanceof UnsupportedChildImageInputError
}

function contentImageStats(blocks: readonly ContentBlock[]): { images: number; imageBytes: number } {
  let images = 0
  let imageBytes = 0
  for (const block of blocks) {
    if (block.type === 'image') {
      images += 1
      imageBytes += block.attachment.bytes
    } else if (block.type === 'tool-result') {
      const nested = contentImageStats(block.content)
      images += nested.images
      imageBytes += nested.imageBytes
    }
  }
  return { images, imageBytes }
}

/**
 * Return the exact completed-Turn prefix used by DSH's in-process fork
 * provider. The current open Turn is excluded.
 */
export function completedTurnPrefix(events: readonly SessionEvent[]): readonly SessionEvent[] {
  const lastEnd = events.findLast(event => event.type === 'turn/end')
  return lastEnd === undefined ? [] : events.slice(0, lastEnd.seq + 1)
}

/** Inspect the actual surface of a child seed plus its one user prompt. */
export function inspectChildImageInput(
  seed: readonly SessionEvent[],
  prompt: readonly ContentBlock[],
): ChildImageInputStats {
  const promptStats = contentImageStats(prompt)
  let images = promptStats.images
  let imageBytes = promptStats.imageBytes
  let assistantSeedImages = 0
  const surface = foldSurface(seed)
  for (const seq of surface.nodes) {
    const event = seed[seq]
    if (event === undefined) continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    const stats = contentImageStats(message.content)
    images += stats.images
    imageBytes += stats.imageBytes
    if (message.role === 'assistant') assistantSeedImages += stats.images
  }
  return { images, imageBytes, assistantSeedImages }
}

function latestModelRoute(
  parent: Agent,
): { provider: string; model: string } | undefined {
  const source = parent.session.events.findLast(event =>
    event.type === 'assistant/message' && event.data.message.source.kind === 'model')
  if (source?.type !== 'assistant/message' || source.data.message.source.kind !== 'model') return undefined
  return {
    provider: source.data.message.source.provider,
    model: source.data.message.source.model,
  }
}

function childRoute(
  parent: Agent,
  requested: AgentOptions | undefined,
): { provider: string; model: string } | undefined {
  const provider = requested?.provider ?? parent.options.provider
  const model = requested?.model ?? parent.options.model
  if (provider !== undefined && model !== undefined) return { provider, model }
  if (provider !== undefined || model !== undefined) return undefined
  return latestModelRoute(parent)
}

/**
 * Require explicit image support for the final child route whenever the full
 * child input contains an image. Text-only input does not require `ctx.llm`.
 */
export async function assertChildImageInputSupported(
  ctx: Context,
  parent: Agent,
  agentOptions: AgentOptions | undefined,
  seed: readonly SessionEvent[],
  prompt: readonly ContentBlock[],
  signal: AbortSignal,
): Promise<ChildImageInputStats> {
  const stats = inspectChildImageInput(seed, prompt)
  if (stats.images === 0) return stats
  if (stats.assistantSeedImages > 0) {
    throw new UnsupportedChildImageInputError('ASSISTANT_IMAGE_IN_SEED', stats)
  }
  const route = childRoute(parent, agentOptions)
  if (route === undefined) {
    throw new UnsupportedChildImageInputError('IMAGE_ROUTE_UNRESOLVED', stats)
  }
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new UnsupportedChildImageInputError('IMAGE_ROUTE_UNVERIFIED', stats)
  }
  signal.throwIfAborted()
  let info: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    info = await llm.resolveModelInfo(route.provider, route.model, signal)
  } catch {
    signal.throwIfAborted()
    throw new UnsupportedChildImageInputError('IMAGE_ROUTE_UNVERIFIED', stats)
  }
  signal.throwIfAborted()
  if (info.inputModalities === undefined) {
    throw new UnsupportedChildImageInputError('IMAGE_CAPABILITY_UNKNOWN', stats)
  }
  if (!info.inputModalities.includes('image')) {
    throw new UnsupportedChildImageInputError('IMAGE_INPUT_UNSUPPORTED', stats)
  }
  return stats
}
