# Deney Kaydı

Şimdiye kadar denenen her şey ve sonucu. Yeni deney eklemeden önce
[03-ARASTIRMA-PROTOKOLU.md](../03-ARASTIRMA-PROTOKOLU.md)'yu oku; şablon orada.

Aşağıdaki ilk kayıtlar 2026-11-26'da mevcut raporlardan ve paper sonuçlarından geriye dönük derlendi.
"Denenen varyant sayısı" bu deneylerin çoğunda kayıtlı değil; bu yüzden sonuçlarına ekstra şüpheyle bakılmalı.
Haziran ve Temmuz raporlarının tamamı `data/` altında; F0-7 kapsamında eksik deneyler eklenecek.

## Özet

| No | Ad | Tür | Tarih | Sonuç | Durum |
|---|---|---|---|---|---|
| EXP-001 | Haziran strateji taraması (20+ aile) | Backtest | 2026-06 | En iyi adaylar günlük %0.12-0.42; çoğu sembolde genelleşmiyor | Geçti (3 aday) |
| EXP-002 | Adaptif strateji seçici | Backtest | 2026-06 | Kör holdout'ta günlük −%0.12 ile −%0.40 | Kaldı |
| EXP-003 | Adaptif rejim yönlendirici | Backtest | 2026-06 | 20 profilden 0-2'si kârlı | Kaldı |
| EXP-004 | Haziran adaylarının ileriye dönük testi | Paper | 2026-06 → 07-02 | Her aday 1 işlem yaptı, test bırakıldı | Yarım kaldı |
| EXP-005 | Harmonik Portföy (12x) | Paper portföy | 2026-07-19 → | 249 işlem, kazanma %11.7, **−%46.6** | Kaldı |
| EXP-006 | Harmonik QualityTarget 4x / 10x | Paper portföy | 2026-07-19 → | 123 işlem, kazanma %10.6, **−%42.8 / −%94.8** | Kaldı |
| EXP-007 | Harmonik Tarayıcı V2 | Paper portföy | 2026-07-08 → | 183 işlem, kazanma %18.6, **−%16.2** | Kaldı |
| EXP-008 | Harmonik Tarayıcı V2 HTF Onay | Paper portföy | 2026-07-21 → | 8 işlem, kazanma %37.5, +%0.8 | Karar verilemez |
| EXP-009 | Harmonik bot (filtresiz) | Paper bot | 2026-05-31 → 11-25 | 93 işlem, kazanma %47.3, **−220 $ / 1000 $** | Kaldı |
| EXP-010 | qwm3 / qwm5 (QM-Wolfe) | Paper bot | 2026-06-02 → | qwm3: kapanan işlem yok; qwm5: −61 $ / 1000 $ | Hipotez yok |

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
- **Seçim:** Pattern/yön/rejim kombinasyonları içinden "train ve test döneminde PF>1 olan tek çift"
  (`data/harmonic_robustness_search_v2_2026-07-08T00-23-10.md`). Denenen kombinasyon sayısı yüksek ama
  kayıtlı değil.
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
- **Sonraki adım:** Ya protokole göre kayda alınıp hipotez ve bitiş kriteri yazılsın, ya da durdurulsun.
