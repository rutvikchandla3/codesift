export function validate(input: Record<string, unknown>): string[] {
  const violations: string[] = [];

  if (typeof input.name !== "string" || input.name.trim() === "") {
    violations.push("name must be a non-empty string");
  }

  if (typeof input.age !== "number" || input.age < 0) {
    violations.push("age must be a number greater than or equal to 0");
  }

  return violations;
}
