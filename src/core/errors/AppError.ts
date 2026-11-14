// Typed application errors -> mapped to HTTP responses by the error middleware.

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const BadRequest = (msg: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', msg, details);
export const Unauthorized = (msg = 'Unauthorized') =>
  new AppError(401, 'UNAUTHORIZED', msg);
export const Forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
export const NotFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
export const Conflict = (msg: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', msg, details);
export const UnprocessableEntity = (msg: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE_ENTITY', msg, details);
export const TooManyRequests = (msg = 'Too many requests') =>
  new AppError(429, 'TOO_MANY_REQUESTS', msg);
export const ServiceUnavailable = (msg = 'Service unavailable') =>
  new AppError(503, 'SERVICE_UNAVAILABLE', msg);
