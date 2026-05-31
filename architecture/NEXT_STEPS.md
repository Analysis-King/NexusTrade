# NexusTrade Pro Sonraki Teknik Adımlar

Bu liste, mimariyi ürüne dönüştürmek için uygulanacak öncelik sırasıdır.

## 0. Karar

Ana geliştirme yolu:

- Backend: `src/`
- Frontend hedefi: `web/`
- Geçici ekran: `public/index.html`
- Strateji çalışma ortamı: Python worker pool

## 1. Hemen Yapılacak Güvenlik İşleri

### 1.1 Secret Yönetimi

- `.env` içindeki `SESSION_SECRET` ve `ENCRYPTION_KEY` güçlü değerlerle zorunlu hale getirilecek.
- Eksik veya default secret ile server başlamayacak.
- Loglarda secret redaction test edilecek.

### 1.2 API Key Saklama

- API key/secret plaintext saklanmayacak.
- AES-GCM veya benzeri authenticated encryption kullanılacak.
- Encryption key sadece `.env` içinde duracak.
- API key metadata ayrı tutulacak:
  - label
  - permissions
  - createdAt
  - lastUsedAt

### 1.3 Live Mode Guard

Live mode ancak şu koşullarda aktif olacak:

- API key test edildi.
- Withdraw izni yok.
- Risk limitleri tanımlı.
- Bot paper modda en az bir başarılı backtest sonucu ile ilişkilendirilmiş.
- Kullanıcı canlı moda geçişi açıkça onaylamış.

## 2. Emir Yürütme ve Takip

### 2.1 Execution Interface

Mevcut `src/bot/execution.ts` korunacak.

Eksik olan:

- `LiveExecution.openPosition`
- `LiveExecution.closePosition`
- Binance order status mapping
- clientOrderId üretimi
- order persistence

### 2.2 Order Store

Yeni storage tipi:

```ts
type OrderRecord = {
  id: string;
  botId: string;
  signalId: string;
  clientOrderId: string;
  exchangeOrderId?: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  requestedPrice?: number;
  averageFillPrice?: number;
  status: 'PENDING' | 'ACK' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'UNKNOWN';
  mode: 'paper' | 'live';
  createdAt: number;
  updatedAt: number;
  raw?: unknown;
};
```

### 2.3 Idempotency

Her sinyalden emir üretirken:

- `signalId` oluştur.
- `clientOrderId = nexus_<botId>_<signalId>` üret.
- Aynı `signalId` için ikinci kez emir gönderme.
- Network hatasında önce order status sorgula, sonra retry karar ver.

### 2.4 Reconciliation

Server açılışında:

- Bot configleri yüklenir.
- Açık order kayıtları bulunur.
- Binance open orders sorgulanır.
- Local state ile Binance state eşleştirilir.
- Bilinmeyen durumlar UI'da `needs_attention` olarak gösterilir.

## 3. Backtest Doğruluğu

### 3.1 Tek Sinyal Motoru

Backtest ve live aynı Python worker `tick` mantığını kullanmalı.

Yanlış yaklaşım:

- Backtestte ayrı JS algoritması.
- Live’da ayrı Python algoritması.

Doğru yaklaşım:

- Aynı strateji dosyası.
- Aynı indicator hesaplama.
- Aynı candle formatı.
- Farklı sadece execution simülasyonu.

### 3.2 Backtest Run Store

Her backtest sonucu saklanmalı:

```ts
type BacktestRun = {
  id: string;
  strategyId: string;
  strategyVersion: number;
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  params: Record<string, unknown>;
  assumptions: {
    feeRate: number;
    slippageModel: string;
    spreadModel: string;
    fillModel: string;
  };
  metrics: {
    totalReturnPct: number;
    winRate: number;
    profitFactor: number;
    maxDrawdownPct: number;
    sharpe?: number;
  };
  trades: unknown[];
  equity: Array<{ t: number; value: number }>;
  createdAt: number;
};
```

### 3.3 Fill Model

İlk sürüm için net ve dürüst model:

- Market order: candle close fiyatı + slippage.
- Long SL/TP: aynı candle içinde ikisi de değerse muhafazakar olarak SL önce kabul edilir.
- Komisyon: varsayılan `%0.1`.

UI raporda bu varsayımlar açıkça yazılacak.

## 4. Strateji Editörü

### 4.1 Minimum Özellikler

- Kod yazma.
- Validate.
- Save as version.
- Backtest.
- Backtest sonuçlarını karşılaştırma.
- Paper bot oluşturma.

### 4.2 Validate

Kontrol edilecekler:

- `on_candle` var mı?
- Gerekli parametreler doğru mu?
- Syntax valid mi?
- Worker içinde load edilebiliyor mu?
- Örnek 100 mumla dry-run çalışıyor mu?

### 4.3 Kullanıcı Dostu Hata

Python traceback direkt basılmamalı.

Hata formatı:

```json
{
  "line": 42,
  "type": "NameError",
  "message": "rsi_value değişkeni tanımlı değil",
  "hint": "Değişken adını veya indicator çağrısını kontrol edin."
}
```

## 5. Bot Paneli

Her bot kartında zorunlu bilgiler:

- Status
- Mode
- Symbol
- Interval
- Strategy version
- Last signal
- Last candle time
- Open position
- Open order
- Realized PnL
- Today PnL
- Last error
- Heartbeat

## 6. İlk Uygulama Sırası

1. `src/` backend'i çalıştırıp mevcut route ve worker akışını doğrula.
2. `LiveExecution` öncesi `OrderStore` ve `PaperExecution` event kayıtlarını tamamla.
3. Backtest run storage ekle.
4. Strategy validate endpoint ekle.
5. React `web/` frontend'i mevcut `public/index.html` ekranının yerine adım adım taşı.
6. LiveExecution için küçük, kontrollü market order MVP yap.
7. Reconciliation tamamlanmadan live mode'u genel kullanıma açma.

