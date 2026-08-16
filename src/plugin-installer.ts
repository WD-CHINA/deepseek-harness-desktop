import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildDshNodeArgs } from './harness-runtime.js'
import { rewriteAsarSymlinksInTree } from './asar-path.js'
import {
  createPluginToolsEnv,
  ensureNpmrcRegistry,
  resolvePluginNpmRegistry,
} from './plugin-tools.js'

/**
 * 桌面版内置插件列表（精确版本，与 DSH/依赖锁定策略一致）。
 * 首次启动安装；后续启动若低于目标版本则升级。
 */
export const BUNDLED_PLUGINS = [
  { name: 'dsh-better-sidebar', version: '0.12.2' },
  { name: 'dshmarket', version: '1.5.0' },
  { name: '@linxin666/dsh-web-ui-all', version: '0.1.15' },
] as const

export type BundledPlugin = (typeof BUNDLED_PLUGINS)[number]

/**
 * 不应出现在 web profile 中的包（终端 TUI 与 web 基础包冲突）。
 * 这些包可能在插件安装过程中被意外拉入。
 */
const INCOMPATIBLE_PACKAGES = ['@deepseek-harness-tui/dsh-tui'] as const

/**
 * 与 `@deepseek-ai/dsh-app-boot` 的 `PROFILE_TEMPLATES.web` 保持一致。
 * 缺少这些 bundles 时，`dsh web` 会以空组合启动并永远无法就绪。
 */
export const WEB_PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
] as const

/**
 * 与 `@deepseek-ai/dsh-app-boot` 的 `PROFILE_PNPM_WORKSPACE` 保持一致。
 */
export const WEB_PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

export type ProfileManifest = {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

function getDshHome(): string {
  return path.join(app.getPath('userData'), 'dsh')
}

function getProfileDir(): string {
  return path.join(getDshHome(), 'profiles', 'web')
}

/** 生成与 DSH `initProfile(web)` 等价的最小化 manifest。 */
export function createWebProfileManifest(): ProfileManifest {
  return {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_PROFILE_BUNDLES] } },
  }
}

/**
 * 修复缺少 `dsh.profile.bundles` 的损坏 profile。
 * 早期版本曾写入空 package.json，导致 DSH 跳过 web 模板初始化。
 * 若已有 bundles 则返回 undefined（无需改写）。
 */
export function healWebProfileManifest(
  manifest: ProfileManifest,
): ProfileManifest | undefined {
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.length > 0) return undefined

  return {
    ...manifest,
    name: manifest.name ?? 'dsh-profile-web',
    private: manifest.private ?? true,
    dependencies: manifest.dependencies ?? {},
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh?.profile,
        bundles: [...WEB_PROFILE_BUNDLES],
      },
    },
  }
}

/**
 * 检查是否所有内置插件都已安装到目标版本。
 * 用于判断是否为首次启动 / 需要前台升级。
 */
export async function allBundledPluginsInstalled(): Promise<boolean> {
  for (const plugin of BUNDLED_PLUGINS) {
    if ((await getInstalledPluginVersion(plugin.name)) !== plugin.version) {
      return false
    }
  }
  return true
}

/**
 * 检查指定插件是否已出现在 DSH web profile 的 package.json 依赖中。
 */
export async function isPluginInstalled(pluginName: string): Promise<boolean> {
  return (await getInstalledPluginVersion(pluginName)) !== undefined
}

/** 读取 profile node_modules 中已安装插件的实际版本。 */
export async function getInstalledPluginVersion(
  pluginName: string,
): Promise<string | undefined> {
  const pkgPath = path.join(getProfileDir(), 'node_modules', pluginName, 'package.json')
  try {
    const content = await fs.readFile(pkgPath, 'utf-8')
    const pkg = JSON.parse(content) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** 生成 `dsh plugin add` 使用的精确版本规格。 */
export function bundledPluginSpec(plugin: BundledPlugin): string {
  return `${plugin.name}@${plugin.version}`
}

/**
 * 确保 profile 目录及其基础配置存在。
 * package.json / pnpm-workspace.yaml 必须与 DSH `initProfile(web)` 对齐：
 * 若只写空 package.json，DSH 会认为 profile 已初始化并跳过 web 模板，
 * 导致 `dsh web` 没有 base/web-app bundles，启动永远无法就绪。
 */
async function ensureProfileInitialized(): Promise<void> {
  const profileDir = getProfileDir()
  await fs.mkdir(profileDir, { recursive: true })

  const pkgPath = path.join(profileDir, 'package.json')
  try {
    const raw = await fs.readFile(pkgPath, 'utf-8')
    const healed = healWebProfileManifest(JSON.parse(raw) as ProfileManifest)
    if (healed !== undefined) {
      await fs.writeFile(pkgPath, JSON.stringify(healed, null, 2) + '\n', 'utf-8')
      console.log('[plugin-installer] 已修复缺少 web bundles 的 profile manifest')
    }
  } catch {
    await fs.writeFile(
      pkgPath,
      JSON.stringify(createWebProfileManifest(), null, 2) + '\n',
      'utf-8',
    )
  }

  const workspacePath = path.join(profileDir, 'pnpm-workspace.yaml')
  try {
    await fs.access(workspacePath)
  } catch {
    await fs.writeFile(workspacePath, WEB_PROFILE_PNPM_WORKSPACE, 'utf-8')
  }

  // 写入中国 npm 镜像，供 profile 内 pnpm / dshmarket 安装使用
  const npmrcPath = path.join(profileDir, '.npmrc')
  const registry = resolvePluginNpmRegistry()
  let npmrc = ''
  try {
    npmrc = await fs.readFile(npmrcPath, 'utf-8')
  } catch {
    // 文件不存在
  }
  const nextNpmrc = ensureNpmrcRegistry(npmrc, registry)
  if (nextNpmrc !== npmrc) {
    await fs.writeFile(npmrcPath, nextNpmrc, 'utf-8')
    console.log(`[plugin-installer] 已配置 npm registry: ${registry}`)
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
  const dshHome = getDshHome()

  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      buildDshNodeArgs(args),
      {
        env: {
          ...createPluginToolsEnv(),
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
 * 在 pnpm-workspace.yaml 中设置 `allowBuilds: true`，
 * 自动批准所有原生模块的构建脚本，无需维护白名单。
 *
 * pnpm 11+ 默认拦截所有构建脚本，逐个包确认太繁琐。
 * 桌面版 profile 仅用于 DSH 插件，不存在供应链攻击风险，
 * 因此直接全局允许。
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

  // 移除所有 "pkg: set this to true or false" 占位行
  content = content.replace(
    /^\s*\S+:\s*set this to true or false\s*$/gm,
    '',
  )

  // 将已有的 allowBuilds 块（含逐包列表）替换为全局 true
  if (/^allowBuilds:\s*$/m.test(content)) {
    content = content.replace(
      /^allowBuilds:\s*\n(?:(?:\s+\S+:.*(?:\n|$))*)/,
      'allowBuilds: true\n',
    )
  } else if (/^allowBuilds:\s+true\s*$/m.test(content)) {
    // 已经是 allowBuilds: true，无需修改
  } else {
    // 不存在 allowBuilds 键，追加
    content += '\nallowBuilds: true\n'
  }

  await fs.writeFile(workspacePath, content, 'utf-8')
}

/**
 * 安装单个插件到 DSH web profile。
 *
 * 流程：
 * 1. 确保 minimumReleaseAgeExclude 包含插件名
 * 2. 调用 `dsh plugin --profile web add <name>@<version>`
 */
async function installPlugin(plugin: BundledPlugin): Promise<void> {
  await ensureMinimumReleaseAgeExclude(plugin.name)

  const spec = bundledPluginSpec(plugin)
  console.log(`[plugin-installer] 正在安装 ${spec}...`)
  await runDshCommand(['plugin', '--profile', 'web', 'add', spec])
  console.log(`[plugin-installer] ${spec} 安装完成`)
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
 * 3. 逐个安装或升级到目标精确版本
 *
 * 每个插件独立 try/catch，单个插件安装失败不影响其他插件。
 * 返回成功安装（含已是目标版本而跳过）的插件名列表。
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

  // 4. 逐个检查并安装 / 升级插件
  const installed: string[] = []

  for (const plugin of BUNDLED_PLUGINS) {
    try {
      const current = await getInstalledPluginVersion(plugin.name)
      if (current === plugin.version) {
        console.log(
          `[plugin-installer] ${plugin.name}@${plugin.version} 已安装，跳过`,
        )
        installed.push(plugin.name)
        continue
      }

      if (current !== undefined) {
        console.log(
          `[plugin-installer] ${plugin.name} 将从 ${current} 升级到 ${plugin.version}`,
        )
      }

      await installPlugin(plugin)
      installed.push(plugin.name)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `[plugin-installer] ${plugin.name}@${plugin.version} 安装失败（不影响其他插件）：${message}`,
      )
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
 * 5. 修正指向 app.asar 的损坏模块软链
 */
/**
 * 安装任意 DSH 插件到 web profile。
 *
 * 流程：
 * 1. 初始化桌面版 web profile
 * 2. 避免 pnpm minimumReleaseAge 阻止新发布插件
 * 3. 处理已有原生模块构建权限
 * 4. 调用官方 DSH CLI 安装
 * 5. 安装完成后执行兼容性修复
 */
export async function installDshPlugin(spec: string): Promise<void> {
  const normalized = spec.trim()

  if (!normalized || normalized.startsWith('-')) {
    throw new Error(`无效的插件规格: ${spec}`)
  }

  const pluginName = getPluginNameFromSpec(normalized)

  console.log(`[plugin-installer] 准备安装插件: ${normalized}`)

  await ensureProfileInitialized()
  await ensureMinimumReleaseAgeExclude(pluginName)
  await approveBuildScripts()

  await runDshCommand(
    ['plugin', '--profile', 'web', 'add', normalized],
    300_000,
  )

  await prepareProfile()

  console.log(`[plugin-installer] 插件安装成功: ${normalized}`)
}

/**
 * 从 web profile 中卸载指定插件。
 */
export async function removeDshPlugin(pluginName: string): Promise<void> {
  const normalized = pluginName.trim()

  if (!normalized || normalized.startsWith('-')) {
    throw new Error(`无效的插件名称: ${pluginName}`)
  }

  await runDshCommand([
    'plugin',
    '--profile',
    'web',
    'remove',
    normalized,
  ])

  await prepareProfile()

  console.log(`[plugin-installer] 插件卸载成功: ${normalized}`)
}

/**
 * 列出 web profile 中已安装的插件。
 */
export async function listDshPlugins(): Promise<string> {
  return await runDshCommand(['plugin', '--profile', 'web', 'list'], 30_000)
}

/**
 * 从包规格中提取插件名称（不含版本号）。
 */
export function getPluginNameFromSpec(spec: string): string {
  const value = spec.trim()

  if (value.startsWith('@')) {
    const slash = value.indexOf('/')
    if (slash < 0) {
      throw new Error(`无效的插件包名: ${spec}`)
    }
    const versionSeparator = value.indexOf('@', slash)
    return versionSeparator < 0 ? value : value.slice(0, versionSeparator)
  }

  const versionSeparator = value.lastIndexOf('@')
  return versionSeparator > 0 ? value.slice(0, versionSeparator) : value
}

export async function prepareProfile(): Promise<void> {
  // 首次启动时 profile 尚未初始化，跳过预检。
  // 后台 installBundledPlugins() 会完成完整初始化，DSH 下次启动时加载。
  const pkgPath = path.join(getProfileDir(), 'package.json')
  try {
    await fs.access(pkgPath)
  } catch {
    console.log('[plugin-installer] profile 尚未初始化，跳过预检')
    return
  }

  await ensureProfileInitialized()
  await approveBuildScripts()
  await stripIncompatiblePackages()
  await patchNodePtyConptyAgent()

  const profilesModules = path.join(getDshHome(), 'profiles', 'node_modules')
  const rewritten = rewriteAsarSymlinksInTree(profilesModules)
  if (rewritten > 0) {
    console.log(`[plugin-installer] 已修正 ${rewritten} 个指向 app.asar 的模块软链`)
  }
}
