import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from '@/core/config/env';
import { errorHandler, notFoundHandler } from '@/core/middleware/errorHandler';
import v1Routes from '@/routes';

export function createApp() {
  const app = express();

  // Single proxy hop (API Gateway / ALB) — needed for correct req.ip + rate limiting.
  // Browsers call this API directly (the live dev stage is https://bidsapi.shubsale.in); the app's optional Next.js /api rewrite (proxy mode) is unused.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      // 2h preflight cache. Deployed stages get CORS from API Gateway
      // (serverless.yml provider.httpApi.cors.allowedOrigins), which ignores
      // these headers; this middleware covers local dev and reads CORS_ORIGINS.
      exposedHeaders: ['content-disposition'],
      maxAge: 7200,
    })
  );
  // Capture the raw body buffer so the Razorpay webhook route can verify the
  // HMAC signature against the exact bytes Razorpay signed (re-stringified JSON
  // would not match). See src/modules/payments for the webhook handler.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use('/', v1Routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
