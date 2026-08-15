import fs from 'node:fs'
import path from 'node:path'

/**
 * DSH 的 healProfilesModuleFallback 会把安装目录中的包软链到
 * `$DSH_HOME/profiles/node_modules`。启用 asar 后，require.resolve 仍返回
 * `app.asar/...` 虚拟路径；操作系统无法跟随指向 asar 的符号链接。
 * 将目标改写到 `app.asar.unpacked/...`（需配合 asarUnpack node_modules）。
 */
export function rewriteAsarSymlinkTarget(target: string): string {
  return target.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked')
}

/**
 * 递归修正目录中指向 `app.asar`（非 unpacked）的符号链接。
 * 用于清理旧版本留下的损坏软链；返回改写数量。
 */
export function rewriteAsarSymlinksInTree(rootDir: string): number {
  let changed = 0

  const visit = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (!entry.isSymbolicLink()) continue

      let target: string
      try {
        target = fs.readlinkSync(fullPath)
      } catch {
        continue
      }

      const rewritten = rewriteAsarSymlinkTarget(target)
      if (rewritten === target) continue

      try {
        fs.unlinkSync(fullPath)
        fs.symlinkSync(
          rewritten,
          fullPath,
          process.platform === 'win32' ? 'junction' : undefined,
        )
        changed += 1
      } catch {
        // 单个软链失败不阻断启动
      }
    }
  }

  visit(rootDir)
  return changed
}
