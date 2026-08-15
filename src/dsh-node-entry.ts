import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { rewriteAsarSymlinkTarget } from './asar-path.js'

/**
 * 从 app.asar.unpacked 加载 DSH，使 INSTALL_ANCHOR / require.resolve
 * 返回真实磁盘路径。这样 healProfilesModuleFallback 创建的软链可被 OS 跟随。
 *
 * 注意：不能靠替换 `fs.symlinkSync` —— DSH 使用 ESM named import，
 * 补丁无法作用于 `import { symlinkSync } from "node:fs"`。
 */
async function main(): Promise<void> {
  const dshBinArg = process.argv[2]
  if (dshBinArg === undefined || dshBinArg.length === 0) {
    console.error('dsh-node-entry: missing @deepseek-ai/dsh bin path')
    process.exit(1)
  }

  const dshBin = rewriteAsarSymlinkTarget(
    path.isAbsolute(dshBinArg) ? dshBinArg : path.resolve(dshBinArg),
  )

  // 让 DSH 看到与直接调用 bin.js 相同的 argv：[execPath, bin, ...args]
  const execPath = process.argv[0] ?? process.execPath
  process.argv = [execPath, dshBin, ...process.argv.slice(3)]

  await import(pathToFileURL(dshBin).href)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[dsh-node-entry] ${message}`)
  process.exit(1)
})
