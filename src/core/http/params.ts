import type { Request } from 'express';
import { BadRequest } from '@/core/errors/AppError';

// A named route param as a plain string. Express 5's types widen every param to
// `string | string[]` because a wildcard (`/*splat`) captures an array; no route
// in this API uses one, so an array here is a bug in the route, not user input.
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw BadRequest(`Invalid route parameter: ${name}`);
  return value;
}
