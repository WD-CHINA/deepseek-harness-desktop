import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWebProfileManifest,
  healWebProfileManifest,
  bundledPluginSpec,
  BUNDLED_PLUGINS,
  WEB_PROFILE_BUNDLES,
} from './plugin-installer.js'
import { ensurePluginToolsBinDir, prependPathEntry, ensureNpmrcRegistry, resolvePluginNpmRegistry, DEFAULT_NPM_REGISTRY, CI_NPM_REGISTRY } from './plugin-tools.js'

describe('createWebProfileManifest', () => {
  it('matches DSH web profile template bundles', () => {
    expect(createWebProfileManifest()).toEqual({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...WEB_PROFILE_BUNDLES] } },
    })
  })
})

describe('bundled plugins', () => {
  it('pins exact latest target versions for add specs', () => {
    expect(BUNDLED_PLUGINS).toEqual([
      { name: 'dsh-better-sidebar', version: '0.12.2' },
      { name: 'dshmarket', version: '1.5.0' },
      { name: '@linxin666/dsh-web-ui-all', version: '0.1.15' },
    ])
    expect(bundledPluginSpec(BUNDLED_PLUGINS[0])).toBe('dsh-better-sidebar@0.12.2')
    expect(bundledPluginSpec(BUNDLED_PLUGINS[1])).toBe('dshmarket@1.5.0')
    expect(bundledPluginSpec(BUNDLED_PLUGINS[2])).toBe('@linxin666/dsh-web-ui-all@0.1.15')
  })
})

describe('healWebProfileManifest', () => {
  it('restores web bundles when missing or empty', () => {
    expect(healWebProfileManifest({ private: true, dependencies: {} })).toEqual({
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...WEB_PROFILE_BUNDLES] } },
    })

    expect(
      healWebProfileManifest({
        name: 'custom',
        dsh: { profile: { bundles: [] } },
      }),
    ).toMatchObject({
      name: 'custom',
      dsh: { profile: { bundles: [...WEB_PROFILE_BUNDLES] } },
    })
  })

  it('leaves manifests with existing bundles unchanged', () => {
    const manifest = {
      name: 'ok',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }
    expect(healWebProfileManifest(manifest)).toBeUndefined()
  })
})

describe('plugin tools PATH helpers', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prepends the tools bin directory to PATH', () => {
    expect(prependPathEntry('/tools/bin', '/usr/bin')).toBe(
      `/tools/bin${path.delimiter}/usr/bin`,
    )
    expect(prependPathEntry('/tools/bin')).toBe('/tools/bin')
  })

  it('writes unix node/pnpm shims that invoke Electron as Node', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-tools-'))
    tempDirs.push(binDir)

    ensurePluginToolsBinDir(binDir, '/App/DeepSeek Harness Desktop', 'darwin')

    const nodeShim = fs.readFileSync(path.join(binDir, 'node'), 'utf-8')
    const pnpmShim = fs.readFileSync(path.join(binDir, 'pnpm'), 'utf-8')

    expect(nodeShim).toContain("exec '/App/DeepSeek Harness Desktop'")
    expect(nodeShim).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(pnpmShim).toContain("exec '/App/DeepSeek Harness Desktop'")
    expect(pnpmShim).toContain('pnpm.cjs')
    expect(fs.statSync(path.join(binDir, 'pnpm')).mode & 0o111).toBeTruthy()
  })

  it('writes Windows cmd shims for node and pnpm', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-tools-'))
    tempDirs.push(binDir)

    ensurePluginToolsBinDir(binDir, 'C:\\Program Files\\App\\Desktop.exe', 'win32')

    const nodeCmd = fs.readFileSync(path.join(binDir, 'node.cmd'), 'utf-8')
    const pnpmCmd = fs.readFileSync(path.join(binDir, 'pnpm.cmd'), 'utf-8')

    expect(nodeCmd).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(nodeCmd).toContain('"C:\\Program Files\\App\\Desktop.exe"')
    expect(pnpmCmd).toContain('pnpm.cjs')
  })
})

describe('npm registry helpers', () => {
  it('defaults to npmmirror, uses npmjs on CI, and allows DSH_NPM_REGISTRY override', () => {
    expect(resolvePluginNpmRegistry({})).toBe(DEFAULT_NPM_REGISTRY)
    expect(resolvePluginNpmRegistry({ CI: 'true' })).toBe(CI_NPM_REGISTRY)
    expect(resolvePluginNpmRegistry({ GITHUB_ACTIONS: 'true' })).toBe(CI_NPM_REGISTRY)
    expect(
      resolvePluginNpmRegistry({
        CI: 'true',
        DSH_NPM_REGISTRY: ' https://example.com/npm ',
      }),
    ).toBe('https://example.com/npm')
  })

  it('writes or replaces registry in .npmrc content', () => {
    expect(ensureNpmrcRegistry('', DEFAULT_NPM_REGISTRY)).toBe(
      `registry=${DEFAULT_NPM_REGISTRY}\n`,
    )
    expect(ensureNpmrcRegistry('registry=https://registry.npmjs.org/\n', DEFAULT_NPM_REGISTRY)).toBe(
      `registry=${DEFAULT_NPM_REGISTRY}\n`,
    )
    expect(ensureNpmrcRegistry('shamefully-hoist=true\n', DEFAULT_NPM_REGISTRY)).toBe(
      `shamefully-hoist=true\nregistry=${DEFAULT_NPM_REGISTRY}\n`,
    )
  })
})
