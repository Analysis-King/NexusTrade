/**
 * WebSocket client.
 *
 * Backend'in /ws endpoint'ine bağlanır, subscribe/unsubscribe yapar,
 * gelen stream/event'leri callback'lere dağıtır. Auto-reconnect içerir.
 *
 * Singleton — uygulama boyunca tek bağlantı.
 *
 * Kullanım:
 *   ws.subscribeKline('BTCUSDT', '1m', (data) => { ... });
 *   ws.onBotEvent((evt) => { ... });
 */

type Listener<T = unknown> = (data: T) => void;

interface BotEvent {
  type: 'bot-event';
  event: string;
  botId: string;
  payload: unknown;
}

interface StreamMessage {
  type: 'stream';
  stream: string;
  data: unknown;
}

class WsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private connecting = false;

  /** Aktif abonelikler — yeniden bağlandığımızda re-subscribe için. */
  private subscriptions = new Map<string, number>(); // stream → ref count

  /** Stream listener'ları: stream key → set of callbacks */
  private streamListeners = new Map<string, Set<Listener>>();
  /** Bot event listener'ları */
  private botEventListeners = new Set<Listener<BotEvent>>();
  /** Bağlantı durumu listener'ları (UI badge için) */
  private statusListeners = new Set<Listener<'connected' | 'disconnected'>>();

  connect(): void {
    if (this.ws || this.connecting) return;
    this.connecting = true;

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.statusListeners.forEach((l) => l('connected'));
      // Re-subscribe — kopuşta açık olan tüm aboneliklere geri dön
      for (const stream of this.subscriptions.keys()) {
        this.send({ type: 'subscribe', stream });
      }
    };

    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatch(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      this.connecting = false;
      this.statusListeners.forEach((l) => l('disconnected'));
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Hata sonrası onclose tetikleniyor, orada handle ediyoruz
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /* ─── Public subscribe API ─────────────────────────────── */

  /** Bir kline stream'e abone ol. Dönen unsubscribe fonksiyonu çağrılınca ref-count azalır. */
  subscribeKline(symbol: string, interval: string, cb: Listener): () => void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    return this.subscribeStream(stream, cb);
  }

  subscribeTrades(symbol: string, cb: Listener): () => void {
    return this.subscribeStream(`${symbol.toLowerCase()}@trade`, cb);
  }

  subscribeDepth(symbol: string, cb: Listener): () => void {
    return this.subscribeStream(`${symbol.toLowerCase()}@depth20@100ms`, cb);
  }

  subscribeMiniTickerAll(cb: Listener): () => void {
    return this.subscribeStream('!miniticker@arr', cb);
  }

  /** Bot olayları (position-opened, stopped, vs.) */
  onBotEvent(cb: Listener<BotEvent>): () => void {
    this.botEventListeners.add(cb);
    return () => this.botEventListeners.delete(cb);
  }

  /** Bağlantı durumu değişimi */
  onStatus(cb: Listener<'connected' | 'disconnected'>): () => void {
    this.statusListeners.add(cb);
    // İlk durumu hemen bildir
    cb(this.ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected');
    return () => this.statusListeners.delete(cb);
  }

  /* ─── Internal ─────────────────────────────────────────── */

  private subscribeStream(stream: string, cb: Listener): () => void {
    const key = stream.toLowerCase();

    // Listener kaydet
    let set = this.streamListeners.get(key);
    if (!set) {
      set = new Set();
      this.streamListeners.set(key, set);
    }
    set.add(cb);

    // Ref-count
    const count = this.subscriptions.get(key) ?? 0;
    this.subscriptions.set(key, count + 1);
    if (count === 0) {
      this.send({ type: 'subscribe', stream: key });
    }

    return () => {
      const listeners = this.streamListeners.get(key);
      listeners?.delete(cb);

      const c = this.subscriptions.get(key) ?? 0;
      if (c <= 1) {
        this.subscriptions.delete(key);
        this.send({ type: 'unsubscribe', stream: key });
      } else {
        this.subscriptions.set(key, c - 1);
      }
    };
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string };

    if (m.type === 'stream') {
      const sm = m as unknown as StreamMessage;
      const listeners = this.streamListeners.get(sm.stream.toLowerCase());
      listeners?.forEach((l) => {
        try { l(sm.data); } catch (e) { console.error('Stream listener err', e); }
      });
      return;
    }

    if (m.type === 'bot-event') {
      this.botEventListeners.forEach((l) => {
        try { l(m as BotEvent); } catch (e) { console.error('Bot event listener err', e); }
      });
      return;
    }
  }

  private send(obj: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
    // OPEN değilse: subscribe/unsubscribe zaten subscriptions map'inde tutuluyor,
    // reconnect olunca otomatik gönderilecek.
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const ws = new WsClient();
