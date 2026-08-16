import {
  installDshPlugin,
  listDshPlugins,
  removeDshPlugin,
} from './plugin-installer.js'

export type CliCommand =
  | { type: 'plugin-add'; spec: string }
  | { type: 'plugin-remove'; name: string }
  | { type: 'plugin-list' }

/**
 * 从包规格中提取插件名称（不含版本号）。
 *
 * 兼容格式：
 * - `foo` → `foo`
 * - `foo@1.2.3` → `foo`
 * - `@scope/foo` → `@scope/foo`
 * - `@scope/foo@1.2.3` → `@scope/foo`
 */
export function getPluginNameFromSpec(spec: string): string {
  const value = spec.trim()

  if (value.startsWith('@')) {
    const slash = value.indexOf('/')

    if (slash < 0) {
      throw new Error(`无效的插件包名: ${spec}`)
    }

    const versionSeparator = value.indexOf('@', slash)

    return versionSeparator < 0
      ? value
      : value.slice(0, versionSeparator)
  }

  const versionSeparator = value.lastIndexOf('@')

  return versionSeparator > 0
    ? value.slice(0, versionSeparator)
    : value
}

/**
 * 解析 CLI 参数，提取 plugin 子命令。
 * 返回 undefined 表示未检测到 plugin 子命令（GUI 模式）。
 */
export function parseCliCommand(argv: string[]): CliCommand | undefined {
  const pluginIndex = argv.indexOf('plugin')

  if (pluginIndex < 0) {
    return undefined
  }

  const action = argv[pluginIndex + 1]
  const value = argv[pluginIndex + 2]

  switch (action) {
    case 'add':
      if (!value) {
        throw new Error('用法: plugin add <package[@version]>')
      }
      return { type: 'plugin-add', spec: value }

    case 'remove':
      if (!value) {
        throw new Error('用法: plugin remove <package>')
      }
      return { type: 'plugin-remove', name: value }

    case 'list':
      return { type: 'plugin-list' }

    default:
      throw new Error(`未知 plugin 子命令: ${action ?? ''}`)
  }
}

/** CLI --help 输出文本。 */
export const CLI_HELP_TEXT = `DeepSeek Harness Desktop

Usage:
  dsh-desktop [options]
  dsh-desktop plugin <command>

Plugin commands:
  plugin add <package[@version]>
      Install a plugin into the desktop web profile.

  plugin remove <package>
      Remove a plugin from the desktop web profile.

  plugin list
      List installed plugins.

Options:
  --workspace <path>
      Set initial workspace.

  --help
      Show this help.
`

/** 执行 CLI 命令并输出结果。 */
export async function runCliCommand(command: CliCommand): Promise<void> {
  switch (command.type) {
    case 'plugin-add':
      console.log(`正在安装插件: ${command.spec}`)
      await installDshPlugin(command.spec)
      console.log(`插件安装成功: ${command.spec}`)
      return

    case 'plugin-remove':
      console.log(`正在卸载插件: ${command.name}`)
      await removeDshPlugin(command.name)
      console.log(`插件卸载成功: ${command.name}`)
      return

    case 'plugin-list': {
      const output = await listDshPlugins()
      process.stdout.write(output)
      return
    }
  }
}
