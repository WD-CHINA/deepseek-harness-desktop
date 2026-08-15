import { app } from 'electron'
import fsSync from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

function resolvePnpmCjs(): string {
  // pnpm 的 exports 仅暴露 "." -> package.json，不能 resolve 'pnpm/package.json'
  const packageJsonPath = require.resolve('pnpm')
  return path.join(path.dirname(packageJsonPath), 'bin', 'pnpm.cjs')
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
 * 为 DSH CLI / Harness 子进程注入内置 pnpm 所在 PATH。
 */
export function createPluginToolsEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const binDir = path.join(app.getPath('userData'), 'plugin-tools', 'bin')
  ensurePluginToolsBinDir(binDir)
  return {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    PATH: prependPathEntry(binDir, baseEnv.PATH ?? ''),
  }
}
