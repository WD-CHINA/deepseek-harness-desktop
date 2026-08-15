import { app } from 'electron'
import fsSync from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { rewriteAsarSymlinkTarget } from './asar-path.js'

const require = createRequire(import.meta.url)

/** 桌面端插件安装默认使用的 npm 中国镜像（与仓库 `.npmrc` 一致）。 */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmmirror.com'

/**
 * 解析插件安装所用 registry。
 * 可通过环境变量 `DSH_NPM_REGISTRY` 覆盖。
 */
export function resolvePluginNpmRegistry(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.DSH_NPM_REGISTRY?.trim()
  return override !== undefined && override.length > 0
    ? override
    : DEFAULT_NPM_REGISTRY
}

/**
 * 确保 `.npmrc` 文本包含指定 registry（已有 `registry=` 则替换，否则追加）。
 */
export function ensureNpmrcRegistry(content: string, registry: string): string {
  const line = `registry=${registry}`
  if (/^registry\s*=/m.test(content)) {
    return content.replace(/^registry\s*=.*$/m, line)
  }
  const trimmed = content.trimEnd()
  return trimmed.length === 0 ? `${line}\n` : `${trimmed}\n${line}\n`
}

function resolvePnpmCjs(): string {
  // pnpm 的 exports 仅暴露 "." -> package.json，不能 resolve 'pnpm/package.json'
  const packageJsonPath = require.resolve('pnpm')
  return rewriteAsarSymlinkTarget(
    path.join(path.dirname(packageJsonPath), 'bin', 'pnpm.cjs'),
  )
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function winQuote(value: string): string {
  return `"${value.replace(/"/g, '')}"`
}

/**
 * 在指定目录写入 `node` / `pnpm` 包装脚本，统一走 Electron 内置 Node
 *（`ELECTRON_RUN_AS_NODE=1`），避免依赖用户或 CI 预装 Node/pnpm。
 *
 * DSH 的 `plugin` 子命令通过 `spawnSync("pnpm")` 查找可执行文件。
 */
export function ensurePluginToolsBinDir(
  binDir: string,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string {
  fsSync.mkdirSync(binDir, { recursive: true })
  const pnpmCjs = resolvePnpmCjs()

  if (platform === 'win32') {
    const exe = winQuote(execPath)
    const script = winQuote(pnpmCjs)
    fsSync.writeFileSync(
      path.join(binDir, 'node.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${exe} %*\r\n`,
      'utf-8',
    )
    fsSync.writeFileSync(
      path.join(binDir, 'pnpm.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${exe} ${script} %*\r\n`,
      'utf-8',
    )
    return binDir
  }

  const quotedExec = shellSingleQuote(execPath)
  const quotedPnpm = shellSingleQuote(pnpmCjs)
  fsSync.writeFileSync(
    path.join(binDir, 'node'),
    `#!/bin/bash\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quotedExec} "$@"\n`,
    { encoding: 'utf-8', mode: 0o755 },
  )
  fsSync.writeFileSync(
    path.join(binDir, 'pnpm'),
    `#!/bin/bash\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quotedExec} ${quotedPnpm} "$@"\n`,
    { encoding: 'utf-8', mode: 0o755 },
  )
  return binDir
}

export function prependPathEntry(binDir: string, existingPath = ''): string {
  if (existingPath.length === 0) return binDir
  return `${binDir}${path.delimiter}${existingPath}`
}

/**
 * 为 DSH CLI / Harness 子进程注入内置 pnpm 所在 PATH，以及中国 npm 镜像。
 */
export function createPluginToolsEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const binDir = path.join(app.getPath('userData'), 'plugin-tools', 'bin')
  ensurePluginToolsBinDir(binDir)
  const registry = resolvePluginNpmRegistry(baseEnv)
  return {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: prependPathEntry(binDir, baseEnv.PATH ?? ''),
    npm_config_registry: registry,
    NPM_CONFIG_REGISTRY: registry,
  }
}
