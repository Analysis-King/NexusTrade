# NexusTrade

Binance trading platformu — bot motoru, indikatörler, harmonik formasyon analizi, paper/live mod.

> **Durum**: Faz 1 (kişisel kullanım için sağlamlaştırma). Live modda kullanmak henüz önerilmez.
>
> **Uzun aradan sonra döndüysen:** önce [docs/00-BURADAN-BASLA.md](docs/00-BURADAN-BASLA.md).

---

## Hızlı Başlangıç

### Gereksinimler
- Node.js >= 20
- Python >= 3.10 (strateji worker'ları için)
- (Opsiyonel) Binance hesabı + API anahtarı (live mod için)

### Kurulum

```bash
# 1. Bağımlılıklar
npm install
pip install -r python/requirements.txt   # Hafta 2'de eklenecek

# 2. Ortam değişkenleri
cp .env.example .env
# .env içindeki boş SESSION_SECRET ve ENCRYPTION_KEY alanlarını doldurun (her biri ayrı üretilsin):
#   openssl rand -hex 32
#   ya da: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Dev modda çalıştır
npm run dev
```

Sunucu varsayılan olarak http://localhost:3000 üzerinde çalışır.

### Sağlık kontrolü
```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/version
```

---

## Komutlar

| Komut | Açıklama |
|-------|----------|
| `npm run dev` | Hot-reload ile geliştirme sunucusu |
| `npm run build` | TypeScript -> JavaScript derleme |
| `npm start` | Üretim modunda başlat (önce `build`) |
| `npm run lint` | ESLint kontrolü |
| `npm run lint:fix` | Otomatik düzeltme |
| `npm run format` | Prettier ile formatla |
| `npm run typecheck` | Sadece tip kontrolü, derleme yok |
| `npm test` | Testleri çalıştır (Hafta 8) |
| `npm run backup:data` | `data/` klasörünü `../nexustrade-backups` altına tarihli arşivle yedekler (`--dest=`, `--keep=`) |

---

## Mimari

```
src/
├── config/           # env yapılandırması (zod ile validate)
├── routes/           # Express route'ları
├── services/         # İş mantığı (Binance, auth, ödeme...)
├── bot/              # Bot motoru (Hafta 2)
├── workers/          # Python worker yönetimi (Hafta 2)
├── storage/          # Veri katmanı — interface + implementasyon
│   └── json/         # JSON dosya tabanlı (Hafta 5'te SQLite)
├── utils/            # logger, errors, helpers
├── types/            # Domain tipleri (single source of truth)
├── app.ts            # Express app fabrikası
└── server.ts         # Giriş noktası
```

---

## Geliştirme Notları

### Yeni endpoint eklerken
1. Tipi `src/types/domain.ts`'e ekle (gerekirse)
2. `src/routes/<feature>.ts` dosyası oluştur
3. `src/app.ts`'de `app.use('/api/...', router)` ile bağla
4. `asyncHandler` ve zod validation kullan

### Hata yönetimi
- Asla generic `throw new Error(...)` atma — `src/utils/errors.ts`'deki sınıfları kullan
- Async route'larda `asyncHandler` wrapper'ı zorunlu

### Logging
- `console.log` yerine `createLogger('module-adı')` kullan
- Hassas bilgi otomatik redact ediliyor — `apiKey`, `apiSecret`, `password`, `token`

---

## Yol Haritası

- [x] **Hafta 1**: Temel altyapı, TypeScript, logger, error handling
- [ ] **Hafta 2**: server.js modülerleştirme, BinanceAPI servisi
- [ ] **Hafta 3**: API key encryption, güvenlik sıkılaştırma
- [ ] **Hafta 4**: Bot crash recovery, circuit breaker
- [ ] **Hafta 5**: SQLite migration
- [ ] **Hafta 6**: Risk yönetimi (max-loss guard, idempotency)
- [ ] **Hafta 7**: Frontend modülerleştirme + Vite
- [ ] **Hafta 8**: Test coverage + dokümantasyon

---

## Lisans

Henüz tanımlanmadı (ürünleştirme aşamasında belirlenecek).
