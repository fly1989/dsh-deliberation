import type { ReviewPacket } from './contracts.ts'

/** The child already compressed its exploration; the runtime must not reinterpret it. */
export function renderReviewPacket(packet: ReviewPacket): string {
  return JSON.stringify(packet)
}
