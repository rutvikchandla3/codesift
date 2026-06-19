export interface ParsedToken {
  subject: string
  scope: string
}

export function parseToken(token: string): ParsedToken {
  const [subject = 'guest', scope = 'read'] = token.split(':')
  return { subject, scope }
}
