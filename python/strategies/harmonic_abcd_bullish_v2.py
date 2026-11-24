# name: Harmonik AB=CD Bullish Izole (V2 arastirma)
# desc: harmonic_pattern_breakdown_v2 taramasinda en yuksek ornekli pozitif-edge pattern
#       olarak cikan AB=CD bullish TEK BASINA izole edilir (30 sembol/2TF/2periyotta
#       268 islem, PF 1.39). Diger pattern'lerle karistirilmadan cikis parametresi
#       taramasi icin kullanilir. Cikis parametreleri KILITLI DEGIL - sweep scriptinin
#       params ile gecebilmesi icin acik birakildi.
# author: NexusTrade
# version: 1.0 (V2 - sadece arastirma, uretimde kullanilmiyor)

import importlib.util as _importlib_util
import os as _os


def _load_core():
    path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "pine_harmonic_patterns.py")
    module_name = f"{__name__}_core"
    spec = _importlib_util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError("pine_harmonic_patterns.py yuklenemedi")
    module = _importlib_util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_CORE = _load_core()

TRADE_FILTERS = [
    {"pattern": "AB=CD", "direction": "bullish"},
]

# Sadece pattern evrenini ve genel calisma modunu kilitliyoruz.
# Cikis parametreleri kasitli olarak burada YOK - resolve_config disaridan gelen
# config'i onceliklendirir, boylece sweep scripti farkli degerler deneyebilir.
LOCKED_CONFIG = {
    "allow_repaint": True,
    "wait_for_confirmation": False,
    "allow_short": True,
    "recent_signal_bars": 3,
    "entry_confirmation_mode": "off",
    "exit_mode": "single",
    "trade_filters": TRADE_FILTERS,
}


def _locked(config=None):
    merged = _CORE.initialize()
    if isinstance(config, dict):
        merged.update(config)
    merged.update(LOCKED_CONFIG)
    merged["trade_filters"] = [dict(item) for item in TRADE_FILTERS]
    return merged


def initialize():
    return _locked()


def resolve_config(config):
    return _locked(config)


def on_candle(candle, portfolio, config):
    return _CORE.on_candle(candle, portfolio, _locked(config))


def draw(candles, indicators, patterns, config=None):
    return _CORE.draw(candles, indicators, patterns, _locked(config))


def scan_patterns(candles, config=None):
    return _CORE.scan_patterns(candles, _locked(config))


def scan_historical_patterns(candles, config=None):
    return _CORE.scan_historical_patterns(candles, _locked(config))
