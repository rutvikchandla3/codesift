import { parseToken } from './token'

export function enqueueToken(raw: string): string {
  const claims = parseToken(raw)
  return `${claims.subject}:${claims.scope}`
}
