# name: Harmonik Yengec Short (V2 - dogrulanmis aday)
# desc: Yengec (Crab) bearish pattern'i tek basina kullanan strateji. Kaynak: 30 sembol x
#       (1h,4h) x ORTUSMEYEN train (365-91 gun once, N=143, PF 1.19) / test (son 91 gun,
#       N=46, PF 2.57) donemlerinde tutarli pozitif Profit Factor gosteren TEK aday
#       (bkz. data/harmonic_robustness_search_v2_2026-07-08T00-23-10.md). Win rate mutevazi
#       (~%20-28) ama bu KASITLI: dar stop (sl_ratio=0.2) + genis hedef (target_2) yapisi
#       "az kazan-buyuk kazan" mantigiyla calisiyor; profit factor asil metriktir.
# author: NexusTrade
# version: 1.0 (V2 - arastirmadan cikan aday, uretime almadan once daha genis dogrulama onerilir)

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
    {"pattern": "Yengec", "direction": "bearish"},
]

LOCKED_CONFIG = {
    "allow_repaint": True,
    "wait_for_confirmation": False,
    "allow_short": True,
    "recent_signal_bars": 3,
    "entry_confirmation_mode": "off",
    "exit_mode": "single",
    "take_profit_mode": "target_2",
    "stop_loss_mode": "target_ratio",
    "stop_loss_target_ratio": 0.2,
    "stop_trigger_mode": "touch",
    "min_reward_risk": 0.5,
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
