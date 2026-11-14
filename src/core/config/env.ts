import 'dotenv/config';

function required(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer env var ${key}: ${v}`);
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

const DEV_SECRETS = new Set(['dev_access_secret_change_me', 'dev_refresh_secret_change_me']);

// In prod, refuse to boot with weak/default secrets. In dev, allow the fallback.
function secret(key: string, devFallback: string): string {
  const v = process.env[key];
  if (isProd) {
    if (!v || DEV_SECRETS.has(v) || v.length < 32) {
      throw new Error(`Insecure ${key}: set a strong value (>=32 chars) in production`);
    }
    return v;
  }
  return v ?? devFallback;
}

// Comma-separated list of allowed web origins (CORS). First entry is the canonical web origin.
function originList(): string[] {
  const raw = process.env.CORS_ORIGINS ?? 'http://localhost:3000';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

const origins = originList();

// In prod, require the env vars the selected drivers actually need, and refuse
// to boot with identical JWT/refresh secrets. Fail fast at boot, not at first use.
function requireProd(key: string, value: string, reason: string): string {
  if (isProd && !value) {
    throw new Error(`Missing required env var ${key} (${reason})`);
  }
  return value;
}

const paymentDriver = process.env.PAYMENT_DRIVER ?? 'stub';

// Storage is S3-only (hospital presigned-direct-to-S3 pattern). These are required in prod.
if (isProd) {
  requireProd('AWS_BUCKET_NAME', process.env.AWS_BUCKET_NAME ?? '', 'S3 storage');
  requireProd('AWS_REGION', process.env.AWS_REGION ?? '', 'S3 storage');
}
if (isProd && paymentDriver === 'razorpay') {
  requireProd('RAZORPAY_KEY_ID', process.env.RAZORPAY_KEY_ID ?? '', 'PAYMENT_DRIVER=razorpay');
  requireProd(
    'RAZORPAY_KEY_SECRET',
    process.env.RAZORPAY_KEY_SECRET ?? '',
    'PAYMENT_DRIVER=razorpay'
  );
  requireProd(
    'RAZORPAY_WEBHOOK_SECRET',
    process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
    'PAYMENT_DRIVER=razorpay'
  );
}

const otpDriver = process.env.OTP_DRIVER ?? 'stub';

const emailDriver = process.env.EMAIL_DRIVER ?? 'stub';
// EMAIL_FROM defaults to a placeholder — SES will reject sends from an
// unverified/example address, so refuse to boot with it in prod rather than
// fail on every real send. No credential guard needed here: SES runs under
// the Lambda execution role (same AWS account as S3 storage), same as
// AWS_REGION/AWS_BUCKET_NAME already required above.
if (isProd && emailDriver === 'ses') {
  const from = process.env.EMAIL_FROM;
  if (!from || from === 'noreply@example.com') {
    throw new Error(
      'EMAIL_FROM must be set to a real SES-verified sender in production (EMAIL_DRIVER=ses)'
    );
  }
}

const accessSecret = secret('JWT_SECRET', 'dev_access_secret_change_me');
const refreshSecret = secret('REFRESH_TOKEN_SECRET', 'dev_refresh_secret_change_me');
if (isProd && accessSecret === refreshSecret) {
  throw new Error('JWT_SECRET and REFRESH_TOKEN_SECRET must differ in production');
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd,
  port: int('PORT', 4000),
  corsOrigin: origins[0],
  corsOrigins: origins,

  databaseUrl: required('DATABASE_URL'),

  jwt: {
    accessSecret,
    refreshSecret,
  },
  cookieDomain: process.env.COOKIE_DOMAIN ?? 'localhost',

  storage: {
    // S3-only. cdnBaseUrl (CloudFront) is the public read base; falls back to the
    // bucket's regional URL in S3Storage.url() when unset.
    cdnBaseUrl: process.env.AWS_CLOUDFRONT_URL ?? '',
    s3: {
      // DPDP Act §16 (cross-border transfer) — default to an India region
      // (Mumbai) rather than an empty/ambiguous fallback, so a deploy that
      // forgets to set AWS_REGION doesn't silently end up storing member
      // documents outside India. Still overridable — see gap #5 in
      // DPDP_COMPLIANCE.md: overriding away from India is a deliberate,
      // undocumented-by-default choice that belongs in the processor register.
      region: process.env.AWS_REGION ?? 'ap-south-1',
      bucket: process.env.AWS_BUCKET_NAME ?? '',
    },
  },

  payment: {
    driver: paymentDriver,
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID ?? '',
      keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
    },
  },

  // Email OTP (signup verification + forgot-password). The stub driver logs the
  // code and always issues env.otp.stubCode so dev/test accounts are trivially
  // verifiable. Real delivery goes through the email provider (SES).
  // ttl/length/resend-cooldown are flat constants (constants.ts), not env vars.
  otp: {
    driver: otpDriver,
    stubCode: process.env.OTP_STUB_CODE ?? '123456',
  },

  // Email delivery (OTP codes now, transactional templates later).
  email: {
    driver: emailDriver,
    fromAddress: process.env.EMAIL_FROM ?? 'noreply@example.com',
    fromName: process.env.EMAIL_FROM_NAME ?? 'NobleBid',
    // Public HTTPS URL to the brand logo, shown in the SES email header. Falls
    // back to a plain text wordmark (fromName) in the template when unset.
    logoUrl: process.env.LOGO_URL ?? '',
  },

  app: {
    // Public web app base URL — used for links in emails.
    url: process.env.APP_URL ?? 'http://localhost:3002',
  },
  admin: {
    // Super Admin / ops contact (contact-form forwarding, alerts).
    email: process.env.ADMIN_EMAIL ?? '',
  },
  commission: {
    // Platform commission in basis points (500 = 5%).
    rateBps: int('COMMISSION_RATE_BPS', 500),
  },
  notify: {
    // SQS queue for async notifications. Auto-injected by serverless.yml
    // (!GetAtt NotifyQueue.QueueUrl); empty locally = send inline.
    queueUrl: process.env.NOTIFY_QUEUE_URL ?? '',
  },

  // Real-time push over WebSocket — the API Gateway
  // Management API endpoint for the WebSocket API serverless.yml sets up
  // alongside the REST httpApi. Auto-injected (`!Sub` referencing the
  // auto-created WebsocketsApi resource), not a manually-set var — never set
  // locally, so an empty value here means "not on Lambda" and
  // ws.transport.ts falls back to the local dev WebSocket server (index.js).
  ws: {
    apiEndpoint: process.env.WS_API_ENDPOINT ?? '',
    // Optional override of the ws:// URL handed to clients when the LOCAL dev
    // WebSocket server is running (default ws://localhost:<PORT>/ws).
    publicUrl: process.env.WS_PUBLIC_URL ?? '',
  },

  // Web Push for the app-icon badge on new notifications.
  // Optional integration, same shape as `ws` above: unset keys mean
  // push.service.ts's sendPushToMember() no-ops and GET /push/vapid-public-key
  // answers '' (the app then shows "not set up on this server"). Generate once
  // with `npx web-push generate-vapid-keys`; rotating the pair orphans every
  // existing browser subscription until the app re-subscribes on next open.
  // `vapidSubject` is a mailto:/https: contact the push services may use.
  push: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    vapidSubject: process.env.VAPID_SUBJECT || 'https://app.example.com',
  },
  // Per-IP caps on OTP verification (authLimiter) and OTP sending
  // (otpIpLimiter). Unset = the production values below. Raised on dev only
  // (deploy_serverless.yml), where OTPs are the fixed stub code anyway and the
  // Playwright E2E suite signs members up from one CI IP many times an hour.
  rateLimit: {
    authMax: int('RATE_LIMIT_AUTH_MAX', 20),
    otpIpMax: int('RATE_LIMIT_OTP_IP_MAX', 20),
  },
} as const;
