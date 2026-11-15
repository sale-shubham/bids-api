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
Uploads: browser PUT via presigned URL --> S3 AppBucket <-- CloudFront (OAC, ENABLE_CDN=true) or S3 direct <-- images
Postgres (managed, pooled URL for Lambda, direct URL for migrations)
```

Everything under `serverless.yml`: functions (`api`, `closeAuctions`, `endingSoon`, `commissionReminder`,
`retentionPurge`, `notifyWorker`), `NotifyQueue` + `NotifyDLQ`, `AppBucket` + bucket policy (+ OAC + CloudFront when `ENABLE_CDN=true`),
optional alarms (`ALERT_EMAIL`), optional custom domain (`API_DOMAIN_NAME` + `API_CERTIFICATE_ARN`).
IAM: S3 object/list on the bucket, `ses:SendEmail/SendRawEmail`, SQS send on NotifyQueue, X-Ray, and
`execute-api:ManageConnections` (auto-added by Serverless for WebSocket events).

Env resolved by CloudFormation (never set by hand): `NOTIFY_QUEUE_URL`, `WS_API_ENDPOINT`,
`AWS_CLOUDFRONT_URL` (`https://<distribution domain>` with the CDN, else `https://<bucket>.s3.<region>.amazonaws.com`).

### Image CDN (`ENABLE_CDN`)

CloudFront is optional because a new AWS account must be verified by AWS Support before it may create
CloudFront distributions.

- `ENABLE_CDN` unset or `false` (default): no CloudFront. A bucket policy makes **only** `auctions/*` and
  `avatars/*` publicly readable (the only folders uploads can write to, and those images are public anyway).
  Public ACLs stay blocked; everything else stays private.
- `ENABLE_CDN=true` (GitHub variable; `ENABLE_CDN_PROD` for prod): creates OAC + CloudFront, the bucket goes
  fully private and the same bucket policy switches to CloudFront-only access. After switching, update the app's
  `NEXT_PUBLIC_IMAGE_ORIGINS` / `NEXT_PUBLIC_UPLOADS_BASE_URL` to the new `MediaBaseUrl` output.
  Image URLs are stored in full (`Auction.images`, `Member.avatarUrl`), so images uploaded before the switch keep
  their S3 URL and stop loading once the bucket goes private. Rewrite them in the same release:
  `UPDATE ... SET ... = replace(..., '<old S3 base>', '<new CloudFront base>')` (additive data fix, no schema change).
- The bucket policy is ONE resource (`AppBucketPublicMediaPolicy`) whose statement changes with the mode. Do not
  split it in two or rename it: CloudFormation would create the new policy, then delete the old resource, and that
  delete removes the bucket's whole policy.

Stack outputs (printed in the job summary after each deploy): `HttpApiUrl`, `WebSocketUrl`,
`MediaBaseUrl`, `CloudFrontDomainName` (only with the CDN), `NotifyQueueUrl`, and `CustomDomainTarget` (only with a
custom domain).

## CORS

Deployed stages: API Gateway answers CORS (`serverless.yml` `provider.httpApi.cors`) with an explicit origin list in `cors.allowedOrigins` (a YAML list, because Serverless v4 variables cannot split a comma string; same pattern as P2X), `allowCredentials: true`, preflight cached 2h. API Gateway answers `OPTIONS` itself (no Lambda invoke) and ignores CORS headers from Express. Local dev (`npm run dev`): the Express `cors()` middleware (`src/app.ts`) uses `CORS_ORIGINS` (comma separated, no trailing slash, falls back to `APP_URL`, exact match per origin). To add a browser origin (app, marketing website, `http://localhost:3002`), edit `provider.httpApi.cors.allowedOrigins` in `serverless.yml` AND `CORS_ORIGINS`, then deploy. Live (`dev` stage): `https://bidsapp.shubsale.in` and `https://noblebids.shubsale.in` (the website's contact form POSTs `/contact`).

## Cookies: two deploy modes

Auth cookies (`nb_at`, `nb_rt`, `dvid`) are built by `src/core/http/cookie-options.ts`.

| Mode | App | API | `COOKIE_DOMAIN` | `COOKIE_SAMESITE` |
|---|---|---|---|---|
| (a) custom domain (live on the `dev` stage) | `bidsapp.shubsale.in` | `bidsapi.shubsale.in` | `.shubsale.in` | `lax` |
| (b) no domain (proxy; optional, not what dev uses) | Amplify default URL | called through a Next.js rewrite on the app origin | empty (host-only cookie, no `domain` attribute) | `lax` |

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
| `APP_URL` | var | prod yes | auction/commission links in emails; live `https://bidsapp.shubsale.in` |
| `WEBSITE_URL` | var | optional | marketing site origin, support `/contact` links in emails; empty -> `APP_URL`; live value `https://noblebids.shubsale.in` (set 2026-11-15) |
| `CORS_ORIGINS` | var | recommended | comma list; empty -> `APP_URL`. Express (local dev) only; deployed CORS comes from `provider.httpApi.cors.allowedOrigins` in `serverless.yml`, keep both in sync |
| `COOKIE_DOMAIN` | var | optional | empty = host-only (no-domain mode); live `.shubsale.in` |
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

1. Create the managed Postgres DBs (`noblebid_dev`, `noblebid_prod`; pooled + direct URLs each; local dev uses Docker Postgres or a dev-branch DB), an IAM deploy user (CloudFormation, Lambda, API Gateway,
   S3, SQS, CloudFront, IAM role/pass-role, SNS, CloudWatch, Logs, Events), and a Serverless access key
   (app.serverless.com > Access Keys; org/app must allow service `bids-api`).
2. Generate secrets: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (x2) and
   `npx web-push generate-vapid-keys` (once).
3. Fill `deploy/dev.env`, run `env:sync` (see above).
4. Push to `dev` (or Actions > Run workflow on `dev`). Read the API/WS/media URLs in the job summary.
5. Seed the Super Admin once: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` + `npm run prisma:seed` against the DB.
6. Point the app (`NEXT_PUBLIC_API_URL` or the Next.js rewrite target `API_PROXY_TARGET`) at `HttpApiUrl`. The app
   needs no WebSocket setting: the ticket endpoint returns the `WebSocketUrl` to connect to.

## Custom domain (live: bidsapi.shubsale.in on the dev stage)

The `dev` stage (stack `bids-api-dev`) is the live deployment. Hosts: website `https://noblebids.shubsale.in`, app `https://bidsapp.shubsale.in`, API `https://bidsapi.shubsale.in`. DNS is in Route 53 (hosted zone `shubsale.in`, which also hosts unrelated sites). Live GitHub variables use the plain names: `APP_URL`, `CORS_ORIGINS`, `COOKIE_DOMAIN=.shubsale.in`, `API_DOMAIN_NAME=bidsapi.shubsale.in`, `AWS_REGION=ap-south-1`. `WEBSITE_URL=https://noblebids.shubsale.in` (set 2026-11-15; used from the first deploy that includes the `WEBSITE_URL` code).

1. Request an ACM certificate for `bidsapi.shubsale.in` in **ap-south-1**, DNS validation through Route 53 ("Create records in Route 53").
2. Set `API_DOMAIN_NAME=bidsapi.shubsale.in` (and `API_CERTIFICATE_ARN` if the workflow needs it), then deploy `dev`.
3. Read output `CustomDomainTarget` and create a Route 53 record `bidsapi.shubsale.in -> <that value>`.
4. Set `COOKIE_DOMAIN=.shubsale.in`, `APP_URL=https://bidsapp.shubsale.in`, `CORS_ORIGINS=https://bidsapp.shubsale.in`; point the app at `https://bidsapi.shubsale.in`; redeploy.
   Done 2026-11-15: `CORS_ORIGINS` includes `https://noblebids.shubsale.in`, so the website contact form works. `WEBSITE_URL=https://noblebids.shubsale.in` is set too; it takes effect on the first deploy that includes the `WEBSITE_URL` code.

`COOKIE_DOMAIN=.shubsale.in` is the owner's choice: `nb_at` / `nb_rt` reach every `*.shubsale.in` host, including unrelated sites, so no other app there may use those cookie names.

A `prod` stage (branch `main`, `_PROD` names) has not been deployed; it is an optional future stage and would need its own hostnames and cookie scope. No-domain (proxy) mode remains documented above as an option.

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
CloudFront PriceClass_200 (includes India edges) + S3 small. Logs 7 days. Main fixed costs: managed Postgres and (later) SES sending.
Set an AWS Budget alert. API Gateway throttle is 50 rps / burst 100 account-stage wide.
