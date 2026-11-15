import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { env } from '@/core/config/env';

// Not named __dirname: the Lambda bundle banner (scripts/build-lambda.mjs) already declares one.
const moduleDir = dirname(fileURLToPath(import.meta.url));
// Source run (tsx): src/providers/email → src/templates. Lambda bundle:
// dist/index.mjs → dist/templates (copied by scripts/build-lambda.mjs).
const templatesDir = existsSync(join(moduleDir, 'templates'))
  ? join(moduleDir, 'templates')
  : join(moduleDir, '../../templates');

export interface RenderedEmail {
  html: string;
  text: string;
}

// Renders `<template>.ejs` (HTML) and `<template>.txt.ejs` (plain text) with the
// caller's data plus the shared brand variables.
export async function renderEmail(template: string, data: Record<string, unknown> = {}): Promise<RenderedEmail> {
  if (!/^[a-z0-9-]+$/.test(template)) throw new Error(`Invalid email template name: ${template}`);
  const vars = {
    fromName: env.email.fromName,
    logoUrl: env.email.logoUrl,
    frontendUrl: env.app.url,
    websiteUrl: env.app.websiteUrl,
    ...data,
  };
  const [html, text] = await Promise.all([
    ejs.renderFile(join(templatesDir, `${template}.ejs`), vars),
    ejs.renderFile(join(templatesDir, `${template}.txt.ejs`), vars),
  ]);
  return { html, text };
}
