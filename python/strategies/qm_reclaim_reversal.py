# name: QM Reclaim Reversal
# desc: Quasimodo sol omuz bolgesi geri alindiginda, donus mumu onayi ile cift yonlu islem arar
# author: NexusTrade
# version: 0.1

from strategies import qm_wolfe_patterns as base


def initialize():
    config = base.initialize()
    config.update({
        "enabled_models": ["qm"],
        "enabled_setups": ["qm:long", "qm:short"],
        "allow_long": True,
        "allow_short": True,
        "max_scan_candles": 250,
        "pivot_depths": [8, 13, 21],
        "qm_entry_mode": "reclaim",
        "qm_require_reversal_candle": True,
        "min_score": 78.0,
        "min_reward_risk": 1.5,
        "default_reward_risk": 2.0,
    })
    return config


def on_candle(candle, portfolio, config):
    return base.on_candle(candle, portfolio, config)


def draw(candles, indicators, patterns, config=None):
    return base.draw(candles, indicators, patterns, config)
