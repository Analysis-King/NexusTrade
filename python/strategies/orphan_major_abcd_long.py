# name: Orphan Major ABCD Long
# desc: Orphan Market Reader cekirdegini major zigzag pivotlariyla sadece ABCD long icin kullanir
# author: NexusTrade
# version: 0.1

from strategies import orphan_market_reader as base


LAST_SIGNAL_KEY = None
LAST_SIGNAL_BAR = None


def _major_config():
    config = base.initialize()
    config.update({
        "pivot_engine": "major",
        "pivot_depths": [8, 13, 21, 34],
        "major_zigzag_dev_pct": 0.75,
        "major_zigzag_atr_mult": 1.0,
        "major_zigzag_bar_depth_mult": 0.75,
        "enabled_models": ["abcd"],
        "enabled_setups": ["ABCD:long"],
        "allow_long": True,
        "allow_short": False,
        "exit_on_opposite_signal": True,
        "recent_signal_bars": 1,
        "min_interval_minutes": 0,
        "draw_setups": True,
        "draw_max_setups": 24,
        "draw_last_bars": 520,
    })
    return config


def initialize():
    global LAST_SIGNAL_KEY, LAST_SIGNAL_BAR
    LAST_SIGNAL_KEY = None
    LAST_SIGNAL_BAR = None
    base.LAST_SIGNAL_KEY = None
    base.LAST_SIGNAL_BAR = None
    return _major_config()


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_KEY, LAST_SIGNAL_BAR
    base.LAST_SIGNAL_KEY = LAST_SIGNAL_KEY
    base.LAST_SIGNAL_BAR = LAST_SIGNAL_BAR
    result = base.on_candle(candle, portfolio, config)
    LAST_SIGNAL_KEY = base.LAST_SIGNAL_KEY
    LAST_SIGNAL_BAR = base.LAST_SIGNAL_BAR
    return result


def draw(candles, indicators, patterns, config=None):
    cfg = _major_config()
    if isinstance(config, dict):
        cfg.update(config)
    return base.draw(candles, indicators, patterns, cfg)
