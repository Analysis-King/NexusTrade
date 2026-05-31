# name: Basit EMA Kesisim
# desc: Test icin sade EMA kesisim stratejisi: yukari kesisimde long, asagi kesisimde short
# author: NexusTrade
# version: 1.0

import builtins as _builtins


def initialize():
    return {
        "fast_period": 9,
        "slow_period": 21,
        "allow_short": True,
        "use_risk": False,
        "stop_loss_pct": 2.0,
        "take_profit_pct": 4.0,
    }


def _to_float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _to_int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _to_bool(value, fallback=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "evet", "acik")
    if value is None:
        return fallback
    return bool(value)


def _ema_series(values, period):
    if not values:
        return []
    alpha = 2.0 / (period + 1.0)
    ema = [float(values[0])]
    for price in values[1:]:
        ema.append(float(price) * alpha + ema[-1] * (1.0 - alpha))
    return ema


def _config(config):
    cfg = initialize()
    if isinstance(config, dict):
        cfg.update(config)
    cfg["fast_period"] = max(2, _to_int(cfg.get("fast_period"), 9))
    cfg["slow_period"] = max(cfg["fast_period"] + 1, _to_int(cfg.get("slow_period"), 21))
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["use_risk"] = _to_bool(cfg.get("use_risk"), False)
    cfg["stop_loss_pct"] = _to_float(cfg.get("stop_loss_pct"), 2.0)
    cfg["take_profit_pct"] = _to_float(cfg.get("take_profit_pct"), 4.0)
    return cfg


def _candles():
    try:
        return indicators.candles()
    except Exception:
        return []


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def draw(candles, indicators, patterns):
    cfg = initialize()
    closes = [c["c"] for c in candles]
    if len(closes) < cfg["slow_period"] + 2:
        return []

    fast = _ema_series(closes, cfg["fast_period"])
    slow = _ema_series(closes, cfg["slow_period"])
    signals = []

    for i in range(1, len(closes)):
        crossed_up = fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]
        crossed_down = fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]
        if crossed_up:
            signals.append({"t": candles[i]["t"], "price": candles[i]["l"], "side": "buy", "label": "EMA"})
        elif crossed_down:
            signals.append({"t": candles[i]["t"], "price": candles[i]["h"], "side": "sell", "label": "EMA"})

    return [{"type": "signals", "signals": signals[-80:]}]


def on_candle(candle, portfolio, config):
    cfg = _config(config)
    candles = _candles()
    closes = [c["c"] for c in candles]
    if len(closes) < cfg["slow_period"] + 2:
        hold()
        return

    fast = _ema_series(closes, cfg["fast_period"])
    slow = _ema_series(closes, cfg["slow_period"])

    crossed_up = fast[-2] <= slow[-2] and fast[-1] > slow[-1]
    crossed_down = fast[-2] >= slow[-2] and fast[-1] < slow[-1]

    if cfg["use_risk"]:
        set_sl(pct=cfg["stop_loss_pct"])
        set_tp(pct=cfg["take_profit_pct"])

    current_side = getattr(portfolio, "side", None)
    if crossed_up and current_side != "BUY":
        _observe(f"ema.{cfg['fast_period']}_{cfg['slow_period']}.cross_up", side="long")
        buy()
    elif crossed_down and cfg["allow_short"] and current_side != "SELL":
        _observe(f"ema.{cfg['fast_period']}_{cfg['slow_period']}.cross_down", side="short")
        sell()
    else:
        hold()
