import type { BrowserBlockProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallBlock } from './tool-call-model.ts'

/**
 * Derive the browser screenshot panel from a settled tool call, or return null
 * for running calls and unknown wire presentation tags.
 * @param block - running or settled browser tool call.
 * @returns browser panel props when the result carries a validated screenshot.
 */
export function browserCardModel(block: ToolCallBlock): BrowserBlockProps | null {
  if (!('kind' in block)) return null
  const result = block.resultView
  if (result?.card !== 'browser' || !isRecord(result.screenshot)) return null
  const { data, mimeType } = result.screenshot
  if (typeof data !== 'string' || data.length === 0 || mimeType !== 'image/png') return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null
  return { screenshot: { data, mimeType: 'image/png' } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
