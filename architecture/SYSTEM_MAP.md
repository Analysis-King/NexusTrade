# NexusTrade Pro Mevcut Sistem Haritası

Bu doküman mevcut kod tabanını ürün hedefiyle eşleştirir.

## Çalışan / Hazır Katmanlar

### Backend Shell

Dosyalar:

- `src/server.ts`
- `src/app.ts`

Durum:

- Express uygulaması var.
- HTTP server var.
- WebSocket server attach ediliyor.
- Worker pool başlatılıyor.
- Bot manager bootstrap ediliyor.
- Graceful shutdown var.
- Process-level hata koruması var.

Eksikler:

- Live trading için shutdown sırasında açık emir/pozisyon reconciliation yok.
- `public/index.html` ve `web/` arasında net frontend seçimi henüz yapılmamış.

## API Haritası

### Health

Route:

- `GET /api/health`
- `GET /api/version`

Amaç:

- Server durumu.
- Versiyon bilgisi.

### Market

Route prefix:

- `/api/market`

Dosya:

- `src/routes/market.ts`

Endpointler:

- `GET /api/market/symbols`
- `GET /api/market/price/:symbol`
- `GET /api/market/ticker/:symbol?`
- `GET /api/market/orderbook/:symbol`
- `GET /api/market/trades/:symbol`
- `GET /api/market/klines/:symbol`
- `GET /api/market/server-time`

Güçlü taraf:

- Binance client ile merkezi market data.
- `format=candle` ile normalize candle formatı.
- Zod validation.

Eksik:

- Eski veri sayfalama endpointi yok.
- Kline endpointinde `startTime/endTime` desteği yok.
- Cache yok.
- Binance rate limit göstergesi UI'a taşınmıyor.

Öneri:

- `GET /api/market/klines/:symbol?interval=1m&limit=500&startTime=&endTime=` desteği eklenmeli.
- Frontend eski mumları direkt Binance yerine backend üzerinden çekmeli.

### Strategies

Route prefix:

- `/api/strategies`

Dosya:

- `src/routes/strategies.ts`
- `src/services/strategies.ts`

Endpointler:

- `GET /api/strategies`
- `GET /api/strategies/:filename`
- `POST /api/strategies`
- `PUT /api/strategies/:filename`
- `DELETE /api/strategies/:filename`

Güçlü taraf:

- Dosya listeleme ve kod kaydetme var.
- Basit metadata parse ediliyor.

Eksik:

- Versioning yok.
- Validate endpoint yok.
- Dry-run endpoint yok.
- Parametre şeması yok.
- Backtest sonucu strateji versiyonuyla bağlanmıyor.

Önerilen yeni endpointler:

- `POST /api/strategies/:filename/validate`
- `POST /api/strategies/:filename/dry-run`
- `GET /api/strategies/:filename/versions`
- `POST /api/strategies/:filename/versions`

### Bots

Route prefix:

- `/api/bots`

Dosyalar:

- `src/routes/bots.ts`
- `src/bot/manager.ts`
- `src/bot/runner.ts`
- `src/bot/execution.ts`

Endpointler:

- `GET /api/bots`
- `GET /api/bots/:id`
- `POST /api/bots`
- `PATCH /api/bots/:id`
- `DELETE /api/bots/:id`
- `POST /api/bots/:id/start`
- `POST /api/bots/:id/stop`
- `POST /api/bots/:id/pause`
- `POST /api/bots/:id/resume`
- `GET /api/bots/:id/trades`

Güçlü taraf:

- Bot lifecycle başlamış.
- Bot state machine var.
- Closed candle ile sinyal üretme prensibi doğru.
- Risk guard için temel alanlar var.
- Paper execution mevcut.

Eksik:

- Live execution stub.
- OrderStore yok.
- Open order state yok.
- Position persistence sınırlı.
- Reconciliation yok.
- Bot statusları ürün yaşam döngüsü için yetersiz.
- Backtest sonucu ile bot canlıya alma arasında guard yok.

Önerilen yeni endpointler:

- `GET /api/bots/:id/orders`
- `GET /api/bots/:id/position`
- `POST /api/bots/:id/live-readiness-check`
- `POST /api/bots/:id/kill-switch`

### Backtest

Mevcut durum:

- `web/src/api/endpoints.ts` içinde backtest `devApi.backtest` ile `/api/dev/pool/backtest` üzerinden gidiyor.
- Bu, ürün endpointi değil; geçici/dev endpoint gibi duruyor.

Eksik:

- Ürün seviyesi `/api/backtests` yok.
- Backtest run store yok.
- Backtest sonucu kalıcı değil.
- Strateji versiyonuna bağlanmıyor.
- Backtest varsayımları saklanmıyor.

Önerilen endpointler:

- `POST /api/backtests`
- `GET /api/backtests`
- `GET /api/backtests/:id`
- `GET /api/strategies/:id/backtests`

## Realtime Haritası

Dosyalar:

- `src/services/binance/stream.ts`
- `src/services/wsServer.ts`

Mevcut iş:

- Binance stream abonelikleri.
- Frontend'e bot event yayını.

Eksik:

- Order event yayını.
- Position event yayını.
- Market stream subscription yönetimi için frontend protokolü net değil.
- Reconnect sonrası state snapshot yayını yok.

Önerilen event tipleri:

```ts
type WsEvent =
  | { type: 'market:candle'; payload: unknown }
  | { type: 'bot:event'; botId: string; event: string; payload: unknown }
  | { type: 'order:update'; orderId: string; payload: unknown }
  | { type: 'position:update'; botId: string; payload: unknown }
  | { type: 'risk:alert'; payload: unknown };
```

## Python Worker Haritası

Dosyalar:

- `src/workers/pool.ts`
- `src/workers/process.ts`
- `python/workers/pool_worker.py`
- `python/workers/strategy_worker.py`

Mevcut iş:

- Worker process başlatma.
- Load/tick/backtest/drop komutları.
- Worker ölürse yeniden başlatma.
- Timeout.

Eksik:

- Strategy sandbox kısıtları net değil.
- Validate/dry-run akışı ürün API'ye bağlanmamış.
- Worker stderr/stdout hata formatı UI dostu değil.
- Backtest determinism garantisi dokümante değil.

## Frontend Haritası

### public/index.html

Güçlü taraf:

- Hızlı çalışan tek ekran.
- Trading terminal hissi var.
- Grafik ve çizim prototipi var.
- Bot modalı ve editor prototipi var.

Zayıf taraf:

- Çok büyük tek dosya.
- State yönetimi kırılgan.
- Uzun vadeli bakım zor.
- API sözleşmeleri eski endpointlerle karışık.

Kullanım kararı:

- Geçici prototip.
- Yeni özellikler mümkünse buraya değil `web/` tarafına taşınmalı.

### web/

Güçlü taraf:

- React component yapısı var.
- API client var.
- Chart component var.
- Bot componentleri başlamış.

Eksik:

- Son yaptığımız `public/index.html` özellikleri burada yok veya eksik.
- TradingView benzeri çizim araçları tamamlanmamış.
- Strategy editor deneyimi net değil.

Kullanım kararı:

- Uzun vadeli ana frontend.

## Öncelikli Boşluk Analizi

### P0: Live Trading Öncesi Zorunlu

- API key encryption.
- OrderStore.
- Idempotent clientOrderId.
- LiveExecution.
- Binance order status reconciliation.
- Kill switch.
- Risk manager.

### P1: Backtest Güvenilirliği

- Ürün endpointi olarak `/api/backtests`.
- Backtest result persistence.
- Fee/slippage/fill assumptions.
- Strategy version binding.
- Same engine for backtest and live signal.

### P2: Editor Stabilitesi

- Validate endpoint.
- Dry-run endpoint.
- Param schema.
- Version history.
- UI-friendly errors.

### P3: Frontend Taşıma

- `web/` Chart + drawing tools.
- `web/` Strategy Editor.
- `web/` Backtest dashboard.
- `web/` Bot operations panel.

