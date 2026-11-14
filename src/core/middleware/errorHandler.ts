import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

// express.json() (body-parser) rejects a bad body with an http-errors object:
// `type` names the failure, `status` is the 4xx to send, `expose` marks it as
// safe to show. Before this branch every one of them fell through to 500.
const BODY_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  'entity.parse.failed': { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
  'entity.too.large': { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
};

function bodyParserError(err: unknown) {
  if (typeof err !== 'object' || err === null) return null;
  const { type, status, expose } = err as { type?: unknown; status?: unknown; expose?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number' || expose !== true) return null;
  if (status < 400 || status >= 500) return null;
  return BODY_ERRORS[type] ?? { status, code: 'BAD_REQUEST', message: 'Malformed request body' };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
    return res.status(409).json({
      success: false,
      error: { code: 'CONFLICT', message: `${target} already exists` },
    });
  }

  const bodyError = bodyParserError(err);
  if (bodyError) {
    return res.status(bodyError.status).json({
      success: false,
      error: { code: bodyError.code, message: bodyError.message },
    });
  }

  logger.error({ err }, 'Unhandled error');
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
}
