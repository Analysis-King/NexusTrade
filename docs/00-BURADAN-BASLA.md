# Buradan Başla

> Uzun bir aradan sonra bilgisayar başına oturduğunda **ilk** bu sayfayı oku.
> Her çalışma oturumunun sonunda en alttaki **Son durum** bölümünü güncelle (5 dakika).
> Bu sayfa güncel değilse geri kalan her şey yine dağılır.

Diğer dokümanlar:

| Doküman | Ne için |
|---|---|
| [01-SISTEM-INCELEMESI.md](01-SISTEM-INCELEMESI.md) | Sistemin eksikleri, kırılgan noktaları, öncelik sırası |
| [02-YOL-HARITASI.md](02-YOL-HARITASI.md) | Kazanan stratejiyi bulup canlıya geçmeye kadar fazlar ve kapılar |
| [03-ARASTIRMA-PROTOKOLU.md](03-ARASTIRMA-PROTOKOLU.md) | Her deneyin nasıl yapılacağı, ne zaman "geçti" sayılacağı, şablon |
| [arastirma/DENEY-KAYDI.md](arastirma/DENEY-KAYDI.md) | Şimdiye kadar denenen her şey ve sonucu |

`architecture/` klasöründeki dokümanlar Mayıs 2026'dan kalma; bilgi amaçlı, güncel değil.

---

## Sistem tek bakışta

```
NexusTrade Baslat.exe
 ├─ scripts/start-backend.cmd ─► node src/server.ts   (http://127.0.0.1:3000)
 │    ├─ REST /api/*  +  WebSocket /ws
 │    ├─ Bot yöneticisi (src/bot/)
 │    │     her bot: Binance mum akışı ─► Python strateji ─► sinyal ─► PAPER emir
 │    ├─ Python worker havuzları (python/workers/pool_worker.py)
 │    │     4 süreç bot tick'leri, 2 süreç backtest/çizim işleri
 │    └─ Paper portföy denetçisi (src/services/paperPortfolioSupervisor.ts)
 │          30 dakikada bir scripts/harmonic_*_paper*.cjs çalıştırır
 └─ scripts/start-web.cmd ─► Vite arayüzü (http://localhost:5173, web/)
```

Önemli: **Gerçek emir gönderen kod yok.** `LiveExecution` bir taslak ve çağrılırsa hata fırlatır
(`src/bot/execution.ts`). Şu an her şey paper (sanal para).

## Nerede ne var

| Yer | İçerik | Git'te mi |
|---|---|---|
| `src/` | Backend (TypeScript, Express) | evet |
| `web/` | Arayüz (React + Vite) | evet |
| `public/` | Eski tek sayfa arayüz, kullanılmıyor | evet |
| `python/strategies/` | 33 strateji dosyası; aktif kullanılan 4-5 tanesi | evet |
| `python/workers/` | Strateji çalıştırıcı ve backtest motoru | evet |
| `scripts/` | Paper portföyler, başlatıcılar, yedekleme ve Faz 1-2 araçları (17 dosya) | evet |
| `scripts/archive/` | Kapanmış deneylerin 48 araştırma script'i; bakımı yapılmıyor | evet |
| `data/` | `bots.json`, `trades.json`, paper portföy durumları, **555 araştırma raporu**, mum önbelleği (~600 MB) | **hayır**; yedek: `npm run backup:data` (`../nexustrade-backups`) |
| `logs/` | `backend.log`, çökme raporları (`logs/reports/`) | hayır |
| `tests/` | 39 test (vitest), hepsi geçiyor (2026-11-26) | evet |

## Sık kullanılan komutlar

```powershell
# Sistemi başlat: kök dizindeki "NexusTrade Baslat.exe"
# Sağlık kontrolü
curl http://127.0.0.1:3000/api/health
# Testler
npm test
# Tip kontrolü
npm run typecheck
# data/ yedeği (varsayılan hedef ../nexustrade-backups, son 14 arşiv tutulur)
npm run backup:data
```

Log: `logs/backend.log`. Saatler UTC yazılır (Türkiye saati = UTC + 3).

## Şu an çalışanlar (2026-11-26)

| Ad | Tür | Strateji dosyası | Sembol / periyot | Durum | Sonuç |
|---|---|---|---|---|---|
| Harmonik | Bot | `pine_harmonic_patterns.py` (filtresiz) | BTCUSDT 1m | Durdu | −220 $ / 1000 $ (93 işlem, 31 May'dan beri) |
| qwm3 | Bot | `qm_wolfe_patterns.py` | ETHUSDT 4h | Çalışıyor | 0 $ (henüz kapanan işlem yok) |
| qwm5 | Bot | `qm_wolfe_patterns.py` | ADAUSDT 5m | Çalışıyor | −61 $ / 1000 $ |
| Harmonik Portföy | Paper portföy | `harmonic_portfolio_candidate.py` | 50 sembol 1h, 12x | Kapanıyor | −%47.3 |
| QualityTarget 4x | Paper portföy | aynı | 50 sembol 1h, 4x | Kapanıyor | −%43.7 |
| QualityTarget 10x | Paper portföy | aynı | 50 sembol 1h, 10x | Kapanıyor | −%94.9 |
| Tarayıcı V2 | Paper portföy | `harmonic_scanner_v2.py` | 380 sembol 1h+4h | Kapanıyor | −%16.3 |
| Tarayıcı V2 HTF Onay | Paper portföy | `harmonic_scanner_v2.py` + 4h onay | 380 sembol 1h | Kapanıyor | +%0.8 (sadece 8 işlem) |

Paper portföy durumları:
- **Çalışıyor:** planlanan bitişe kadar yeni işlem açar.
- **Kapanıyor:** süre doldu; yeni işlem açılmaz, açık pozisyonlar SL/TP ile kapanana kadar izlenir.
- **Tamamlandı:** açık pozisyon kalmadı.
- **Durduruldu:** arayüzdeki "Durdur" ile; açık pozisyonlar son fiyattan kapatılır, geri alınamaz.

Süresi dolan bir portföy arayüzdeki "Süreyi 30 gün uzat" ile yeniden işlem açar. Komut satırından aynı
işler: `node scripts/<script>.cjs --action=stop` ya da `--action=extend --extend-days=30` (supervisor'daki
argümanlarla birlikte).

## Unutulmaması gereken araştırma sonuçları

1. **12 Haziran 2026 özeti** (`data/STRATEGY_RESEARCH_SUMMARY_20260612.md`):
   20'den fazla strateji ailesi denendi. Gerçekçi maliyetlerle hiçbiri günlük %0.8'i sağlam
   biçimde vermedi. Savunulabilir en iyi adaylar günlük %0.12 ile %0.42 arasında, ortalama
   düşüş %6 ile %28 arasında. Adaptif seçici kör testte başarısız oldu.
   Özetin kendi önerisi: üç adayı (DEMA long TRXUSDT 1h, Donchian ZECUSDT 1h iki varyant)
   ileriye dönük paper testte çalıştırmak ve **parametre madenciliğini bırakmak**.
2. O ileriye dönük test **yarım kaldı**: botlar 2-3 hafta sonra, her biri tek işlemle bırakıldı.
3. Temmuz 2026'da harmonik araştırmasına geçildi; oradan çıkan portföyler ileriye dönük
   paper testte yukarıdaki tablodaki gibi zarar etti.
4. **Harmonik Portföy'ün güzel backtest'i bir hataydı** (2026-11-27'de bulundu). Portföy replay'i giriş
   mumunda stop olan işlemleri (işlemlerin yarısı) atıyordu. Düzeltilince aynı veri günlük −%3.9 ile −%6.1
   veriyor. Ayrıntı: [DENEY-KAYDI EXP-016](arastirma/DENEY-KAYDI.md).

Ders: sorun fikir eksikliği değil, **başlanan doğrulamanın bitirilmemesi**. Yol haritası bu
yüzden aynı anda en fazla 3 adayın test edilmesini ve testlerin önceden belirlenen süre
dolmadan bırakılmamasını şart koşuyor.

---

## Son durum

> Her oturum sonunda burayı güncelle. En yeni kayıt en üstte.

### 2026-11-27

- **Faz:** Faz 0, Toparlanma
- **Bu oturumda yapılanlar:**
  - `chore/faz0-toparlanma` dalı GitHub'a gönderildi ve PR #1 ile `main`'e birleştirildi
    (https://github.com/Analysis-King/NexusTrade/pull/1). GitHub'daki `main` artık güncel.
  - F0-6: kapanmış deneylerin 48 script'i `scripts/archive/` altına taşındı; hepsi repo kökünden
    çalışmaya devam ediyor. Testler (39) ve tip kontrolü geçiyor.
  - F0-6: başlatıcının `.exe`, `.dll` ve iki `.json` dosyası birlikte git'e eklendi (yeniden derleme
    adımları yol haritasında).
  - Bu iki iş PR #2'de (https://github.com/Analysis-King/NexusTrade/pull/2); PR #2 birleştirildi.
  - Backend yeniden başlatıldı; beş paper portföy de API'de durdurulabilir görünüyor.
  - İlk `data/` yedeği alındı (`D:\nexustrade-backups`, 32 MB).
  - Faz 1 başladı. Harmonik Portföy'ün backtest'i ile paper sonucu arasındaki fark açıklandı: portföy
    replay'i giriş mumunda stop olan işlemleri atıyordu (EXP-016). `harmonic_exit_optimizer.cjs`
    düzeltildi.
- **Açık işler:**
  - Yedekleme Görev Zamanlayıcı'ya bağlanmadı (şimdilik elle `npm run backup:data`).
  - `.env` anahtarları: backend penceresinde uyarı çıkıyorsa yenilenmeli.
  - Harmonik Portföy ve QualityTarget 4x/10x'in dayandığı backtest geçersiz çıktı; açık pozisyonlarını
    beklemek yerine durdurmak senin kararın. Tarayıcı V2 ve HTF Onay başka araştırmadan (EXP-017/018).
- **Sıradaki adım:** F1-1 tek yürütme çekirdeği ve F1-6 altın testi.

### 2026-11-26

- **Faz:** Faz 0, Toparlanma ([02-YOL-HARITASI.md](02-YOL-HARITASI.md))
- **Bu oturumda yapılanlar:**
  - Grafik: açık pozisyonda tek Giriş/SL/TP çizgisi.
  - 429 (çok fazla istek) sorunu: arayüz yoklamaları azaltıldı, okuma ve işlem istekleri ayrı limitlerde.
  - Paper portföyler: aynı pattern'e stop sonrası tekrar giriş engellendi.
  - Sistem incelemesi ve bu dokümanlar yazıldı.
  - Faz 0: negatif PnL artık eksi işaretli (F0-3).
  - Faz 0: paper portföyler planlanan bitişte yeni işlem açmayı bırakıyor; arayüzde "Durdur" ve
    "Süreyi uzat" var (F0-4). Bitiş tarihleri geçtiği için beşi de "Kapanıyor" durumuna geçti.
  - Faz 0: `npm run backup:data` yedekleme script'i (F0-2). `.env.example`'daki gerçek görünümlü
    anahtarlar kaldırıldı; `.env` hâlâ eski değerleri kullanıyorsa backend açılışta uyarır (F0-5).
  - Faz 0: deney kaydı tamamlandı, EXP-011 ile EXP-018 eklendi (F0-7). İki önemli not:
    - Harmonik Portföy'ün backtest'i ile paper sonucu arasındaki fark açıklanmadı.
    - Risk filtreli iç içe seçici (EXP-013c) hiç ileriye dönük test edilmedi.
  - F0-6 envanteri ve taşıma önerisi yol haritasında; taşıma yapılmadı.
- **Commit:** `chore/faz0-toparlanma` dalında; 2026-11-27'de GitHub'a gönderildi, `main`'e birleştirilmedi.
- **Açık işler:**
  - Backend yeniden başlatılmadı; Durdur/Uzat düğmeleri ve `.env` uyarısı yeniden başlatınca devreye girer.
  - Yedekleme zamanlayıcıya (Windows Görev Zamanlayıcı) bağlanmadı.
  - `.env`'deki SESSION_SECRET / ENCRYPTION_KEY yenilenmeli (uyarı çıkarsa).
  - Backend'in ara sıra çökmesi (Windows kodu 0xC0000409) ayrı bir oturumda inceleniyor,
    dal `fix/backend-native-crash-diagnostics`.
  - GitHub'daki `main` hâlâ 31 Mayıs'ta; Haziran'dan bu yana yapılan her şey `chore/faz0-toparlanma`
    dalında. `main`'e birleştirmek için pull request açılmalı.
- **Sıradaki adım:** Dalı `main`'e birleştirmek (F0-1), F0-6 taşıma kararı, ardından Faz 1.
