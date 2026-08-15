import { describe, expect, it } from 'vitest'
import { createTerminationPlan } from './process-tree.js'

describe('createTerminationPlan', () => {
  it('uses taskkill /F to stop the complete Windows process tree', () => {
    // Windows 上 taskkill /T 在目标进程是当前进程的子进程时必须使用 /F，
    // 因此统一使用 /F 参数。
    expect(createTerminationPlan(42, false, 'win32')).toEqual({
      kind: 'command',
      file: 'taskkill.exe',
      args: ['/PID', '42', '/T', '/F'],
    })

    expect(createTerminationPlan(42, true, 'win32')).toEqual({
      kind: 'command',
      file: 'taskkill.exe',
      args: ['/PID', '42', '/T', '/F'],
    })
  })

  it.each(['darwin', 'linux'] as const)('signals the Unix process group on %s', (platform) => {
    expect(createTerminationPlan(42, false, platform)).toEqual({
      kind: 'signal',
      pid: -42,
      signal: 'SIGTERM',
    })
    expect(createTerminationPlan(42, true, platform)).toEqual({
      kind: 'signal',
      pid: -42,
      signal: 'SIGKILL',
    })
  })

  it('rejects invalid process IDs before constructing a command', () => {
    expect(() => createTerminationPlan(0, false, 'win32')).toThrow(RangeError)
    expect(() => createTerminationPlan(-1, false, 'darwin')).toThrow(RangeError)
  })
})
