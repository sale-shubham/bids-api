import type { NextFunction, Request, Response } from 'express';
import type { Schema } from 'joi';

type Source = 'body' | 'query' | 'params';

export function validate(schema: Schema, source: Source = 'body') {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      convert: true,
      stripUnknown: true,
    });

    if (error) {
      const errors = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message.replace(/['"]/g, ''),
      }));
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: errors.map((e) => `${e.field}: ${e.message}`).join('; '),
          details: errors,
        },
      });
    }

    Object.defineProperty(req, source, { value, writable: true, configurable: true });
    next();
  };
}
