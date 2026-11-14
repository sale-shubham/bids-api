// Email delivery abstraction — stub or SES. Swap by EMAIL_DRIVER env, same
// pattern as the payment/storage providers.
// `template` names an EJS pair in src/templates: `<template>.ejs` (HTML) and
// `<template>.txt.ejs` (plain text). `data` is the template's variables.
export interface SendEmailInput {
  to: string;
  subject: string;
  template: string;
  data?: Record<string, unknown>;
  // Optional Reply-To address (contact form: reply goes to the sender).
  replyTo?: string;
}

export interface EmailProvider {
  send(input: SendEmailInput): Promise<void>;
}
