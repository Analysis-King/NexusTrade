# name: Mined High Winrate Short Breakdown
# desc: Edge miner taramasinda artida kalan en yuksek winrate kural: EMA20/50 dusus rejimi, 20 bar dip kirilimi ve RSI kalite filtresi
# author: NexusTrade
# version: 1.0

import builtins as _builtins


LAST_SIGNAL_BAR = None
SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "ema_fast": [],
    "ema_slow": [],
    "atr": [],
    "rsi": [],
    "avg_gain": [],
    "avg_loss": [],
}


def initialize():
    return {
        "fast_ema": 20,
        "slow_ema": 50,
        "breakout_period": 20,
        "rsi_period": 14,
        "short_rsi_min": 26.0,
        "short_rsi_max": 48.0,
        "atr_period": 14,
        "stop_atr": 0.8,
        "reward_risk": 1.2,
        "min_stop_pct": 0.12,
        "cooldown_bars": 2,
        "allow_long_mirror": False,
        "use_take_profit": True,
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
    cfg["fast_ema"] = max(2, _to_int(cfg.get("fast_ema"), 20))
    cfg["slow_ema"] = max(cfg["fast_ema"] + 1, _to_int(cfg.get("slow_ema"), 50))
    cfg["breakout_period"] = max(2, _to_int(cfg.get("breakout_period"), 20))
    cfg["rsi_period"] = max(2, _to_int(cfg.get("rsi_period"), 14))
    cfg["short_rsi_min"] = max(0.0, _to_float(cfg.get("short_rsi_min"), 26.0))
    cfg["short_rsi_max"] = min(100.0, _to_float(cfg.get("short_rsi_max"), 48.0))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 0.8))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.2))
    cfg["min_stop_pct"] = max(0.0, _to_float(cfg.get("min_stop_pct"), 0.12))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 2))
    cfg["allow_long_mirror"] = _to_bool(cfg.get("allow_long_mirror"), False)
    cfg["use_take_profit"] = _to_bool(cfg.get("use_take_profit"), True)
    cfg["exit_on_opposite_signal"] = _to_bool(cfg.get("exit_on_opposite_signal"), True)
    return cfg


def _candles():
    try:
        return indicators.candles()
    except Exception:
        return []


def _ema_next(previous, value, period):
    alpha = 2.0 / (period + 1.0)
    return float(value) * alpha + float(previous) * (1.0 - alpha)


def _rma_next(previous, value, period):
    return (float(previous) * (period - 1.0) + float(value)) / period


def _series_signature(cfg):
    return (
        cfg["fast_ema"],
        cfg["slow_ema"],
        cfg["atr_period"],
        cfg["rsi_period"],
    )


def _reset(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in ("ema_fast", "ema_slow", "atr", "rsi", "avg_gain", "avg_loss"):
        SERIES_CACHE[key] = []


def _cached_series(candles, cfg):
    signature = _series_signature(cfg)
    if SERIES_CACHE["signature"] != signature:
        _reset(signature)

    count = SERIES_CACHE["count"]
    if count > 0:
        changed = len(candles) < count or candles[count - 1].get("t") != SERIES_CACHE["last_t"]
        if changed:
            _reset(signature)
            count = 0

    ema_fast = SERIES_CACHE["ema_fast"]
    ema_slow = SERIES_CACHE["ema_slow"]
    atr = SERIES_CACHE["atr"]
    rsi = SERIES_CACHE["rsi"]
    avg_gain = SERIES_CACHE["avg_gain"]
    avg_loss = SERIES_CACHE["avg_loss"]

    for i in range(count, len(candles)):
        close = float(candles[i]["c"])
        if i == 0 or not ema_fast:
            ema_fast.append(close)
            ema_slow.append(close)
            atr.append(0.0)
            rsi.append(50.0)
            avg_gain.append(0.0)
            avg_loss.append(0.0)
            continue

        prev_close = float(candles[i - 1]["c"])
        high = float(candles[i]["h"])
        low = float(candles[i]["l"])
        change = close - prev_close
        gain = max(0.0, change)
        loss = max(0.0, -change)
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))

        ema_fast.append(_ema_next(ema_fast[-1], close, cfg["fast_ema"]))
        ema_slow.append(_ema_next(ema_slow[-1], close, cfg["slow_ema"]))
        atr.append(_rma_next(atr[-1], tr, cfg["atr_period"]))
        avg_gain.append(_rma_next(avg_gain[-1], gain, cfg["rsi_period"]))
        avg_loss.append(_rma_next(avg_loss[-1], loss, cfg["rsi_period"]))

        if avg_loss[-1] <= 0:
            rsi.append(50.0)
        else:
            rs = avg_gain[-1] / avg_loss[-1]
            rsi.append(100.0 - 100.0 / (1.0 + rs))

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return {
        "ema_fast": ema_fast,
        "ema_slow": ema_slow,
        "atr": atr,
        "rsi": rsi,
    }


def _ready(candles, cfg):
    return len(candles) >= max(
        cfg["slow_ema"] + 2,
        cfg["breakout_period"] + 2,
        cfg["atr_period"] + 2,
        cfg["rsi_period"] + 2,
    )


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _risk(side, entry, atr_value, cfg):
    distance = max(float(atr_value) * cfg["stop_atr"], float(entry) * cfg["min_stop_pct"] / 100.0)
    if side == "BUY":
        return entry - distance, entry + distance * cfg["reward_risk"]
    return entry + distance, entry - distance * cfg["reward_risk"]


def _lowest(values, start, end):
    return min(values[start:end]) if end > start else values[start]


def _highest(values, start, end):
    return max(values[start:end]) if end > start else values[start]


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []

    saved = {key: SERIES_CACHE[key] for key in SERIES_CACHE}
    try:
        _reset(_series_signature(cfg))
        series = _cached_series(candles, cfg)
    finally:
        for key, value in saved.items():
            SERIES_CACHE[key] = value

    limit = min(500, len(candles))
    start = len(candles) - limit
    signals = []
    lows = [float(c["l"]) for c in candles]
    closes = [float(c["c"]) for c in candles]
    for i in range(max(start, cfg["slow_ema"], cfg["breakout_period"] + 1), len(candles)):
        prev_low = _lowest(lows, i - cfg["breakout_period"], i)
        trend_down = series["ema_fast"][i] < series["ema_slow"][i] and closes[i] < series["ema_fast"][i]
        rsi_ok = cfg["short_rsi_min"] < series["rsi"][i] < cfg["short_rsi_max"]
        if trend_down and closes[i] < prev_low and closes[i - 1] >= prev_low and rsi_ok:
            signals.append({
                "t": candles[i]["t"],
                "price": candles[i]["h"],
                "side": "sell",
                "label": "HW Short",
            })

    return [
        {
            "type": "plot",
            "title": f"EMA {cfg['fast_ema']}",
            "points": [{"time": candles[start + i]["t"], "value": series["ema_fast"][start + i]} for i in range(limit)],
            "color": "#38bdf8",
            "linewidth": 1,
        },
        {
            "type": "plot",
            "title": f"EMA {cfg['slow_ema']}",
            "points": [{"time": candles[start + i]["t"], "value": series["ema_slow"][start + i]} for i in range(limit)],
            "color": "#f59e0b",
            "linewidth": 1,
        },
        {"type": "signals", "signals": signals[-120:]},
    ]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    series = _cached_series(candles, cfg)
    idx = len(candles) - 1
    closes = [float(c["c"]) for c in candles]
    lows = [float(c["l"]) for c in candles]
    highs = [float(c["h"]) for c in candles]
    close = closes[-1]
    prev_close = closes[-2]
    current_side = getattr(portfolio, "side", None)

    if LAST_SIGNAL_BAR is not None and idx - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    previous_low = _lowest(lows, idx - cfg["breakout_period"], idx)
    previous_high = _highest(highs, idx - cfg["breakout_period"], idx)

    short_trend = series["ema_fast"][-1] < series["ema_slow"][-1] and close < series["ema_fast"][-1]
    short_break = close < previous_low and prev_close >= previous_low
    short_rsi_ok = cfg["short_rsi_min"] < series["rsi"][-1] < cfg["short_rsi_max"]
    short_signal = short_trend and short_break and short_rsi_ok

    if short_signal and current_side != "SELL":
        sl, tp = _risk("SELL", close, series["atr"][-1], cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe(
            "mined_high_winrate.short_breakdown",
            side="short",
            rsi=round(series["rsi"][-1], 2),
            previous_low=round(previous_low, 8),
        )
        sell()
        return

    if cfg["allow_long_mirror"]:
        long_trend = series["ema_fast"][-1] > series["ema_slow"][-1] and close > series["ema_fast"][-1]
        long_break = close > previous_high and prev_close <= previous_high
        long_rsi_ok = (100.0 - cfg["short_rsi_max"]) < series["rsi"][-1] < (100.0 - cfg["short_rsi_min"])
        if long_trend and long_break and long_rsi_ok and current_side != "BUY":
            sl, tp = _risk("BUY", close, series["atr"][-1], cfg)
            set_sl(price=sl)
            if cfg["use_take_profit"]:
                set_tp(price=tp)
            LAST_SIGNAL_BAR = idx
            _observe("mined_high_winrate.long_mirror", side="long", rsi=round(series["rsi"][-1], 2))
            buy()
            return

    hold()
