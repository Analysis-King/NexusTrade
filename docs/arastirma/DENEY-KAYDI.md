# Deney Kaydı

Şimdiye kadar denenen her şey ve sonucu. Yeni deney eklemeden önce
[03-ARASTIRMA-PROTOKOLU.md](../03-ARASTIRMA-PROTOKOLU.md)'yu oku; şablon orada.

Aşağıdaki kayıtlar 2026-11-26'da `data/` altındaki 555 rapordan ve paper sonuçlarından geriye dönük derlendi
(EXP-011 ile EXP-018 arası F0-7 kapsamında eklendi). "Denenen varyant sayısı" çoğunda kayıtlı değil; bu yüzden
sonuçlarına ekstra şüpheyle bakılmalı.

**Raporlardaki "Avg Daily %" hakkında:** Çoğu tarama sembol başına ayrı hesap simüle ediyor. "Pozitif
X/Y" sembol veya pencere sayısıdır; hesabı sıfırlanan semboller ("null") ortalamaya girmez, yani ortalama
olduğundan iyi görünür.

## Bu kayıttan çıkan üç ders

1. **Az pencere, büyük umut; çok pencere, sıfır.** Birçok aile 4-7 pencerede günlük %0.3-1.3 gösterdi;
   aynı aile 15-20 pencerede ya da temizlenmiş sembol evreninde sıfıra yakın çıktı (EXP-013, EXP-014).
2. **Backtest'i paper'dan ayıran şey bir replay hatasıydı (2026-11-27'de bulundu).** Harmonik Portföy
   backtest'te 5 pencerede günlük %0.84-1.59 ve %27-32 kazanma oranı gösterdi; paper testte kazanma oranı
   %11.7, sonuç −%46.6 (EXP-016 → EXP-005). Portföy replay'i giriş mumunda kapanan işlemleri (işlemlerin
   yarısı, neredeyse hepsi stop) sonucu önceden biliyormuş gibi atıyordu. Düzeltilince aynı veriden
   günlük −%3.9 ile −%6.1 çıkıyor. Ders: sonucu bir işlemin geleceğine bakan her filtre, ne kadar masum
   görünürse görünsün, geleceği görmedir. Yeni çekirdekte (F1-1) bunun için test yazılmalı.
3. **Bitmemiş tek umut verici iş:** risk filtreli iç içe seçici (EXP-013c), 14 kör pencerenin 13'ünde
   pozitif. Hiç ileriye dönük test edilmedi.

## Özet

| No | Ad | Tür | Tarih | Sonuç | Durum |
|---|---|---|---|---|---|
| EXP-001 | Haziran strateji taraması (20+ aile) | Backtest | 2026-06 | En iyi adaylar günlük %0.12-0.42; çoğu sembolde genelleşmiyor | Geçti (3 aday) |
| EXP-002 | Adaptif strateji seçici | Backtest | 2026-06 | Kör holdout'ta günlük −%0.12 ile −%0.40 | Kaldı |
| EXP-003 | Adaptif rejim yönlendirici | Backtest | 2026-06 | 20 profilden 0-2'si kârlı | Kaldı |
| EXP-004 | Haziran adaylarının ileriye dönük testi | Paper | 2026-06 → 07-02 | Her aday 1 işlem yaptı, test bırakıldı; tek işlemin sebebi paper bottaki bekleme sayacı hatası | Yarım kaldı |
| EXP-005 | Harmonik Portföy (12x) | Paper portföy | 2026-07-19 → | 249 işlem, kazanma %11.7, **−%46.6** | Kaldı; dayandığı backtest geçersiz (EXP-016) |
| EXP-006 | Harmonik QualityTarget 4x / 10x | Paper portföy | 2026-07-19 → | 123 işlem, kazanma %10.6, **−%42.8 / −%94.8** | Kaldı; dayandığı backtest geçersiz (EXP-016) |
| EXP-007 | Harmonik Tarayıcı V2 | Paper portföy | 2026-07-08 → | 183 işlem, kazanma %18.6, **−%16.2** | Kaldı |
| EXP-008 | Harmonik Tarayıcı V2 HTF Onay | Paper portföy | 2026-07-21 → | 8 işlem, kazanma %37.5, +%0.8 | Karar verilemez |
| EXP-009 | Harmonik bot (filtresiz) | Paper bot | 2026-05-31 → 11-25 | 93 işlem, kazanma %47.3, **−220 $ / 1000 $** | Kaldı |
| EXP-010 | qwm3 / qwm5 (QM-Wolfe) | Paper bot | 2026-06-02 → | qwm3: kapanan işlem yok; qwm5: −61 $ / 1000 $ | Hipotez yok |
| EXP-011 | Orphan Market Reader | Backtest | 2026-05-21 → 06-18 | Tek sembolde %0.75-1.08/gün (17 işlem); 50 sembolde ~%0.03/gün | Kaldı |
| EXP-012 | MOST, QM/Wolfe, çoklu strateji 50 sembol | Backtest | 2026-06-13 → 06-14 | Hiçbir varyant 50 sembolde ortalama %0.1/gün'ü geçmedi | Kaldı |
| EXP-013 | Kesitsel momentum, fonlama, iç içe seçiciler | Backtest | 2026-06-14 → 06-25 | Momentum ve fonlama dağıldı; risk filtreli seçici 13/14 pozitif | Karışık |
| EXP-014 | Vadeli Orphan, kaldıraç taraması | Backtest | 2026-06-18 | Kaldıraç arttıkça ortalama kötüleşti | Kaldı |
| EXP-015 | İnternet stratejileri, universal alpha, edge miner | Backtest | 2026-06-25 → 06-26 | Hepsi günlük −%0.22 ile +%0.0 arası | Kaldı |
| EXP-016 | Harmonik çıkış optimizasyonu ve portföy adayı | Backtest | 2026-06-26 → 06-28 | ~209 varyant; portföy adayı 5 pencerede %0.84-1.59/gün; replay hatası düzeltilince −%3.9 ile −%6.1/gün | **Geçersiz** (replay hatası) |
| EXP-017 | Harmonik V2 taramaları (matris, ABCD, çıkış) | Backtest | 2026-07-05 → 07-07 | 50 sembolde hiçbir periyot/süre ortalamada pozitif değil (1h 1 yıl −%19) | Kaldı |
| EXP-018 | Harmonik dayanıklılık araması ve Yengeç nihai test | Backtest | 2026-07-08 | Train ve test'te PF>1 kalan 2 bearish pattern seçildi (test'te 46 ve 21 işlem) | Paper'da kaldı (EXP-007) |

Paper portföy sonuçları 2026-11-26 raporlarından; hepsinin planlanan süresi dolmuş ama işlem açmaya devam
ettikleri için rakamlar değişebilir.

---

## Ayrıntılar

### EXP-001 · Haziran strateji taraması

- **Durum:** Geçti (3 aday ileriye dönük teste önerildi)
- **Tarih:** 2026-06, özet 2026-06-12
- **Hedef:** Gerçekçi maliyetle sağlam günlük %0.8.
- **Yöntem:** NexusTrade backtest motoru; 2x kaldıraç; komisyon 10 bps, kayma 2 bps; 45 günlük örtüşmeyen
  pencereler; 540 gün geriye; 20-50 sembol; adaptif seçiciler için kör holdout.
- **Denenen aileler:** Donchian/ATR kırılım, DEMA, EMA trend/pullback, RSI ve Stoch RSI, Bollinger,
  Smart Money Concepts, arz/talep bölgeleri, günlük momentum, harmonik (Pine ve reees), QM/Wolfe,
  Orphan Market Reader, mined reversal, explosion catcher, TradingView popüler set, buy & hold,
  çoklu strateji karışımları.
- **Denenen varyant sayısı:** Kayıtlı değil (çok sayıda).
- **Sonuç:** %0.8'i sağlam şekilde veren yok. En iyi savunulabilir adaylar:

  | Profil | Günlük ort. | Pozitif pencere | Ort. düşüş |
  |---|---|---|---|
  | DEMA long TRXUSDT 1h 2x | %0.12 | %66.7 | %6.3 |
  | Donchian EMA-eğim ZECUSDT 1h 2x | %0.29 | %75.0 | %20.0 |
  | Donchian kırılım 0.30 ATR ZECUSDT 1h 2x | %0.33 | %75.0 | %25.2 |

  Aynı profiller tüm sembol evreninde ortalama negatif; ZEC ve TRX sonuçları sembole özgü hipotez.
- **Rapor:** `data/STRATEGY_RESEARCH_SUMMARY_20260612.md`
- **Sonraki adım (o zaman yazılan):** İleriye dönük paper test, parametre madenciliğini bırakmak. → EXP-004

### EXP-002 · Adaptif strateji seçici

- **Durum:** Kaldı
- **Sonuç:** Doğrulamada günlük +%0.03 ile +%0.14; kör holdout'ta günlük −%0.12 ile −%0.40.
- **Rapor:** `data/all_strategy_selector_holdout*_20260612.md`

### EXP-003 · Adaptif rejim yönlendirici

- **Durum:** Kaldı
- **Sonuç:** Trend/yatay geçişli varyantlarda 20 profilden 0-2'si kârlı. Strateji dosyası silinmiş, raporlar duruyor.
- **Rapor:** `data/STRATEGY_RESEARCH_SUMMARY_20260612.md` ("Adaptive Regime Router Result")

### EXP-004 · Haziran adaylarının ileriye dönük testi

- **Durum:** Yarım kaldı
- **Tarih:** 2026-06-12 → 2026-07-02
- **Sonuç:** TRXUSDT ve ZECUSDT botları birer işlem yaptı, sonra bırakıldı.
- **Tek işlemin sebebi (2026-11-27):** Paper bot stratejiye son 500 mumu verir. Stratejiler bekleme
  sayacını mum sırasıyla (`len(candles) - 1`) tutuyor; pencere dolunca bu sayı 499'da sabit kalıyor ve
  bekleme süresi hiç dolmuyor. Bot ilk sinyalden sonra backend yeniden başlayana kadar yeni giriş yapamıyor.
  DEMA botu için kesin (`dema_cross_trend.py` 31 Mayıs'tan beri değişmedi). Donchian dosyasının Haziran
  sürümü git'te yok, bugünkü sürümde aynı hata var. Aynı mumlarda tam geçmişle 10 ve 20 işlem çıkan DEMA ve
  Donchian, 500 mumluk pencereyle 1'er işlem üretiyor. Yani bu test stratejileri ölçmedi. F1-8 ile düzeltildi:
  düzeltmeden sonra pencere ile tam geçmiş aynı işlemleri veriyor.
- **Not:** Bu adayların parametreleri 12 Haziran'da sabitlendi. O tarihten sonraki veri onlar için gerçekten
  görülmemiş veri; Faz 2'de ilk yeniden test edilecekler bunlar ([02-YOL-HARITASI.md](../02-YOL-HARITASI.md)).

### EXP-005 · Harmonik Portföy

- **Durum:** Kaldı
- **Strateji:** `harmonic_portfolio_candidate.py` (çekirdek `pine_harmonic_patterns.py` + 6 seçili
  pattern/zigzag/yön kombinasyonu, TP = target_2, SL = hedef mesafesinin 0.2'si)
- **Kurulum:** 50 sembol, 1h, en fazla 10 pozisyon, **12x** portföy kaldıracı, başlangıç 1000 $
- **Tarih:** 2026-07-19 başlangıç, planlanan bitiş 2026-08-03 (bitişten sonra da çalışmaya devam etti)
- **Sonuç:** 249 işlem, kazanma %11.7, −%46.6, en büyük düşüş ~%73.
- **Not:** 2026-11-26'ya kadar aynı pattern'e stop sonrası tekrar giriş yapılıyordu (son 100 işlemde
  11 fazla işlem); o tarihte düzeltildi.

### EXP-006 · Harmonik QualityTarget 4x / 10x

- **Durum:** Kaldı
- **Kurulum:** EXP-005 ile aynı strateji; en fazla 2 pozisyon, kaliteye ve hedefe göre sıralama; 4x ve 10x.
- **Sonuç:** 123 işlem, kazanma %10.6; 4x −%42.8, 10x −%94.8. Vadeli hesapta 10x büyük ihtimalle likide olurdu
  (simülasyonda likidasyon yok).

### EXP-007 · Harmonik Tarayıcı V2 (Yengeç + 3 Basamak, bearish)

- **Durum:** Kaldı
- **Seçim:** Pattern/yön/rejim kombinasyonları içinden train ve test döneminde PF>1 kalan bearish
  pattern'lerden ikisi: Yengeç (test'te 46 işlem, PF 2.57) ve 3 Basamak (test'te 21 işlem, PF 2.68)
  (`data/harmonic_robustness_search_v2_2026-07-08T00-23-10.md`, EXP-018). Denenen kombinasyon sayısı yüksek
  ama kayıtlı değil.
- **Kurulum:** 380 sembol, 1h + 4h, en fazla 15 pozisyon, 1x, sadece short.
- **Tarih:** 2026-07-08 →
- **Sonuç:** 183 işlem, kazanma %18.6, −%16.2. Hedef stop mesafesinin 5 katı olduğu için başa baş kazanma
  oranı maliyetsiz ~%17; maliyetlerle bunun üstüne çıkamadı.
- **Ders:** Çok sayıda kombinasyon içinden seçilen "tek geçen" aday, ileriye dönük testte tutmadı.

### EXP-008 · Harmonik Tarayıcı V2 HTF Onay

- **Durum:** Karar verilemez (yetersiz örnek)
- **Kurulum:** EXP-007 + 4h'de aynı yönde onay şartı; 380 sembol, 1h giriş.
- **Tarih:** 2026-07-21 →
- **Sonuç:** 4 ayda 8 işlem, kazanma %37.5, +%0.8.
- **Sonraki adım:** 8 Temmuz sonrası veride backtest ile işlem sayısını büyütüp protokole göre değerlendir.

### EXP-009 · Harmonik bot (filtresiz, BTCUSDT 1m)

- **Durum:** Kaldı
- **Strateji:** `pine_harmonic_patterns.py`, varsayılan ayarlar (tüm pattern'ler, zigzag 5-25, TP = target_1).
  Araştırmadaki filtrelerin hiçbiri yok; araştırma 1h/4h'de yapılmıştı, bot 1m'de.
- **Tarih:** 2026-05-31 → 2026-11-25 (durduruldu)
- **Sonuç:** 93 kapanan işlem, kazanma %47.3, −220 $ / 1000 $.

### EXP-010 · qwm3 / qwm5 (QM-Wolfe)

- **Durum:** Hipotez yazılmamış
- **Strateji:** `qm_wolfe_patterns.py`; qwm3 ETHUSDT 4h, qwm5 ADAUSDT 5m.
- **Tarih:** 2026-06-02 →
- **Sonuç (2026-11-26):** qwm3 kapanan işlem yok; qwm5 −61 $ / 1000 $.
- **Not:** Aynı strateji dosyası 13 Haziran'da 20-50 sembolde 30'dan fazla varyantla taranmıştı (EXP-012);
  hiçbir varyant ortalamada günlük %0.02'yi geçmedi. Bu botların avantajı olduğuna dair kayıtlı bir kanıt yok.
- **Paper sonucu stratejiyi ölçmüyor (2026-11-27):** `qm_wolfe_patterns.py` de bekleme sayacını mum
  sırasıyla tutuyor (EXP-004'teki hata). Botlar backend her başladığında en fazla bir giriş yapabiliyor.
  Log da bunu gösteriyor: backend 26 Kasım 22:26'da başladı, qwm5 22:55'te girdi; 27 Kasım 00:15'te yeniden
  başladı, qwm5 01:05'te girdi; sonra yeni giriş yok (saatler UTC).
- **Sonraki adım:** Durdurulması önerilir; ya da protokole göre hipotez ve bitiş kriteri yazılsın.

### EXP-011 · Orphan Market Reader

- **Durum:** Kaldı
- **Tarih:** 2026-05-21 → 05-31 (spot), 2026-06-18 (vadeli, EXP-014)
- **Strateji:** `orphan_market_reader.py`, 5m / 30m / 1h, 2-3x
- **Sonuç:**
  - Tek sembolde çok iyi görünen sonuç: ZECUSDT 30m günlük %0.75 (2x) - %1.08 (3x), ama **17 işlem**.
  - 50 sembolde yeniden tarama (31 Mayıs): ortalama günlük %0.03 (1x) - %0.07 (3x), medyan ~%0.
  - Walk-forward'da en iyi 10 profil: ortalama günlük −%0.07, 10 profilin 2'si pozitif.
  - 5m taramaları: 50 sembolün 0-2'si pozitif.
- **Ders:** 17 işlemlik tek sembol sonucu kaldıraçla büyütülünce hedefi aşıyor gibi görünür; genelleşmedi.
- **Rapor:** `data/orphan_market_reader_*.md`, `data/orphan_gate_*.md`

### EXP-012 · MOST, QM/Wolfe ve çoklu strateji karşılaştırması (50 sembol)

- **Durum:** Kaldı
- **Tarih:** 2026-06-13 → 06-14
- **Denenen:**
  - MOST (`most_rsi_stoch.py`): 1h / 2h / 4h / 15m, retest-red, flip, stop, cooldown, rejim, zamanlama
    varyantları; ATR/MOST parametre optimizasyonu. Toplam 40'tan fazla varyant.
  - QM/Wolfe (`qm_wolfe_patterns.py`): 30'dan fazla filtre varyantı, top-20 ve 50 sembol.
  - 50 sembolde Bollinger, DEMA, mined reversal, SMC, arz/talep, trend ATR, Orphan.
- **Sonuç:**
  - MOST: 4h varyantlarında sembol ortalaması günlük −%0.16 ile +%0.08 arası; 1h ve 15m'de −%0.18 ile
    −%0.69, birçok sembolde hesap sıfırlanıyor. ATR/MOST optimizasyonu: "hedefi geçen aday yok", en iyi aday
    medyan günlük ~%0.
  - QM/Wolfe: tüm varyantlar ortalama günlük −%0.08 ile +%0.02 arası; hiçbir sembol %0.8'e ulaşmadı.
  - Haziran adayı Donchian RR 3.5 top-50'ye uygulanınca: ortalama −%0.24/gün, 50 sembolün 13'ü pozitif.
- **Rapor:** `data/most_*.md`, `data/multi50_*.md`, `data/qm_*.md`, `data/atr_most_*.md`,
  `data/multi_strategy_50_symbol_comparison_*.md`

### EXP-013 · Kesitsel momentum, fonlama ve iç içe seçiciler

- **Durum:** Karışık. Momentum ve fonlama kaldı; risk filtreli seçici yarım kaldı.
- **Tarih:** 2026-06-14 → 06-25
- **Ortam:** 50 likit Binance USDT vadeli, 45 günlük bağımsız pencereler, her pencere için konfigürasyon
  sadece daha eski pencerelere bakılarak seçiliyor ("nested walk-forward").

**a) Kesitsel momentum (vadeli):**
- 14 Haziran, 7 pencere: "consistent momentum taker7" günlük %0.72, "refined momentum" %0.67 (7 pencerenin
  5'i pozitif, ortalama düşüş %45-50).
- 18-19 Haziran, temizlenmiş kripto evreni: aynı aile −%0.17 ile +%0.20.
- 25 Haziran, 15-19 pencere: %0.04-0.05; "flip" ve "refine" varyantları −%0.20 ile −%0.34.
- Ders: 7 pencerede görülen sonuç, pencere sayısı artınca kayboldu.

**b) Fonlama (funding carry):**
- 14 Haziran, 4 pencere: "carry confirmed" günlük %1.30, ama en kötü pencere −%1.67 ve düşüş %47-73.
- 19 Haziran, temiz test: ayar döneminde 7/7 pozitif (%0.33/gün); holdout −%0.23; sembol holdout'u −%0.17;
  iç içe seçici −%0.28.

**c) Risk filtreli iç içe strateji seçici:**
- Girdi: 16 strateji ailesinin (Donchian, Orphan, harmonik, QM, SMC, MOST vb.) 12 Haziran walk-forward
  sonuçları, top-20/50 sembol. Her kör pencerede 24.576 kural adayından biri sadece eski pencerelere bakılarak
  seçiliyor; seçilen plan neredeyse her pencerede "en iyi strateji ailesinin momentumu".
- Sonuç (14 kör pencere, 45 gün): düşüş limiti %20 ile günlük %0.49, 14'ün 13'ü pozitif, ortalama düşüş %12;
  limit %30 ile günlük %0.67, 14/14 pozitif, en kötü düşüş %32.
- **Dikkat:**
  - Girdi stratejilerin parametreleri aynı veride geliştirildi; kural seçimi kör, stratejiler değil.
  - Düşüş "tahmini"; portföy aynı anda birçok sembolde pozisyon taşıyınca gerçek düşüş farklı olabilir.
  - 24.576 aday çok sayıda deneme demek (protokol 4. bölüm).
- **Sonraki adım (yazılmamış, şimdi öneriliyor):** 14 Haziran'da seçilen kuralı sabitleyip 14 Haziran
  sonrası veride çalıştırmak. Faz 2'de aday.

**d) Diğerleri (hepsi kaldı):**
- Günlük volatilite kırılımı −%0.14
- Order-flow kesitsel −%0.83
- Pairs trading −%0.06
- ML kesitsel −%0.04 / −%0.21
- Rejim kapılı seçici %0.16 (7 pencerenin 5'i pozitif, en kötü düşüş %69)
- Adaptive trend replikasyonu %0.00-0.08 (sadece ayar dönemi)
- Robust alpha −%0.19 / −%0.25

- **Rapor:** `data/consistent_momentum_*.md`, `data/perp_*.md`, `data/funding_*.md`,
  `data/nested_selector_*.md`, `data/regime_*.md`

### EXP-014 · Vadeli Orphan ve kaldıraç taraması

- **Durum:** Kaldı
- **Tarih:** 2026-06-18
- **Sonuç:** Olgun 12 sembolde ABCD long 1h: 2x'te ortalama günlük −%0.005; 12x'te −%0.18, 14x'te −%0.24
  (84 vakanın 7'si %0.8'i geçiyor ama ortalama negatif). Seçili profiller 2x portföy: walk-forward %0.03-0.41,
  tutarsız. Tek sembol BNB 1h 8x: 7/7 pozitif, %0.64; tek sembol, 7 vaka.
- **Ders:** Kaldıraç kötü ortalamayı iyileştirmiyor; sadece birkaç şanslı vakayı %0.8'in üstüne taşıyor.
- **Rapor:** `data/orphan_futures_*_20260618.md`

### EXP-015 · İnternet stratejileri, universal alpha, edge miner

- **Durum:** Kaldı
- **Tarih:** 2026-06-25 → 06-26
- **Sonuç:** İnternet strateji karışımı ve tersi: 20 pencerede ~%0.00/gün. Universal alpha portföyleri:
  −%0.10 ile −%0.22. Universal rejim meta: −%0.13 (19 pencerenin 5'i pozitif). Edge miner: −%0.01.
  Donchian long/short top-50 örtüşmeyen 45 gün: −%0.14 / −%0.04.
- **Rapor:** `data/internet_strategy_*.md`, `data/universal_*.md`, `data/edge_miner_*.md`

### EXP-016 · Harmonik çıkış optimizasyonu ve portföy adayı

- **Durum:** Geçersiz. Backtest'teki portföy sonucu bir replay hatasından geliyordu (aşağıda); paper testte
  kaldı (EXP-005, EXP-006)
- **Tarih:** 2026-06-26 → 06-28
- **Yöntem:** `scripts/harmonic_exit_optimizer.cjs`, 15m / 1h / 4h, 50 sembol, 90 günlük pencereler ve
  90-270 gün kaydırılmış pencereler. 90 raporda yaklaşık **209 farklı varyant** (pattern filtresi, TP hedefi,
  SL oranı, ADX/HTF/DEMA filtreleri, "öğrenen" filtreler, repaint açık/kapalı).
- **Sembol başına sonuç:** 422 varyant satırının 130'u pozitif. Sonradan portföye alınan "detail_seed"
  filtresi sembol başına günlük −%0.02 ile −%0.04 arasında.
- **Portföy adayı (28 Haziran):** 6 pattern/zigzag/yön filtresi, TP = hedef 2, SL = hedef mesafesinin %20'si,
  en fazla 10 pozisyon, 12x. Beş 90 günlük pencerede günlük %0.84-1.59 (ortalama %1.12), kazanma oranı
  %27-32, gerçekleşmiş en büyük düşüş %42-71. Son pencere "görülmemiş holdout" olarak işaretli.
- **İleriye dönük sonuç:** Paper portföy (EXP-005) kazanma oranı %11.7, −%46.6.
- **Fark açıklandı (2026-11-27): portföy replay hatası.**
  - Backtest motoru (pool_worker `backtest`) sembol başına mumları sırayla işliyor; orada sorun yok.
    Sorun, sembol işlemlerini ortak sermayede birleştiren `replayPortfolio()`'daydı
    (`scripts/harmonic_exit_optimizer.cjs`): `exitTime > entryTime` filtresi giriş mumunda kapanan her
    işlemi listeden atıyordu. Giriş anında bunu bilmek mümkün değil, yani geleceği görme.
  - SL hedef mesafesinin %20'si olduğu için stop çok yakın; işlemlerin %48-51'i giriş mumunda kapanıyor
    ve neredeyse hepsi stop. Paper'da da aynı: 251 işlemin 130'u (%52) giriş mumunda kapandı, bunların
    kazanma oranı %4.6.
  - 28 Haziran'daki 5 pencere, kayıtlı işlem satırlarından (`data/harmonic_exit_optimizer_1h_90d_*50s_20260628T06*.json`)
    birebir yeniden üretildi; sonra filtre düzeltilerek tekrar hesaplandı:

    | Pencere | Raporlanan: günlük / kazanma / işlem / düşüş | Düzeltilmiş: günlük / kazanma / işlem / düşüş |
    |---|---|---|
    | Güncel | %1.585 / %31.6 / 580 / %42.5 | −%3.90 / %17.8 / 1198 / %97.4 |
    | 90 gün önce | %1.059 / %27.2 / 595 / %45.6 | −%4.13 / %16.2 / 1146 / %98.6 |
    | 180 gün önce | %0.836 / %28.8 / 580 / %58.6 | −%4.50 / %15.5 / 1145 / %98.5 |
    | 270 gün önce | %0.953 / %26.7 / 772 / %59.1 | −%6.06 / %14.5 / 1547 / %99.7 |
    | 360 gün önce (holdout) | %1.143 / %27.1 / 569 / %71.2 | −%4.03 / %16.2 / 1094 / %97.8 |

  - Kaldıraçsız (1x) bile güncel pencere günlük −%0.30. Yani strateji işlem başına zarar ediyor; sonucu
    kaldıraç değil, atılan işlemler pozitife çeviriyordu.
  - QualityTarget ayarları (2 pozisyon, kalite × √hedef sıralaması) da aynı replay'den geliyor: raporlanan
    günlük %0.50-1.73, düzeltilmiş 4x'te −%2.7 ile −%5.2, 10x'te −%8.4 ile −%14.1 (5 pencerenin hepsinde
    %95-100 düşüş).
  - Filtre düzeltildi (`>=`). Düzeltilmiş sonuçlar şu komutla yeniden üretilir:
    `node scripts/harmonic_exit_optimizer.cjs --replay-json=<dosya> --replay-combine=true --portfolio-replay=true --portfolio-score=target --portfolio-positions=10 --portfolio-extra-cost-bps=0`
- **Kalan küçük fark:** Düzeltilmiş backtest kazanma oranı %14.5-17.8, paper %11.6 (farklı dönemler).
  Motorlar arasında bilinen başka farklar da var, F1-6 altın testinde ölçülecek:
  - Backtest açık pozisyonun SL/TP'sini her mumda stratejinin son çıktısına göre güncelliyor
    (`pool_worker.py` `_apply_risk_update`); paper girişte sabitliyor.
  - Backtest tüm geçmişi görüyor; paper son 600 mumu.
  - Paper 130 günde 725 döngü çalıştı (saatlik 3120 mumun yaklaşık dörtte biri); bilgisayar kapalıyken
    sinyaller kaçtı.
- **Rapor:** `data/harmonic_exit_optimizer_*.md`, `data/harmonic_portfolio_candidate_20260628.md`

### EXP-017 · Harmonik V2 taramaları

- **Durum:** Kaldı
- **Tarih:** 2026-07-05 → 07-07
- **Sonuç:** V2 portföy matrisi (50 sembol, 15m / 1h / 4h, 3 ay - 2 yıl): hiçbir hücrede ortalama getiri
  pozitif değil; 1h 1 yılda −%19 (karlı sembol %10), 4h 1 yılda −%8 (karlı sembol %28). Kazanma oranı her
  yerde %15-20. ABCD ve çıkış taramalarında en iyi satırlar PF 0.98-1.31.
- **Rapor:** `data/harmonic_portfolio_matrix*.md`, `data/harmonic_*_sweep_v2_*.md`,
  `data/harmonic_pattern_breakdown_v2_*.md`

### EXP-018 · Harmonik dayanıklılık araması ve Yengeç nihai test

- **Durum:** Paper testte kaldı (EXP-007)
- **Tarih:** 2026-07-08
- **Sonuç:** Train/test ayrımında PF>1 kalan bearish pattern'ler: 3 Basamak (test'te 21 işlem), Yengeç
  (46 işlem), Derin Yengeç (129 işlem, test PF 1.02). Yengeç nihai test matrisi: 1h 1 yılda sembol başına
  ortalama 4.7 işlem, ortalama getiri %0.36, karlı sembol %33.
- **Ders:** Test'te 21-46 işlemlik PF, 380 sembollük bir portföyü başlatmak için yetersizdi; protokol
  eşikleri (holdout ≥30 işlem, çok varyant varsa PF ≥1.4 ve ≥200 işlem) o zaman olsaydı geçmezdi.
- **Rapor:** `data/harmonic_robustness_search_v2_*.md`, `data/harmonic_yengec_final_test_v2_*.md`
