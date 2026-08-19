import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertClientBuildEnvironment,
  clientBuildEnvironmentDefines,
  clientBuildProcessEnvironment,
  readClientBuildRecord,
  resolveClientBuildEnvironment,
  repositoryCommitHash,
  writeClientBuildRecord,
} from './client-build-environment.ts'

const roots: string[] = []
const commit = '0123456789abcdef0123456789abcdef01234567'

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function fixture(environment: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-client-build-'))
  roots.push(root)
  write(join(root, 'apps/web/dist/index.html'), '<main></main>')
  write(join(root, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(root, environment)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('client build environment', () => {
  it('keeps only public static values in bundler defines', () => {
    expect(clientBuildEnvironmentDefines({
      PATH: '/bin',
      DSH_CLIENT_TITLE: 'quoted "title"',
      DSH_SECRET: 'not public',
      DSH_CLIENT_UNSET: undefined,
    })).toEqual({
      'process.env': '{}',
      'process.env.DSH_CLIENT_TITLE': JSON.stringify('quoted "title"'),
    })
  })

  it('selects the official profile and removes inherited client values', () => {
    const parent = {
      PATH: '/bin',
      DSH_BUILD_CLIENT_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: commit.slice(0, 7),
      DSH_CLIENT_TITLE: 'local',
      DSH_CLIENT_EXTRA: 'leak',
    }
    const expected = {
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: commit.slice(0, 7),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
    }
    expect(resolveClientBuildEnvironment(parent)).toEqual(expected)
    expect(clientBuildProcessEnvironment(parent, expected)).toEqual({ PATH: '/bin', ...expected })
    expect(repositoryCommitHash('/unused', { DSH_CLIENT_COMMIT_HASH: commit })).toBe(commit.slice(0, 7))
    expect(() => resolveClientBuildEnvironment({}, 'unknown')).toThrow(/unknown client build profile/)
  })

  it('requires exact profile values and current artifact bytes', () => {
    const expected = {
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: commit.slice(0, 7),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
    }
    const root = fixture(expected)
    expect(() => {
      assertClientBuildEnvironment(readClientBuildRecord(root).environment, expected)
    }).not.toThrow()
    expect(readClientBuildRecord(root, expected).environment).toEqual(expected)
    write(join(root, 'apps/web/dist/index.html'), '<main>changed</main>')
    expect(() => readClientBuildRecord(root, expected)).toThrow(/artifacts differ/)
  })

  it('rejects malformed records before consuming them', () => {
    const root = fixture({})
    write(join(root, '.dsh-build/client-build-environment.json'), `${JSON.stringify({
      formatVersion: 99,
      environment: {},
      artifacts: { fileCount: 1, sha256: '0'.repeat(64) },
    })}\n`)
    expect(() => readClientBuildRecord(root)).toThrow(/unsupported format/)
    expect(readFileSync(join(root, '.dsh-build/client-build-environment.json'), 'utf8')).toContain('99')
  })
})
