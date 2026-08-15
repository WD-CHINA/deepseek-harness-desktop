import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDshBin } from './harness-runtime.js'

const PLUGIN_NAME = 'dsh-better-sidebar'

function getDshHome(): string {
  return path.join(app.getPath('userData'), 'dsh')
}

function getProfileDir(): string {
  return path.join(getDshHome(), 'profiles', 'web')
}

/**
 * 检查 better-sidebar 插件是否已安装在 DSH web profile 中。
 * 通过检查 profile 目录下的 package.json 是否包含插件依赖来判断。
 */
export async function isPluginInstalled(): Promise<boolean> {
  const pkgPath = path.join(getProfileDir(), 'package.json')
  try {
    const content = await fs.readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return (
      pkg.dependencies?.[PLUGIN_NAME] !== undefined ||
      pkg.devDependencies?.[PLUGIN_NAME] !== undefined
    )
  } catch {
    return false
  }
}

/**
 * 确保 profile 目录及其基础配置存在。
 * 若 profile 尚未初始化，创建最小化的 package.json 与 cordis.patch.yml，
 * 使后续 `dsh plugin add` 命令可以正常运行。
 */
async function ensureProfileInitialized(): Promise<void> {
  const profileDir = getProfileDir()
  await fs.mkdir(profileDir, { recursive: true })

  // 确保 package.json 存在
  const pkgPath = path.join(profileDir, 'package.json')
  try {
    await fs.access(pkgPath)
  } catch {
    await fs.writeFile(
      pkgPath,
      JSON.stringify(
        {
          name: 'dsh-web-profile',
          version: '1.0.0',
          private: true,
          dependencies: {},
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    )
  }

  // 确保 pnpm-workspace.yaml 存在
  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml')
  try {
    await fs.access(workspacePath)
  } catch {
    await fs.writeFile(workspacePath, 'packages: []\n', 'utf-8')
  }
}

/**
 * 确保 pnpm-workspace.yaml 中包含 minimumReleaseAgeExclude 配置，
 * 避免 pnpm 拦截发布时间不足 24 小时的新版本。
 */
async function ensureMinimumReleaseAgeExclude(): Promise<void> {
  const workspacePath = path.join(getProfileDir(), 'pnpm-workspace.yaml')
  let content: string
  try {
    content = await fs.readFile(workspacePath, 'utf-8')
  } catch {
    content = ''
  }

  if (content.includes(PLUGIN_NAME)) return

  const addition = `\nminimumReleaseAgeExclude:\n  - ${PLUGIN_NAME}\n`
  if (content.includes('minimumReleaseAgeExclude')) {
    // 键已存在，追加条目
    content = content.replace(
      /(minimumReleaseAgeExclude:\s*\n)/,
      `$1  - ${PLUGIN_NAME}\n`,
    )
  } else {
    content += addition
  }

  await fs.writeFile(workspacePath, content, 'utf-8')
}

/**
 * 执行 Electron 内置 Node.js 运行 DSH CLI 命令。
 */
function runDshCommand(args: string[], timeoutMs = 120_000): Promise<string> {
  const dshBin = resolveDshBin()
  const dshHome = getDshHome()

  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      ['--expose-internals', dshBin, ...args],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HOME: dshHome,
        },
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(
            new Error(
              `DSH 命令失败: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          )
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * 在 pnpm-workspace.yaml 中设置 allowBuilds 白名单，
 * 规避 pnpm 11 对构建脚本的默认拦截。
 *
 * DSH 初始化 profile 后会生成形如：
 *   allowBuilds:
 *     node-pty: set this to true or false
 * 的占位提示。本函数将占位值替换为 true，并追加缺失的包。
 */
async function approveBuildScripts(): Promise<void> {
  const profileDir = getProfileDir()
  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml')

  let content = ''
  try {
    content = await fs.readFile(workspacePath, 'utf-8')
  } catch {
    // 文件不存在
  }

  const requiredPackages = ['node-pty', 'protobufjs']

  if (content.includes('allowBuilds')) {
    // allowBuilds 键已存在，将占位值替换为 true 并补充缺失包
    for (const pkg of requiredPackages) {
      // 替换 "pkg: set this to true or false" → "pkg: true"
      content = content.replace(
        new RegExp(`(\\s+)${pkg}:\\s*set this to true or false`),
        `$1${pkg}: true`,
      )
      // 若包不在 allowBuilds 中，追加到末尾
      if (!new RegExp(`allowBuilds:[\\s\\S]*?${pkg}:`).test(content)) {
        content = content.replace(
          /(allowBuilds:\s*\n)/,
          `$1  ${pkg}: true\n`,
        )
      }
    }
  } else {
    // 没有 allowBuilds 键，追加整段
    const lines = requiredPackages.map((pkg) => `  ${pkg}: true`).join('\n')
    content += `\nallowBuilds:\n${lines}\n`
  }

  await fs.writeFile(workspacePath, content, 'utf-8')
}

/**
 * 安装 better-sidebar 插件到 DSH web profile。
 *
 * 流程：
 * 1. 确保 profile 目录已初始化
 * 2. 写入构建脚本白名单与版本限制配置
 * 3. 调用 `dsh plugin --profile web add dsh-better-sidebar`
 *
 * 安装失败时抛出错误，调用方应捕获并优雅降级（DSH 仍然可以在没有侧边栏的情况下运行）。
 */
export async function installBetterSidebar(): Promise<void> {
  const profileDir = getProfileDir()

  console.log(`[plugin-installer] Profile 目录: ${profileDir}`)

  // 1. 确保 profile 基础结构存在
  await ensureProfileInitialized()

  // 2. 预写构建脚本白名单
  await approveBuildScripts()

  // 3. 确保 minimumReleaseAgeExclude 包含插件名
  await ensureMinimumReleaseAgeExclude()

  // 4. 通过 DSH CLI 安装插件（幂等，可安全重复执行）
  console.log(`[plugin-installer] 正在安装 ${PLUGIN_NAME}...`)
  await runDshCommand(['plugin', '--profile', 'web', 'add', PLUGIN_NAME])
  console.log(`[plugin-installer] ${PLUGIN_NAME} 安装完成`)
}
