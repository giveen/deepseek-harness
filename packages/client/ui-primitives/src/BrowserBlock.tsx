import clsx from 'clsx'
import css from './BrowserBlock.module.css'

/** A captured browser viewport rendered inside a tool card. */
export interface BrowserBlockProps {
  /** Base64-encoded PNG bytes supplied by the host-computed browser view. */
  screenshot: {
    data: string
    mimeType: 'image/png'
  }
  /** Extra class merged onto the panel wrapper. */
  className?: string | undefined
}

/**
 * Render one camofox viewport screenshot without interpreting page HTML or
 * executing page-controlled content.
 * @param props - validated browser screenshot and optional layout class.
 * @returns the browser screenshot panel.
 */
export function BrowserBlock({ screenshot, className }: BrowserBlockProps) {
  return (
    <figure className={clsx(css.block, className)} data-browser="screenshot">
      <div className={css.chrome} aria-hidden>
        <span className={css.dot} />
        <span className={css.dot} />
        <span className={css.dot} />
        <span className={css.label}>Browser</span>
      </div>
      <div className={css.viewport}>
        <img
          className={css.image}
          src={`data:${screenshot.mimeType};base64,${screenshot.data}`}
          alt="Browser page after the latest action"
          decoding="async"
        />
      </div>
    </figure>
  )
}
