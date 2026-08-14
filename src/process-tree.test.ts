import { describe, expect, it } from 'vitest'
import { createTerminationPlan } from './process-tree.js'

describe('createTerminationPlan', () => {
  it('uses taskkill to stop the complete Windows process tree', () => {
    expect(createTerminationPlan(42, false, 'win32')).toEqual({
      kind: 'command',
      file: 'taskkill.exe',
      args: ['/PID', '42', '/T'],
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
