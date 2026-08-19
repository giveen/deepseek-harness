// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficialBrandMark, OfficialBrandName } from '../src/client/Brand.tsx'
import { apply } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('official browser branding', () => {
  it('renders the official mark and wordmark occupants', () => {
    const view = render(<>
      <OfficialBrandMark size={24} />
      <OfficialBrandName />
    </>)
    expect(view.container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2)
  })

  it('registers only for the official build profile', () => {
    const inject = vi.fn((_name: string, registerFactory: () => unknown) => {
      const value = registerFactory()
      if (value !== null && typeof value === 'object' && Symbol.iterator in value) {
        for (const _entry of value as Iterable<unknown>) {}
      }
      return value
    })
    const register = vi.fn()
    const ctx = { slots: { inject, register } } as never

    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    apply(ctx)
    expect(inject).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()

    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    apply(ctx)
    expect(inject).toHaveBeenCalledTimes(3)
    expect(register).toHaveBeenCalledTimes(3)
    expect(register.mock.calls.map(call => (call[0] as { name: string }).name)).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
    ])
  })
})
