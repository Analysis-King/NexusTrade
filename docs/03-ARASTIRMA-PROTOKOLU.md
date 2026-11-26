# Araştırma Protokolü

Her strateji fikri aynı yoldan geçer. Amaç: şans eseri iyi görünen stratejiyi, gerçekten avantajı olan
stratejiden ayırmak. Eşikler başlangıç önerisidir; değiştirilebilir ama **deney başlamadan önce** ve kayda
yazılarak.

---

## 1. Deneyin yaşam döngüsü

```
Fikir ─► Kayıt ─► Geliştirme ─► Doğrulama ─► Holdout ─► İleriye dönük paper ─► Küçük canlı
         (hipotez,  (ayar      (ayar yok,    (tek       (6-8 hafta,            (4-8 hafta,
          kriter)    serbest)    kontrol)     bakış)     ≥30 işlem)             en küçük boyut)
```

Her deneyin kayıttaki durumu şunlardan biri: **Fikir**, **Geliştiriliyor**, **Doğrulamada**,
**İleriye dönük teste hazır**, **İleriye dönük testte**, **Geçti**, **Kaldı**, **Yarım kaldı**, **Arşiv**.

## 2. Veriyi bölmek

- Zaman sırasına göre, örtüşmeden üç parça:
  - **Geliştirme** (ilk ~%60): istediğin kadar ayar yap.
  - **Doğrulama** (sonraki ~%20): ayar yapma, sadece kontrol et. Kötüyse geliştirmeye dön ve kayda yaz.
  - **Holdout** (son ~%20): **bir kez** bak. Sonucunu gördükten sonra parametre değiştirirsen holdout artık
    holdout değildir; kayda yaz. Bundan sonraki tek görülmemiş veri ileriye dönük paper testtir.
- Sonuçları örtüşmeyen pencerelerle (ör. 45 gün) raporla. Örtüşen pencereler aynı piyasa hareketini birden
  çok kez sayar ve stratejiyi olduğundan iyi gösterir (Haziran araştırmasının bulgusu).
- Tek sembolde çıkan avantaj "sembole özgü hipotez" olarak etiketlenir; genel strateji sayılmaz.

## 3. Maliyetler

- Varsayılan: komisyon 10 bps, kayma 2 bps, her giriş ve çıkışta.
- Stres testi: maliyetler 1,5 ve 2 katı.
- Vadeli işlemde fonlama ve likidasyon dahil.
- Aynı mumda hem SL hem TP görülürse önce SL.
- Sinyal mumunun kapanışıyla üretilen sinyal, **bir sonraki mumun açılışında** işleme girer.

## 4. "İleriye dönük teste hazır" kriterleri

| Metrik | Eşik |
|---|---|
| Kapanan işlem (geliştirme + doğrulama) | ≥ 100 |
| Kapanan işlem (holdout) | ≥ 30 |
| Holdout'ta işlem başına ortalama R, maliyet sonrası | > 0 |
| Aynı metrik, maliyet ×1,5 | > 0 |
| Holdout profit factor (maliyet sonrası) | ≥ 1,2 |
| Pozitif pencere oranı (örtüşmeyen) | ≥ %60 |
| Holdout en büyük düşüş | ≤ geliştirme döneminin 1,5 katı |
| Parametre komşuluğu: ana parametreler ±%20 değişince | PF > 1 kalıyor (sivri tepe değil, plato) |
| Canlıda yapılabilirlik | Spot hedefleniyorsa sadece long işlemler |

**Denenen varyant sayısı kayda yazılır.** 20'den fazla varyant içinden seçildiyse eşikler sıkılaşır:
holdout PF ≥ 1,4 ve toplam işlem ≥ 200. Çok deneme yapıp en iyisini seçmek, şansı avantaj sanmanın en
yaygın yoludur.

## 5. İleriye dönük paper test kriterleri

- Başlarken kaydet: backtest'ten beklenen işlem başına R, aylık işlem sayısı, en büyük düşüş.
- Süre: en az 6 hafta **ve** en az 30 kapanan işlem (hangisi daha geç dolarsa).
- **Geçti:** ortalama R > 0, sonuç backtest beklentisinin alt %10'unun üstünde, düşüş backtest'teki en
  büyük düşüşü aşmadı.
- **Kaldı:** düşüş backtest'teki en büyük düşüşü aşarsa test erken bitirilir. Bu "yarım kaldı" değil,
  "kaldı" sayılır.

## 6. Tuzak kontrol listesi

Her deney raporunda işaretle:

- [ ] **Geleceği görme:** Strateji her adımda sadece o ana kadarki mumları görüyor; giriş sonraki açılışta.
- [ ] **Repaint:** Pattern/indikatör sonradan değişebiliyorsa backtest adım adım yürütüldü
      (NexusTrade backtest motoru böyle çalışır; özel script'ler kontrol edilmeli).
- [ ] **Hayatta kalan yanlılığı:** Sembol listesi bugünün listesinden alındıysa, geçmişte listeden çıkmış
      coinler eksik; sonuç iyimser olabilir.
- [ ] **Aynı veride tekrar tekrar ayar:** Holdout'a kaç kez bakıldı? Kayda yazıldı mı?
- [ ] **Kaldıraçla hedefe ulaşmak:** Getiri kaldıraçla büyütüldüyse aynı oranda düşüş de büyür; likidasyon
      modellendi mi?
- [ ] **Az işlem:** 8 işlemde %37 kazanma oranı istatistiksel olarak hiçbir şey söylemez.
- [ ] **Maliyet:** Yüksek işlem sıklığında maliyetler avantajın büyük kısmını yiyebilir (Haziran bulgusu:
      Donchian ZEC'de maliyetsiz %0.38/gün, maliyetli %0.20/gün).

---

## 7. Deney şablonu

Yeni bir deney için aşağıdaki bloğu kopyala, [arastirma/DENEY-KAYDI.md](arastirma/DENEY-KAYDI.md)'nin
**Ayrıntılar** bölümüne ekle ve özet tablosuna bir satır yaz.

```markdown
### EXP-0XX · <kısa ad>

- **Durum:** Fikir
- **Tarih:** başlangıç <YYYY-AA-GG>, bitiş <YYYY-AA-GG>
- **Hipotez:** <Neden bu stratejinin avantajı olmalı? Piyasada hangi davranışı yakalıyor? Tek cümle.>
- **Strateji dosyası ve commit:** `python/strategies/<dosya>.py` @ <git commit>
- **Semboller / periyot:** <...>
- **Veri bölümü:** geliştirme <tarih-tarih>, doğrulama <tarih-tarih>, holdout <tarih-tarih>
- **Parametreler:** <sabit değerler; aranan aralıklar>
- **Denenen varyant sayısı:** <sayı>
- **Maliyet varsayımı:** komisyon <bps>, kayma <bps>, fonlama <var/yok>, kaldıraç <x>
- **Geçti/kaldı kriteri:** <protokol 4. bölüm, ya da önceden yazılmış farklı eşikler>
- **Sonuç:**

  | Dönem | İşlem | Ort. R | PF | Pozitif pencere | En büyük düşüş |
  |---|---|---|---|---|---|
  | Geliştirme | | | | | |
  | Doğrulama | | | | | |
  | Holdout | | | | | |
  | Maliyet ×1,5 | | | | | |

- **Tuzak kontrol listesi:** <işaretlenen ve işaretlenemeyen maddeler>
- **Karar ve gerekçe:** <Geçti / Kaldı / Yarım kaldı, neden>
- **Rapor dosyaları:** `data/<...>.md`
- **Sonraki adım:** <...>
```
