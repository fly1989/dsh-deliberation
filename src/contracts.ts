import { valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { InferValue, ObjectJsonSchema, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

export const REVIEW_ROLES = [
  'independent-alternative',
  'trajectory-audit',
  'masked-review',
] as const

export const REVIEW_ITEM_KINDS = [
  'observation',
  'conclusion',
  'assumption',
  'unknown',
  'possible_error',
  'suggestion',
] as const

export const REVIEW_CERTAINTIES = ['certain', 'likely', 'uncertain'] as const

// Bound the complete Primary-facing packet, not each individual finding. A
// per-item character cap can reject a valid evidence + implication statement
// even when the complete packet remains compact.
export const MAX_REVIEW_PACKET_CHARS = 10_000

const REVIEW_ITEM_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      required: true,
      enum: REVIEW_ITEM_KINDS,
      description: 'What this item contributes; use one item instead of filling empty category fields.',
    },
    certainty: {
      type: 'string',
      required: true,
      enum: REVIEW_CERTAINTIES,
      description: 'The child\'s epistemic self-report, not a runtime-verified probability.',
    },
    content: {
      type: 'string',
      required: true,
      description: 'One compressed decision-relevant statement. Do not include hidden reasoning or a branch transcript.',
    },
  },
} as const satisfies ValueSchemaSpec

const COMMON_PACKET_PROPERTIES = {
  status: {
    type: 'string',
    required: true,
    enum: ['update', 'no_update'],
    description: 'Use no_update only when the branch found no decision-relevant information.',
  },
  items: {
    type: 'array',
    items: REVIEW_ITEM_VALUE_SCHEMA,
    description: 'Sparse compressed items. Omit for no_update; do not emit empty category placeholders.',
  },
} as const

function packetSchema<const Role extends typeof REVIEW_ROLES[number]>(role: Role) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      role: { type: 'string', const: role, required: true },
      ...COMMON_PACKET_PROPERTIES,
    },
  } as const satisfies ValueSchemaSpec
}

export const ALTERNATIVE_PACKET_VALUE_SCHEMA = packetSchema('independent-alternative')
export const AUDIT_PACKET_VALUE_SCHEMA = packetSchema('trajectory-audit')
export const MASKED_REVIEW_PACKET_VALUE_SCHEMA = packetSchema('masked-review')

export const REVIEW_PACKET_VALUE_SCHEMA = {
  oneOf: [
    ALTERNATIVE_PACKET_VALUE_SCHEMA,
    AUDIT_PACKET_VALUE_SCHEMA,
    MASKED_REVIEW_PACKET_VALUE_SCHEMA,
  ],
} as const satisfies ValueSchemaSpec

export type AlternativePacket = InferValue<typeof ALTERNATIVE_PACKET_VALUE_SCHEMA>
export type AuditPacket = InferValue<typeof AUDIT_PACKET_VALUE_SCHEMA>
export type MaskedReviewPacket = InferValue<typeof MASKED_REVIEW_PACKET_VALUE_SCHEMA>
export type ReviewPacket = InferValue<typeof REVIEW_PACKET_VALUE_SCHEMA>
export type ReviewItem = NonNullable<ReviewPacket['items']>[number]

export const ROLE_OUTPUT_SCHEMA = {
  'independent-alternative': valueSchemaSpecToJsonSchema(ALTERNATIVE_PACKET_VALUE_SCHEMA) as ObjectJsonSchema,
  'trajectory-audit': valueSchemaSpecToJsonSchema(AUDIT_PACKET_VALUE_SCHEMA) as ObjectJsonSchema,
  'masked-review': valueSchemaSpecToJsonSchema(MASKED_REVIEW_PACKET_VALUE_SCHEMA) as ObjectJsonSchema,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
}

/**
 * Mirror the model schema and enforce the semantic compression rules the schema
 * subset cannot express. Certainty remains a child claim; this function does
 * not pretend to verify natural-language truth.
 */
export function validReviewPacket(value: unknown): value is ReviewPacket {
  if (!isRecord(value)
    || !exactKeys(value, ['role', 'status', 'items'])
    || !REVIEW_ROLES.includes(value.role as typeof REVIEW_ROLES[number])
    || !['update', 'no_update'].includes(String(value.status))) return false

  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return false
  }
  if (serialized.length > MAX_REVIEW_PACKET_CHARS) return false

  const items = value.items
  if (value.status === 'no_update') return items === undefined
  if (!Array.isArray(items) || items.length < 1) return false

  const contents = new Set<string>()
  for (const item of items) {
    if (!isRecord(item)
      || !exactKeys(item, ['kind', 'certainty', 'content'])
      || !REVIEW_ITEM_KINDS.includes(item.kind as typeof REVIEW_ITEM_KINDS[number])
      || !REVIEW_CERTAINTIES.includes(item.certainty as typeof REVIEW_CERTAINTIES[number])
      || !nonEmptyText(item.content)) return false
    const normalized = item.content.trim().toLowerCase()
    if (contents.has(normalized)) return false
    contents.add(normalized)
  }
  return true
}

/**
 * Recover a packet when a model emits the exact JSON as its final text instead
 * of calling DSH's structured_output capture tool. The normal provider-owned
 * capture remains authoritative; this narrow fallback exists for models that
 * follow the packet contract but ignore the capture-tool instruction.
 *
 * Private reasoning blocks are ignored because DSH's final assistant output
 * may contain them beside the visible final text. Any prose, markdown fence,
 * image, tool call, tool result, or malformed value is rejected so an
 * arbitrary child transcript can never become a Primary notice.
 */
export function parseTextualReviewPacket(
  output: readonly ContentBlock[] | undefined,
): ReviewPacket | undefined {
  if (output === undefined || output.length === 0
    || output.some(block => block.type !== 'text' && block.type !== 'reasoning')) {
    return undefined
  }
  const text = output.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  if (text.length === 0 || text.length > MAX_REVIEW_PACKET_CHARS) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return validReviewPacket(value) ? value : undefined
  } catch {
    return undefined
  }
}
