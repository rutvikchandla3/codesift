import { parseToken } from './token'

export function readSubject(header: string): string {
  const claims = parseToken(header.replace('Bearer ', ''))
  return claims.subject
}
