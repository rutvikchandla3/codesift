import { validate } from "../schema/validator";

export function handleRequest(
  body: Record<string, unknown>
): { ok: boolean; errors: string[] } {
  const errors = validate(body);

  return { ok: errors.length === 0, errors };
}
