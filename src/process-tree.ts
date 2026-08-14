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
    return {
      kind: 'command',
      file: 'taskkill.exe',
      args: ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
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
