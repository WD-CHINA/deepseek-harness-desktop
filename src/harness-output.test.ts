import { describe, expect, it } from 'vitest'
import {
  appendTail,
  findHarnessUrl,
  hasSameOrigin,
  isAllowedExternalUrl,
} from './harness-output.js'

describe('findHarnessUrl', () => {
  it('extracts the random loopback port from the ready line', () => {
    expect(findHarnessUrl('booting\ndsh web: http://127.0.0.1:58224\n')).toBe(
      'http://127.0.0.1:58224',
    )
  })

  it('rejects non-loopback and incomplete output', () => {
    expect(findHarnessUrl('dsh web: http://0.0.0.0:3080')).toBeUndefined()
    expect(findHarnessUrl('dsh web: http://127.0.0.1:')).toBeUndefined()
  })
})

describe('appendTail', () => {
  it('keeps only the configured diagnostic tail', () => {
    expect(appendTail('1234', '5678', 5)).toBe('45678')
  })
})

describe('navigation policy', () => {
  it('allows only the Harness origin in the main window', () => {
    expect(hasSameOrigin('http://127.0.0.1:3080/settings', 'http://127.0.0.1:3080')).toBe(true)
    expect(hasSameOrigin('http://127.0.0.1:4000', 'http://127.0.0.1:3080')).toBe(false)
    expect(hasSameOrigin('not a url', 'http://127.0.0.1:3080')).toBe(false)
  })

  it('opens only HTTP(S) URLs externally', () => {
    expect(isAllowedExternalUrl('https://github.com/deepseek-ai/deepseek-harness')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
