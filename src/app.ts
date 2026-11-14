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
  // Browsers call this API directly (the web app has no same-origin proxy), so that hop's client IP is the member's own.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
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
