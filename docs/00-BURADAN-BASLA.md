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
 │          30 dakikada bir her paper portföyü bir kez çalıştırır: yeniler scripts/paper_portfolio.cjs,
 │          eski beş portföy scripts/harmonic_*_paper*.cjs (sadece kalan pozisyonlar)
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
| `scripts/` | Paper portföyler, başlatıcılar, yedekleme ve Faz 1-2 araçları (16 dosya + `lib/`) | evet |
| `scripts/archive/` | Kapanmış deneylerin 48 araştırma script'i; bakımı yapılmıyor | evet |
| `data/` | `bots.json`, `trades.json`, paper portföy durumları, **555 araştırma raporu**, mum önbelleği (~600 MB) | **hayır**; yedek: `npm run backup:data` (`../nexustrade-backups`) |
| `logs/` | `backend.log`, çökme raporları (`logs/reports/`) | hayır |
| `tests/` | 60 test (vitest), hepsi geçiyor (2026-11-28) | evet |

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

## Şu an çalışanlar (botlar 2026-11-26, portföyler 2026-11-28)

| Ad | Tür | Strateji dosyası | Sembol / periyot | Durum | Sonuç |
|---|---|---|---|---|---|
| Harmonik | Bot | `pine_harmonic_patterns.py` (filtresiz) | BTCUSDT 1m | Durdu | −220 $ / 1000 $ (93 işlem, 31 May'dan beri) |
| qwm3 | Bot | `qm_wolfe_patterns.py` | ETHUSDT 4h | Çalışıyor | 0 $ (henüz kapanan işlem yok); sonuç stratejiyi ölçmüyor (EXP-010) |
| qwm5 | Bot | `qm_wolfe_patterns.py` | ADAUSDT 5m | Çalışıyor | −61 $ / 1000 $; sonuç stratejiyi ölçmüyor (EXP-010) |
| Harmonik Portföy | Paper portföy | `harmonic_portfolio_candidate.py` | 50 sembol 1h, 12x | Tamamlandı | −%45.3 (252 işlem) |
| QualityTarget 4x | Paper portföy | aynı | 50 sembol 1h, 4x | Tamamlandı | −%39.9 (125 işlem) |
| QualityTarget 10x | Paper portföy | aynı | 50 sembol 1h, 10x | Tamamlandı | −%94.0 (125 işlem) |
| Tarayıcı V2 | Paper portföy | `harmonic_scanner_v2.py` | 380 sembol 1h+4h | Kapanıyor (2 açık) | −%16.8 (184 işlem) |
| Tarayıcı V2 HTF Onay | Paper portföy | `harmonic_scanner_v2.py` + 4h/1d onay | 380 sembol 1h+4h | Kapanıyor (1 açık) | +%0.5 (sadece 8 işlem) |

Bu beş portföy F1-7 öncesi script'lerle başladı. Script'ler yeni işlem açmıyor, süre uzatmıyor; kalan
pozisyonlar kapanınca biter. Yeni paper portföy aşağıdaki gibi açılır.

Paper portföy durumları:
- **Çalışıyor:** planlanan bitişe kadar yeni işlem açar.
- **Kapanıyor:** süre doldu; yeni işlem açılmaz, açık pozisyonlar SL/TP ile kapanana kadar izlenir.
- **Tamamlandı:** açık pozisyon kalmadı.
- **Durduruldu:** arayüzdeki "Durdur" ile; açık pozisyonlar son fiyattan kapatılır, geri alınamaz.

Süresi dolan bir portföy arayüzdeki "Süreyi 30 gün uzat" ile yeniden işlem açar (eski beş portföy hariç).

Yeni paper portföy (F1-7; kurallar backtest ile aynı, `python/workers/portfolio_core.py`):

```powershell
node scripts/paper_portfolio.cjs --action=create --name=HTF_Onay_Retest --strategy=harmonic_scanner_v2.py --intervals=1h,4h --confirm-intervals=4h,1d --symbols=380 --positions=15 --days=90
```

Durum `data/htf_onay_retest_paper_state.json` dosyasına yazılır. Backend'deki supervisor bu portföyü
30 dakikada bir kendisi bulup çalıştırır. Diğer komutlar `--state=data/<ad>_paper_state.json` ile:
`--action=report`, `--action=stop`, `--action=extend --extend-days=30`. Ayarların listesi script'in
başında. Faz 3'te aynı anda en fazla 3 aday.

## Unutulmaması gereken araştırma sonuçları

1. **12 Haziran 2026 özeti** (`data/STRATEGY_RESEARCH_SUMMARY_20260612.md`):
   20'den fazla strateji ailesi denendi. Gerçekçi maliyetlerle hiçbiri günlük %0.8'i sağlam
   biçimde vermedi. Savunulabilir en iyi adaylar günlük %0.12 ile %0.42 arasında, ortalama
   düşüş %6 ile %28 arasında. Adaptif seçici kör testte başarısız oldu.
   Özetin kendi önerisi: üç adayı (DEMA long TRXUSDT 1h, Donchian ZECUSDT 1h iki varyant)
   ileriye dönük paper testte çalıştırmak ve **parametre madenciliğini bırakmak**.
2. O ileriye dönük test **yarım kaldı**: botlar 2-3 hafta sonra, her biri tek işlemle bırakıldı.
   Tek işlemin sebebi bir hataydı (2026-11-27'de bulundu): paper botta stratejinin bekleme sayacı ilk
   sinyalden sonra donuyor, bot backend yeniden başlayana kadar yeni giriş yapamıyor. Bu yüzden o test
   stratejileri ölçmedi. Ayrıntı: [DENEY-KAYDI EXP-004](arastirma/DENEY-KAYDI.md); F1-8 ile düzeltildi.
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

### 2026-11-28

- **Faz:** Faz 1, Tek ölçüm hattı
- **Bu oturumda yapılanlar:**
  - Paper bot işi PR #6'da (https://github.com/Analysis-King/NexusTrade/pull/6), birleştirilmeyi bekliyor.
  - F1-7: çok sembollü paper portföy aynı kurallara geçti. Kurallar `python/workers/portfolio_core.py`'de;
    backtest (`portfolio_backtest`) ve paper (`scripts/paper_portfolio.cjs`) aynı kodu çalıştırıyor.
    Paper her çalışmada kapalı kalınan süre dahil kaçan mumları işliyor. `tests/portfolioParity.test.ts`
    (8 test) bunu doğruluyor. Ayrıntı ve davranış farkları yol haritasında (F1-7).
  - Eski üç portföy script'i yeni portföy açmıyor ve süre uzatmıyor; beş eski portföyün üçü tamamlandı,
    ikisi (Tarayıcı V2, HTF Onay) toplam 3 açık pozisyonun kapanmasını bekliyor.
- **Açık işler:**
  - Önceki günün açık işleri (yedek zamanlayıcısı, `.env`, qwm botları) aynen duruyor.
  - PR #6 ve bu iş birleşip ana klasör `main`'e geçince ve backend yeniden başlayınca çalışan sisteme
    yansır.
- **Sıradaki adım:** Faz 1'de F1-2 ile F1-5 arası (risk bazlı büyüklük, maliyet modeli, standart rapor,
  otomatik deney kaydı) ya da Faz 2'nin ilk yeniden testleri: Haziran adayları (tek sembol) ve
  Tarayıcı V2 HTF Onay'ın 8 Temmuz sonrası portföy backtest'i.

### 2026-11-27

- **Faz:** Faz 1, Tek ölçüm hattı (Faz 0'dan yedek zamanlayıcısı kaldı)
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
    düzeltildi (PR #3).
  - F1-1 başladı: backtest'in yürütme kuralları `python/workers/execution_core.py`'ye taşındı; backtest
    sonuçları değişmedi. Paper için mum mum çalışan `paper_step` worker komutu eklendi.
  - F1-6 altın testi yazıldı (`tests/executionParity.test.ts`): aynı mumlarda backtest ve `paper_step` 6
    senaryoda birebir aynı işlemleri üretiyor. Paper bot henüz `paper_step`'i kullanmıyor.
  - Altın test bir hata buldu (F1-8): paper botun 500 mumluk penceresinde 15 stratejinin bekleme sayacı
    donuyor. Haziran testinin (EXP-004) tek işlemde kalması ve qwm botlarının sonucu bundan. PR #5 ile
    düzeltildi.
  - F1-1 paper bot: `src/bot/runner.ts` artık kendi SL/TP ve giriş kodu yerine her kapanan mumda
    `paper_step`'i çağırıyor. Çekirdek durumu bot kaydında (`paperCore`) saklanıyor; yeniden başlatmada
    kapalıyken kaçan mumlar (son 500 içindekiler) işleniyor. `tests/runnerParity.test.ts`: bot aynı
    mumlarda backtest ile birebir aynı işlemleri kaydediyor, yeniden başlatma ve kaçan mumlar dahil.
    Davranış değişiklikleri yol haritasında (F1-1).
- **Açık işler:**
  - Yedekleme Görev Zamanlayıcı'ya bağlanmadı (şimdilik elle `npm run backup:data`).
  - `.env` anahtarları: backend penceresinde uyarı çıkıyorsa yenilenmeli.
  - Harmonik Portföy ve QualityTarget 4x/10x'in dayandığı backtest geçersiz çıktı; açık pozisyonlarını
    beklemek yerine durdurmak senin kararın. Tarayıcı V2 ve HTF Onay başka araştırmadan (EXP-017/018).
  - F1-8 ve paper botun çekirdeğe bağlanması çalışan botlarda ancak ana klasör `main`'e geçip backend
    yeniden başlatılınca geçerli olur. O zaman qwm botları daha sık işlem açar ve giriş/çıkış kuralları
    backtest'inkiyle aynı olur.
  - qwm3/qwm5'in bugüne kadarki paper sonucu stratejiyi ölçmüyor (EXP-010); durdurmak senin kararın.
  - PR #3, #4 ve #5 birleştirildi. Paper bot işi `feat/f1-runner-paper-step` dalında, ayrı bir PR'da.
- **Sıradaki adım:** F1-7 (paper portföy script'lerinin çekirdeği kullanması) ya da Faz 2'nin ilk yeniden
  testi (Haziran adayları, yeni çekirdekte, 12 Haziran sonrası veride).

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
