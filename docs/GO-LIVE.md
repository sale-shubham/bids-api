# NobleBid go-live checklist (backend)

Details for each step: `readme/flows/deployment.md`. Tick in order. The `dev` stage is the live deployment; repeating for a `prod` stage (`_PROD` names) is optional and not done yet.

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

## 3. Domain (decided: D7, `docs/DECISIONS.md`)
Live on the `dev` stage (stack `bids-api-dev`), DNS in Route 53 (hosted zone `shubsale.in`): website `noblebids.shubsale.in`, app `bidsapp.shubsale.in`, API `bidsapi.shubsale.in`. Plain (non-`_PROD`) variable names.
- [x] ACM certificate for `bidsapi.shubsale.in` in ap-south-1, validated through Route 53
- [x] `API_DOMAIN_NAME=bidsapi.shubsale.in` set, `dev` deployed, Route 53 record `bidsapi` -> stack output `CustomDomainTarget`
- [x] Amplify custom domains: `bidsapp.shubsale.in` (bids-app, branch `dev`) and `noblebids.shubsale.in` (bids-website, branch `main`)
- [x] Vars: `COOKIE_DOMAIN=.shubsale.in`, `APP_URL=https://bidsapp.shubsale.in`, `CORS_ORIGINS=https://bidsapp.shubsale.in,https://noblebids.shubsale.in`; app `NEXT_PUBLIC_API_URL=https://bidsapi.shubsale.in`
- [x] `CORS_ORIGINS=https://bidsapp.shubsale.in,https://noblebids.shubsale.in` set and the API redeployed (2026-11-15): the website contact form POST `/contact` passes CORS. API Gateway now answers CORS from `provider.httpApi.cors.allowedOrigins` in `serverless.yml` (add new origins there too; `CORS_ORIGINS` is then only for local dev)
- [x] `WEBSITE_URL=https://noblebids.shubsale.in` set as a GitHub variable (2026-11-15); it takes effect on the first deploy that includes the `WEBSITE_URL` code
- [ ] Login persists across page loads and refresh works (cookie sent to both hosts)
- [ ] Optional: `DISABLE_DEFAULT_ENDPOINT=true` once everything uses the custom domain
- `COOKIE_DOMAIN=.shubsale.in` also sends `nb_at` / `nb_rt` to the unrelated sites on `shubsale.in`; none of them may use those cookie names
- A separate `prod` stage (branch `main`, `_PROD` names) is not deployed yet; it is an optional future stage and would need its own hostnames and cookie scope
- No-domain (proxy) mode (empty `COOKIE_DOMAIN`, app `/api` rewrite) remains documented as an option, but dev does not use it

## 4. Email (SES)
- [ ] Domain verified (DKIM), MAIL FROM + DMARC DNS records
- [ ] Production access granted (out of sandbox)
- [ ] `EMAIL_DRIVER=ses`, `EMAIL_FROM` on a verified `shubsale.in` address; real signup OTP email arrives (not in spam)

## 5. Payments (Razorpay)
- [ ] KYC done; live keys in `RAZORPAY_*_PROD`; `PAYMENT_DRIVER_PROD=razorpay`
- [ ] Webhook `https://bidsapi.shubsale.in/payments/webhook` with events payment.captured / payment.failed / order.paid
- [ ] Rs 1 test commission payment completes end to end, webhook idempotent
- [ ] Terms, privacy, refund and contact pages published

## 6. Safety and monitoring
- [ ] `ALERT_EMAIL` set; SNS confirmation email accepted
- [ ] Prod `OTP_DRIVER`/`EMAIL_DRIVER` not stub; no `OTP_STUB_CODE` reliance
- [ ] Rate limits at defaults on prod (no raised `RATE_LIMIT_*`)
- [ ] CloudWatch log retention reviewed (7 days dev, consider 30 on prod)
- [ ] Add the alarms that `serverless.yml` does not have yet (only `api-request-spike` and `api-5xx` exist): NotifyDLQ depth > 0, `closeAuctions` errors, Lambda throttles
- [ ] SES bounce / complaint handling: configuration set + SNS topic, then a suppression check before sending (not built yet)

## 7. Product acceptance
- [ ] PWA installs on Android Chrome and iOS Safari; push notification arrives (iOS needs the installed PWA)
- [ ] Load test: 50 bidders on one auction, bids accepted in order, one winner, commission created
- [ ] Rollback rehearsed (redeploy previous commit; DB restore procedure known)
