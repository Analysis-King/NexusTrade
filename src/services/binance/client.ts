/**
 * Binance REST API client.
 *
 * Eski JS BinanceAPI sınıfının portu, üstüne:
 *   - native https yerine fetch (Node 20+)
 *   - AbortController ile gerçek timeout
 *   - 429/5xx hatalarda exponential backoff retry
 *   - Rate limit weight tracking (basit, header'dan okur)
 *   - Tipli response'lar
 *
 * Public endpoint'ler için apiKey/secret gerekmez — `BinanceClient.public()`
 * factory'si ile boş key'le instance açabilirsin.
 */

import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { BinanceError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import type {
  BinanceAccountInfo,
  BinanceErrorResponse,
  BinanceKlineRaw,
  BinanceNewOrderResponse,
  BinanceOrder,
  BinanceOrderBook,
  BinancePrice,
  BinanceServerTime,
  BinanceTicker24h,
  BinanceTrade,
  KlinesParams,
  NewOrderParams,
} from './types.js';

const log = createLogger('binance');

interface RequestOptions {
  signed?: boolean;
  timeoutMs?: number;
  /** Retry sayısı (default: 2 — toplam 3 deneme) */
  retries?: number;
}

export interface BinanceClientConfig {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  recvWindow?: number;
}

export class BinanceClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly recvWindow: number;

  /** Son request weight (header'dan okunur) */
  public lastUsedWeight = 0;

  constructor(config: BinanceClientConfig = {}) {
    this.apiKey = config.apiKey ?? '';
    this.apiSecret = config.apiSecret ?? '';
    this.baseUrl = config.baseUrl ?? env.BINANCE_REST_URL;
    this.recvWindow = config.recvWindow ?? env.BINANCE_RECV_WINDOW;
  }

  /** Public-only client — signed endpoint çağrılırsa hata alır. */
  static public(): BinanceClient {
    return new BinanceClient();
  }

  /** Bu client signed endpoint çağırabilir mi? */
  get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /* ─── Private helpers ──────────────────────────────────── */

  private sign(queryString: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  private buildQuery(params: Record<string, unknown>, signed: boolean): string {
    const merged: Record<string, unknown> = signed
      ? { ...params, timestamp: Date.now(), recvWindow: this.recvWindow }
      : { ...params };

    const qs = Object.entries(merged)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');

    if (!signed) return qs;
    return `${qs}&signature=${this.sign(qs)}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    endpoint: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {}
  ): Promise<T> {
    const { signed = false, timeoutMs = 15_000, retries = 2 } = options;

    if (signed && !this.hasCredentials) {
      throw new BinanceError('API anahtarları eksik (signed endpoint için gerekli)');
    }

    const query = this.buildQuery(params, signed);
    const url = query ? `${this.baseUrl}${endpoint}?${query}` : `${this.baseUrl}${endpoint}`;

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          method,
          headers: {
            'X-MBX-APIKEY': this.apiKey,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        // Rate limit weight tracking
        const usedWeight = res.headers.get('x-mbx-used-weight-1m');
        if (usedWeight) this.lastUsedWeight = Number(usedWeight);

        const text = await res.text();
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          throw new BinanceError(`Geçersiz JSON yanıtı (${res.status})`, { raw: text.slice(0, 500) });
        }

        // Binance hata code'u (negatif)
        if (body && typeof body === 'object' && 'code' in body) {
          const errBody = body as BinanceErrorResponse;
          if (typeof errBody.code === 'number' && errBody.code < 0) {
            // 429 = rate limit, 418 = ban
            if (res.status === 429 || res.status === 418) {
              if (attempt < retries) {
                const delay = (attempt + 1) * 1000;
                log.warn({ delay, status: res.status }, 'Binance rate limit, retry');
                await sleep(delay);
                continue;
              }
            }
            throw new BinanceError(`Binance: ${errBody.msg}`, {
              code: errBody.code,
              endpoint,
            });
          }
        }

        // HTTP 5xx — retry
        if (res.status >= 500 && attempt < retries) {
          const delay = 500 * 2 ** attempt; // 500, 1000, 2000ms
          log.warn({ status: res.status, attempt, delay }, 'Binance 5xx, retry');
          await sleep(delay);
          continue;
        }

        if (!res.ok) {
          throw new BinanceError(`HTTP ${res.status}`, { body });
        }

        return body as T;
      } catch (err: unknown) {
        clearTimeout(timer);
        lastError = err;

        // AbortError (timeout) veya network hatası
        if (err instanceof BinanceError) throw err;

        const isAbort = (err as Error).name === 'AbortError';
        const isNetwork = err instanceof TypeError;

        if ((isAbort || isNetwork) && attempt < retries) {
          const delay = 500 * 2 ** attempt;
          log.warn(
            { reason: isAbort ? 'timeout' : 'network', attempt, delay },
            'Binance request retry'
          );
          await sleep(delay);
          continue;
        }

        if (isAbort) throw new BinanceError(`İstek zaman aşımına uğradı (${timeoutMs}ms)`);
        throw new BinanceError(`İstek hatası: ${(err as Error).message ?? 'unknown'}`);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new BinanceError(`Max retry aşıldı: ${(lastError as Error)?.message ?? 'unknown'}`);
  }

  /* ─── Public endpoints ─────────────────────────────────── */

  ping(): Promise<Record<string, never>> {
    return this.request('GET', '/api/v3/ping');
  }

  serverTime(): Promise<BinanceServerTime> {
    return this.request('GET', '/api/v3/time');
  }

  price(symbol: string): Promise<BinancePrice> {
    return this.request('GET', '/api/v3/ticker/price', { symbol });
  }

  ticker24h(symbol?: string): Promise<BinanceTicker24h | BinanceTicker24h[]> {
    return this.request('GET', '/api/v3/ticker/24hr', symbol ? { symbol } : {});
  }

  orderBook(symbol: string, limit = 20): Promise<BinanceOrderBook> {
    return this.request('GET', '/api/v3/depth', { symbol, limit });
  }

  recentTrades(symbol: string, limit = 50): Promise<BinanceTrade[]> {
    return this.request('GET', '/api/v3/trades', { symbol, limit });
  }

  klines(params: KlinesParams): Promise<BinanceKlineRaw[]> {
    return this.request('GET', '/api/v3/klines', params as unknown as Record<string, unknown>);
  }

  /* ─── Signed endpoints ─────────────────────────────────── */

  accountInfo(): Promise<BinanceAccountInfo> {
    return this.request('GET', '/api/v3/account', {}, { signed: true });
  }

  openOrders(symbol?: string): Promise<BinanceOrder[]> {
    return this.request('GET', '/api/v3/openOrders', symbol ? { symbol } : {}, { signed: true });
  }

  allOrders(symbol: string, limit = 50): Promise<BinanceOrder[]> {
    return this.request('GET', '/api/v3/allOrders', { symbol, limit }, { signed: true });
  }

  myTrades(symbol: string, limit = 50): Promise<BinanceTrade[]> {
    return this.request('GET', '/api/v3/myTrades', { symbol, limit }, { signed: true });
  }

  newOrder(params: NewOrderParams): Promise<BinanceNewOrderResponse> {
    return this.request('POST', '/api/v3/order', params as unknown as Record<string, unknown>, {
      signed: true,
    });
  }

  cancelOrder(symbol: string, orderId: number): Promise<BinanceOrder> {
    return this.request('DELETE', '/api/v3/order', { symbol, orderId }, { signed: true });
  }

  cancelAllOrders(symbol: string): Promise<BinanceOrder[]> {
    return this.request('DELETE', '/api/v3/openOrders', { symbol }, { signed: true });
  }

  createListenKey(): Promise<{ listenKey: string }> {
    return this.request('POST', '/api/v3/userDataStream');
  }

  keepAliveListenKey(listenKey: string): Promise<unknown> {
    return this.request('PUT', '/api/v3/userDataStream', { listenKey });
  }

  closeListenKey(listenKey: string): Promise<unknown> {
    return this.request('DELETE', '/api/v3/userDataStream', { listenKey });
  }
}

/* ─── Helper functions ─────────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
