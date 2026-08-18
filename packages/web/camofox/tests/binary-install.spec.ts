import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The helper is intentionally shipped as plain ESM because npm executes it
// before the TypeScript build exists.
interface InstallerVersions {
  camofoxBrowser: string
  camoufoxJs: string
  camoufoxBin: string
}

interface InstallerOptions {
  cacheDir: string
  env: Record<string, string>
  versions: InstallerVersions
  runFetch: (
    file: string,
    args: string[],
    options: { env: Record<string, string | undefined> },
  ) => { status: number; error?: Error | undefined }
  log: { info: (message: string) => void; warn: (message: string) => void }
}

// @ts-expect-error The package installer helper is a shipped .mjs module.
const { ensureBinary } = await import('../scripts/camofox-binary.mjs') as unknown as {
  ensureBinary: (options: InstallerOptions) => boolean
}

const tempDirectories: string[] = []

function cacheWithVersion(version = '135.0', release = '2026.08.01') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-camofox-test-'))
  tempDirectories.push(root)
  writeFileSync(join(root, 'version.json'), JSON.stringify({ version, release }))
  return root
}

function versions(camofoxBrowser = '1.13.1', camoufoxJs = '0.11.5') {
  return { camofoxBrowser, camoufoxJs, camoufoxBin: '/unused/camoufox-js' }
}

const log = { info: vi.fn(), warn: vi.fn() }

afterEach(async () => {
  vi.restoreAllMocks()
  log.info.mockClear()
  log.warn.mockClear()
  const { rmSync } = await import('node:fs')
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('camofox binary installer', () => {
  it('reuses an existing cache and records its upstream version without downloading', () => {
    const cacheDir = cacheWithVersion()
    const runFetch = vi.fn()

    expect(ensureBinary({ cacheDir, env: {}, versions: versions(), runFetch, log })).toBe(true)
    expect(runFetch).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(cacheDir, '.dsh-camofox-browser.json'), 'utf8'))).toEqual({
      camofoxBrowser: '1.13.1',
      camoufoxJs: '0.11.5',
    })
  })

  it('refreshes into a new cache when either upstream package version changes', () => {
    const cacheDir = cacheWithVersion('134.0')
    writeFileSync(join(cacheDir, '.dsh-camofox-browser.json'), JSON.stringify({
      camofoxBrowser: '1.12.0',
      camoufoxJs: '0.11.4',
    }))
    const runFetch = vi.fn((_file: string, _args: string[], options: { env: Record<string, string | undefined> }) => {
      writeFileSync(join(options.env.CAMOUFOX_INSTALL_DIR!, 'version.json'), JSON.stringify({
        version: '135.0',
        release: '2026.09.01',
      }))
      return { status: 0, error: undefined }
    })

    expect(ensureBinary({ cacheDir, env: {}, versions: versions(), runFetch, log })).toBe(true)
    expect(runFetch).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(cacheDir, 'version.json'), 'utf8')).toContain('2026.09.01')
  })

  it('keeps the existing cache and lets installation continue when refresh fails', () => {
    const cacheDir = cacheWithVersion('134.0')
    writeFileSync(join(cacheDir, '.dsh-camofox-browser.json'), JSON.stringify({
      camofoxBrowser: '1.12.0',
      camoufoxJs: '0.11.4',
    }))
    const runFetch = vi.fn(() => ({ status: 1, error: undefined }))

    expect(ensureBinary({ cacheDir, env: {}, versions: versions(), runFetch, log })).toBe(true)
    expect(readFileSync(join(cacheDir, 'version.json'), 'utf8')).toContain('134.0')
    expect(log.warn).toHaveBeenCalled()
  })
})
