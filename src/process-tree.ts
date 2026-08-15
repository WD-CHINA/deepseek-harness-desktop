import { execFile } from 'node:child_process'

export type TerminationPlan =
  | {
      kind: 'command'
      file: string
      args: string[]
    }
  | {
      kind: 'signal'
      pid: number
      signal: NodeJS.Signals
    }

/** Builds a platform-specific plan that targets the complete child process tree. */
export function createTerminationPlan(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
): TerminationPlan {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError(`无效的进程 ID：${pid}`)
  }

  if (platform === 'win32') {
    // taskkill /T 在目标进程是当前进程的子进程时必须使用 /F，
    // 否则会拒绝终止。既然我们总是终止自己创建的子进程树，
    // 统一使用 /F 避免非强制终止失败。
    return {
      kind: 'command',
      file: 'taskkill.exe',
      args: ['/PID', String(pid), '/T', '/F'],
    }
  }

  return {
    kind: 'signal',
    pid: -pid,
    signal: force ? 'SIGKILL' : 'SIGTERM',
  }
}

export async function terminateProcessTree(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const plan = createTerminationPlan(pid, force, platform)

  if (plan.kind === 'signal') {
    process.kill(plan.pid, plan.signal)
    return
  }

  await new Promise<void>((resolve, reject) => {
    execFile(plan.file, plan.args, { windowsHide: true }, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}
