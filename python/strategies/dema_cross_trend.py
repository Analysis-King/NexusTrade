# name: DEMA Cross Trend
# desc: Pine DEMA Cross karar cizgisiyle trend takip stratejisi
# author: NexusTrade
# version: 1.0

import builtins as _builtins
from indicators.bars import bar_number

LAST_SIGNAL_BAR = None
SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "ema_fast": [],
    "ema_fast_2": [],
    "ema_slow": [],
    "ema_slow_2": [],
    "dema_fast": [],
    "dema_slow": [],
    "decc": [],
    "atr": [],
}


def initialize():
    return {
        "slow_period": 30,
        "fast_period": 20,
        "entry_mode": "decc_cross",
        "confirm_dema_order": True,
        "allow_short": True,
        "use_take_profit": False,
        "risk_mode": "atr",
        "atr_period": 14,
        "stop_atr": 1.6,
        "reward_risk": 2.0,
        "stop_loss_pct": 1.2,
        "take_profit_pct": 2.4,
        "cooldown_bars": 3,
        "min_decc_distance_pct": 0.0,
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
    cfg["slow_period"] = max(2, _to_int(cfg.get("slow_period"), 30))
    cfg["fast_period"] = max(2, _to_int(cfg.get("fast_period"), 20))
    if cfg["fast_period"] == cfg["slow_period"]:
        cfg["fast_period"] = max(2, cfg["slow_period"] - 1)
    cfg["entry_mode"] = str(cfg.get("entry_mode") or "decc_cross").strip().lower()
    if cfg["entry_mode"] not in ("decc_cross", "dema_cross", "trend_state"):
        cfg["entry_mode"] = "decc_cross"
    cfg["confirm_dema_order"] = _to_bool(cfg.get("confirm_dema_order"), True)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["use_take_profit"] = _to_bool(cfg.get("use_take_profit"), False)
    cfg["risk_mode"] = str(cfg.get("risk_mode") or "atr").strip().lower()
    if cfg["risk_mode"] not in ("atr", "percent", "none"):
        cfg["risk_mode"] = "atr"
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 1.6))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 2.0))
    cfg["stop_loss_pct"] = max(0.0, _to_float(cfg.get("stop_loss_pct"), 1.2))
    cfg["take_profit_pct"] = max(0.0, _to_float(cfg.get("take_profit_pct"), 2.4))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 3))
    cfg["min_decc_distance_pct"] = max(0.0, _to_float(cfg.get("min_decc_distance_pct"), 0.0))
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


def _dema(values, period):
    ema1 = _ema(values, period)
    ema2 = _ema(ema1, period)
    return [(2.0 * a) - b for a, b in zip(ema1, ema2)]


def _atr(candles, period):
    if not candles:
        return []
    trs = [0.0]
    for idx in range(1, len(candles)):
        high = _to_float(candles[idx].get("h"))
        low = _to_float(candles[idx].get("l"))
        prev_close = _to_float(candles[idx - 1].get("c"))
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return _ema(trs, period)


def _decc_series(closes, cfg):
    slow = cfg["slow_period"]
    fast = cfg["fast_period"]
    fk = 2.0 / (slow + 1.0)
    fp = 2.0 / (fast + 1.0)
    denom = (2.0 - fp) * fp - (2.0 - fk) * fk
    if abs(denom) < 1e-12:
        return []

    ema_slow = _ema(closes, slow)
    ema_fast = _ema(closes, fast)
    dema_slow = _dema(closes, slow)
    dema_fast = _dema(closes, fast)
    return [
        ((1.0 - fp) * fp * ema_fast[i]
         - (1.0 - fk) * fk * ema_slow[i]
         + (1.0 - fk) * dema_slow[i]
         - (1.0 - fp) * dema_fast[i]) / denom
        for i in range(len(closes))
    ]


def _cache_signature(cfg):
    return (
        cfg["fast_period"],
        cfg["slow_period"],
        cfg["atr_period"],
    )


def _reset_cache(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in ("ema_fast", "ema_fast_2", "ema_slow", "ema_slow_2", "dema_fast", "dema_slow", "decc", "atr"):
        SERIES_CACHE[key] = []


def _cached_series(candles, cfg):
    signature = _cache_signature(cfg)
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

    fast_period = cfg["fast_period"]
    slow_period = cfg["slow_period"]
    fk = 2.0 / (slow_period + 1.0)
    fp = 2.0 / (fast_period + 1.0)
    denom = (2.0 - fp) * fp - (2.0 - fk) * fk

    for i in range(count, len(candles)):
        close = _to_float(candles[i].get("c"))
        if i == 0 or not SERIES_CACHE["ema_fast"]:
            ema_fast = close
            ema_slow = close
            ema_fast_2 = close
            ema_slow_2 = close
            atr_value = 0.0
        else:
            ema_fast = _ema_next(SERIES_CACHE["ema_fast"][-1], close, fast_period)
            ema_slow = _ema_next(SERIES_CACHE["ema_slow"][-1], close, slow_period)
            ema_fast_2 = _ema_next(SERIES_CACHE["ema_fast_2"][-1], ema_fast, fast_period)
            ema_slow_2 = _ema_next(SERIES_CACHE["ema_slow_2"][-1], ema_slow, slow_period)
            high = _to_float(candles[i].get("h"))
            low = _to_float(candles[i].get("l"))
            prev_close = _to_float(candles[i - 1].get("c"))
            tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
            atr_value = _ema_next(SERIES_CACHE["atr"][-1], tr, cfg["atr_period"])

        dema_fast = 2.0 * ema_fast - ema_fast_2
        dema_slow = 2.0 * ema_slow - ema_slow_2
        decc = None
        if abs(denom) >= 1e-12:
            decc = (
                (1.0 - fp) * fp * ema_fast
                - (1.0 - fk) * fk * ema_slow
                + (1.0 - fk) * dema_slow
                - (1.0 - fp) * dema_fast
            ) / denom

        SERIES_CACHE["ema_fast"].append(ema_fast)
        SERIES_CACHE["ema_fast_2"].append(ema_fast_2)
        SERIES_CACHE["ema_slow"].append(ema_slow)
        SERIES_CACHE["ema_slow_2"].append(ema_slow_2)
        SERIES_CACHE["dema_fast"].append(dema_fast)
        SERIES_CACHE["dema_slow"].append(dema_slow)
        SERIES_CACHE["decc"].append(decc)
        SERIES_CACHE["atr"].append(atr_value)

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return SERIES_CACHE["dema_fast"], SERIES_CACHE["dema_slow"], SERIES_CACHE["decc"], SERIES_CACHE["atr"]


def _ready(candles, cfg):
    return len(candles) >= max(cfg["slow_period"], cfg["fast_period"], cfg["atr_period"]) * 3


def _risk(side, entry, candles, cfg):
    if cfg["risk_mode"] == "none":
        return None, None
    if cfg["risk_mode"] == "percent":
        sl = entry * (1.0 - cfg["stop_loss_pct"] / 100.0) if side == "BUY" else entry * (1.0 + cfg["stop_loss_pct"] / 100.0)
        tp = entry * (1.0 + cfg["take_profit_pct"] / 100.0) if side == "BUY" else entry * (1.0 - cfg["take_profit_pct"] / 100.0)
        return sl, tp
    _, _, _, atr_values = _cached_series(candles, cfg)
    atr_value = atr_values[-1] if atr_values else 0.0
    if atr_value <= 0:
        return None, None
    stop_distance = atr_value * cfg["stop_atr"]
    target_distance = stop_distance * cfg["reward_risk"]
    if side == "BUY":
        return entry - stop_distance, entry + target_distance
    return entry + stop_distance, entry - target_distance


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _set_meta(**meta):
    fn = getattr(_builtins, "set_meta", None)
    if callable(fn):
        fn(**meta)


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []
    closes = [_to_float(c.get("c")) for c in candles]
    decc = _decc_series(closes, cfg)
    fast = _dema(closes, cfg["fast_period"])
    slow = _dema(closes, cfg["slow_period"])
    return [
        {"type": "plot", "title": "DEMA Cross", "points": decc[-400:], "color": "#2563eb", "linewidth": 1, "style": "line"},
        {"type": "plot", "title": f"DEMA {cfg['fast_period']}", "points": fast[-400:], "color": "#22c55e", "linewidth": 1, "style": "line"},
        {"type": "plot", "title": f"DEMA {cfg['slow_period']}", "points": slow[-400:], "color": "#f59e0b", "linewidth": 1, "style": "line"},
    ]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    bar = bar_number(candles)
    closes = [_to_float(c.get("c")) for c in candles]
    close = closes[-1]
    fast, slow, decc, _ = _cached_series(candles, cfg)
    if not decc or decc[-1] is None or close <= 0:
        hold()
        return

    if LAST_SIGNAL_BAR is not None and bar - LAST_SIGNAL_BAR <= cfg["cooldown_bars"]:
        hold()
        return

    distance_pct = abs(close - decc[-1]) / close * 100.0
    if distance_pct < cfg["min_decc_distance_pct"]:
        hold()
        return

    dema_up = fast[-1] > slow[-1]
    dema_down = fast[-1] < slow[-1]
    close_cross_up = closes[-2] <= decc[-2] and close > decc[-1]
    close_cross_down = closes[-2] >= decc[-2] and close < decc[-1]
    dema_cross_up = fast[-2] <= slow[-2] and fast[-1] > slow[-1]
    dema_cross_down = fast[-2] >= slow[-2] and fast[-1] < slow[-1]

    if cfg["entry_mode"] == "dema_cross":
        long_signal = dema_cross_up
        short_signal = dema_cross_down
    elif cfg["entry_mode"] == "trend_state":
        long_signal = close > decc[-1] and dema_up
        short_signal = close < decc[-1] and dema_down
    else:
        long_signal = close_cross_up
        short_signal = close_cross_down

    if cfg["confirm_dema_order"]:
        long_signal = long_signal and dema_up
        short_signal = short_signal and dema_down

    current_side = getattr(portfolio, "side", None)
    if long_signal and current_side != "BUY":
        sl, tp = _risk("BUY", close, candles, cfg)
        if sl is not None:
            set_sl(price=sl)
        if cfg["use_take_profit"] and tp is not None:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        _observe("dema_cross.long", side="long", decc=round(decc[-1], 8), distance_pct=round(distance_pct, 4))
        _set_meta(setup="dema_cross", direction="long", decc=round(decc[-1], 8), distance_pct=round(distance_pct, 4))
        buy()
        return

    if cfg["allow_short"] and short_signal and current_side != "SELL":
        sl, tp = _risk("SELL", close, candles, cfg)
        if sl is not None:
            set_sl(price=sl)
        if cfg["use_take_profit"] and tp is not None:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        _observe("dema_cross.short", side="short", decc=round(decc[-1], 8), distance_pct=round(distance_pct, 4))
        _set_meta(setup="dema_cross", direction="short", decc=round(decc[-1], 8), distance_pct=round(distance_pct, 4))
        sell()
        return

    hold()
