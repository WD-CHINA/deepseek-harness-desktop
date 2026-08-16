import { describe, expect, it } from 'vitest'
import { getPluginNameFromSpec, parseCliCommand } from './cli.js'

describe('parseCliCommand', () => {
  it('parses plugin add with package name', () => {
    expect(parseCliCommand(['plugin', 'add', 'foo'])).toEqual({
      type: 'plugin-add',
      spec: 'foo',
    })
  })

  it('parses plugin add with versioned package', () => {
    expect(parseCliCommand(['plugin', 'add', 'foo@1.0.0'])).toEqual({
      type: 'plugin-add',
      spec: 'foo@1.0.0',
    })
  })

  it('parses plugin add with scoped package', () => {
    expect(parseCliCommand(['plugin', 'add', '@scope/foo'])).toEqual({
      type: 'plugin-add',
      spec: '@scope/foo',
    })
  })

  it('parses plugin add with scoped and versioned package', () => {
    expect(parseCliCommand(['plugin', 'add', '@scope/foo@1.0.0'])).toEqual({
      type: 'plugin-add',
      spec: '@scope/foo@1.0.0',
    })
  })

  it('parses plugin remove', () => {
    expect(parseCliCommand(['plugin', 'remove', 'foo'])).toEqual({
      type: 'plugin-remove',
      name: 'foo',
    })
  })

  it('parses plugin list', () => {
    expect(parseCliCommand(['plugin', 'list'])).toEqual({
      type: 'plugin-list',
    })
  })

  it('returns undefined when no plugin subcommand', () => {
    expect(parseCliCommand([])).toBeUndefined()
    expect(parseCliCommand(['--help'])).toBeUndefined()
    expect(parseCliCommand(['--workspace', '/tmp'])).toBeUndefined()
  })

  it('throws on plugin add without value', () => {
    expect(() => parseCliCommand(['plugin', 'add'])).toThrow(
      '用法: plugin add',
    )
  })

  it('throws on plugin remove without value', () => {
    expect(() => parseCliCommand(['plugin', 'remove'])).toThrow(
      '用法: plugin remove',
    )
  })

  it('throws on unknown plugin subcommand', () => {
    expect(() => parseCliCommand(['plugin', 'unknown'])).toThrow(
      '未知 plugin 子命令',
    )
  })

  it('throws on plugin without action', () => {
    expect(() => parseCliCommand(['plugin'])).toThrow('未知 plugin 子命令')
  })

  it('handles extra args before plugin keyword', () => {
    expect(
      parseCliCommand(['--workspace', '/tmp', 'plugin', 'add', 'foo']),
    ).toEqual({
      type: 'plugin-add',
      spec: 'foo',
    })
  })
})

describe('getPluginNameFromSpec', () => {
  it('extracts name from simple spec', () => {
    expect(getPluginNameFromSpec('foo')).toBe('foo')
    expect(getPluginNameFromSpec('foo@1.2.3')).toBe('foo')
  })

  it('extracts name from scoped spec', () => {
    expect(getPluginNameFromSpec('@scope/foo')).toBe('@scope/foo')
    expect(getPluginNameFromSpec('@scope/foo@1.2.3')).toBe('@scope/foo')
  })

  it('throws on invalid scoped name without slash', () => {
    expect(() => getPluginNameFromSpec('@invalid')).toThrow('无效的插件包名')
  })
})
