/**
 * Express middleware'leri.
 */

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, toAppError, ValidationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { isProd } from '../config/env.js';

const log = createLogger('http');

/**
 * Async route handler wrapper — try/catch'e gerek kalmadan async hata yakalama.
 *
 * Kullanım:
 *   router.get('/x', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler<
  TReq extends Request = Request,
  TRes extends Response = Response,
>(fn: (req: TReq, res: TRes, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as TReq, res as TRes, next)).catch(next);
  };
}

/** Request loglama middleware. */
export const requestLogger: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level](
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
      },
      `${req.method} ${req.path} ${res.statusCode} ${ms}ms`
    );
  });
  next();
};

/** 404 handler — bilinmeyen route'lar için. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Endpoint bulunamadı' },
  });
};

/**
 * Merkezi hata yakalama. Tüm route hataları buraya düşer.
 * Zod hatalarını ValidationError'a çevirir, AppError'ları olduğu gibi gönderir,
 * geri kalanları generic 500'e maskeleyip log'lar.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;

  if (err instanceof ZodError) {
    appErr = new ValidationError('Geçersiz giriş', err.issues);
  } else {
    appErr = toAppError(err);
  }

  // 5xx hatalarını her zaman log'la
  if (appErr.statusCode >= 500) {
    log.error({ err: appErr, path: req.path, method: req.method }, appErr.message);
  } else {
    log.warn({ code: appErr.code, path: req.path }, appErr.message);
  }

  const message = appErr.exposable ? appErr.message : 'Sunucu hatası';

  res.status(appErr.statusCode).json({
    ok: false,
    error: {
      code: appErr.code,
      message,
      ...(appErr.exposable && appErr.details ? { details: appErr.details } : {}),
      ...(isProd ? {} : { stack: appErr.stack }),
    },
  });
};
