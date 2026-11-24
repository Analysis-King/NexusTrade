# name: Orphan ABCD Long
# desc: Orphan Market Reader cekirdegini sadece ABCD long kurulumlari icin kullanir
# author: NexusTrade
# version: 0.1

from strategies import orphan_market_reader as base


LAST_SIGNAL_KEY = None
LAST_SIGNAL_BAR = None


def initialize():
    global LAST_SIGNAL_KEY, LAST_SIGNAL_BAR
    LAST_SIGNAL_KEY = None
    LAST_SIGNAL_BAR = None
    base.LAST_SIGNAL_KEY = None
    base.LAST_SIGNAL_BAR = None

    config = base.initialize()
    config.update({
        "enabled_models": ["abcd"],
        "enabled_setups": ["ABCD:long"],
        "allow_long": True,
        "allow_short": False,
        "exit_on_opposite_signal": True,
        "recent_signal_bars": 1,
        "draw_setups": True,
    })
    return config


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_KEY, LAST_SIGNAL_BAR
    base.LAST_SIGNAL_KEY = LAST_SIGNAL_KEY
    base.LAST_SIGNAL_BAR = LAST_SIGNAL_BAR
    result = base.on_candle(candle, portfolio, config)
    LAST_SIGNAL_KEY = base.LAST_SIGNAL_KEY
    LAST_SIGNAL_BAR = base.LAST_SIGNAL_BAR
    return result


def draw(candles, indicators, patterns, config=None):
    cfg = base.initialize()
    cfg.update({
        "enabled_models": ["abcd"],
        "enabled_setups": ["ABCD:long"],
        "allow_long": True,
        "allow_short": False,
        "exit_on_opposite_signal": True,
        "recent_signal_bars": 1,
        "draw_setups": True,
    })
    if isinstance(config, dict):
        cfg.update(config)
    return base.draw(candles, indicators, patterns, cfg)
