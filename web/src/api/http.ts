/**
 * REST istemcisi.
 *
 * Vite proxy sayesinde dev'de "/api" doğrudan backend'e gidiyor,
 * production build'de aynı origin'den serve ettiğimiz için yine "/api" çalışacak.
 *
 * Kullanım:
 *   const data = await api.get<BotConfig[]>('/bots');
 *   const created = await api.post<BotConfig>('/bots', body);
 */

import type { ApiResponse } from '@/types/api';

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  // 204 No Content
  if (res.status === 204) return undefined as T;

  let payload: ApiResponse<T> | unknown;
  const text = await res.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('PARSE_ERROR', 'Geçersiz JSON yanıtı', res.status);
  }

  // Standart zarf
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const env = payload as ApiResponse<T>;
    if (env.ok) return env.data;
    throw new ApiError(env.error.code, env.error.message, res.status, env.error.details);
  }

  // Eski endpoint'ler doğrudan body dönebilir
  if (res.ok) return payload as T;
  throw new ApiError('HTTP_ERROR', `HTTP ${res.status}`, res.status);
}

export const api = {
  get:    <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post:   <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('POST', path, body, signal),
  patch:  <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('PATCH', path, body, signal),
  put:    <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>('PUT', path, body, signal),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>('DELETE', path, undefined, signal),
};
