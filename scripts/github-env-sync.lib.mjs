// Pure helpers for scripts/github-env-sync.mjs (unit-tested, no I/O).

// Per-stage secrets: `NAME` for dev, `NAME_PROD` for prod.
export const STAGE_SECRETS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'SERVERLESS_ACCESS_KEY',
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_SECRET',
  'REFRESH_TOKEN_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'MSG91_AUTH_KEY',
  'TOTP_ENC_KEY',
  'WHATSAPP_TOKEN',
];

// Per-stage variables: `NAME` for dev, `NAME_PROD` for prod.
export const STAGE_VARIABLES = [
  'AWS_REGION',
  'AWS_BUCKET_NAME',
  'CORS_ORIGINS',
  'COOKIE_DOMAIN',
  'COOKIE_SAMESITE',
  'APP_URL',
  'WEBSITE_URL',
  'ADMIN_EMAIL',
  'ALERT_EMAIL',
  'COMMISSION_RATE_BPS',
  'PAYMENT_DRIVER',
  'EMAIL_DRIVER',
  'EMAIL_FROM',
  'EMAIL_FROM_NAME',
  'LOGO_URL',
  'OTP_STUB_CODE',
  'API_DOMAIN_NAME',
  'API_CERTIFICATE_ARN',
  'DISABLE_DEFAULT_ENDPOINT',
  'ENABLE_CDN', // true = CloudFront in front of the uploads bucket
  'SMS_DRIVER',
  'MSG91_SENDER_ID',
  'MSG91_OTP_TEMPLATE_ID',
  'REQUIRE_ADMIN_2FA',
  'WHATSAPP_DRIVER',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_API_VERSION',
  'WHATSAPP_TEMPLATE_OUTBID',
  'WHATSAPP_TEMPLATE_ENDING_SOON',
  'WHATSAPP_TEMPLATE_AUCTION_WON',
  'WHATSAPP_TEMPLATE_SALE_PAYMENT_DUE',
];

// Shared by both stages: the workflow reads these WITHOUT a _PROD twin.
export const SHARED_SECRETS = ['VAPID_PRIVATE_KEY'];
export const SHARED_VARIABLES = [
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  'RATE_LIMIT_AUTH_MAX', // dev-only knobs in the workflow
  'RATE_LIMIT_OTP_IP_MAX',
];

/** Strip an optional trailing _PROD so deploy/prod.env may use either form. */
export function baseName(key) {
  return key.endsWith('_PROD') ? key.slice(0, -5) : key;
}

/**
 * Classify a dotenv key.
 * @returns {{kind:'secret'|'variable', name:string, shared:boolean} | null} null = unknown key
 */
export function classifyKey(key, stage) {
  const base = baseName(key);
  const suffix = stage === 'prod' ? '_PROD' : '';
  if (SHARED_SECRETS.includes(base)) return { kind: 'secret', name: base, shared: true };
  if (SHARED_VARIABLES.includes(base)) return { kind: 'variable', name: base, shared: true };
  if (STAGE_SECRETS.includes(base)) return { kind: 'secret', name: base + suffix, shared: false };
  if (STAGE_VARIABLES.includes(base)) return { kind: 'variable', name: base + suffix, shared: false };
  return null;
}

/** Minimal dotenv parser: KEY=VALUE, # comments, optional quotes, `export ` prefix. */
export function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/(^|\s+)#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

/**
 * Turn parsed dotenv entries into an ordered plan. Values stay in `value` for the
 * real run; formatPlanLine() never includes them.
 */
export function buildPlan(entries, stage) {
  const plan = [];
  const unknown = [];
  for (const [key, value] of Object.entries(entries)) {
    const c = classifyKey(key, stage);
    if (!c) {
      unknown.push(key);
      continue;
    }
    plan.push({ key, ...c, value, empty: value === '' });
  }
  return { plan, unknown };
}

/** One dry-run line: names + kind + set/empty only. Never the value. */
export function formatPlanLine(item) {
  return `${item.kind.padEnd(8)} ${item.name}  ${item.empty ? 'empty (skipped)' : 'set'}`;
}

/** `git remote get-url origin` -> owner/name. */
export function repoFromRemote(url) {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}
