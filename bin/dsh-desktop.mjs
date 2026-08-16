#!/usr/bin/env node

/**
 * dsh-desktop CLI 入口。
 *
 * 用法：
 *   dsh-desktop                          # 启动 GUI
 *   dsh-desktop plugin add <pkg>         # 安装插件
 *   dsh-desktop plugin remove <pkg>      # 卸载插件
 *   dsh-desktop plugin list              # 列出插件
 *   dsh-desktop --help                   # 显示帮助
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 解析项目根目录（bin/ 的上一级）
const projectRoot = path.resolve(__dirname, '..')

// 加载项目的 package.json 以获取 electron 版本
const pkgPath = path.join(projectRoot, 'package.json')
const pkg = JSON.parse(
  require('node:fs').readFileSync(pkgPath, 'utf-8'),
)

// 检查是否已编译
const distMain = path.join(projectRoot, 'dist', 'main.js')
try {
  require('node:fs').accessSync(distMain)
  launchElectron()
} catch {
  console.log('[dsh-desktop] 正在编译 TypeScript...')
  const buildResult = spawn('npm', ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
  })
  buildResult.on('exit', (code) => {
    if (code !== 0) {
      console.error('[dsh-desktop] 编译失败')
      process.exit(code ?? 1)
    }
    launchElectron()
  })
}

function launchElectron() {
  // 解析 electron 可执行文件路径
  const electronPath = require('electron')

  const args = [projectRoot, ...process.argv.slice(2)]

  const child = spawn(electronPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // 确保 Electron 能找到正确的 Node 版本
      ELECTRON_NO_ATTACH_CONSOLE: '0',
    },
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 0)
    }
  })

  // 转发信号
  process.on('SIGINT', () => child.kill('SIGINT'))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
}
