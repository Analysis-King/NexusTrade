/**
 * NexusTrade WebSocket sunucusu — frontend ile gerçek-zamanlı iletişim.
 *
 * Mesaj protokolü (JSON):
 *
 * Client → Server:
 *   { type: 'ping' }
 *   { type: 'subscribe',   stream: 'btcusdt@kline_1m' }
 *   { type: 'unsubscribe', stream: 'btcusdt@kline_1m' }
 *   { type: 'subscribe_kline',  payload: { symbol, interval } }
 *   { type: 'subscribe_trades', payload: { symbol } }
 *   { type: 'subscribe_depth',  payload: { symbol } }
 *   { type: 'subscribe_ticker' }                       // !miniTicker@arr
 *
 * Server → Client:
 *   { type: 'pong', ts }
 *   { type: 'connected', ts }
 *   { type: 'stream', stream, data }
 *   { type: 'error', message }
 *
 * Her client'ın aktif aboneliklerini izler, bağlantı kapanınca otomatik unsubscribe.
 */

import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { getBinanceStream, type BinanceStreamManager } from './binance/stream.js';

const log = createLogger('ws-server');

interface ClientState {
  id: string;
  ws: WebSocket;
  /** stream → unsubscribe fonksiyonu */
  subscriptions: Map<string, () => void>;
  /** Heartbeat — son pong zamanı */
  alive: boolean;
}

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('subscribe'), stream: z.string().min(1).max(100) }),
  z.object({ type: z.literal('unsubscribe'), stream: z.string().min(1).max(100) }),
  z.object({
    type: z.literal('subscribe_kline'),
    payload: z.object({
      symbol: z.string().regex(/^[A-Z0-9]+$/),
      interval: z.string().min(1).max(5),
    }),
  }),
  z.object({
    type: z.literal('subscribe_trades'),
    payload: z.object({ symbol: z.string().regex(/^[A-Z0-9]+$/) }),
  }),
  z.object({
    type: z.literal('subscribe_depth'),
    payload: z.object({ symbol: z.string().regex(/^[A-Z0-9]+$/) }),
  }),
  z.object({ type: z.literal('subscribe_ticker') }),
]);

export class NexusWebSocketServer {
  private wss: WebSocketServer;
  private clients = new Map<string, ClientState>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private binanceStream: BinanceStreamManager;

  constructor(httpServer: http.Server) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.binanceStream = getBinanceStream();

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.startHeartbeat();
  }

  /** Açık client sayısı */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Tüm client'lara broadcast (bot status update vs. için) */
  broadcast(message: object): void {
    const data = JSON.stringify(message);
    for (const c of this.clients.values()) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  /** Graceful kapatma */
  async close(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const c of this.clients.values()) {
      for (const unsub of c.subscriptions.values()) unsub();
      c.subscriptions.clear();
      c.ws.terminate();
    }
    this.clients.clear();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /* ─── Private ──────────────────────────────────────────── */

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const id = randomUUID();
    const client: ClientState = {
      id,
      ws,
      subscriptions: new Map(),
      alive: true,
    };
    this.clients.set(id, client);

    log.info(
      { clientId: id, ip: req.socket.remoteAddress, total: this.clients.size },
      'WS client bağlandı'
    );

    this.send(ws, { type: 'connected', ts: Date.now() });

    ws.on('pong', () => {
      client.alive = true;
    });

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        this.send(ws, { type: 'error', message: 'Geçersiz JSON' });
        return;
      }
      const result = messageSchema.safeParse(parsed);
      if (!result.success) {
        this.send(ws, { type: 'error', message: 'Geçersiz mesaj formatı' });
        return;
      }
      this.handleMessage(client, result.data);
    });

    ws.on('close', () => this.cleanupClient(id));
    ws.on('error', (err) => {
      log.warn({ clientId: id, err: err.message }, 'WS client error');
      this.cleanupClient(id);
    });
  }

  private cleanupClient(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    for (const unsub of c.subscriptions.values()) unsub();
    c.subscriptions.clear();
    this.clients.delete(id);
    log.info({ clientId: id, total: this.clients.size }, 'WS client ayrıldı');
  }

  private handleMessage(
    client: ClientState,
    msg: z.infer<typeof messageSchema>
  ): void {
    switch (msg.type) {
      case 'ping':
        this.send(client.ws, { type: 'pong', ts: Date.now() });
        return;

      case 'subscribe':
        this.subscribeStream(client, msg.stream.toLowerCase());
        return;

      case 'unsubscribe':
        this.unsubscribeStream(client, msg.stream.toLowerCase());
        return;

      case 'subscribe_kline': {
        const stream = `${msg.payload.symbol.toLowerCase()}@kline_${msg.payload.interval}`;
        this.subscribeStream(client, stream);
        return;
      }

      case 'subscribe_trades': {
        const stream = `${msg.payload.symbol.toLowerCase()}@trade`;
        this.subscribeStream(client, stream);
        return;
      }

      case 'subscribe_depth': {
        const stream = `${msg.payload.symbol.toLowerCase()}@depth20@100ms`;
        this.subscribeStream(client, stream);
        return;
      }

      case 'subscribe_ticker':
        this.subscribeStream(client, '!miniticker@arr');
        return;
    }
  }

  private subscribeStream(client: ClientState, stream: string): void {
    if (client.subscriptions.has(stream)) return; // zaten abone

    const handler = (data: unknown): void => {
      this.send(client.ws, { type: 'stream', stream, data });
    };

    this.binanceStream.on(stream, handler);
    const unsubBinance = this.binanceStream.subscribe(stream);

    client.subscriptions.set(stream, () => {
      this.binanceStream.off(stream, handler);
      unsubBinance();
    });
  }

  private unsubscribeStream(client: ClientState, stream: string): void {
    const unsub = client.subscriptions.get(stream);
    if (!unsub) return;
    unsub();
    client.subscriptions.delete(stream);
  }

  private send(ws: WebSocket, message: object): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  /** Ölü bağlantıları tespit edip temizle */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [id, c] of this.clients) {
        if (!c.alive) {
          log.warn({ clientId: id }, 'WS client heartbeat timeout — kapatılıyor');
          c.ws.terminate();
          this.cleanupClient(id);
          continue;
        }
        c.alive = false;
        if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
      }
    }, 30_000);
  }
}
