package auth;

public class TokenVerifier {
  public static final String DEFAULT_AUDIENCE = "agents";
  private int retryBudgetMs = 250;

  public boolean verifyToken(String token) {
    if (token == null) {
      throw new IllegalArgumentException("missing bearer token");
    }
    return !token.isEmpty();
  }
}

interface TokenPolicy {
  boolean allows(String token);
}
