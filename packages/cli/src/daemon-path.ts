import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function getDefaultDaemonSocketPath(): string {
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\codesift-daemon-${process.env.USERNAME ?? 'user'}`
  }

  const user = typeof process.getuid === 'function' ? String(process.getuid()) : process.env.USER ?? 'user'
  return join(tmpdir(), `codesift-daemon-${user}.sock`)
}
