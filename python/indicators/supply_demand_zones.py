# name: Automatic Supply Demand Zones
# desc: Base + impulse supply/demand zone detector with strength and freshness labels
# category: Price Action
# author: NexusTrade
# version: 1.0

import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_STRATEGY_PATH = os.path.abspath(os.path.join(_HERE, "..", "strategies", "supply_demand_zones.py"))
_SPEC = importlib.util.spec_from_file_location("_nexus_supply_demand_zones", _STRATEGY_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise ImportError("supply_demand_zones.py yuklenemedi")

sd = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(sd)


def initialize():
    config = sd.initialize()
    config.update(
        {
            "draw_history_bars": 900,
            "draw_max_zones": 16,
            "min_strength": 52.0,
            "max_tests": 2,
        }
    )
    return config


def draw(candles, indicators, patterns, config=None):
    return sd.draw(candles, indicators, patterns, config)
