/**
 * Domain-spesifik hata sınıfları.
 *
 * Her hata bir HTTP status code'a ve makine-okunur bir code'a sahip.
 * Frontend hata code'a göre kullanıcıya ne gösterileceğine karar verir.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BINANCE_ERROR'
  | 'BOT_ERROR'
  | 'WORKER_ERROR'
  | 'STORAGE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  /** Kullanıcıya gösterilebilir mi? false ise generic mesaj döner. */
  public readonly exposable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 500,
    options: { details?: unknown; exposable?: boolean; cause?: unknown } = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.exposable = options.exposable ?? statusCode < 500;
    if (options.cause) (this as { cause?: unknown }).cause = options.cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, { details, exposable: true });
  }
}

export class AuthError extends AppError {
  constructor(message = 'Yetkisiz erişim') {
    super('AUTH_REQUIRED', message, 401, { exposable: true });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} bulunamadı`, 404, { exposable: true });
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409, { exposable: true });
  }
}

export class BinanceError extends AppError {
  constructor(message: string, details?: unknown) {
    super('BINANCE_ERROR', message, 502, { details, exposable: true });
  }
}

export class BotError extends AppError {
  constructor(message: string, details?: unknown) {
    super('BOT_ERROR', message, 500, { details, exposable: true });
  }
}

export class WorkerError extends AppError {
  constructor(message: string, details?: unknown) {
    super('WORKER_ERROR', message, 500, { details, exposable: false });
  }
}

export class StorageError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('STORAGE_ERROR', message, 500, { cause, exposable: false });
  }
}

/** Bilinmeyen hatayı AppError'a çevir. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError('INTERNAL_ERROR', err.message, 500, {
      cause: err,
      exposable: false,
    });
  }
  return new AppError('INTERNAL_ERROR', 'Bilinmeyen hata', 500, {
    details: err,
    exposable: false,
  });
}
