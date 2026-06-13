module Auth
  class TokenVerifier
    DEFAULT_AUDIENCE = "agents"
    @@retry_budget_ms = 250

    def verify_token(token)
      raise "missing bearer token" if token.nil?
      !token.empty?
    end
  end
end
