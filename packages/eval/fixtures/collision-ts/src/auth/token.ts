const TOKEN_PREFIX = "Bearer ";

export function validate(token: string): boolean {
  if (token.trim() === "") {
    return false;
  }

  const hasPrefix = token.startsWith(TOKEN_PREFIX);
  return hasPrefix && token.length > TOKEN_PREFIX.length;
}
