import { BaseVerifier, type AuthStrategy } from './contract'

export class JwtVerifier extends BaseVerifier implements AuthStrategy {
  override verify(token: string): boolean {
    return super.verify(token)
  }
}

export interface StrictStrategy extends AuthStrategy {}
