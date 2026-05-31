# NexusTrade Backtest API Design

Bu dokuman, strateji editorunde yazilan Python stratejilerini gecmis Binance verisiyle test edip, sonucu bot panelinde guvenilir sekilde analiz edebilmek icin hedef backtest mimarisini tarif eder.

## Mevcut Durum

Projede su anda backtest akisi gelistirme amacli endpoint uzerinden calisiyor:

- `POST /api/dev/pool/backtest`
- Python worker pool'a `candles`, `min_quality`, `tp_mode` gonderiyor.
- Harmonik strateji icin `python/strategies/harmonik_formasyon.py` icindeki `run_backtest` fonksiyonunu calistiriyor.

Mevcut yapinin iyi taraflari:

- Python strateji dosyalari ayri worker process icinde calisiyor.
- `src/services/binance/marketData.ts` icinde `fetchHistorical()` var; sayfali gecmis veri cekmeye hazir.
- Worker protokolu zaten `load`, `tick`, `backtest` komutlarini destekliyor.

Mevcut yapinin urun icin eksikleri:

- Endpoint sadece development modunda aciliyor.
- Backtest sonucu kalici kaydedilmiyor.
- Dev endpoint `days` parametresini dogruluyor ama fiilen son `1000` mumu cekiyor; istenen gun araligini dogru temsil etmeyebilir.
- Sonuc tipi `Record<string, unknown>` oldugu icin frontend, raporlama ve strateji karsilastirma zorlasiyor.
- Islem varsayimlari net degil: fee, slippage, ayni mumda TP/SL carpismasi, emir dolum modeli, veri araligi.
- Her strateji kendi sonuc formatini donebilir; bunu normalize etmek gerekiyor.

## Hedef Urun Endpointleri

### `POST /api/backtests`

Yeni backtest baslatir. Ilk surum senkron calisabilir; uzun vadede job tabanli calismali.

Request:

```json
{
  "strategyFile": "harmonik_formasyon.py",
  "symbol": "BTCUSDT",
  "interval": "1h",
  "startTime": 1714521600000,
  "endTime": 1746057600000,
  "initialCapital": 1000,
  "feeBps": 10,
  "slippageBps": 2,
  "fillModel": "pessimistic_ohlc",
  "params": {
    "min_quality": 60,
    "tp_mode": "TP2"
  }
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "id": "bt_20260512_001",
    "status": "completed",
    "summary": {
      "symbol": "BTCUSDT",
      "interval": "1h",
      "candleCount": 8760,
      "initialCapital": 1000,
      "finalCapital": 1184.3,
      "totalReturnPct": 18.43,
      "maxDrawdownPct": 9.8,
      "winRatePct": 54.2,
      "profitFactor": 1.42,
      "sharpe": 1.18,
      "totalTrades": 48
    },
    "assumptions": {
      "feeBps": 10,
      "slippageBps": 2,
      "fillModel": "pessimistic_ohlc",
      "sameCandleTpSl": "stop_first"
    }
  }
}
```

### `GET /api/backtests/:id`

Kaydedilmis backtest sonucunu getirir.

### `GET /api/backtests`

Son backtestleri listeler. Strateji, sembol, interval ve tarih filtresi desteklemeli.

### `DELETE /api/backtests/:id`

Eski test sonucunu siler.

## Backtest Run Kayit Modeli

Ilk asamada JSON dosyasi yeterli; sonra SQLite daha dogru olur.

```ts
interface BacktestRun {
  id: string;
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  strategyFile: string;
  strategyVersionHash: string;
  symbol: string;
  interval: Interval;
  startTime: number;
  endTime: number;
  candleCount: number;
  initialCapital: number;
  params: Record<string, unknown>;
  assumptions: BacktestAssumptions;
  summary?: BacktestSummary;
  trades?: BacktestTrade[];
  equity?: EquityPoint[];
  patternStats?: PatternStat[];
  error?: string;
}
```

## Normalize Edilmis Sonuc Tipleri

Worker stratejiye ozel sonuc donebilir ama backend bunu standart hale getirmeli.

```ts
interface BacktestSummary {
  initialCapital: number;
  finalCapital: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  sharpe: number | null;
  totalTrades: number;
  avgTradePct: number | null;
  bestTradePct: number | null;
  worstTradePct: number | null;
}

interface BacktestTrade {
  id: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  netPnl: number;
  pnlPct: number;
  feePaid: number;
  reason: 'tp' | 'sl' | 'signal' | 'timeout' | 'end_of_test';
  meta?: Record<string, unknown>;
}
```

## Dogruluk Kurallari

Backtestte dogruluk icin her run su varsayimlari kaydetmeli:

- Veri araligi: `startTime`, `endTime`, `candleCount`.
- Veri kaynagi: Binance spot klines.
- Fee: varsayilan `10 bps` yani `0.1%`.
- Slippage: varsayilan `2 bps`, ayarlanabilir.
- Emir dolumu v1: sinyal gelen mum kapandiktan sonra sonraki mum acilisindan giris.
- TP/SL ayni mumda gorulurse v1 icin muhafazakar kural: once SL kabul edilir.
- Look-ahead bias yasak: strateji sadece mevcut ve gecmis mumlari gorebilir.
- Baslangic sermayesi ve pozisyon boyutu her run'da kaydedilir.

## Servis Katmani

Onerilen yeni dosyalar:

- `src/services/backtest.ts`
- `src/storage/backtestStore.ts`
- `src/routes/backtests.ts`
- `src/types/backtest.ts`

`src/services/backtest.ts` sorumluluklari:

- Request'i dogrulamak.
- Strateji dosyasinin mevcut ve guvenli oldugunu kontrol etmek.
- Strateji hash'i almak.
- Binance'den tarihsel veriyi `fetchHistorical()` ile cekmek.
- Worker pool'a backtest istegi gondermek.
- Sonucu normalize etmek.
- Run kaydini store'a yazmak.

## Worker Kontrati

`src/workers/types.ts` icindeki `BacktestResponse = Record<string, unknown>` yerine standart ama genisletilebilir bir tip kullanilmali:

```ts
export interface BacktestWorkerResponse {
  summary?: Partial<BacktestSummary>;
  trades?: BacktestTrade[];
  equity?: EquityPoint[];
  patterns?: PatternStat[];
  drawings?: unknown[];
  raw?: Record<string, unknown>;
}
```

Harmonik dosya gibi kendi `run_backtest` fonksiyonu olan stratejiler desteklenmeli. Fakat genel strateji editoru icin ikinci bir mod gerekli:

- Strateji `run_backtest` sagliyorsa onu kullan.
- Saglamiyorsa backend genel simulator ile her mumda `on_candle` calistirir.
- Bu sayede sadece `on_candle` yazan kullanici stratejileri de test edilebilir.

## Frontend Akisi

Strateji editorunde hedef akisi:

1. Kullanici strateji kodunu yazar.
2. `Validate` butonu kodu worker'da yukler, syntax ve gerekli fonksiyonlari kontrol eder.
3. Kullanici sembol, interval, tarih araligi ve sermaye secer.
4. `Backtest Basla` butonu `POST /api/backtests` cagirir.
5. Sonuc paneli standart metrikleri gosterir.
6. Trades tablosu, equity curve ve formasyon/strateji bazli detaylar acilir.
7. Kullanici ayni sonucu bot deploy kararinda referans olarak gorebilir.

## Ilk Uygulama Sirasi

1. `src/types/backtest.ts` tiplerini ekle.
2. `src/storage/backtestStore.ts` ile JSON tabanli run kaydi yap.
3. `src/services/backtest.ts` servis katmanini yaz.
4. `src/routes/backtests.ts` endpointlerini ekle.
5. `src/app.ts` icinde `/api/backtests` route'unu mount et.
6. Dev endpointteki `/api/dev/pool/backtest` akisini yeni servise yonlendir ya da sadece test amacli birak.
7. `python/workers/pool_worker.py` backtest sonucunu standart alanlarla donecek sekilde genislet.
8. Frontend editorundeki backtest butonunu `/api/backtests` endpointine bagla.

## Kritik Not

Backtest modulu kurulmadan live bot emirlerine gecmemek daha saglikli. Once ayni stratejinin:

- Hangi veriyle test edildigi,
- Hangi varsayimlarla kar/zarar hesapladigi,
- Hangi trade'leri actigi/kapattigi,
- Canliya alinmaya uygun olup olmadigi

net ve kayitli olmali. Bu, hem strateji bulma surecini temizler hem de canli emir tarafindaki riski azaltir.
