# name: Daily Momentum Breakout
# desc: Gun ici hareket baslarken EMA trendi, ROC, RSI, hacim ve ATR filtreleriyle devam eden kirilimi yakalamayi dener
# author: NexusTrade
# version: 1.0

import builtins as _builtins
from indicators.bars import bar_number


DAY_MS = 86_400_000
TR_OFFSET_MS = 3 * 60 * 60 * 1000

LAST_SIGNAL_BAR = None
LAST_ENTRY_BAR = None
ENTRY_PRICE = None
HIGHEST_CLOSE = None
LOWEST_CLOSE = None

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
    "volume_sma": [],
    "macd_fast": [],
    "macd_slow": [],
    "macd_signal": [],
    "macd_hist": [],
    "donchian_high": [],
    "donchian_low": [],
    "roc": [],
}


def initialize():
    return {
        "fast_ema": 21,
        "slow_ema": 89,
        "atr_period": 14,
        "rsi_period": 14,
        "volume_period": 20,
        "breakout_period": 24,
        "roc_period": 6,
        "min_day_gain_pct": 0.6,
        "max_day_gain_pct": 2.8,
        "min_day_drop_pct": 0.6,
        "max_day_drop_pct": 2.8,
        "min_roc_pct": 0.18,
        "min_volume_ratio": 1.0,
        "min_rsi": 50.0,
        "max_rsi": 78.0,
        "short_max_rsi": 50.0,
        "short_min_rsi": 22.0,
        "min_atr_pct": 0.08,
        "max_atr_pct": 3.0,
        "require_breakout": True,
        "require_macd": True,
        "allow_short": False,
        "stop_atr": 1.0,
        "min_stop_pct": 0.22,
        "max_stop_pct": 1.2,
        "reward_risk": 1.8,
        "trailing_stop": True,
        "trail_atr": 1.3,
        "cooldown_bars": 8,
        "min_hold_bars": 2,
        "max_hold_bars": 96,
        "exit_on_momentum_loss": True,
    }


def _to_float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _to_int(value, fallback=0):
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
    cfg["slow_ema"] = max(cfg["fast_ema"] + 1, _to_int(cfg.get("slow_ema"), 89))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["rsi_period"] = max(2, _to_int(cfg.get("rsi_period"), 14))
    cfg["volume_period"] = max(2, _to_int(cfg.get("volume_period"), 20))
    cfg["breakout_period"] = max(2, _to_int(cfg.get("breakout_period"), 24))
    cfg["roc_period"] = max(1, _to_int(cfg.get("roc_period"), 6))
    cfg["min_day_gain_pct"] = max(0.0, _to_float(cfg.get("min_day_gain_pct"), 0.6))
    cfg["max_day_gain_pct"] = max(cfg["min_day_gain_pct"], _to_float(cfg.get("max_day_gain_pct"), 2.8))
    cfg["min_day_drop_pct"] = max(0.0, _to_float(cfg.get("min_day_drop_pct"), 0.6))
    cfg["max_day_drop_pct"] = max(cfg["min_day_drop_pct"], _to_float(cfg.get("max_day_drop_pct"), 2.8))
    cfg["min_roc_pct"] = _to_float(cfg.get("min_roc_pct"), 0.18)
    cfg["min_volume_ratio"] = max(0.0, _to_float(cfg.get("min_volume_ratio"), 1.0))
    cfg["min_rsi"] = _to_float(cfg.get("min_rsi"), 50.0)
    cfg["max_rsi"] = _to_float(cfg.get("max_rsi"), 78.0)
    cfg["short_max_rsi"] = _to_float(cfg.get("short_max_rsi"), 50.0)
    cfg["short_min_rsi"] = _to_float(cfg.get("short_min_rsi"), 22.0)
    cfg["min_atr_pct"] = max(0.0, _to_float(cfg.get("min_atr_pct"), 0.08))
    cfg["max_atr_pct"] = max(cfg["min_atr_pct"], _to_float(cfg.get("max_atr_pct"), 3.0))
    cfg["require_breakout"] = _to_bool(cfg.get("require_breakout"), True)
    cfg["require_macd"] = _to_bool(cfg.get("require_macd"), True)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), False)
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 1.0))
    cfg["min_stop_pct"] = max(0.02, _to_float(cfg.get("min_stop_pct"), 0.22))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _to_float(cfg.get("max_stop_pct"), 1.2))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.8))
    cfg["trailing_stop"] = _to_bool(cfg.get("trailing_stop"), True)
    cfg["trail_atr"] = max(0.1, _to_float(cfg.get("trail_atr"), 1.3))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 8))
    cfg["min_hold_bars"] = max(0, _to_int(cfg.get("min_hold_bars"), 2))
    cfg["max_hold_bars"] = max(1, _to_int(cfg.get("max_hold_bars"), 96))
    cfg["exit_on_momentum_loss"] = _to_bool(cfg.get("exit_on_momentum_loss"), True)
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
    return (float(previous) * (period - 1) + float(value)) / period


def _local_day(timestamp):
    return int((int(timestamp) + TR_OFFSET_MS) // DAY_MS)


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _set_meta(**meta):
    fn = getattr(_builtins, "set_meta", None)
    if callable(fn):
        fn(**meta)


def _series_signature(cfg):
    return (
        cfg["fast_ema"],
        cfg["slow_ema"],
        cfg["atr_period"],
        cfg["rsi_period"],
        cfg["volume_period"],
        cfg["breakout_period"],
        cfg["roc_period"],
    )


def _reset_cache(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in (
        "ema_fast", "ema_slow", "atr", "rsi", "avg_gain", "avg_loss", "volume_sma",
        "macd_fast", "macd_slow", "macd_signal", "macd_hist", "donchian_high",
        "donchian_low", "roc",
    ):
        SERIES_CACHE[key] = []


def _cached_series(candles, cfg):
    signature = _series_signature(cfg)
    if SERIES_CACHE["signature"] != signature:
        _reset_cache(signature)

    count = SERIES_CACHE["count"]
    if count > 0:
        changed_stream = (
            len(candles) < count or
            count > len(candles) or
            candles[count - 1].get("t") != SERIES_CACHE["last_t"]
        )
        if changed_stream:
            _reset_cache(signature)
            count = 0

    for i in range(count, len(candles)):
        candle = candles[i]
        close_price = float(candle["c"])
        volume = float(candle["v"])

        if i == 0:
            SERIES_CACHE["ema_fast"].append(close_price)
            SERIES_CACHE["ema_slow"].append(close_price)
            SERIES_CACHE["atr"].append(0.0)
            SERIES_CACHE["rsi"].append(50.0)
            SERIES_CACHE["avg_gain"].append(0.0)
            SERIES_CACHE["avg_loss"].append(0.0)
            SERIES_CACHE["volume_sma"].append(volume)
            SERIES_CACHE["macd_fast"].append(close_price)
            SERIES_CACHE["macd_slow"].append(close_price)
            SERIES_CACHE["macd_signal"].append(0.0)
            SERIES_CACHE["macd_hist"].append(0.0)
            SERIES_CACHE["donchian_high"].append(float(candle["h"]))
            SERIES_CACHE["donchian_low"].append(float(candle["l"]))
            SERIES_CACHE["roc"].append(0.0)
            continue

        prev_close = float(candles[i - 1]["c"])
        high = float(candle["h"])
        low = float(candle["l"])
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))

        SERIES_CACHE["ema_fast"].append(_ema_next(SERIES_CACHE["ema_fast"][-1], close_price, cfg["fast_ema"]))
        SERIES_CACHE["ema_slow"].append(_ema_next(SERIES_CACHE["ema_slow"][-1], close_price, cfg["slow_ema"]))
        SERIES_CACHE["atr"].append(_rma_next(SERIES_CACHE["atr"][-1], tr, cfg["atr_period"]))

        change = close_price - prev_close
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        avg_gain = _rma_next(SERIES_CACHE["avg_gain"][-1], gain, cfg["rsi_period"])
        avg_loss = _rma_next(SERIES_CACHE["avg_loss"][-1], loss, cfg["rsi_period"])
        SERIES_CACHE["avg_gain"].append(avg_gain)
        SERIES_CACHE["avg_loss"].append(avg_loss)
        if avg_loss == 0:
            SERIES_CACHE["rsi"].append(100.0 if avg_gain > 0 else 50.0)
        else:
            rs = avg_gain / avg_loss
            SERIES_CACHE["rsi"].append(100.0 - 100.0 / (1.0 + rs))

        volume_window = candles[max(0, i - cfg["volume_period"] + 1):i + 1]
        SERIES_CACHE["volume_sma"].append(sum(float(row["v"]) for row in volume_window) / len(volume_window))

        macd_fast = _ema_next(SERIES_CACHE["macd_fast"][-1], close_price, 12)
        macd_slow = _ema_next(SERIES_CACHE["macd_slow"][-1], close_price, 26)
        macd_line = macd_fast - macd_slow
        macd_signal = _ema_next(SERIES_CACHE["macd_signal"][-1], macd_line, 9)
        SERIES_CACHE["macd_fast"].append(macd_fast)
        SERIES_CACHE["macd_slow"].append(macd_slow)
        SERIES_CACHE["macd_signal"].append(macd_signal)
        SERIES_CACHE["macd_hist"].append(macd_line - macd_signal)

        lookback = candles[max(0, i - cfg["breakout_period"]):i]
        if lookback:
            SERIES_CACHE["donchian_high"].append(max(float(row["h"]) for row in lookback))
            SERIES_CACHE["donchian_low"].append(min(float(row["l"]) for row in lookback))
        else:
            SERIES_CACHE["donchian_high"].append(high)
            SERIES_CACHE["donchian_low"].append(low)

        if i >= cfg["roc_period"]:
            base = float(candles[i - cfg["roc_period"]]["c"])
            SERIES_CACHE["roc"].append((close_price / base - 1.0) * 100.0 if base else 0.0)
        else:
            SERIES_CACHE["roc"].append(0.0)

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return SERIES_CACHE


def _day_context(candles, index):
    day = _local_day(candles[index]["t"])
    start = index
    while start > 0 and _local_day(candles[start - 1]["t"]) == day:
        start -= 1
    window = candles[start:index + 1]
    day_low = min(float(row["l"]) for row in window)
    day_high = max(float(row["h"]) for row in window)
    day_open = float(window[0]["o"])
    close_price = float(candles[index]["c"])
    day_gain = (close_price / day_low - 1.0) * 100.0 if day_low else 0.0
    day_drop = (day_high / close_price - 1.0) * 100.0 if close_price else 0.0
    return day_open, day_high, day_low, day_gain, day_drop


def _risk_levels(side, entry, atr_value, cfg):
    atr_pct = atr_value / entry * 100.0 if entry else cfg["min_stop_pct"]
    stop_pct = max(cfg["min_stop_pct"], min(cfg["max_stop_pct"], atr_pct * cfg["stop_atr"]))
    distance = entry * stop_pct / 100.0
    target_distance = distance * cfg["reward_risk"]
    if side == "BUY":
        return entry - distance, entry + target_distance, stop_pct
    return entry + distance, entry - target_distance, stop_pct


def _ready(candles, cfg):
    return len(candles) >= max(
        cfg["slow_ema"] + 2,
        cfg["atr_period"] + 2,
        cfg["rsi_period"] + 2,
        cfg["breakout_period"] + 2,
        cfg["roc_period"] + 2,
    )


def _manage_position(bar, close_price, atr_value, series, cfg, portfolio):
    global LAST_ENTRY_BAR, ENTRY_PRICE, HIGHEST_CLOSE, LOWEST_CLOSE

    side = getattr(portfolio, "side", None)
    if side not in ("BUY", "SELL"):
        ENTRY_PRICE = None
        HIGHEST_CLOSE = None
        LOWEST_CLOSE = None
        return False

    if ENTRY_PRICE is None:
        ENTRY_PRICE = close_price
    HIGHEST_CLOSE = close_price if HIGHEST_CLOSE is None else max(HIGHEST_CLOSE, close_price)
    LOWEST_CLOSE = close_price if LOWEST_CLOSE is None else min(LOWEST_CLOSE, close_price)

    bars_held = bar - LAST_ENTRY_BAR if LAST_ENTRY_BAR is not None else 0
    if cfg["trailing_stop"] and atr_value > 0:
        if side == "BUY":
            trail = HIGHEST_CLOSE - atr_value * cfg["trail_atr"]
            set_sl(price=trail)
        else:
            trail = LOWEST_CLOSE + atr_value * cfg["trail_atr"]
            set_sl(price=trail)

    if bars_held >= cfg["max_hold_bars"]:
        close()
        return True

    if cfg["exit_on_momentum_loss"] and bars_held >= cfg["min_hold_bars"]:
        ema_fast = series["ema_fast"][-1]
        macd_hist = series["macd_hist"][-1]
        if side == "BUY" and (close_price < ema_fast or macd_hist < 0):
            close()
            return True
        if side == "SELL" and (close_price > ema_fast or macd_hist > 0):
            close()
            return True

    return False


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR, LAST_ENTRY_BAR, ENTRY_PRICE, HIGHEST_CLOSE, LOWEST_CLOSE

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    idx = len(candles) - 1
    bar = bar_number(candles)
    close_price = float(candles[-1]["c"])
    volume = float(candles[-1]["v"])
    series = _cached_series(candles, cfg)

    atr_value = series["atr"][-1]
    atr_pct = atr_value / close_price * 100.0 if close_price else 0.0
    volume_sma = series["volume_sma"][-1]
    volume_ratio = volume / volume_sma if volume_sma else 0.0
    rsi = series["rsi"][-1]
    roc = series["roc"][-1]
    macd_hist = series["macd_hist"][-1]
    macd_rising = len(series["macd_hist"]) > 2 and macd_hist > series["macd_hist"][-2]
    ema_fast = series["ema_fast"][-1]
    ema_slow = series["ema_slow"][-1]
    day_open, day_high, day_low, day_gain, day_drop = _day_context(candles, idx)

    if getattr(portfolio, "has_position", False):
        if _manage_position(bar, close_price, atr_value, series, cfg, portfolio):
            return
        hold()
        return

    ENTRY_PRICE = None
    HIGHEST_CLOSE = None
    LOWEST_CLOSE = None

    if LAST_SIGNAL_BAR is not None and bar - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    if atr_pct < cfg["min_atr_pct"] or atr_pct > cfg["max_atr_pct"]:
        hold()
        return
    if volume_ratio < cfg["min_volume_ratio"]:
        hold()
        return

    breakout_up = close_price > series["donchian_high"][-1]
    breakout_down = close_price < series["donchian_low"][-1]
    trend_up = close_price > ema_fast > ema_slow
    trend_down = close_price < ema_fast < ema_slow
    macd_long = (macd_hist > 0 and macd_rising) if cfg["require_macd"] else True
    macd_short = (macd_hist < 0 and not macd_rising) if cfg["require_macd"] else True
    breakout_long = breakout_up if cfg["require_breakout"] else close_price > day_open
    breakout_short = breakout_down if cfg["require_breakout"] else close_price < day_open

    long_ok = (
        cfg["min_day_gain_pct"] <= day_gain <= cfg["max_day_gain_pct"] and
        roc >= cfg["min_roc_pct"] and
        cfg["min_rsi"] <= rsi <= cfg["max_rsi"] and
        trend_up and
        breakout_long and
        macd_long
    )
    if long_ok:
        sl, tp, stop_pct = _risk_levels("BUY", close_price, atr_value, cfg)
        set_sl(price=sl)
        set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        LAST_ENTRY_BAR = bar
        ENTRY_PRICE = close_price
        HIGHEST_CLOSE = close_price
        LOWEST_CLOSE = close_price
        _set_meta(last_signal="BUY", day_gain=round(day_gain, 3), rsi=round(rsi, 2), roc=round(roc, 3))
        _observe(
            "daily_momentum.long",
            side="long",
            day_gain=round(day_gain, 3),
            volume_ratio=round(volume_ratio, 3),
            atr_pct=round(atr_pct, 3),
            rsi=round(rsi, 2),
            roc=round(roc, 3),
            stop_pct=round(stop_pct, 3),
        )
        buy()
        return

    short_ok = (
        cfg["allow_short"] and
        cfg["min_day_drop_pct"] <= day_drop <= cfg["max_day_drop_pct"] and
        roc <= -abs(cfg["min_roc_pct"]) and
        cfg["short_min_rsi"] <= rsi <= cfg["short_max_rsi"] and
        trend_down and
        breakout_short and
        macd_short
    )
    if short_ok:
        sl, tp, stop_pct = _risk_levels("SELL", close_price, atr_value, cfg)
        set_sl(price=sl)
        set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        LAST_ENTRY_BAR = bar
        ENTRY_PRICE = close_price
        HIGHEST_CLOSE = close_price
        LOWEST_CLOSE = close_price
        _set_meta(last_signal="SELL", day_drop=round(day_drop, 3), rsi=round(rsi, 2), roc=round(roc, 3))
        _observe(
            "daily_momentum.short",
            side="short",
            day_drop=round(day_drop, 3),
            volume_ratio=round(volume_ratio, 3),
            atr_pct=round(atr_pct, 3),
            rsi=round(rsi, 2),
            roc=round(roc, 3),
            stop_pct=round(stop_pct, 3),
        )
        sell()
        return

    _set_meta(last_signal="HOLD", day_gain=round(day_gain, 3), rsi=round(rsi, 2), roc=round(roc, 3))
    hold()


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not candles or not _ready(candles, cfg):
        return []
    series = _cached_series(candles, cfg)
    return [
        {
            "type": "plot",
            "title": f"EMA {cfg['fast_ema']}",
            "points": [{"time": candle["t"], "value": value} for candle, value in zip(candles[-300:], series["ema_fast"][-300:])],
            "color": "#22c55e",
            "linewidth": 1,
        },
        {
            "type": "plot",
            "title": f"EMA {cfg['slow_ema']}",
            "points": [{"time": candle["t"], "value": value} for candle, value in zip(candles[-300:], series["ema_slow"][-300:])],
            "color": "#f59e0b",
            "linewidth": 1,
        },
    ]
