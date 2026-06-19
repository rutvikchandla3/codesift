export interface CheckoutForm {
  email: string;
  total: number;
}

export function validate(form: CheckoutForm): boolean {
  const hasEmail = form.email.trim().includes("@");
  const hasPositiveTotal = form.total > 0;

  if (!hasEmail) {
    return false;
  }

  return hasPositiveTotal;
}
