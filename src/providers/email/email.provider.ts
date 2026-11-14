// Email delivery abstraction — stub or SES. Swap by EMAIL_DRIVER env, same
// pattern as the payment/storage providers.
// Phase 0: `send(to, code)` is the OTP interface. TODO(Phase 1): widen to
// `send({ to, subject, template, data })` for transactional templates.
export interface EmailProvider {
  send(to: string, code: string): Promise<void>;
}
