# name: Donchian Momentum
# desc: Donchian breakout, EMA regime, ADX/DI strength and volume confirmation
# author: NexusTrade
# version: 1.0

import builtins as _builtins
from indicators.bars import bar_number


LAST_SIGNAL_BAR = None
ENTRY_BAR = None
SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "ema": [],
    "atr": [],
    "adx": [],
    "plus_di": [],
    "minus_di": [],
    "smooth_tr": [],
    "smooth_plus": [],
    "smooth_minus": [],
    "volume_ma": [],
}


def initialize():
    return {
        "breakout_period": 34,
        "ema_period": 100,
        "ema_slope_lookback": 24,
        "min_ema_slope_pct": 0.0,
        "min_close_ema_distance_pct": 0.0,
        "adx_period": 14,
        "adx_min": 16.0,
        "min_di_spread": 0.0,
        "volume_period": 30,
        "min_volume_ratio": 1.1,
        "atr_period": 14,
        "min_atr_pct": 0.0,
        "max_atr_pct": 0.0,
        "min_breakout_atr": 0.0,
        "stop_atr": 1.15,
        "reward_risk": 2.4,
        "min_stop_pct": 0.12,
        "max_stop_pct": 4.0,
        "max_hold_bars": 72,
        "cooldown_bars": 1,
        "allow_long": True,
        "allow_short": True,
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
    cfg["breakout_period"] = max(2, _to_int(cfg.get("breakout_period"), 34))
    cfg["ema_period"] = max(2, _to_int(cfg.get("ema_period"), 100))
    cfg["ema_slope_lookback"] = max(1, _to_int(cfg.get("ema_slope_lookback"), 24))
    cfg["min_ema_slope_pct"] = max(0.0, _to_float(cfg.get("min_ema_slope_pct"), 0.0))
    cfg["min_close_ema_distance_pct"] = max(0.0, _to_float(cfg.get("min_close_ema_distance_pct"), 0.0))
    cfg["adx_period"] = max(2, _to_int(cfg.get("adx_period"), 14))
    cfg["adx_min"] = max(0.0, _to_float(cfg.get("adx_min"), 16.0))
    cfg["min_di_spread"] = max(0.0, _to_float(cfg.get("min_di_spread"), 0.0))
    cfg["volume_period"] = max(2, _to_int(cfg.get("volume_period"), 30))
    cfg["min_volume_ratio"] = max(0.0, _to_float(cfg.get("min_volume_ratio"), 1.1))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["min_atr_pct"] = max(0.0, _to_float(cfg.get("min_atr_pct"), 0.0))
    cfg["max_atr_pct"] = max(0.0, _to_float(cfg.get("max_atr_pct"), 0.0))
    cfg["min_breakout_atr"] = max(0.0, _to_float(cfg.get("min_breakout_atr"), 0.0))
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 1.15))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 2.4))
    cfg["min_stop_pct"] = max(0.01, _to_float(cfg.get("min_stop_pct"), 0.12))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _to_float(cfg.get("max_stop_pct"), 4.0))
    cfg["max_hold_bars"] = max(0, _to_int(cfg.get("max_hold_bars"), 72))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 1))
    cfg["allow_long"] = _to_bool(cfg.get("allow_long"), True)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["use_take_profit"] = _to_bool(cfg.get("use_take_profit"), True)
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


def _sma(values, period):
    out = []
    total = 0.0
    for index, value in enumerate(values):
        total += float(value)
        if index >= period:
            total -= float(values[index - period])
        out.append(total / min(period, index + 1))
    return out


def _atr(candles, period):
    tr = [0.0]
    for index in range(1, len(candles)):
        high = float(candles[index]["h"])
        low = float(candles[index]["l"])
        prev_close = float(candles[index - 1]["c"])
        tr.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return _ema(tr, period)


def _adx(candles, period):
    plus_dm = [0.0] * len(candles)
    minus_dm = [0.0] * len(candles)
    tr = [0.0] * len(candles)
    for index in range(1, len(candles)):
        high = float(candles[index]["h"])
        low = float(candles[index]["l"])
        prev_high = float(candles[index - 1]["h"])
        prev_low = float(candles[index - 1]["l"])
        prev_close = float(candles[index - 1]["c"])
        up = high - prev_high
        down = prev_low - low
        plus_dm[index] = up if up > down and up > 0 else 0.0
        minus_dm[index] = down if down > up and down > 0 else 0.0
        tr[index] = max(high - low, abs(high - prev_close), abs(low - prev_close))

    smooth_tr = _ema(tr, period)
    smooth_plus = _ema(plus_dm, period)
    smooth_minus = _ema(minus_dm, period)
    plus_di = []
    minus_di = []
    dx = []
    for index in range(len(candles)):
        if smooth_tr[index] <= 0:
            plus = 0.0
            minus = 0.0
        else:
            plus = 100.0 * smooth_plus[index] / smooth_tr[index]
            minus = 100.0 * smooth_minus[index] / smooth_tr[index]
        plus_di.append(plus)
        minus_di.append(minus)
        denom = plus + minus
        dx.append(0.0 if denom <= 0 else 100.0 * abs(plus - minus) / denom)
    return _ema(dx, period), plus_di, minus_di


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _series_signature(cfg):
    return (cfg["ema_period"], cfg["adx_period"], cfg["atr_period"], cfg["volume_period"])


def _reset_series(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in ("ema", "atr", "adx", "plus_di", "minus_di", "smooth_tr", "smooth_plus", "smooth_minus", "volume_ma"):
        SERIES_CACHE[key] = []


def _cached_series(candles, cfg):
    signature = _series_signature(cfg)
    if SERIES_CACHE["signature"] != signature:
        _reset_series(signature)

    count = SERIES_CACHE["count"]
    if count > 0 and (
        len(candles) < count
        or candles[count - 1].get("t") != SERIES_CACHE["last_t"]
    ):
        _reset_series(signature)
        count = 0

    for index in range(count, len(candles)):
        close_price = float(candles[index]["c"])
        volume = float(candles[index].get("v", 0.0))
        if index == 0 or not SERIES_CACHE["ema"]:
            SERIES_CACHE["ema"].append(close_price)
            SERIES_CACHE["atr"].append(0.0)
            SERIES_CACHE["adx"].append(0.0)
            SERIES_CACHE["plus_di"].append(0.0)
            SERIES_CACHE["minus_di"].append(0.0)
            SERIES_CACHE["smooth_tr"].append(0.0)
            SERIES_CACHE["smooth_plus"].append(0.0)
            SERIES_CACHE["smooth_minus"].append(0.0)
            SERIES_CACHE["volume_ma"].append(volume)
            continue

        high = float(candles[index]["h"])
        low = float(candles[index]["l"])
        prev_high = float(candles[index - 1]["h"])
        prev_low = float(candles[index - 1]["l"])
        prev_close = float(candles[index - 1]["c"])
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        up = high - prev_high
        down = prev_low - low
        plus_dm = up if up > down and up > 0 else 0.0
        minus_dm = down if down > up and down > 0 else 0.0

        SERIES_CACHE["ema"].append(_ema_next(SERIES_CACHE["ema"][-1], close_price, cfg["ema_period"]))
        SERIES_CACHE["atr"].append(_ema_next(SERIES_CACHE["atr"][-1], tr, cfg["atr_period"]))
        SERIES_CACHE["smooth_tr"].append(_ema_next(SERIES_CACHE["smooth_tr"][-1], tr, cfg["adx_period"]))
        SERIES_CACHE["smooth_plus"].append(_ema_next(SERIES_CACHE["smooth_plus"][-1], plus_dm, cfg["adx_period"]))
        SERIES_CACHE["smooth_minus"].append(_ema_next(SERIES_CACHE["smooth_minus"][-1], minus_dm, cfg["adx_period"]))

        smooth_tr = SERIES_CACHE["smooth_tr"][-1]
        plus = 0.0 if smooth_tr <= 0 else 100.0 * SERIES_CACHE["smooth_plus"][-1] / smooth_tr
        minus = 0.0 if smooth_tr <= 0 else 100.0 * SERIES_CACHE["smooth_minus"][-1] / smooth_tr
        denom = plus + minus
        dx = 0.0 if denom <= 0 else 100.0 * abs(plus - minus) / denom
        SERIES_CACHE["plus_di"].append(plus)
        SERIES_CACHE["minus_di"].append(minus)
        SERIES_CACHE["adx"].append(_ema_next(SERIES_CACHE["adx"][-1], dx, cfg["adx_period"]))

        start = max(0, index - cfg["volume_period"] + 1)
        window = candles[start:index + 1]
        SERIES_CACHE["volume_ma"].append(sum(float(item.get("v", 0.0)) for item in window) / len(window))

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return SERIES_CACHE


def _ready(candles, cfg):
    return len(candles) >= max(
        cfg["breakout_period"],
        cfg["ema_period"],
        cfg["ema_slope_lookback"],
        cfg["adx_period"] * 3,
        cfg["volume_period"],
        cfg["atr_period"] * 3,
    ) + 3


def _signals(candles, cfg):
    closes = [float(item["c"]) for item in candles]
    highs = [float(item["h"]) for item in candles]
    lows = [float(item["l"]) for item in candles]
    series = _cached_series(candles, cfg)
    volume = float(candles[-1].get("v", 0.0))
    previous_high = max(highs[-cfg["breakout_period"] - 1:-1])
    previous_low = min(lows[-cfg["breakout_period"] - 1:-1])
    volume_ratio = volume / max(series["volume_ma"][-1], 1e-12)
    atr_value = series["atr"][-1]
    atr_pct = atr_value / max(closes[-1], 1e-12) * 100.0
    ema_reference = series["ema"][-1 - cfg["ema_slope_lookback"]]
    ema_slope_pct = (series["ema"][-1] / max(ema_reference, 1e-12) - 1.0) * 100.0
    close_ema_distance_pct = abs(closes[-1] - series["ema"][-1]) / max(closes[-1], 1e-12) * 100.0
    long_breakout_atr = (closes[-1] - previous_high) / max(atr_value, 1e-12)
    short_breakout_atr = (previous_low - closes[-1]) / max(atr_value, 1e-12)
    atr_allowed = (
        atr_pct >= cfg["min_atr_pct"]
        and (cfg["max_atr_pct"] <= 0 or atr_pct <= cfg["max_atr_pct"])
    )
    long_signal = (
        cfg["allow_long"]
        and closes[-1] > previous_high
        and closes[-2] <= previous_high
        and closes[-1] > series["ema"][-1]
        and (cfg["min_ema_slope_pct"] <= 0 or ema_slope_pct >= cfg["min_ema_slope_pct"])
        and close_ema_distance_pct >= cfg["min_close_ema_distance_pct"]
        and series["adx"][-1] >= cfg["adx_min"]
        and series["plus_di"][-1] > series["minus_di"][-1]
        and series["plus_di"][-1] - series["minus_di"][-1] >= cfg["min_di_spread"]
        and volume_ratio >= cfg["min_volume_ratio"]
        and atr_allowed
        and long_breakout_atr >= cfg["min_breakout_atr"]
    )
    short_signal = (
        cfg["allow_short"]
        and closes[-1] < previous_low
        and closes[-2] >= previous_low
        and closes[-1] < series["ema"][-1]
        and (cfg["min_ema_slope_pct"] <= 0 or ema_slope_pct <= -cfg["min_ema_slope_pct"])
        and close_ema_distance_pct >= cfg["min_close_ema_distance_pct"]
        and series["adx"][-1] >= cfg["adx_min"]
        and series["minus_di"][-1] > series["plus_di"][-1]
        and series["minus_di"][-1] - series["plus_di"][-1] >= cfg["min_di_spread"]
        and volume_ratio >= cfg["min_volume_ratio"]
        and atr_allowed
        and short_breakout_atr >= cfg["min_breakout_atr"]
    )
    return {
        "long": long_signal,
        "short": short_signal,
        "ema": series["ema"],
        "atr": atr_value,
        "atr_pct": atr_pct,
        "adx": series["adx"][-1],
        "ema_slope_pct": ema_slope_pct,
        "close_ema_distance_pct": close_ema_distance_pct,
        "long_breakout_atr": long_breakout_atr,
        "short_breakout_atr": short_breakout_atr,
        "volume_ratio": volume_ratio,
        "previous_high": previous_high,
        "previous_low": previous_low,
    }


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []
    closes = [float(item["c"]) for item in candles]
    ema = _ema(closes, cfg["ema_period"])
    limit = min(500, len(candles))
    start = len(candles) - limit
    return [{
        "type": "plot",
        "title": f"EMA {cfg['ema_period']}",
        "points": [{"time": candles[index]["t"], "value": ema[index]} for index in range(start, len(candles))],
        "color": "#f59e0b",
        "linewidth": 1,
    }]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR, ENTRY_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    bar = bar_number(candles)
    current_side = getattr(portfolio, "side", None)
    if not current_side:
        ENTRY_BAR = None
    elif ENTRY_BAR is None:
        ENTRY_BAR = bar

    if current_side and cfg["max_hold_bars"] > 0 and bar - ENTRY_BAR >= cfg["max_hold_bars"]:
        ENTRY_BAR = None
        close()
        return

    if LAST_SIGNAL_BAR is not None and bar - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    signal = _signals(candles, cfg)
    close_price = float(candles[-1]["c"])
    stop_pct = signal["atr"] * cfg["stop_atr"] / max(close_price, 1e-12) * 100.0
    stop_pct = min(cfg["max_stop_pct"], max(cfg["min_stop_pct"], stop_pct))
    target_pct = stop_pct * cfg["reward_risk"]

    if signal["long"] and current_side != "BUY":
        set_sl(pct=stop_pct)
        if cfg["use_take_profit"]:
            set_tp(pct=target_pct)
        LAST_SIGNAL_BAR = bar
        ENTRY_BAR = bar + 1
        _observe("donchian_momentum.long", side="long", adx=round(signal["adx"], 2), volume_ratio=round(signal["volume_ratio"], 3))
        buy()
        return

    if signal["short"] and current_side != "SELL":
        set_sl(pct=stop_pct)
        if cfg["use_take_profit"]:
            set_tp(pct=target_pct)
        LAST_SIGNAL_BAR = bar
        ENTRY_BAR = bar + 1
        _observe("donchian_momentum.short", side="short", adx=round(signal["adx"], 2), volume_ratio=round(signal["volume_ratio"], 3))
        sell()
        return

    hold()
