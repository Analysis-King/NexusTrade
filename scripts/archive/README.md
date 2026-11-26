# Arşivlenmiş araştırma script'leri

Haziran-Temmuz 2026 deneylerinde kullanılan tarama ve backtest araçları. Hepsi kapanmış deneylere ait;
sonuçları [docs/arastirma/DENEY-KAYDI.md](../../docs/arastirma/DENEY-KAYDI.md)'da, ham raporları `data/`
altında. 2026-11-27'de `scripts/` kökünden buraya taşındı (F0-6).

- **Bakımı yapılmıyor.** Sistem bunların hiçbirini çağırmıyor. Yeni bir deney için bunları düzeltmek
  yerine Faz 1'deki ortak çekirdeği kullan.
- **Çalıştırma:** eskisi gibi repo kökünden, `node scripts/archive/<script>.cjs ...`. Script'lerin çoğu
  `data/...` yollarını çalışılan klasöre göre açar; kök klasörü kendi konumundan bulan 13 tanesi taşınırken
  iki seviye yukarıyı gösterecek şekilde düzeltildi.
- **Silme.** Deney kaydı bu dosyaların adlarına ve ürettikleri raporlara dayanıyor.

| Aile | Script'ler |
|---|---|
| Harmonik | `harmonic_*`, `_validate_abcd.cjs` |
| Momentum ve rotasyon | `*momentum*`, `adaptive_*`, `rotation_scan.cjs`, `slow_trend_follow_research.cjs`, `regime_gated_momentum_selector.cjs` |
| Fonlama | `funding_*`, `delta_neutral_funding_research.cjs` |
| Orphan / market reader | `orphan_*` |
| Genel taramalar | `strategy_scan.cjs`, `aggregate_multi_strategy_scan.cjs`, `research_alpha*.cjs`, `signal_mining.cjs`, `edge_*`, `internet_strategy_scout_50.cjs`, `universal_regime_meta_research.cjs`, `strategy_selector_holdout.cjs` |
| Diğer | `atr_most_optimizer.cjs`, `most_red_retest_analysis.cjs`, `daily_volatility_breakout_research.cjs`, `meta_breakout_research.cjs`, `pairs_trading_research.cjs`, `footprint_backtest.cjs`, `orderbook_market_maker_forward.cjs`, `orderflow_cross_sectional_research.cjs`, `ml_cross_sectional_research.cjs` |

Faz 1-2'de hâlâ gereken araçlar (`nested_strategy_selector.cjs`, `strategy_portfolio_blend.cjs`,
`orphan_market_reader_walk_forward*.cjs`, `harmonic_exit_optimizer.cjs`) `scripts/` altında kaldı.
`strategy_selector_holdout.cjs` bunlardan `strategy_portfolio_blend.cjs`'i `../` ile yüklüyor.
