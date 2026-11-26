# Sistem İncelemesi

Tarih: 2026-11-26 · Kapsam: `src/`, `web/`, `python/`, `scripts/`, `data/`, çalışma ortamı

Bu doküman yazılım ve süreç incelemesidir; yatırım tavsiyesi değildir.

Öncelik seviyeleri:

- **Kritik:** Doğrudan para kaybına ya da yanlış karara yol açabilir. Canlıya geçmeden önce kapanmalı.
- **Yüksek:** Araştırma sonuçlarının güvenilirliğini bozar. Yanlış stratejinin "kazanıyor" görünmesine yol açabilir.
- **Orta:** Bakımı zorlaştırır, ileride sorun çıkarır.

Efor: **S** = birkaç saat, **M** = 1-3 gün, **L** = 1 hafta ve üstü.

---

## Özet tablo

| No | Bulgu | Seviye | Efor |
|---|---|---|---|
| K-1 | Canlı emir kodu yok; Binance istemcisi sadece spot, stratejiler short ve kaldıraç kullanıyor | Kritik | L |
| K-2 | Stop'lar sadece uygulama içinde; uygulama kapanınca pozisyon korumasız, backend ara sıra çöküyor | Kritik | M |
| K-3 | API anahtarı şifreleme/saklama yok; örnek env dosyasında gerçek görünümlü anahtarlar GitHub'da (örnek dosya 2026-11-26'da temizlendi) | Kritik | M |
| K-4 | Yedek yok: `data/` git dışında ve yedeksiz; 6 aylık iş GitHub'a gönderilmemiş (yedek script'i 2026-11-26'da eklendi, zamanlayıcı yok) | Kritik | S |
| K-5 | ~~Arayüz negatif PnL'yi eksi işareti olmadan gösteriyor~~ Düzeltildi 2026-11-26 | Kritik | S |
| K-6 | ~~Paper portföyler durdurulamıyor; "Tamamlandı" sonrası işlem açmaya devam ediyor~~ Düzeltildi 2026-11-26 | Kritik | M |
| Y-1 | Aynı strateji üç farklı simülatörde, farklı kurallarla çalışıyor | Yüksek | L |
| Y-2 | Fonlama (funding) maliyeti ve likidasyon hiçbir simülasyonda yok | Yüksek | M |
| Y-3 | Deney kaydı yok; kaç varyant denendiği bilinmiyor (çoklu deneme yanlılığı) | Yüksek | S |
| Y-4 | Pozisyon büyüklüğü risk bazlı değil | Yüksek | M |
| Y-5 | Paper sonucunu backtest beklentisiyle karşılaştıran rapor yok | Yüksek | M |
| Y-6 | İzleme ve uyarı yok | Yüksek | M |
| O-1 | Dağınıklık: kullanılmayan stratejiler, script'ler, eski arayüz ve dokümanlar | Orta | M |
| O-2 | Dallar dağınık; `main` 6 ay geride | Orta | S |
| O-3 | JSON depolama canlı işlem defteri için yetersiz; işlem kaydı 5000'de kırpılıyor | Orta | M |
| O-4 | Kimlik doğrulama yok | Orta | M |
| O-5 | Python stratejileri ve simülatör tutarlılığı için test yok | Orta | M |
| O-6 | Canlı işlem için borsa kuralları eksik (saat senkronu, adım/fiyat yuvarlama, emir mutabakatı) | Orta | M |

---

## Kritik

### K-1 · Canlı emir kodu yok, ve olsa da stratejilere uymaz

- **Nerede:** `src/bot/execution.ts:181` `LiveExecution` çağrılınca "Live mod henuz aktif degil" hatası fırlatıyor.
  `src/services/binance/client.ts` sadece spot uç noktalarını (`/api/v3/...`) biliyor.
- **Neden önemli:** Paper botlar ve portföyler SHORT açıyor ve kaldıraç kullanıyor (Harmonik Portföy 12x,
  QualityTarget 10x). Binance spot'ta short ve kaldıraç yok. Yani bugünkü paper sonuçların bir kısmı
  canlıda **aynen yapılamayacak** işlemlerden geliyor. Tarayıcı V2 sadece short açıyor.
- **Öneri:** Canlı hedefi stratejiden önce seçilmez; aday strateji belli olunca karar verilir:
  - Aday sadece long ise → **spot** yeterli. Daha basit: likidasyon yok, fonlama yok.
  - Aday short ya da kaldıraç gerektiriyorsa → **USDⓈ-M Futures** (`fapi`) istemcisi yazılmalı:
    kaldıraç ve marjin modu ayarı, `reduceOnly` stop emirleri, fonlama, likidasyon fiyatı takibi.
  - Her iki durumda da önce Binance **testnet** üzerinde çalıştırılmalı.

### K-2 · Stop'lar uygulama içinde; uygulama düşerse pozisyon korumasız

- **Nerede:** `src/bot/runner.ts:654` `checkSlTp` gelen her mumda SL/TP'yi kontrol eder; borsada stop emri yok.
- **Neden önemli:** Paper'da sorun değil. Canlıda ev bilgisayarı kapanırsa, uyku moduna geçerse, internet
  giderse ya da backend çökerse (bkz. 0xC0000409 çökmeleri, ayrı oturumda inceleniyor) açık pozisyonun
  stop'u **hiç çalışmaz**.
- **Öneri:**
  1. Canlıda giriş emri dolar dolmaz koruyucu stop emri **borsaya** gönderilmeli
     (spot'ta OCO, futures'ta `STOP_MARKET` + `reduceOnly`). Uygulama içindeki kontrol sadece yedek olsun.
  2. Canlı sistem ev bilgisayarı yerine küçük bir sunucuda (VPS) çalışmalı; ya da en azından PC'nin uyku
     moduna geçmesi kapatılmalı ve kesintisiz güç kaynağı olmalı.
  3. Backend çökmesi çözülmeden canlıya geçilmemeli.

### K-3 · API anahtarı saklama yok

- **Nerede:** `ENCRYPTION_KEY` ve `SESSION_SECRET` sadece `src/config/env.ts:16` içinde uzunluk kontrolünden
  geçiyor; şifreleme kodu yok. `.env.example` içinde gerçek görünümlü 64 karakterlik değerler var ve
  GitHub'a gönderilmiş.
- **Öneri:**
  - `.env.example` içindeki değerleri `degistir-beni` gibi yer tutucularla değiştir. Bu değerleri herhangi
    bir yerde kullandıysan yenilerini üret.
  - Binance API anahtarı: **sadece işlem izni**, çekme (withdraw) izni **kapalı**, **IP kısıtlaması açık**.
  - Anahtar `.env` dosyasında ya da işletim sisteminin anahtar deposunda dursun; diske yazılacaksa
    AES-256-GCM ile şifrelensin. Loglarda anahtarın görünmediği test edilsin.

### K-4 · Yedek yok

- **Nerede:** `.gitignore` tüm `data/` klasörünü dışarıda tutuyor. Bu klasörde `bots.json`, `trades.json`,
  paper portföy durumları ve 555 araştırma raporu var (~600 MB). Tek yedek Mayıs'tan kalma bir strateji
  zip'i. `origin/main` 31 Mayıs'ta; sonraki commit'ler sadece bu bilgisayarda.
- **Neden önemli:** Disk arızasında 6 aylık araştırma ve tüm işlem geçmişi gider.
- **Öneri:**
  - Önce commit et ve GitHub'a gönder (dal olarak; `main`'e birleştirmek ayrı karar).
  - `data/` için günlük yedek: mum önbelleği (`data/klines_cache`) hariç, sıkıştırılmış, bilgisayar dışında
    (bulut klasörü ya da harici disk). Basit bir `scripts/backup-data.ps1` + Görev Zamanlayıcı yeterli.
  - Araştırma özetleri (`.md` raporlar) küçük; seçilenleri `docs/arastirma/` altına kopyalayıp git'e almak
    en sağlam çözüm.

### K-5 · Arayüz negatif PnL'yi eksi işareti olmadan gösteriyor

- **Nerede:** `web/src/components/bots/BotDetail.tsx:323` ve `:392`, `PortfolioPanel.tsx:167`,
  `TradingPanel.tsx:479` ve `:693`. Kod `+` işaretini ekliyor ama negatif değerde `Math.abs` ile
  eksiyi siliyor.
- **Neden önemli:** Harmonik botunun toplam PnL'si −165 $ iken ekranda "$165.12" yazıyordu; tek ipucu
  kırmızı renk. Stratejiye karar verirken yanlış okunması çok kolay.
- **Öneri:** Tek bir `formatSignedUsd` yardımcı fonksiyonu yazıp beş yerde onu kullanmak (S).

### K-6 · Paper portföyler kontrol edilemiyor

- **Nerede:** `src/services/paperPortfolioSupervisor.ts` beş işi koda sabit bir listede tutuyor ve backend
  açık olduğu sürece 30 dakikada bir çalıştırıyor. Script'ler `--action=once` ile çağrıldığı için bitiş
  tarihi (`stopAt`) yeni işlem açmayı durdurmuyor.
- **Neden önemli:** "Tamamlandı" yazan portföyler aylardır işlem açıyor; sonuçlar ve Binance istek yükü
  birikiyor, ve kullanıcı neyin çalıştığını bilmiyor.
- **Öneri:** Her portföy için `enabled` ve `durum` alanı: arayüzde "Durdur" butonu; durdurulan portföy yeni
  işlem açmaz ama açık pozisyonlarını SL/TP'ye kadar yönetir. Bitiş tarihi geçince de aynı davranış.

---

## Yüksek

### Y-1 · Üç simülatör, üç farklı kural seti

- **Nerede:**
  - Backtest: `python/workers/pool_worker.py` (sonraki mum açılışından giriş, aynı mumda SL+TP olursa önce SL).
  - Paper bot: `src/bot/runner.ts` + `src/bot/execution.ts`. Fiyat SL'nin ötesine boşlukla (gap) atlasa bile
    stop'u SL fiyatından kapatıyor (`runner.ts:668`), bu iyimser bir varsayım.
  - Paper portföyler: üç ayrı `.cjs` script, her birinde kendi kopyası olan SL/TP ve giriş kodu.
    Gap'te açılış fiyatından kapatıyorlar. `harmonic_portfolio_paper.cjs:140` sonraki mum yoksa sinyal
    mumunun kendi açılışından giriyor (geleceği görme riski); V2 script'inde bu düzeltilmiş, diğerinde değil.
- **Neden önemli:** Aynı strateji backtest'te, paper botta ve paper portföyde farklı sonuç verir.
  Backtest ile paper arasındaki farkın stratejiden mi motordan mı geldiği anlaşılmaz.
- **Öneri:** Tek bir yürütme çekirdeği: giriş fiyatı, SL/TP/gap kuralları, maliyetler, pozisyon büyüklüğü
  tek bir yerde. Backtest, paper ve canlı bu çekirdeği farklı "aracı" (broker) ile kullanır:
  `SimuleAracı` (geçmiş mumlar), `PaperAracı` (canlı mum, sanal dolum), `BinanceAracı` (gerçek emir).
  Python motoru zaten en olgun olanı; çekirdek orada kalabilir.

### Y-2 · Fonlama ve likidasyon yok

- **Nerede:** Hiçbir simülatör vadeli işlem fonlama ücretini (8 saatte bir) ya da likidasyonu modellemiyor.
- **Neden önemli:** QualityTarget 10x −%94.8. Gerçek vadeli hesapta bu portföy büyük ihtimalle çok daha
  önce likide olurdu. Uzun tutulan short/long pozisyonlarda fonlama, küçük bir avantajı tamamen silebilir.
- **Öneri:** Futures'a gidilecekse fonlama geçmişini (Binance `fundingRate` uç noktası) maliyet modeline ekle;
  kaldıraçlı testlerde likidasyon fiyatını hesapla ve o fiyata dokunan pozisyonu "likide" kapat.

### Y-3 · Deney kaydı yok

- **Nerede:** 33 strateji, 64 script, 555 rapor. Hangi fikrin ne zaman, kaç varyantla denendiği ve ne
  sonuç verdiği tek bir yerde yok.
- **Neden önemli:** Çok sayıda varyant denenip en iyisi seçildiğinde, o "en iyi" büyük ihtimalle şanstır.
  Örnek: Tarayıcı V2, birçok pattern/rejim kombinasyonu içinden "train ve test'te PF>1 olan tek çift"
  olarak seçildi; ileriye dönük paper testte −%16.2. Kaç denemeden seçildiği bilinmeden bu sonucun ne kadar
  güvenilir olduğu ölçülemez.
- **Öneri:** [arastirma/DENEY-KAYDI.md](arastirma/DENEY-KAYDI.md) (başlatıldı). Sonraki adımda her backtest
  çalıştırması otomatik bir satır yazsın: tarih, strateji dosyası ve git commit'i, parametreler, veri aralığı,
  denenen varyant sayısı, sonuçlar.

### Y-4 · Pozisyon büyüklüğü risk bazlı değil

- **Nerede:** `src/bot/runner.ts:690` → `notional = min(maxPositionUsd, sermaye × kaldıraç)`.
- **Neden önemli:** Stop mesafesi %0.5 da olsa %8 de olsa aynı büyüklükte pozisyon açılıyor. Böylece işlem
  başına risk 16 kat değişebiliyor; sonuçlar stratejinin isabetinden çok stop mesafelerinin dağılımına bağlı.
- **Öneri:** Profesyonel standart: işlem başına sermayenin sabit bir yüzdesini riske et.
  `pozisyon = (sermaye × risk%) / stop mesafesi`, ve üst sınır olarak `maxPositionUsd`.
  Sonuçları "R" cinsinden (kazanç / risk edilen tutar) raporla.

### Y-5 · Paper ile backtest beklentisi karşılaştırılmıyor

- **Öneri:** Her ileriye dönük test için başlangıçta backtest'ten beklenen dağılımı kaydet (işlem başına
  ortalama R, aylık işlem sayısı, en kötü düşüş). Paper sonucu bu dağılımın neresinde, haftalık rapor göstersin.
  Beklentinin çok altında kalan strateji kendiliğinden "inceleme" durumuna düşsün.

### Y-6 · İzleme ve uyarı yok

- **Öneri:** Telegram botu ile bildirim: bot durdu ya da çöktü, risk limiti tetiklendi, pozisyon açıldı/kapandı,
  20 dakikadır yeni mum gelmiyor, günlük özet. Canlıda bu zorunlu.

---

## Orta

### O-1 · Dağınıklık

- `public/` eski arayüz (kullanılmıyor), `architecture/` Mayıs dokümanları, kökte `.exe`/`.dll`/`NuGet`
  dosyaları (`NexusTrade Baslat.exe` git'te), `STRATEJI.docx` ve `formasyonlar.docx` git dışında.
- 33 strateji dosyasından bugün sadece `pine_harmonic_patterns.py`, `qm_wolfe_patterns.py` ve harmonik
  sarmalayıcılar kullanılıyor.
- **Öneri:** `python/strategies/_arsiv/` ve `scripts/_arsiv/` klasörleri; kullanılmayanları oraya taşı
  (silme, deney kaydında adı geçsin). Başlatıcı derleme çıktılarını `.gitignore`'a ekle.
- **Durum (2026-11-27):** 48 araştırma script'i `scripts/archive/` altına taşındı, derleme çıktıları
  `.gitignore`'da. Strateji dosyaları Faz 2'ye kadar yerinde; `public/` ve başlatıcı dosyaları bekliyor.

### O-2 · Dallar

- `main` 31 Mayıs'ta. `fix/storage-worker-bot-reliability` ve `fix/backend-native-crash-diagnostics`
  birleştirilmemiş; çalışma klasöründe çok sayıda commit edilmemiş değişiklik var.
- **Öneri:** Haftada bir "temizlik": bitmiş dalları `main`'e birleştir, GitHub'a gönder.

### O-3 · JSON depolama

- `src/storage/json/tradeStore.ts:18` → `MAX_TRADES = 5000`; dosya 5000 kaydı geçince eski işlemler siliniyor.
  Paper için kabul edilebilir, canlı işlem defteri için değil.
- **Öneri:** Canlı için SQLite (WAL modu): `orders`, `fills`, `positions`, `equity_snapshots` tabloları.
  Hiçbir kayıt silinmez.

### O-4 · Kimlik doğrulama yok

- Sunucu `127.0.0.1`'e bağlı olduğu için bugün dışarıdan erişilemiyor. VPS'e taşınınca API'ye giriş şart
  (en azından tek kullanıcılı parola + oturum, ya da sadece VPN/SSH tüneli üzerinden erişim).

### O-5 · Test kapsamı

- 34 TypeScript testi geçiyor (2026-11-26). Python stratejileri, paper script'leri ve simülatörler arası
  tutarlılık için test yok.
- **Öneri:** "Altın test": sabit bir mum dosyasında bir stratejinin backtest, paper ve canlı-simülasyon
  yollarından aynı işlemleri ürettiğini doğrulayan test (Y-1 ile birlikte).

### O-6 · Canlı işlem için borsa kuralları

- İmzalı isteklerde zaman `Date.now()`; Binance sunucu saatine göre düzeltme yok (Windows saati kayarsa
  `-1021` hataları). Fiyat/miktar `tickSize`, `stepSize`, `minNotional` kurallarına göre yuvarlanmıyor.
  Yeniden başlatmada borsadaki açık emir ve pozisyonlarla mutabakat yok. Dolumlar için kullanıcı veri akışı
  (`userDataStream`) istemcide var ama kullanılmıyor.
- **Öneri:** Canlı aracının (K-1) ilk sürümünde bunların hepsi olmalı; tekrar gönderilen emirlerin çift
  dolmaması için her emirde benzersiz `newClientOrderId`.

---

## Sağlam olan ve korunması gerekenler

- Backtest motoru: sonraki mum açılışından giriş, aynı mumda SL+TP'de önce SL, komisyon (10 bps) ve kayma
  (2 bps) varsayılan, strateji her adımda sadece o ana kadarki mumları görüyor.
- TP hedefi maliyetleri karşılamıyorsa işlem açılmıyor.
- JSON yazımları atomik ve eşzamanlı yazımlara karşı korumalı; worker havuzları ayrılmış.
- Haziran araştırmasındaki yöntem (örtüşmeyen 45 günlük pencereler, kör holdout testi, maliyet duyarlılığı)
  doğru yöntem. Eksik olan, bu yöntemin her deneyde zorunlu olması ve sonuçların kaydedilmesi.
