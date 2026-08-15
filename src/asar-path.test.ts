import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rewriteAsarSymlinkTarget, rewriteAsarSymlinksInTree } from './asar-path.js'

describe('rewriteAsarSymlinkTarget', () => {
  it('rewrites app.asar module paths to app.asar.unpacked', () => {
    expect(
      rewriteAsarSymlinkTarget(
        '/App/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh-session-persistence-jsonl',
      ),
    ).toBe(
      '/App/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-session-persistence-jsonl',
    )
  })

  it('does not double-rewrite already unpacked paths', () => {
    const unpacked =
      '/App/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh'
    expect(rewriteAsarSymlinkTarget(unpacked)).toBe(unpacked)
  })

  it('leaves non-asar paths unchanged', () => {
    const plain = '/App/Contents/Resources/app/node_modules/@deepseek-ai/dsh'
    expect(rewriteAsarSymlinkTarget(plain)).toBe(plain)
  })
})

describe('rewriteAsarSymlinksInTree', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rewrites nested symlinks that point into app.asar', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-asar-links-'))
    tempDirs.push(root)
    const scoped = path.join(root, '@deepseek-ai')
    fs.mkdirSync(scoped, { recursive: true })
    const link = path.join(scoped, 'dsh-base')
    fs.symlinkSync(
      '/App/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh-base',
      link,
    )

    expect(rewriteAsarSymlinksInTree(root)).toBe(1)
    expect(fs.readlinkSync(link)).toBe(
      '/App/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-base',
    )
  })
})
