# NobleBid go-live checklist (backend)

Details for each step: `readme/flows/deployment.md`. Tick in order. Dev first, then repeat for prod (`_PROD` names).

## 1. Accounts and secrets
- [ ] AWS account, region ap-south-1, IAM deploy user, budget alert set
- [ ] Serverless Framework access key (`SERVERLESS_ACCESS_KEY`)
- [ ] Managed Postgres per stage; pooled `DATABASE_URL` + direct `DIRECT_URL`; backups on, point-in-time restore on prod
- [ ] `JWT_SECRET` / `REFRESH_TOKEN_SECRET` (>=32 chars, different) generated per stage
- [ ] One VAPID pair generated and stored (never rotate)
- [ ] `deploy/dev.env` / `deploy/prod.env` filled, `npm run env:sync -- ... --dry-run` reviewed, then synced

## 2. First deploy
- [ ] Dev deploy green (job summary shows HTTP API, WebSocket, CloudFront URLs)
- [ ] `GET <HttpApiUrl>/health` (or any public route) answers; WebSocket connects
- [ ] Super Admin seeded (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, then remove the password)
- [ ] Image upload works (presigned PUT, image served via CloudFront URL)
- [ ] Scheduled jobs run (CloudWatch logs for closeAuctions every minute); NotifyDLQ is empty

## 3. Domain (when the name is known)
- [ ] ACM certificate for `api.<domain>` in ap-south-1 validated
- [ ] `API_DOMAIN_NAME` + `API_CERTIFICATE_ARN` set, redeployed, DNS CNAME to `CustomDomainTarget`
- [ ] Amplify custom domain `app.<domain>` (and `dev-app.<domain>`)
- [ ] `COOKIE_DOMAIN=.<domain>`, `CORS_ORIGINS=https://app.<domain>`, `APP_URL`, app `NEXT_PUBLIC_API_URL` updated
- [ ] Login persists across page loads and refresh works (cookie sent to both hosts)
- [ ] Optional: `DISABLE_DEFAULT_ENDPOINT=true` once everything uses the custom domain
- Before the domain exists: no-domain mode (Next.js rewrite, empty `COOKIE_DOMAIN`)

## 4. Email (SES)
- [ ] Domain verified (DKIM), MAIL FROM + DMARC DNS records
- [ ] Production access granted (out of sandbox)
- [ ] `EMAIL_DRIVER=ses`, `EMAIL_FROM=noreply@<domain>`; real signup OTP email arrives (not in spam)

## 5. Payments (Razorpay)
- [ ] KYC done; live keys in `RAZORPAY_*_PROD`; `PAYMENT_DRIVER_PROD=razorpay`
- [ ] Webhook `https://api.<domain>/payments/webhook` with events payment.captured / payment.failed / order.paid
- [ ] Rs 1 test commission payment completes end to end, webhook idempotent
- [ ] Terms, privacy, refund and contact pages published

## 6. Safety and monitoring
- [ ] `ALERT_EMAIL` set; SNS confirmation email accepted
- [ ] Prod `OTP_DRIVER`/`EMAIL_DRIVER` not stub; no `OTP_STUB_CODE` reliance
- [ ] Rate limits at defaults on prod (no raised `RATE_LIMIT_*`)
- [ ] CloudWatch log retention reviewed (7 days dev, consider 30 on prod)

## 7. Product acceptance
- [ ] PWA installs on Android Chrome and iOS Safari; push notification arrives (iOS needs the installed PWA)
- [ ] Load test: 50 bidders on one auction, bids accepted in order, one winner, commission created
- [ ] Rollback rehearsed (redeploy previous commit; DB restore procedure known)
