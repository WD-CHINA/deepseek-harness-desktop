const READY_LINE_PATTERN = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/

/** Returns the loopback Harness URL once the CLI has printed its ready line. */
export function findHarnessUrl(output: string): string | undefined {
  return READY_LINE_PATTERN.exec(output)?.[1]
}

/** Keeps diagnostic buffers bounded while preserving the most recent output. */
export function appendTail(current: string, chunk: string, limit = 16_000): string {
  return `${current}${chunk}`.slice(-limit)
}

export function hasSameOrigin(targetUrl: string, allowedOrigin: string): boolean {
  try {
    return new URL(targetUrl).origin === allowedOrigin
  } catch {
    return false
  }
}

export function isAllowedExternalUrl(targetUrl: string): boolean {
  try {
    const protocol = new URL(targetUrl).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
