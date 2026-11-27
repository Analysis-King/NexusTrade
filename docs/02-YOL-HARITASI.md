# Yol Haritası: Kazanan Stratejiyi Bulmaktan Tek Stratejiyle Canlıya

Tarih: 2026-11-26

Bu doküman bir yazılım ve süreç planıdır; yatırım tavsiyesi değildir. Ne kadar sermaye kullanılacağı ve
canlıya geçilip geçilmeyeceği senin kararın.

---

## 1. Hedefi doğru koymak

Günlük getirinin bileşik etkisi:

| Günlük ortalama | 30 günde | 1 yılda (bileşik) |
|---:|---:|---:|
| %0.1 | +%3 | +%44 |
| %0.3 | +%9 | yaklaşık 3 kat |
| %0.8 | +%27 | yaklaşık **18 kat** |

Kendi verilerin:

- Haziran araştırması: gerçekçi maliyetle savunulabilir en iyi adaylar günlük %0.12 ile %0.42 arasında.
  %0.8'e sadece medyan değer olarak, 4x kaldıraçla ve %48 ortalama düşüşle ulaşılabildi; ortalama yine %0.54'te kaldı.
- İleriye dönük paper testlerde harmonik portföyler −%16 ile −%95 arasında.

Bu tablo umut kırmak için değil, **yöntemi doğru kurmak** için önemli:

- "Günlük %0.8 veren stratejiyi bulana kadar dene" yaklaşımı, yeterince çok deneme yapıldığında
  geçmiş veride %0.8 gösteren bir stratejiyi **mutlaka** bulur, ama bu büyük ihtimalle şanstır.
  Tarayıcı V2 bunun canlı örneği.
- Bu yüzden seçim filtresi getiri olmamalı. Seçim filtresi: **görülmemiş veride ve ileriye dönük testte
  maliyetler düşüldükten sonra tutarlı pozitif beklenti**. Getiri ne çıkarsa o; büyütme kaldıraçla değil,
  kanıt biriktikçe sermayeyle yapılır.
- Günlük %0.1 bile bileşik olarak yılda %44 eder. Küçük ama **gerçek** bir avantaj, büyük ama şans
  eseri bir avantajdan çok daha değerlidir.

---

## 2. Dağılmamak için çalışma kuralları

1. **Tek giriş noktası:** Her oturum [00-BURADAN-BASLA.md](00-BURADAN-BASLA.md) ile başlar, "Son durum"
   güncellenerek biter.
2. **Aynı anda en fazla 3 aday** ileriye dönük testte. Yeni aday ancak biri bitince (geçti ya da kaldı) girer.
3. **Önce yaz, sonra test et:** Her deneyin numarası, hipotezi ve "geçti/kaldı" kriteri deney başlamadan
   [arastirma/DENEY-KAYDI.md](arastirma/DENEY-KAYDI.md)'ye yazılır. Kurallar [03-ARASTIRMA-PROTOKOLU.md](03-ARASTIRMA-PROTOKOLU.md)'da.
4. **Test yarıda bırakılmaz.** Bırakılırsa kayda "yarım kaldı" ve nedeni yazılır.
5. **Kod düzeni:** Bir deney = bir git dalı. Biten dal birleştirilir ya da etiketlenip arşivlenir.
   Haftada en az bir kez GitHub'a gönderilir.
6. **Kullanılmayan strateji ve script arşive** (`_arsiv/` klasörü), silinmez; kayıtta adı geçer.

---

## 3. Fazlar

| Faz | Amaç | Tahmini süre | Çıkış kapısı |
|---|---|---|---|
| 0 | Toparlanma | ~1 hafta | Her şey yedekli, görünür, durdurulabilir; sayılar doğru |
| 1 | Tek ölçüm hattı | 2-4 hafta | Aynı strateji backtest ve paper'da aynı işlemleri üretiyor |
| 2 | Araştırma | sürekli, deney başı 1-2 hafta | Bir aday protokoldeki "ileriye dönük teste hazır" kriterini geçiyor |
| 3 | İleriye dönük paper | aday başı 6-8 hafta | Aday beklenti aralığında kalıyor |
| 4 | Canlı altyapı | 3-5 hafta (Faz 2-3 ile paralel) | Testnet'te tüm kesinti senaryoları geçiyor |
| 5 | Küçük canlı | 4-8 hafta | Canlı sonuç paper beklentisinde, operasyon hatasız |
| 6 | Sadeleşme ve ölçek | sürekli | Tek strateji, gerisi arşivde |

Madde numaralarındaki K/Y/O kodları [01-SISTEM-INCELEMESI.md](01-SISTEM-INCELEMESI.md)'deki bulgulardır.

### Faz 0 · Toparlanma

| No | İş | Bulgu | Efor | Durum (2026-11-26) |
|---|---|---|---|---|
| F0-1 | Bekleyen değişiklikleri commit et, dalları GitHub'a gönder | K-4, O-2 | S | Bitti: PR #1 ile `main`'e birleştirildi (2026-11-27) |
| F0-2 | `data/` için günlük yedekleme script'i ve zamanlayıcı (mum önbelleği hariç) | K-4 | S | Script hazır (`npm run backup:data`); zamanlayıcı kurulmadı |
| F0-3 | Negatif PnL'yi eksi işaretiyle göster (5 yer) | K-5 | S | Bitti |
| F0-4 | Paper portföylere "Durdur"; bitiş tarihinde yeni işlem açmayı kes; kaybedenleri durdur | K-6 | M | Kod bitti; backend yeniden başlatılınca düğmeler görünür. Kaybedenleri durdurmak senin kararın |
| F0-5 | `.env.example` içindeki değerleri yer tutucuyla değiştir, kullanılan secret'ları yenile | K-3 | S | Örnek dosya temizlendi; `.env`'deki değerleri yenilemek sende |
| F0-6 | Kullanılmayan strateji ve script'leri arşive taşı; `public/` ve başlatıcı binary'lerini temizle | O-1 | M | Bitti (2026-11-27): script'ler arşivde, başlatıcının dört dosyası git'te. `public/` Faz 1'de kaldırılacak |
| F0-7 | Deney kaydındaki eski deneyleri tamamla (Haziran ve Temmuz raporlarından) | Y-3 | S | Bitti (EXP-011 - EXP-018) |
| F0-8 | Backend çökmesini kapat (ayrı oturumda devam ediyor) | K-2 | M | Ayrı oturumda |

**Kapı:** Her şey yedekli ve GitHub'da. Çalışan her bot ve portföy arayüzde görünüyor ve durdurulabiliyor.
Ekrandaki sayılar doğru.

#### F0-6 envanteri ve önerisi (2026-11-26; script kısmı 2026-11-27'de uygulandı)

- **Script'ler (65):**
  - `scripts/` altında kalan 12 dosya ve `lib/` sistemin parçası: `package.json` komutları, supervisor,
    başlatıcı ve `test-pool.ps1` (worker havuzu deneme aracı).
  - Yine `scripts/` altında kalan Faz 1-2 araçları:
    - `nested_strategy_selector.cjs` + `strategy_portfolio_blend.cjs` (EXP-013c yeniden testi)
    - `orphan_market_reader_walk_forward*.cjs` (adı yanıltıcı; "Strategy Walk-Forward" raporlarını üreten genel
      walk-forward)
    - `harmonic_exit_optimizer.cjs` (F1-6 karşılaştırması)
  - **Yapıldı:** kalan 48 script, kapanmış deneylerin araçları, `scripts/archive/` altına taşındı. Bakımı
    yapılmıyor. Kök klasörü kendi konumundan bulan 13'ünün yolu düzeltildi; hepsi eskisi gibi repo kökünden
    çalışır (bkz. `scripts/archive/README.md`).
- **Strateji dosyaları (33):** Şimdilik hiçbiri taşınmasın. EXP-013c'nin yeniden testi 16 aileyi kullanıyor.
  Faz 2 bitince kalanlar arşive.
- **`public/`:** Backend 3000 portunda bunu sunuyor (eski arayüz, `src/app.ts` `express.static`). Gerçek
  arayüz Vite (5173). Öneri: Faz 1'de statik sunum ve `public/` kaldırılsın.
- **Başlatıcı (yapıldı, 2026-11-27):** Kökteki `NexusTrade Baslat.exe` ile yanındaki `.dll`, `.deps.json` ve
  `.runtimeconfig.json` artık birlikte git'te; temiz bir klonda da çalışır. Bu bir .NET 8 derlemesi, makinede
  .NET 8 Runtime gerekir; yoksa aynı işi yapan `NexusTrade Baslat.cmd` kullanılır.
  `tools/NexusTradeLauncher/Program.cs` değişirse: `dotnet build tools/NexusTradeLauncher -c Release`, sonra
  `bin/Release/net8.0/` altındaki dört `NexusTrade Baslat.*` dosyasını köke kopyala ve dördünü birlikte commit et.
- **Yapıldı:** Başlatıcının `bin/`, `obj/` ve boş `NuGet/` klasörleri `.gitignore`'a eklendi.

### Faz 1 · Tek ölçüm hattı

| No | İş | Bulgu | Efor |
|---|---|---|---|
| F1-1 | Tek yürütme çekirdeği: giriş, SL/TP/gap kuralları, maliyetler tek yerde (Python); backtest ve paper aynı kodu kullanır. **Başladı (2026-11-27):** çekirdek `python/workers/execution_core.py`. Backtest ve yeni `paper_step` worker komutu onu kullanıyor; 9 regresyon senaryosunda backtest sonucu değişiklik öncesiyle birebir aynı. Paper botun (`src/bot/runner.ts`) `paper_step`'e bağlanması kaldı; bugün kendi SL/TP kodunu kullanıyor (gap'te SL fiyatından çıkış, sinyal mumunun kapanışından giriş, ters sinyalde her zaman çıkış) | Y-1 | L |
| F1-2 | Risk bazlı pozisyon büyüklüğü; sonuçların R cinsinden raporlanması | Y-4 | M |
| F1-3 | Maliyet modeli: komisyon, kayma, fonlama, likidasyon | Y-2 | M |
| F1-4 | Standart deney raporu (protokoldeki metrikler, pencere tablosu, görülmemiş veri ayrımı) | Y-3 | M |
| F1-5 | Her backtest çalıştırmasının deney kaydına otomatik satır yazması | Y-3 | S |
| F1-6 | "Altın test": sabit mumlarda backtest ve paper aynı işlemleri üretiyor mu. **Var (2026-11-27):** `tests/executionParity.test.ts` aynı mumları bir kez `backtest`, bir kez mum mum `paper_step` ile çalıştırıyor; 6 senaryoda işlemler ve sermaye eğrisi birebir aynı. Paper stratejiye son 500 mumu verdiği için backtest de `max_history_bars: 500` ile çalışıyor. Harmonik farkın ana nedeni bulundu (EXP-016). Kalan: kaçan döngüler (bilgisayar kapalıyken) | O-5 | M |
| F1-7 | Üç ayrı paper portföy script'i yerine çekirdeği kullanan tek "çok sembollü paper" modu | Y-1 | M |
| F1-8 | Stratejilerde bekleme ve tutma sayaçları mum sırasıyla (`len(candles) - 1`) tutuluyordu. 500 mumluk paper penceresinde bu sayı 499'da sabit kalıyor, bot ilk sinyalden sonra backend yeniden başlayana kadar yeni giriş yapamıyordu. **Bitti (2026-11-27):** 16 strateji pencereden bağımsız mum numarasını (`python/indicators/bars.py`, mum zamanı / mum aralığı) kullanıyor. Tam geçmişle 32 backtest senaryosu öncekiyle birebir aynı; 500 mumluk pencere ile tam geçmiş 16 stratejide ve iki veri setinde aynı işlemleri veriyor. Altın teste 5 stratejilik pencere kontrolü eklendi. Açık: `harmonic_portfolio_candidate` pencerede biraz farklı işlem üretiyor (formasyon taraması pencereye bağlı); QM-Wolfe, Orphan ve harmonik stratejilerin sinyal anahtarlarında pencereye göre kayan mum indeksi var (ölçülen veride fark çıkmadı) | O-5 | M |

**Kapı:** Altın test geçiyor.

### Faz 2 · Araştırma

Yeni fikirle başlama. Elinde bedava bir avantaj var: **Haziran adaylarının parametreleri 12 Haziran'da
sabitlendi**; o tarihten bugüne 5,5 aylık veri bu adaylar için gerçekten görülmemiş veri. Aynı şey
8 Temmuz'da sabitlenen harmonik adaylar için de geçerli.

İlk deneyler (her biri [03-ARASTIRMA-PROTOKOLU.md](03-ARASTIRMA-PROTOKOLU.md)'ya göre):

1. DEMA long TRXUSDT 1h, Donchian EMA-eğim ZECUSDT 1h, Donchian kırılım ZECUSDT 1h: **parametre değiştirmeden**,
   yeni çekirdekte, 12 Haziran sonrası veride.
2. Tarayıcı V2 HTF Onay: 8 işlem karar vermek için yetersiz. 380 sembolde 8 Temmuz sonrası veride kaç işlem
   ürettiğine ve sonucuna bak.
3. Risk filtreli iç içe strateji seçici ([EXP-013c](arastirma/DENEY-KAYDI.md)): 14 kör pencerenin 13'ünde
   pozitif ama hiç ileriye dönük test edilmedi. 14 Haziran'da seçilen kuralı sabitleyip sonrasındaki veride
   çalıştır. Aynı anda en fazla 3 aday kuralı gereği 1 veya 2 bitince başlar.
4. Bunlardan hiçbiri geçmezse yeni hipotezler. Ama her yeni hipotez önce kayda yazılır.

Harmonik Portföy'ün backtest'i ile paper sonucu arasındaki fark 2026-11-27'de açıklandı: portföy replay'i
giriş mumunda stop olan işlemleri atıyordu. Düzeltilince 28 Haziran adayı (ve QualityTarget ayarları) her
pencerede ağır zarar ediyor ([EXP-016](arastirma/DENEY-KAYDI.md)). Bu aile Faz 2 listesine alınmadı.
`harmonic_exit_optimizer.cjs` ile üretilmiş başka portföy sonuçları da aynı hatayı taşıyor; yeniden
hesaplanmadan kullanılmamalı.

**Kapı:** Bir aday "ileriye dönük teste hazır" kriterlerini geçiyor.

### Faz 3 · İleriye dönük paper

- En fazla 3 aday aynı anda; yeni çekirdekle, gerçek zamanlı mumlarla.
- Başlarken backtest'ten beklenen dağılım kaydedilir (işlem başına R, aylık işlem sayısı, en kötü düşüş).
- Haftalık rapor: gerçekleşen sonuç beklentinin neresinde (Y-5).
- Süre: en az 6-8 hafta **ve** en az 30 kapanan işlem; hangisi daha geç dolarsa.

**Kapı:** Protokoldeki ileriye dönük test kriteri.

### Faz 4 · Canlı altyapı (Faz 2-3 ile paralel yürür)

| No | İş | Bulgu | Efor |
|---|---|---|---|
| F4-1 | Spot mu vadeli mi: adayın yönüne göre karar (sadece long → spot) | K-1 | — |
| F4-2 | Binance aracı: emir gönderme, **borsa tarafında koruyucu stop**, yeniden başlatmada mutabakat, kullanıcı veri akışı, saat senkronu, adım/fiyat yuvarlama, benzersiz emir kimliği | K-1, K-2, O-6 | L |
| F4-3 | API anahtarı: sadece işlem izni, çekme kapalı, IP kısıtlı; şifreli saklama | K-3 | M |
| F4-4 | Bağımsız risk bekçisi: günlük zarar limiti, toplam açık risk sınırı, tek tuşla her şeyi kapat, veri bayatlık koruması, düşüş zarfı aşılınca otomatik durdurma | — | M |
| F4-5 | SQLite işlem defteri (silinmeyen emir, dolum, pozisyon, sermaye kayıtları) | O-3 | M |
| F4-6 | Telegram uyarıları ve günlük özet | Y-6 | M |
| F4-7 | Çalışma ortamı: VPS (Linux + systemd) ya da en azından uyku kapalı ve kesintisiz güç kaynağı | K-2 | M |
| F4-8 | Testnet'te 2 hafta: interneti kes, süreci öldür, yeniden başlat; pozisyon ve stop doğru kalıyor mu | — | M |

**Kapı:** F4-8'deki senaryoların hepsi geçiyor.

### Faz 5 · Küçük canlı

- Borsanın izin verdiği en küçük pozisyon büyüklüğüyle. Amaç kazanç değil **ölçüm**: gerçek kayma,
  komisyon, dolum gecikmesi, paper ile fark.
- Süre: 4-8 hafta.

**Kapı:** Canlı sonuç paper/backtest beklenti aralığında, operasyonel hata yok.

### Faz 6 · Sadeleşme ve ölçek

- Diğer stratejileri, paper portföyleri ve araştırma script'lerini git etiketiyle arşivle
  (`arsiv-<tarih>`); çalışan sistemde tek strateji kalsın.
- Büyütme kademeli ve kurallı: sadece sonuçlar beklenti aralığındaysa; düşüş zarfı aşılırsa otomatik küçült
  ya da durdur. Büyütme miktarı senin kararın.

---

## 4. Hedef mimari (canlı, tek strateji)

```
             Binance (mum akışı, kullanıcı veri akışı, emirler)
                 │                     ▲
                 ▼                     │
        ┌─────────────────┐   ┌──────────────────┐
        │ Veri katmanı    │   │ Binance aracı     │  borsa tarafı stop, mutabakat,
        │ mumlar, bayatlık│   │ (spot ya da fapi) │  saat senkronu, yuvarlama
        └────────┬────────┘   └─────────▲────────┘
                 ▼                      │
        ┌─────────────────┐   ┌─────────┴────────┐   ┌──────────────────┐
        │ Strateji        │──►│ Yürütme çekirdeği │◄──│ Risk bekçisi     │
        │ (saf fonksiyon: │   │ büyüklük, SL/TP,  │   │ günlük limit,     │
        │ mumlar→sinyal)  │   │ maliyet modeli    │   │ kill switch,      │
        └─────────────────┘   └─────────┬────────┘   │ düşüş zarfı       │
                                        ▼            └──────────────────┘
                              ┌──────────────────┐   ┌──────────────────┐
                              │ İşlem defteri     │──►│ Uyarılar ve rapor │
                              │ (SQLite)          │   │ (Telegram, web)   │
                              └──────────────────┘   └──────────────────┘
```

Aynı strateji ve yürütme çekirdeği; backtest'te "simüle aracı", paper'da "paper aracı", canlıda
"Binance aracı" ile çalışır. Böylece canlıda görülen fark sadece gerçek piyasa koşullarından gelir.

---

## 5. Canlıya geçiş kontrol listesi

Hepsi işaretlenmeden canlı moda geçilmez.

- [ ] Aday, protokoldeki görülmemiş veri ve ileriye dönük test kriterlerini geçti; deney kaydında belgeli.
- [ ] Spot/vadeli kararı verildi; strateji canlıda gerçekten yapılabilecek işlemler üretiyor.
- [ ] Backend 2 hafta çökmesiz çalıştı.
- [ ] Koruyucu stop borsada duruyor; uygulama kapatıldığında da pozisyon korunuyor (testnet'te denendi).
- [ ] Yeniden başlatmada açık emir ve pozisyonlar borsadan okunup doğru eşleşiyor.
- [ ] API anahtarı: çekme izni kapalı, IP kısıtlı, kodda ya da logda görünmüyor.
- [ ] Günlük zarar limiti ve tek tuşla kapatma çalışıyor (testnet'te denendi).
- [ ] Telegram uyarıları geliyor: açılış, kapanış, hata, risk limiti, veri kesintisi.
- [ ] İşlem defteri silinmiyor ve yedekleniyor.
- [ ] İlk canlı dönemin süresi, pozisyon büyüklüğü ve durdurma kriteri önceden yazıldı.
