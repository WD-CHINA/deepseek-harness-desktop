import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveDshBin } from './harness-runtime.js'

/**
 * 桌面版内置插件列表。
 * 首次启动时自动安装到 DSH web profile，后续启动由 Harness 自动加载。
 */
const BUNDLED_PLUGINS = ['dsh-better-sidebar', 'dshmarket'] as const

/**
 * 不应出现在 web profile 中的包（终端 TUI 与 web 基础包冲突）。
 * 这些包可能在插件安装过程中被意外拉入。
 */
const INCOMPATIBLE_PACKAGES = ['@deepseek-harness-tui/dsh-tui'] as const

function getDshHome(): string {
  return path.join(app.getPath('userData'), 'dsh')
}

function getProfileDir(): string {
  return path.join(getDshHome(), 'profiles', 'web')
}

/**
 * 检查指定插件是否已安装在 DSH web profile 中。
 * 通过检查 profile 目录下的 package.json 是否包含插件依赖来判断。
 */
export async function isPluginInstalled(pluginName: string): Promise<boolean> {
  const pkgPath = path.join(getProfileDir(), 'package.json')
  try {
    const content = await fs.readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return (
      pkg.dependencies?.[pluginName] !== undefined ||
      pkg.devDependencies?.[pluginName] !== undefined
    )
  } catch {
    return false
  }
}

/**
 * 确保 profile 目录及其基础配置存在。
 * 若 profile 尚未初始化，创建最小化的 package.json 与 pnpm-workspace.yaml，
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
async function ensureMinimumReleaseAgeExclude(pluginName: string): Promise<void> {
  const workspacePath = path.join(getProfileDir(), 'pnpm-workspace.yaml')
  let content: string
  try {
    content = await fs.readFile(workspacePath, 'utf-8')
  } catch {
    content = ''
  }

  if (content.includes(pluginName)) return

  const addition = `\nminimumReleaseAgeExclude:\n  - ${pluginName}\n`
  if (content.includes('minimumReleaseAgeExclude')) {
    // 键已存在，追加条目
    content = content.replace(
      /(minimumReleaseAgeExclude:\s*\n)/,
      `$1  - ${pluginName}\n`,
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

  // 将所有 "pkg: set this to true or false" 占位替换为 "pkg: true"
  content = content.replace(
    /(\S+):\s*set this to true or false/g,
    '$1: true',
  )

  // 确保关键包在 allowBuilds 白名单中
  const requiredPackages = ['node-pty', 'protobufjs', 'cloudflared', 'cpu-features', 'ssh2']

  if (content.includes('allowBuilds')) {
    for (const pkg of requiredPackages) {
      if (!new RegExp(`allowBuilds:[\\s\\S]*?${pkg}:`).test(content)) {
        content = content.replace(
          /(allowBuilds:\s*\n)/,
          `$1  ${pkg}: true\n`,
        )
      }
    }
  } else {
    const lines = requiredPackages.map((pkg) => `  ${pkg}: true`).join('\n')
    content += `\nallowBuilds:\n${lines}\n`
  }

  await fs.writeFile(workspacePath, content, 'utf-8')
}

/**
 * 安装单个插件到 DSH web profile。
 *
 * 流程：
 * 1. 确保 minimumReleaseAgeExclude 包含插件名
 * 2. 调用 `dsh plugin --profile web add <pluginName>`
 */
async function installPlugin(pluginName: string): Promise<void> {
  await ensureMinimumReleaseAgeExclude(pluginName)

  console.log(`[plugin-installer] 正在安装 ${pluginName}...`)
  await runDshCommand(['plugin', '--profile', 'web', 'add', pluginName])
  console.log(`[plugin-installer] ${pluginName} 安装完成`)
}

/**
 * 从 web profile 中移除不兼容的包（dependencies 和 bundles）。
 * 防止终端 TUI 等包与 web 基础包产生加载器条目冲突。
 */
export async function stripIncompatiblePackages(): Promise<void> {
  const pkgPath = path.join(getProfileDir(), 'package.json')
  let content: string
  try {
    content = await fs.readFile(pkgPath, 'utf-8')
  } catch {
    return
  }

  let pkg: {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  try {
    pkg = JSON.parse(content) as typeof pkg
  } catch {
    return
  }

  let changed = false

  for (const incompatible of INCOMPATIBLE_PACKAGES) {
    if (pkg.dependencies?.[incompatible] !== undefined) {
      delete pkg.dependencies[incompatible]
      changed = true
      console.log(`[plugin-installer] 已移除不兼容依赖: ${incompatible}`)
    }

    const bundles = pkg.dsh?.profile?.bundles
    if (bundles !== undefined) {
      const idx = bundles.indexOf(incompatible)
      if (idx >= 0) {
        bundles.splice(idx, 1)
        changed = true
        console.log(`[plugin-installer] 已移除不兼容 bundle: ${incompatible}`)
      }
    }
  }

  if (changed) {
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
  }
}

/**
 * 修补 node-pty 的 conpty_console_list_agent.js，
 * 使其在 ELECTRON_RUN_AS_NODE=1 环境下调用 AttachConsole() 失败时
 * 返回空列表而非崩溃退出。
 *
 * 根因：node-pty 在 Windows 上通过 fork 子进程调用原生 AttachConsole API
 * 来获取控制台进程列表，但 Electron 子进程没有可附加的控制台，
 * 导致 DSH 整个进程树崩溃退出（exit code 1）。
 */
export async function patchNodePtyConptyAgent(): Promise<void> {
  const agentPath = path.join(
    getProfileDir(),
    'node_modules',
    'node-pty',
    'lib',
    'conpty_console_list_agent.js',
  )

  let content: string
  try {
    content = await fs.readFile(agentPath, 'utf-8')
  } catch {
    // node-pty 未安装或文件不存在，无需修补
    return
  }

  // 已打过补丁则跳过
  if (content.includes('ELECTRON_CONPTY_PATCHED')) return

  // 将 `var consoleProcessList = getConsoleProcessList(shellPid);`
  // 替换为 try/catch 包裹版本
  const original = 'var consoleProcessList = getConsoleProcessList(shellPid);'
  const patched = [
    '// ELECTRON_CONPTY_PATCHED: AttachConsole fails under ELECTRON_RUN_AS_NODE',
    'var consoleProcessList;',
    'try { consoleProcessList = getConsoleProcessList(shellPid); } catch (_e) {',
    '  process.send({ consoleProcessList: [] });',
    '  process.exit(0);',
    '}',
  ].join('\n')

  if (!content.includes(original)) {
    console.warn('[plugin-installer] node-pty conpty_console_list_agent.js 格式不匹配，跳过修补')
    return
  }

  content = content.replace(original, patched)
  await fs.writeFile(agentPath, content, 'utf-8')
  console.log('[plugin-installer] 已修补 node-pty conpty_console_list_agent.js（AttachConsole 兼容）')
}

/**
 * 安装所有内置插件到 DSH web profile。
 *
 * 流程：
 * 1. 确保 profile 目录已初始化
 * 2. 写入构建脚本白名单
 * 3. 逐个安装尚未安装的插件
 *
 * 每个插件独立 try/catch，单个插件安装失败不影响其他插件。
 * 返回成功安装的插件名列表。
 */
export async function installBundledPlugins(): Promise<string[]> {
  const profileDir = getProfileDir()
  console.log(`[plugin-installer] Profile 目录: ${profileDir}`)

  // 1. 确保 profile 基础结构存在
  await ensureProfileInitialized()

  // 2. 预写构建脚本白名单
  await approveBuildScripts()

  // 3. 移除与 web 基础包冲突的包（如 dsh-tui）
  await stripIncompatiblePackages()

  // 4. 逐个检查并安装插件
  const installed: string[] = []

  for (const pluginName of BUNDLED_PLUGINS) {
    try {
      const alreadyInstalled = await isPluginInstalled(pluginName)
      if (alreadyInstalled) {
        console.log(`[plugin-installer] ${pluginName} 已安装，跳过`)
        installed.push(pluginName)
        continue
      }

      await installPlugin(pluginName)
      installed.push(pluginName)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[plugin-installer] ${pluginName} 安装失败（不影响其他插件）：${message}`)
    }
  }

  // 5. 修补 node-pty 原生模块兼容性（每次安装后执行）
  await patchNodePtyConptyAgent()

  return installed
}

/**
 * 每次应用启动时（DSH 启动前）的 profile 预检与修补。
 *
 * 覆盖场景：
 * - 首次启动：内置插件尚未安装，profile 可能不存在
 * - 后续启动：用户通过 dshmarket 安装了新插件，可能引入新的原生构建脚本
 * - 任何启动：node-pty 可能被更新，需要重新打补丁
 *
 * 流程：
 * 1. 确保 profile 目录存在
 * 2. 批准所有原生构建脚本（包括 dshmarket 新增的包）
 * 3. 移除与 web 基础包冲突的包
 * 4. 修补 node-pty 的 AttachConsole 兼容性
 */
export async function prepareProfile(): Promise<void> {
  await ensureProfileInitialized()
  await approveBuildScripts()
  await stripIncompatiblePackages()
  await patchNodePtyConptyAgent()
}
