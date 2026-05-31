# name: Basit Al Tut
# desc: Backtest kontrolu icin ilk firsatta long acip test sonuna kadar tutar
# author: NexusTrade
# version: 1.0

ENTERED = False


def initialize():
    return {
        "only_once": True,
    }


def draw(candles, indicators, patterns):
    if not candles:
        return []
    return [{
        "type": "signals",
        "signals": [{
            "t": candles[0]["t"],
            "price": candles[0]["l"],
            "side": "buy",
            "label": "BUY HOLD",
        }],
    }]


def on_candle(candle, portfolio, config):
    global ENTERED

    if not ENTERED and not portfolio.has_position:
        ENTERED = True
        buy()
    else:
        hold()
