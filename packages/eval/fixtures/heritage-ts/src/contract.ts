export interface AuthStrategy {
  verify(token: string): boolean
}

export class BaseVerifier {
  verify(token: string): boolean {
    return token.length > 0
  }
}
