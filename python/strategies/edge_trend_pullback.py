# name: Edge Trend Pullback
# desc: EMA trend stack, ADX/DI strength and fast EMA reclaim with ATR risk
# author: NexusTrade
# version: 1.0

import builtins as _builtins
from indicators.bars import bar_number


LAST_SIGNAL_BAR = None
SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "fast": [],
    "mid": [],
    "slow": [],
    "atr": [],
    "adx": [],
    "plus_di": [],
    "minus_di": [],
    "tr": [],
    "plus_dm": [],
    "minus_dm": [],
}


def initialize():
    return {
        "fast_ema": 13,
        "mid_ema": 55,
        "slow_ema": 200,
        "adx_period": 14,
        "adx_min": 24.0,
        "atr_period": 14,
        "stop_atr": 1.0,
        "reward_risk": 1.5,
        "pullback": True,
        "allow_short": True,
        "cooldown_bars": 1,
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
    cfg["fast_ema"] = max(2, _to_int(cfg.get("fast_ema"), 13))
    cfg["mid_ema"] = max(cfg["fast_ema"] + 1, _to_int(cfg.get("mid_ema"), 55))
    cfg["slow_ema"] = max(cfg["mid_ema"] + 1, _to_int(cfg.get("slow_ema"), 200))
    cfg["adx_period"] = max(2, _to_int(cfg.get("adx_period"), 14))
    cfg["adx_min"] = max(0.0, _to_float(cfg.get("adx_min"), 24.0))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 1.0))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.5))
    cfg["pullback"] = _to_bool(cfg.get("pullback"), True)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 1))
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


def _series_signature(cfg):
    return (
        cfg["fast_ema"],
        cfg["mid_ema"],
        cfg["slow_ema"],
        cfg["adx_period"],
        cfg["atr_period"],
    )


def _reset(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in ("fast", "mid", "slow", "atr", "adx", "plus_di", "minus_di", "tr", "plus_dm", "minus_dm"):
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

    fast = SERIES_CACHE["fast"]
    mid = SERIES_CACHE["mid"]
    slow = SERIES_CACHE["slow"]
    atr_values = SERIES_CACHE["atr"]
    adx_values = SERIES_CACHE["adx"]
    plus_di = SERIES_CACHE["plus_di"]
    minus_di = SERIES_CACHE["minus_di"]
    tr_values = SERIES_CACHE["tr"]
    plus_dm_values = SERIES_CACHE["plus_dm"]
    minus_dm_values = SERIES_CACHE["minus_dm"]

    for i in range(count, len(candles)):
        close = float(candles[i]["c"])
        if i == 0 or not fast:
            fast.append(close)
            mid.append(close)
            slow.append(close)
            atr_values.append(0.0)
            adx_values.append(0.0)
            plus_di.append(0.0)
            minus_di.append(0.0)
            tr_values.append(0.0)
            plus_dm_values.append(0.0)
            minus_dm_values.append(0.0)
            continue

        high = float(candles[i]["h"])
        low = float(candles[i]["l"])
        prev_high = float(candles[i - 1]["h"])
        prev_low = float(candles[i - 1]["l"])
        prev_close = float(candles[i - 1]["c"])

        fast.append(_ema_next(fast[-1], close, cfg["fast_ema"]))
        mid.append(_ema_next(mid[-1], close, cfg["mid_ema"]))
        slow.append(_ema_next(slow[-1], close, cfg["slow_ema"]))

        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        up_move = high - prev_high
        down_move = prev_low - low
        plus_dm = up_move if up_move > down_move and up_move > 0 else 0.0
        minus_dm = down_move if down_move > up_move and down_move > 0 else 0.0

        tr_values.append(_ema_next(tr_values[-1], tr, cfg["adx_period"]))
        plus_dm_values.append(_ema_next(plus_dm_values[-1], plus_dm, cfg["adx_period"]))
        minus_dm_values.append(_ema_next(minus_dm_values[-1], minus_dm, cfg["adx_period"]))
        atr_values.append(_ema_next(atr_values[-1], tr, cfg["atr_period"]))

        smooth_tr = tr_values[-1]
        plus = 0.0 if smooth_tr <= 0 else 100.0 * plus_dm_values[-1] / smooth_tr
        minus = 0.0 if smooth_tr <= 0 else 100.0 * minus_dm_values[-1] / smooth_tr
        denom = plus + minus
        dx = 0.0 if denom <= 0 else 100.0 * abs(plus - minus) / denom
        adx_values.append(_ema_next(adx_values[-1], dx, cfg["adx_period"]))
        plus_di.append(plus)
        minus_di.append(minus)

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return {
        "fast": fast,
        "mid": mid,
        "slow": slow,
        "atr": atr_values,
        "adx": adx_values,
        "plus_di": plus_di,
        "minus_di": minus_di,
    }


def _ready(candles, cfg):
    return len(candles) >= max(cfg["slow_ema"], cfg["adx_period"] * 3, cfg["atr_period"] * 3) + 5


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _risk(side, entry, atr_value, cfg):
    distance = max(float(atr_value) * cfg["stop_atr"], entry * 0.0012)
    if side == "BUY":
        return entry - distance, entry + distance * cfg["reward_risk"]
    return entry + distance, entry - distance * cfg["reward_risk"]


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
    return [
        {
            "type": "plot",
            "title": f"EMA {cfg['fast_ema']}",
            "points": [{"time": candles[start + i]["t"], "value": series["fast"][start + i]} for i in range(limit)],
            "color": "#22c55e",
            "linewidth": 1,
        },
        {
            "type": "plot",
            "title": f"EMA {cfg['mid_ema']}",
            "points": [{"time": candles[start + i]["t"], "value": series["mid"][start + i]} for i in range(limit)],
            "color": "#38bdf8",
            "linewidth": 1,
        },
        {
            "type": "plot",
            "title": f"EMA {cfg['slow_ema']}",
            "points": [{"time": candles[start + i]["t"], "value": series["slow"][start + i]} for i in range(limit)],
            "color": "#f59e0b",
            "linewidth": 1,
        },
    ]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    series = _cached_series(candles, cfg)
    bar = bar_number(candles)
    close = float(candles[-1]["c"])
    prev_close = float(candles[-2]["c"])
    fast = series["fast"]
    mid = series["mid"]
    slow = series["slow"]
    adx = series["adx"][-1]
    plus_di = series["plus_di"][-1]
    minus_di = series["minus_di"][-1]
    atr_value = series["atr"][-1]
    current_side = getattr(portfolio, "side", None)

    if LAST_SIGNAL_BAR is not None and bar - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    trend_up = fast[-1] > mid[-1] > slow[-1] and close > slow[-1] and adx >= cfg["adx_min"] and plus_di > minus_di
    trend_down = fast[-1] < mid[-1] < slow[-1] and close < slow[-1] and adx >= cfg["adx_min"] and minus_di > plus_di

    if cfg["pullback"]:
        long_signal = trend_up and prev_close <= fast[-2] and close > fast[-1]
        short_signal = trend_down and prev_close >= fast[-2] and close < fast[-1]
    else:
        long_signal = trend_up and close > fast[-1] and prev_close <= fast[-2]
        short_signal = trend_down and close < fast[-1] and prev_close >= fast[-2]

    if long_signal and current_side != "BUY":
        sl, tp = _risk("BUY", close, atr_value, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        _observe("edge_trend_pullback.long", side="long", adx=round(adx, 2))
        buy()
        return

    if cfg["allow_short"] and short_signal and current_side != "SELL":
        sl, tp = _risk("SELL", close, atr_value, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        _observe("edge_trend_pullback.short", side="short", adx=round(adx, 2))
        sell()
        return

    hold()
