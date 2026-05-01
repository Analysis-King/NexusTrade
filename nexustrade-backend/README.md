# NexusTrade PRO — Kurulum Kılavuzu

## Gereksinimler
- Node.js 18+
- Binance hesabı + API Key

## Kurulum

```bash
cd nexustrade-backend
npm install
node server.js
```

Tarayıcıda: http://localhost:3000

## API Key Bağlantısı

1. Binance > API Management > Create API Key
2. İzinler: **Spot Trading** ✓  (Çekme kapalı tutun)
3. IP kısıtlaması ekleyin (güvenlik için)
4. Platformda **API** sekmesi > Key girin > **Bağlan**

## Endpoints

| Method | Path | Açıklama |
|--------|------|----------|
| GET | /health | Sunucu durumu |
| POST | /api/auth | Binance auth |
| GET | /api/account | Bakiye |
| GET | /api/klines/:sym | Mum verileri |
| GET | /api/orderbook/:sym | Emir defteri |
| POST | /api/order | Emir ver |
| DELETE | /api/order/:sym/:id | Emir iptal |
| GET | /api/bots | Bot listesi |
| POST | /api/bots | Bot oluştur |
| PUT | /api/bots/:id/stop | Bot durdur |
| DELETE | /api/bots/:id | Bot sil |

## WebSocket

`ws://localhost:3000/ws`

Mesaj tipleri: `subscribe_kline`, `subscribe_depth`, `subscribe_trades`, `place_order`, `get_bots`
