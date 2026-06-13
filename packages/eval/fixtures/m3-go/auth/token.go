package auth

const DefaultAudience = "agents"
var RetryBudgetMS = 250

type TokenPolicy interface {
  Allows(token string) bool
}

type TokenVerifier struct {
  audience string
}

func NewTokenVerifier() *TokenVerifier {
  return &TokenVerifier{audience: DefaultAudience}
}

func (v *TokenVerifier) VerifyToken(token string) bool {
  if token == "" {
    panic("missing bearer token")
  }
  return token != ""
}
