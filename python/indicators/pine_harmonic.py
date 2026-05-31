# name: Pine Harmonik Pattern
# desc: PineScript coklu zigzag harmoniklerini grafikte cizer
# category: Formasyon
# author: NexusTrade
# version: 1.0

import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_HARMONIC_PATH = os.path.abspath(os.path.join(_HERE, "..", "strategies", "pine_harmonic_patterns.py"))
_SPEC = importlib.util.spec_from_file_location("_nexus_pine_harmonic_patterns", _HARMONIC_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError("pine_harmonic_patterns.py yuklenemedi")

harmonic = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(harmonic)


def initialize():
    config = harmonic.initialize()
    config.update(
        {
            "indicator_only": True,
            "draw_historical_patterns": True,
            "draw_history_bars": 700,
            "max_draw_patterns": 40,
            "enable_double_top_bottom": False,
            "min_quality": 0,
        }
    )
    return config


def draw(candles, indicators, patterns, config=None):
    return harmonic.draw(candles, indicators, patterns, config)
