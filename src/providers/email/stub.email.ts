import type { EmailProvider } from './email.provider';

// Dev stub — no real email gateway, just logs the code server-side. auth.service
// is the one that decides the code is always env.otp.stubCode while EMAIL_DRIVER
// is stub (see generateCode()) — this class only delivers it.
export class StubEmail implements EmailProvider {
  async send(to: string, code: string): Promise<void> {
    console.log(`[email:stub] code for ${to} is ${code}`);
  }
}
