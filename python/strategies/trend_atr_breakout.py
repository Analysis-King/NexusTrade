# name: Trend ATR Breakout
# desc: EMA trend filtresi, Donchian kirilimi ve ATR tabanli risk kullanan evrensel trend stratejisi
# author: NexusTrade
# version: 1.0

import builtins as _builtins

LAST_SIGNAL_BAR = None
SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "fast": [],
    "mid": [],
    "slow": [],
    "atr": [],
}


def initialize():
    return {
        "fast_ema": 21,
        "mid_ema": 55,
        "slow_ema": 144,
        "atr_period": 14,
        "breakout_period": 20,
        "slope_period": 12,
        "min_slope_pct": 0.03,
        "min_atr_pct": 0.08,
        "max_atr_pct": 3.0,
        "stop_atr": 1.4,
        "reward_risk": 1.8,
        "use_take_profit": False,
        "cooldown_bars": 8,
        "allow_short": True,
        "exit_on_opposite_signal": True,
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
        return value.strip().lower() in ("1", "true", "yes", "evet", "acik", "on")
    if value is None:
        return fallback
    return bool(value)


def _config(config):
    cfg = initialize()
    if isinstance(config, dict):
        cfg.update(config)

    cfg["fast_ema"] = max(2, _to_int(cfg.get("fast_ema"), 21))
    cfg["mid_ema"] = max(cfg["fast_ema"] + 1, _to_int(cfg.get("mid_ema"), 55))
    cfg["slow_ema"] = max(cfg["mid_ema"] + 1, _to_int(cfg.get("slow_ema"), 144))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["breakout_period"] = max(2, _to_int(cfg.get("breakout_period"), 20))
    cfg["slope_period"] = max(2, _to_int(cfg.get("slope_period"), 12))
    cfg["min_slope_pct"] = max(0.0, _to_float(cfg.get("min_slope_pct"), 0.03))
    cfg["min_atr_pct"] = max(0.0, _to_float(cfg.get("min_atr_pct"), 0.08))
    cfg["max_atr_pct"] = max(cfg["min_atr_pct"], _to_float(cfg.get("max_atr_pct"), 3.0))
    cfg["stop_atr"] = max(0.2, _to_float(cfg.get("stop_atr"), 1.4))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.8))
    cfg["use_take_profit"] = _to_bool(cfg.get("use_take_profit"), False)
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 8))
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    return cfg


def _candles():
    try:
        return indicators.candles()
    except Exception:
        return []


def _ema(values, period):
    if not values:
        return []
    alpha = 2.0 / (period + 1.0)
    out = [float(values[0])]
    for value in values[1:]:
        out.append(float(value) * alpha + out[-1] * (1.0 - alpha))
    return out


def _ema_next(previous, value, period):
    alpha = 2.0 / (period + 1.0)
    return float(value) * alpha + float(previous) * (1.0 - alpha)


def _atr(candles, period):
    if len(candles) < 2:
        return []
    trs = [0.0]
    for i in range(1, len(candles)):
        high = float(candles[i]["h"])
        low = float(candles[i]["l"])
        prev_close = float(candles[i - 1]["c"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return _ema(trs, period)


def _series_signature(cfg):
    return (cfg["fast_ema"], cfg["mid_ema"], cfg["slow_ema"], cfg["atr_period"])


def _reset_series_cache(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    SERIES_CACHE["fast"] = []
    SERIES_CACHE["mid"] = []
    SERIES_CACHE["slow"] = []
    SERIES_CACHE["atr"] = []


def _cached_series(candles, cfg):
    signature = _series_signature(cfg)
    if SERIES_CACHE["signature"] != signature:
        _reset_series_cache(signature)

    count = SERIES_CACHE["count"]
    if count > 0:
        changed_stream = (
            len(candles) < count or
            count > len(candles) or
            candles[count - 1].get("t") != SERIES_CACHE["last_t"]
        )
        if changed_stream:
            _reset_series_cache(signature)
            count = 0

    fast = SERIES_CACHE["fast"]
    mid = SERIES_CACHE["mid"]
    slow = SERIES_CACHE["slow"]
    atr = SERIES_CACHE["atr"]

    for i in range(count, len(candles)):
        close = float(candles[i]["c"])
        if i == 0 or not fast:
            fast.append(close)
            mid.append(close)
            slow.append(close)
            atr.append(0.0)
            continue

        fast.append(_ema_next(fast[-1], close, cfg["fast_ema"]))
        mid.append(_ema_next(mid[-1], close, cfg["mid_ema"]))
        slow.append(_ema_next(slow[-1], close, cfg["slow_ema"]))

        high = float(candles[i]["h"])
        low = float(candles[i]["l"])
        prev_close = float(candles[i - 1]["c"])
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        atr.append(_ema_next(atr[-1], tr, cfg["atr_period"]))

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return fast, mid, slow, atr


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _risk_levels(side, entry, atr_value, cfg):
    stop_distance = atr_value * cfg["stop_atr"]
    target_distance = stop_distance * cfg["reward_risk"]
    if side == "BUY":
        return entry - stop_distance, entry + target_distance
    return entry + stop_distance, entry - target_distance


def _series_ready(candles, cfg):
    return len(candles) >= max(
        cfg["slow_ema"] + cfg["slope_period"] + 2,
        cfg["atr_period"] + 2,
        cfg["breakout_period"] + 2,
    )


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _series_ready(candles, cfg):
        return []
    closes = [float(c["c"]) for c in candles]
    fast = _ema(closes, cfg["fast_ema"])
    mid = _ema(closes, cfg["mid_ema"])
    slow = _ema(closes, cfg["slow_ema"])
    return [
        {"type": "plot", "title": f"EMA {cfg['fast_ema']}", "points": fast[-300:], "color": "#22c55e", "linewidth": 1},
        {"type": "plot", "title": f"EMA {cfg['mid_ema']}", "points": mid[-300:], "color": "#38bdf8", "linewidth": 1},
        {"type": "plot", "title": f"EMA {cfg['slow_ema']}", "points": slow[-300:], "color": "#f59e0b", "linewidth": 1},
    ]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _series_ready(candles, cfg):
        hold()
        return

    idx = len(candles) - 1
    closes = [float(c["c"]) for c in candles]
    highs = [float(c["h"]) for c in candles]
    lows = [float(c["l"]) for c in candles]
    close = closes[-1]

    fast, mid, slow, atr_values = _cached_series(candles, cfg)
    atr_value = atr_values[-1]
    if close <= 0 or atr_value <= 0:
        hold()
        return

    atr_pct = atr_value / close * 100.0
    if atr_pct < cfg["min_atr_pct"] or atr_pct > cfg["max_atr_pct"]:
        hold()
        return

    slope_base = slow[-1 - cfg["slope_period"]]
    if slope_base == 0:
        hold()
        return
    slope_pct = (slow[-1] - slope_base) / slope_base * 100.0

    previous_high = max(highs[-cfg["breakout_period"] - 1:-1])
    previous_low = min(lows[-cfg["breakout_period"] - 1:-1])
    trend_up = fast[-1] > mid[-1] > slow[-1] and close > slow[-1] and slope_pct >= cfg["min_slope_pct"]
    trend_down = fast[-1] < mid[-1] < slow[-1] and close < slow[-1] and slope_pct <= -cfg["min_slope_pct"]
    breakout_up = close > previous_high and closes[-2] <= previous_high
    breakout_down = close < previous_low and closes[-2] >= previous_low
    reclaim_up = closes[-2] <= fast[-2] and close > fast[-1]
    reclaim_down = closes[-2] >= fast[-2] and close < fast[-1]

    current_side = getattr(portfolio, "side", None)
    if LAST_SIGNAL_BAR is not None and idx - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    if trend_up and (breakout_up or reclaim_up) and current_side != "BUY":
        sl, tp = _risk_levels("BUY", close, atr_value, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe("trend_atr_breakout.long", side="long", atr_pct=round(atr_pct, 4), slope_pct=round(slope_pct, 4))
        buy()
        return

    if cfg["allow_short"] and trend_down and (breakout_down or reclaim_down) and current_side != "SELL":
        sl, tp = _risk_levels("SELL", close, atr_value, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe("trend_atr_breakout.short", side="short", atr_pct=round(atr_pct, 4), slope_pct=round(slope_pct, 4))
        sell()
        return

    hold()
