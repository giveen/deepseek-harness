/**
 * Reuse or refresh the Camoufox binary cache without making npm installation
 * fail when the optional browser download is unavailable.
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const MARKER_NAME = '.dsh-camofox-browser.json'
const EXTERNAL_EXECUTABLE_ENV_VARS = [
  'CAMOUFOX_EXECUTABLE',
  'CAMOUFOX_EXECUTABLE_PATH',
  'CAMOFOX_EXECUTABLE_PATH',
]

/** Return the cache directory used by camoufox-js for this environment. */
export function defaultCacheDir(env = process.env, os = platform(), home = homedir()) {
  if (env.CAMOUFOX_INSTALL_DIR) return resolve(env.CAMOUFOX_INSTALL_DIR)
  if (os === 'darwin') return join(home, 'Library', 'Caches', 'camoufox')
  if (os === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'camoufox', 'camoufox', 'Cache')
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox')
}

/** Read a JSON object from a file, returning undefined for an absent or malformed file. */
function readJson(path) {
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Read the installed Camoufox version metadata. */
export function readInstalledVersion(cacheDir) {
  const value = readJson(join(cacheDir, 'version.json'))
  if (typeof value?.version !== 'string' || typeof value?.release !== 'string') return undefined
  return { version: value.version, release: value.release }
}

/** Resolve the two upstream versions used to decide whether a refresh is needed. */
export function upstreamVersions() {
  const camofoxEntry = require.resolve('@askjo/camofox-browser')
  const camofoxRequire = createRequire(camofoxEntry)
  const camofox = camofoxRequire('@askjo/camofox-browser/package.json')
  const camoufox = camofoxRequire('camoufox-js/package.json')
  return {
    camofoxBrowser: String(camofox.version),
    camoufoxJs: String(camoufox.version),
    camoufoxBin: resolve(dirname(camofoxRequire.resolve('camoufox-js')), '__main__.js'),
  }
}

/** Whether a cache marker belongs to the currently installed upstream packages. */
function markerMatches(marker, versions) {
  return marker?.camofoxBrowser === versions.camofoxBrowser
    && marker?.camoufoxJs === versions.camoufoxJs
}

/** Return the first configured external Camoufox executable. */
function externalExecutable(env) {
  for (const name of EXTERNAL_EXECUTABLE_ENV_VARS) {
    const value = env[name]?.trim()
    if (value) return { name, value }
  }
  return undefined
}

/** Write the marker only after a cache has a valid version file. */
function writeMarker(cacheDir, versions) {
  writeFileSync(join(cacheDir, MARKER_NAME), `${JSON.stringify({
    camofoxBrowser: versions.camofoxBrowser,
    camoufoxJs: versions.camoufoxJs,
  }, null, 2)}\n`)
}

/** Run the upstream fetcher in a directory that is not the live cache. */
function fetchInto(cacheDir, versions, env, run = spawnSync) {
  const parent = dirname(cacheDir)
  // Custom CAMOUFOX_INSTALL_DIR values may point below a new directory.
  // Create only the cache parent; the live cache itself is swapped atomically.
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.dsh-camofox-'))
  try {
    const childEnv = { ...env, CAMOUFOX_INSTALL_DIR: staging }
    delete childEnv.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
    const result = run(process.execPath, [versions.camoufoxBin, 'fetch'], {
      env: childEnv,
      stdio: 'inherit',
    })
    if (result.error || result.status !== 0 || readInstalledVersion(staging) === undefined) {
      return false
    }
    writeMarker(staging, versions)
    const backup = `${cacheDir}.dsh-old-${process.pid}`
    let movedOld = false
    try {
      if (existsSync(cacheDir)) {
        rmSync(backup, { recursive: true, force: true })
        renameSync(cacheDir, backup)
        movedOld = true
      }
      renameSync(staging, cacheDir)
      if (movedOld) rmSync(backup, { recursive: true, force: true })
      return true
    } catch (error) {
      if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true })
      if (movedOld) renameSync(backup, cacheDir)
      throw error
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Ensure the cache is usable for the installed upstream package versions.
 *
 * @param options - environment, cache location, and optional fetch override.
 * @returns `true` when a valid cache is present after the operation.
 */
export function ensureBinary({
  env = process.env,
  cacheDir = defaultCacheDir(env),
  versions = upstreamVersions(),
  runFetch = spawnSync,
  log = console,
} = {}) {
  if (env.CAMOFOX_SKIP_DOWNLOAD === '1' || env.CAMOFOX_SKIP_DOWNLOAD === 'true') {
    log.warn('[camofox] binary download skipped by CAMOFOX_SKIP_DOWNLOAD')
    return readInstalledVersion(cacheDir) !== undefined
  }
  const external = externalExecutable(env)
  if (external) {
    log.info(`[camofox] using external executable from ${external.name}; bundled download skipped`)
    return true
  }

  const installed = readInstalledVersion(cacheDir)
  const marker = readJson(join(cacheDir, MARKER_NAME))
  if (installed && (markerMatches(marker, versions) || marker === undefined)) {
    if (marker === undefined) {
      try {
        writeMarker(cacheDir, versions)
      } catch (error) {
        log.warn(`[camofox] could not record cache version: ${String(error)}`)
      }
    }
    log.info('[camofox] existing compatible binary cache reused')
    return true
  }

  try {
    const refreshed = fetchInto(cacheDir, versions, env, runFetch)
    if (refreshed) {
      log.info(installed
        ? '[camofox] upstream package changed; binary cache refreshed'
        : '[camofox] binary cache installed')
      return true
    }
    log.warn('[camofox] binary download did not complete; keeping any existing cache')
  } catch (error) {
    log.warn(`[camofox] binary refresh failed; keeping any existing cache: ${String(error)}`)
  }
  return installed !== undefined
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  ensureBinary()
}
