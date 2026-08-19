import type { Context } from '@deepseek-ai/cordis'
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { browserCardModel } from '../models/browser-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/** Full browser row props: the toolview runtime share plus the conversation locale. */
type BrowserRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const BROWSER_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll'] as const

/**
 * Render one camofox action with its latest captured viewport. The screenshot
 * card starts open so the chat visibly follows browser work without requiring a
 * second click; calls without a capture retain the generic output fallback.
 * @param props - tool call block and the standard toolview runtime share.
 * @returns the browser action row.
 */
export function BrowserRow({ toolName, block, inspect, t }: BrowserRowProps) {
  const model = toolRowModel(toolName, block)
  const browser = browserCardModel(block)
  return (
    <ToolRow
      t={t}
      variant="others"
      toolName={toolName}
      icon={<IconGlobeOutline14 size={14} />}
      title="Browser"
      summary={model.summary}
      body={null}
      output={model.output}
      errorSummary={model.errorSummary}
      browser={browser}
      defaultExpanded={browser !== null}
      state={model.state}
      inspect={inspect}
    />
  )
}

/** Register the browser row under every model-facing camofox tool name. */
export const browserToolview = {
  name: 'browser-toolview',
  inject: ['slots'],
  /**
   * Register one browser row for each camofox action.
   * @param ctx - registrant context; slot registrations own their disposers.
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      for (const key of BROWSER_TOOLS) {
        yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, BrowserRow)
      }
    })
  },
}
