import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appendTail, findHarnessUrl } from './harness-output.js'
import { terminateProcessTree } from './process-tree.js'

const require = createRequire(import.meta.url)
const STARTUP_TIMEOUT_MS = 60_000

export interface HarnessRuntimeOptions {
  workspace: string
  onUnexpectedExit?: (code: number | null, stderr: string) => void
}

export class HarnessRuntime {
  readonly #options: HarnessRuntimeOptions
  #child: ChildProcess | undefined
  #url: string | undefined
  #stderr = ''
  #stopping = false

  constructor(options: HarnessRuntimeOptions) {
    this.#options = options
  }

  get url(): string | undefined {
    return this.#url
  }

  get running(): boolean {
    return this.#child?.pid !== undefined
  }

  async start(): Promise<string> {
    if (this.#url !== undefined && this.running) return this.#url
    if (this.#child !== undefined) {
      throw new Error('DeepSeek Harness 正在启动，请勿重复启动。')
    }

    this.#stopping = false
    this.#stderr = ''

    const child = spawn(
      process.execPath,
      ['--expose-internals', resolveDshBin(), 'web', '--port', '0'],
      {
        cwd: this.#options.workspace,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HOME: path.join(app.getPath('userData'), 'dsh'),
          // Electron 子进程无法使用 koffi 原生绑定（ABI 不兼容），
          // 设置 SSH_CONNECTION 让 DSH 目录选择器降级到浏览器模式
          SSH_CONNECTION: 'electron-desktop',
        },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    this.#child = child

    return await new Promise<string>((resolve, reject) => {
      let stdout = ''
      let settled = false

      const settleError = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }

      const timeout = setTimeout(() => {
        this.#stopping = true
        settleError(
          new Error(`DeepSeek Harness 在 ${STARTUP_TIMEOUT_MS / 1000} 秒内未完成启动。\n${this.#stderr}`),
        )
        void this.#terminateChild(child, false)
      }, STARTUP_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stdout = appendTail(stdout, text)
        process.stdout.write(`[dsh] ${text}`)

        const url = findHarnessUrl(stdout)
        if (url === undefined || settled) return

        settled = true
        clearTimeout(timeout)
        this.#url = url
        resolve(url)
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        this.#stderr = appendTail(this.#stderr, text)
        process.stderr.write(`[dsh] ${text}`)
      })

      child.once('error', (error) => {
        settleError(new Error(`无法启动 DeepSeek Harness 子进程：${error.message}`))
      })

      child.once('exit', (code) => {
        this.#child = undefined
        this.#url = undefined

        if (!settled) {
          settleError(
            new Error(`DeepSeek Harness 启动失败，退出码 ${code}。\n${this.#stderr}`),
          )
          return
        }

        if (!this.#stopping) {
          this.#options.onUnexpectedExit?.(code, this.#stderr)
        }
      })
    })
  }

  async stop(timeoutMs = 6_000): Promise<void> {
    const child = this.#child
    if (child?.pid === undefined) return

    this.#stopping = true

    await new Promise<void>((resolve) => {
      const forceTimeout = setTimeout(() => {
        void this.#terminateChild(child, true)
      }, timeoutMs)
      const giveUpTimeout = setTimeout(resolve, timeoutMs + 1_000)

      child.once('exit', () => {
        clearTimeout(forceTimeout)
        clearTimeout(giveUpTimeout)
        resolve()
      })

      void this.#terminateChild(child, false)
    })

    this.#child = undefined
    this.#url = undefined
  }

  async #terminateChild(child: ChildProcess, force: boolean): Promise<void> {
    const pid = child.pid
    if (pid === undefined) return

    try {
      await terminateProcessTree(pid, force)
    } catch (error) {
      const signal = force ? 'SIGKILL' : 'SIGTERM'
      console.warn(
        `[electron] 无法终止 Harness 进程树，将回退到终止主进程：${String(error)}`,
      )
      child.kill(signal)
    }
  }
}

export function resolveDshBin(): string {
  const packageJson = require.resolve('@deepseek-ai/dsh/package.json')
  return path.join(path.dirname(packageJson), 'lib', 'bin.js')
}
