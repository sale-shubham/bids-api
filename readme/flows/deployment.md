# Deployment (AWS, Serverless Framework v4)

Region `ap-south-1`. Stages: `dev` (push to branch `dev`) and `prod` (push to `main`), deployed by
`.github/workflows/deploy_serverless.yml`. PR checks: `.github/workflows/pr_checks.yml` (`npm run check`).

> Builds (`npm run build:lambda`, `sls deploy`) run in CI only. Never run them locally.

## Architecture

```
Browser --> Amplify (Next.js app) ----(NEXT_PUBLIC_API_URL or Next.js rewrite)----> API Gateway HTTP API --> Lambda `api` (Express)
        \--> wss://<ws-id>.execute-api... (API Gateway WebSocket) --> Lambda `api` ($connect/$disconnect/$default)
EventBridge schedules --> closeAuctions (1 min), endingSoon (15 min), commissionReminder (1 day),
                          retentionPurge (1 day), api warmer (5 min)
Lambda `api` / jobs --> SQS NotifyQueue (+DLQ, 3 receives) --> Lambda notifyWorker (batch 10, ReportBatchItemFailures)
Uploads: browser PUT via presigned URL --> S3 AppBucket (private) <-- CloudFront (OAC) <-- images
Postgres (managed, pooled URL for Lambda, direct URL for migrations)
```

Everything under `serverless.yml`: functions (`api`, `closeAuctions`, `endingSoon`, `commissionReminder`,
`retentionPurge`, `notifyWorker`), `NotifyQueue` + `NotifyDLQ`, `AppBucket` + OAC + CloudFront + bucket policy,
optional alarms (`ALERT_EMAIL`), optional custom domain (`API_DOMAIN_NAME` + `API_CERTIFICATE_ARN`).
IAM: S3 object/list on the bucket, `ses:SendEmail/SendRawEmail`, SQS send on NotifyQueue, X-Ray, and
`execute-api:ManageConnections` (auto-added by Serverless for WebSocket events).

Env resolved by CloudFormation (never set by hand): `NOTIFY_QUEUE_URL`, `WS_API_ENDPOINT`,
`AWS_CLOUDFRONT_URL` (`https://<distribution domain>`).

Stack outputs (printed in the job summary after each deploy): `HttpApiUrl`, `WebSocketUrl`,
`CloudFrontDomainName`, `NotifyQueueUrl`, and `CustomDomainTarget` (only with a custom domain).

## CORS

Handled by the Express `cors()` middleware (`src/app.ts`), origin list from `CORS_ORIGINS` (comma separated, no
trailing slash, falls back to `APP_URL`), `credentials: true`, preflight cached 2h. API Gateway-level CORS is
deliberately off: Serverless v4 variables cannot split a comma string into a list. The catch-all route forwards
`OPTIONS` to the Lambda. Add every app origin (prod, dev, `http://localhost:3002`) to `CORS_ORIGINS`.

## Cookies: two deploy modes

Auth cookies (`nb_at`, `nb_rt`, `dvid`) are built by `src/core/http/cookie-options.ts`.

| Mode | App | API | `COOKIE_DOMAIN` | `COOKIE_SAMESITE` |
|---|---|---|---|---|
| (a) custom domain | `app.<domain>` | `api.<domain>` | `.<domain>` | `lax` |
| (b) temporary, no domain | Amplify default URL | called through a Next.js rewrite on the app origin | empty (host-only cookie, no `domain` attribute) | `lax` |

`COOKIE_SAMESITE=none` forces `Secure`; only for genuinely cross-site setups. In mode (b) the browser only
talks to the app origin, so the cookie is first-party; set `APP_URL` to the Amplify URL and `CORS_ORIGINS` to it too.

## GitHub secrets and variables

Repo `sale-shubham/bids-api` (Settings > Secrets and variables > Actions). Dev uses the plain name; prod uses
the same name with `_PROD`. Shared names have no `_PROD` twin. Empty optional values are fine.

| Name | Type | Required | Notes |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret | yes | deploy IAM user |
| `SERVERLESS_ACCESS_KEY` | secret | yes | Serverless v4 access key |
| `DATABASE_URL` | secret | yes | pooled URL (Lambda runtime) |
| `DIRECT_URL` | secret | yes | direct URL (`prisma migrate deploy`) |
| `JWT_SECRET`, `REFRESH_TOKEN_SECRET` | secret | yes | >=32 chars, different |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | secret | if `PAYMENT_DRIVER=razorpay` | |
| `VAPID_PRIVATE_KEY` | secret | shared | one pair, never rotate |
| `AWS_REGION` | var | yes | `ap-south-1` |
| `AWS_BUCKET_NAME` | var | yes | globally unique |
| `APP_URL` | var | prod yes | links in emails |
| `CORS_ORIGINS` | var | recommended | comma list; empty -> `APP_URL` |
| `COOKIE_DOMAIN` | var | optional | empty = host-only; `.example.com` in mode (a) |
| `COOKIE_SAMESITE` | var | optional | `lax` (default) / `none` |
| `PAYMENT_DRIVER` | var | yes | `stub` / `razorpay` |
| `EMAIL_DRIVER` | var | optional | default `stub` dev, `ses` prod |
| `EMAIL_FROM`, `EMAIL_FROM_NAME`, `LOGO_URL` | var | `EMAIL_FROM` if `ses` | |
| `OTP_STUB_CODE` | var | optional | stub driver only |
| `ADMIN_EMAIL`, `ALERT_EMAIL` | var | optional | `ALERT_EMAIL` enables alarms + SNS |
| `COMMISSION_RATE_BPS` | var | optional | default 500 |
| `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT` | var | shared | |
| `API_DOMAIN_NAME`, `API_CERTIFICATE_ARN` | var | optional | both set = custom domain created |
| `DISABLE_DEFAULT_ENDPOINT` | var | optional | `true` only after the domain works |
| `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_OTP_IP_MAX` | var | dev only | workflow default 300 |

The workflow fails early and names any missing required setting (never its value).

### Env sync script

```
cp deploy/dev.env.example deploy/dev.env        # gitignored; fill in
npm run env:sync -- deploy/dev.env --stage dev --dry-run   # key names + secret/variable + set/empty only
npm run env:sync -- deploy/dev.env --stage dev
npm run env:sync -- deploy/prod.env --stage prod            # adds _PROD (except VAPID_*)
```

Needs `gh auth login`. Repo is taken from `git remote get-url origin` (override `--repo owner/name`). Values are
passed to `gh` on stdin, never on the command line or in output. Empty values are skipped; nothing is deleted.

## First deploy

1. Create the managed Postgres DB (pooled + direct URLs), an IAM deploy user (CloudFormation, Lambda, API Gateway,
   S3, SQS, CloudFront, IAM role/pass-role, SNS, CloudWatch, Logs, Events), and a Serverless access key
   (app.serverless.com > Access Keys; org/app must allow service `bids-api`).
2. Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (x2) and
   `npx web-push generate-vapid-keys` (once).
3. Fill `deploy/dev.env`, run `env:sync` (see above).
4. Push to `dev` (or Actions > Run workflow on `dev`). Read the API/WS/CloudFront URLs in the job summary.
5. Seed the Super Admin once: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` + `npm run prisma:seed` against the DB.
6. Point the app (`NEXT_PUBLIC_API_URL` or the Next.js rewrite target) at `HttpApiUrl`; `NEXT_PUBLIC_WS_URL`
   style settings at `WebSocketUrl`.

## Custom domain (optional, switched on by variables)

1. Request an ACM certificate for `api.<domain>` in **ap-south-1** (DNS validation: add the CNAME ACM shows).
2. Set `API_DOMAIN_NAME=api.<domain>`, `API_CERTIFICATE_ARN=<arn>` (per stage), redeploy.
3. Read output `CustomDomainTarget` and create DNS `CNAME api.<domain> -> <that value>`.
4. Switch the app to `https://api.<domain>`, set `COOKIE_DOMAIN=.<domain>`, `CORS_ORIGINS=https://app.<domain>`, redeploy.
5. Only now optionally set `DISABLE_DEFAULT_ENDPOINT=true` (resolved with `strToBool`, default false) so the raw
   `execute-api` URL stops working. Doing it earlier locks you out.
6. The WebSocket keeps its `wss://<id>.execute-api...` URL (no cookie needed; clients use a REST ticket).

## SES (real email)

1. SES console in ap-south-1: verify the domain identity (Easy DKIM, 3 CNAMEs), custom MAIL FROM `mail.<domain>`
   (MX + SPF TXT), DMARC TXT (`v=DMARC1; p=none; rua=mailto:...` first).
2. Request **production access** (sandbox only sends to verified addresses, 200/day). Describe: verification/reset
   OTPs, outbid, won, commission reminders.
3. Set `EMAIL_DRIVER=ses` and `EMAIL_FROM=noreply@<domain>`. The boot check refuses `ses` with the placeholder sender.

## Razorpay webhook

Dashboard > Settings > Webhooks: URL `https://api.<domain>/payments/webhook` (dev: test mode + dev URL), secret =
`RAZORPAY_WEBHOOK_SECRET`, events `payment.captured`, `payment.failed`, `order.paid`. Live mode needs KYC and live
policy pages (terms, privacy, refund, contact). Set `PAYMENT_DRIVER=razorpay` with the key secrets.

## Migrations

CI runs `npx prisma migrate deploy` (via `DIRECT_URL`) before packaging, on every deploy. Write migrations
backward compatible (expand, deploy, contract) because the old Lambda code runs against the new schema briefly.
Never run `migrate reset` against a deployed DB.

## Rollback

- Code: revert the commit on the branch and push (redeploy), or re-run the workflow on a previous good commit via
  a branch reset. CloudFormation automatically rolls back a failed deploy.
- Data: migrations are forward-only; fix forward with a new migration or restore the DB backup (point-in-time on prod).
- The S3 bucket is `Retain` on stack delete. Never delete the stack on prod without exporting data.

## Costs (rough, low traffic)

Lambda/API Gateway/SQS/EventBridge within or near free tier; the 1-minute `closeAuctions` run is ~43k invocations/month.
CloudFront PriceClass_100 + S3 small. Logs 7 days. Main fixed costs: managed Postgres and (later) SES sending.
Set an AWS Budget alert. API Gateway throttle is 50 rps / burst 100 account-stage wide.
