/**
 * Binance combined stream yönetimi (fan-out).
 *
 * Tek bir WebSocket bağlantısı çoklu stream'e abone olur (kline, depth, trade vs.).
 * Yerel client'lar bu stream'lere `subscribe()` ile abone olur, mesajlar
 * EventEmitter ile dağıtılır. Auto-reconnect, ping/pong, ref-counting içerir.
 *
 * Binance combined stream URL formatı:
 *   wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m
 *
 * Aboneler düştüğünde stream'i otomatik kapatır (ref-count = 0 olduğunda).
 */

import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('binance-stream');

/** Kline stream payload (Binance WS docs). */
export interface KlineStreamData {
  e: 'kline';
  E: number; // event time
  s: string; // symbol
  k: {
    t: number; // open time
    T: number; // close time
    s: string;
    i: string; // interval
    o: string; // open
    h: string; // high
    l: string; // low
    c: string; // close
    v: string; // volume
    x: boolean; // closed?
  };
}

export interface MiniTickerData {
  e: '24hrMiniTicker';
  E: number;
  s: string;
  c: string;
  o: string;
  h: string;
  l: string;
  v: string;
  q: string;
}

export interface TradeStreamData {
  e: 'trade';
  E: number;
  s: string;
  t: number;
  p: string;
  q: string;
  T: number;
  m: boolean; // is buyer maker
}

export interface DepthStreamData {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export type StreamPayload =
  | KlineStreamData
  | MiniTickerData
  | TradeStreamData
  | DepthStreamData
  | unknown;

/**
 * Binance combined stream manager.
 *
 * Olaylar:
 *   .on('<streamName>', (payload) => ...)
 *   .on('connected', () => ...)
 *   .on('disconnected', () => ...)
 */
export class BinanceStreamManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly subscriptions = new Map<string, number>(); // stream → refCount
  private connected = false;
  private connecting = false;
  private connectingStartedAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  /** Periyodik abonelik senkronizasyonu (gerekirse) */
  private reqId = 1;

  constructor(private readonly baseUrl: string = env.BINANCE_WS_URL) {
    super();
    this.setMaxListeners(0); // sınırsız listener
  }

  /** Aktif abonelik var mı? */
  get hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  /** Bağlantı durumu */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Stream'e abone ol. Aynı stream'e tekrar abone olunursa ref-count artar.
   * Dönen unsubscribe fonksiyonu çağrıldığında ref-count azalır,
   * sıfırlanırsa stream Binance'den de kaldırılır.
   *
   * Stream isim örnekleri:
   *   "btcusdt@kline_1m"
   *   "ethusdt@trade"
   *   "btcusdt@depth20@100ms"
   *   "!miniTicker@arr"
   */
  subscribe(stream: string): () => void {
    const key = stream.toLowerCase();
    const count = this.subscriptions.get(key) ?? 0;
    this.subscriptions.set(key, count + 1);

    if (count === 0) {
      // Yeni stream — Binance'a SUBSCRIBE gönder veya bağlantıyı aç
      if (this.connected && this.ws) {
        this.sendSubscribe([key]);
      } else {
        this.ensureConnected();
      }
    } else if (!this.connected) {
      this.ensureConnected();
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const c = this.subscriptions.get(key) ?? 0;
      if (c <= 1) {
        this.subscriptions.delete(key);
        if (this.connected && this.ws) this.sendUnsubscribe([key]);
        if (this.subscriptions.size === 0) this.disconnect();
      } else {
        this.subscriptions.set(key, c - 1);
      }
    };
  }

  /* ─── Connection lifecycle ─────────────────────────────── */

  /** Birden fazla stream'i tek baglanti acilisinda atomik olarak abone eder. */
  subscribeMany(streams: string[]): () => void {
    const keys = [...new Set(streams.map((stream) => stream.toLowerCase()))];
    const newlyAdded: string[] = [];
    for (const key of keys) {
      const count = this.subscriptions.get(key) ?? 0;
      this.subscriptions.set(key, count + 1);
      if (count === 0) newlyAdded.push(key);
    }

    if (newlyAdded.length > 0) {
      if (this.connected && this.ws) {
        this.sendSubscribe(newlyAdded);
      } else {
        this.ensureConnected();
      }
    } else if (!this.connected) {
      this.ensureConnected();
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const removed: string[] = [];
      for (const key of keys) {
        const count = this.subscriptions.get(key) ?? 0;
        if (count <= 1) {
          this.subscriptions.delete(key);
          removed.push(key);
        } else {
          this.subscriptions.set(key, count - 1);
        }
      }
      if (removed.length > 0 && this.connected && this.ws) this.sendUnsubscribe(removed);
      if (this.subscriptions.size === 0) this.disconnect();
    };
  }

  private connect(): void {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.connectingStartedAt = Date.now();

    const streams = [...this.subscriptions.keys()].join('/');
    const url = streams
      ? `${this.baseUrl}/stream?streams=${streams}`
      : `${this.baseUrl}/ws`;

    log.info({ streams: this.subscriptions.size }, 'Binance WS bağlanıyor');

    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.connecting = false;
      this.connectingStartedAt = 0;
      this.reconnectAttempt = 0;
      this.startPing();
      log.info('Binance WS bağlandı');
      this.emit('connected');
    });

    ws.on('message', (raw) => this.handleMessage(raw));

    ws.on('pong', () => {
      // Bağlantı sağlam — bir şey yapmaya gerek yok
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'Binance WS hata');
      if (this.ws === ws && ws.readyState !== WebSocket.CLOSED) {
        try {
          ws.terminate();
        } catch {
          // close event temizligi tamamlar
        }
      }
    });

    ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'Binance WS kapandı');
      this.cleanup();
      if (this.subscriptions.size > 0) {
        this.scheduleReconnect();
      }
    });
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      // Hata fırlatabilir; özellikle henüz CONNECTING durumundaysa terminate()
      // "WebSocket was closed before the connection was established" atar.
      // close() bu durumda daha güvenli; emin olmak için ikisini de try-catch'e al.
      try {
        const state = this.ws.readyState;
        if (state === WebSocket.OPEN || state === WebSocket.CLOSING) {
          this.ws.terminate();
        } else {
          // CONNECTING veya CLOSED — close çağırarak listener temizliği yapılır
          this.ws.close();
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'WS terminate/close hata');
      }
      this.ws = null;
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.connected = false;
    this.connecting = false;
    this.connectingStartedAt = 0;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.emit('disconnected');
  }

  private ensureConnected(): void {
    if (this.connected) return;
    if (this.connecting) {
      const startedAt = this.connectingStartedAt || Date.now();
      if (Date.now() - startedAt < 20_000) return;
      log.warn('Binance WS baglantisi connecting durumunda takildi, yeniden baslatiliyor');
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch {
          // close event temizligi tamamlar
        }
      }
      this.cleanup();
    }
    this.connect();
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
    log.info({ attempt: this.reconnectAttempt, delay }, 'Binance WS yeniden bağlanma planlandı');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30_000);
  }

  /* ─── Subscribe / Unsubscribe wire protocol ────────────── */

  private sendSubscribe(streams: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: streams,
        id: this.reqId++,
      })
    );
  }

  private sendUnsubscribe(streams: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        method: 'UNSUBSCRIBE',
        params: streams,
        id: this.reqId++,
      })
    );
  }

  /* ─── Message handling ─────────────────────────────────── */

  private handleMessage(raw: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      log.warn('Binance WS: geçersiz JSON');
      return;
    }

    // Combined stream format: { stream: "btcusdt@kline_1m", data: {...} }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'stream' in parsed &&
      'data' in parsed
    ) {
      const { stream, data } = parsed as { stream: string; data: StreamPayload };
      this.emit(stream.toLowerCase(), data);
      this.emit('message', { stream, data });
      return;
    }

    // Tek stream (raw) veya subscribe response
    if (parsed && typeof parsed === 'object' && 'result' in parsed && 'id' in parsed) {
      // SUBSCRIBE/UNSUBSCRIBE ack — yoksay
      return;
    }

    // Diğer (event-based, raw)
    this.emit('raw', parsed);
  }
}

/** Singleton — tek bir Binance bağlantısı yeter. */
let instance: BinanceStreamManager | null = null;
export function getBinanceStream(): BinanceStreamManager {
  if (!instance) instance = new BinanceStreamManager();
  return instance;
}
