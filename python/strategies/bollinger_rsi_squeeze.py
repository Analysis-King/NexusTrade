# name: Bollinger RSI Squeeze
# desc: Bollinger band squeeze/breakout, RSI and MACD confirmation with ATR risk
# author: NexusTrade
# version: 1.0

import builtins as _builtins
import math


LAST_SIGNAL_BAR = None


def initialize():
    return {
        "bb_period": 20,
        "bb_std_mult": 2.0,
        "squeeze_lookback": 120,
        "squeeze_percentile": 0.35,
        "require_squeeze": True,
        "require_expansion": True,
        "ema_filter_period": 200,
        "use_ema_filter": True,
        "rsi_period": 14,
        "rsi_long_min": 54.0,
        "rsi_short_max": 46.0,
        "use_macd_filter": True,
        "macd_fast": 12,
        "macd_slow": 26,
        "macd_signal": 9,
        "atr_period": 14,
        "stop_atr": 1.4,
        "min_stop_pct": 0.18,
        "max_stop_pct": 1.8,
        "reward_risk": 1.8,
        "use_take_profit": False,
        "allow_short": True,
        "cooldown_bars": 8,
        "exit_on_midline": True,
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
    cfg["bb_period"] = max(5, _to_int(cfg.get("bb_period"), 20))
    cfg["bb_std_mult"] = max(0.5, _to_float(cfg.get("bb_std_mult"), 2.0))
    cfg["squeeze_lookback"] = max(cfg["bb_period"] + 5, _to_int(cfg.get("squeeze_lookback"), 120))
    cfg["squeeze_percentile"] = min(0.9, max(0.05, _to_float(cfg.get("squeeze_percentile"), 0.35)))
    cfg["require_squeeze"] = _to_bool(cfg.get("require_squeeze"), True)
    cfg["require_expansion"] = _to_bool(cfg.get("require_expansion"), True)
    cfg["ema_filter_period"] = max(2, _to_int(cfg.get("ema_filter_period"), 200))
    cfg["use_ema_filter"] = _to_bool(cfg.get("use_ema_filter"), True)
    cfg["rsi_period"] = max(2, _to_int(cfg.get("rsi_period"), 14))
    cfg["rsi_long_min"] = _to_float(cfg.get("rsi_long_min"), 54.0)
    cfg["rsi_short_max"] = _to_float(cfg.get("rsi_short_max"), 46.0)
    cfg["use_macd_filter"] = _to_bool(cfg.get("use_macd_filter"), True)
    cfg["macd_fast"] = max(2, _to_int(cfg.get("macd_fast"), 12))
    cfg["macd_slow"] = max(cfg["macd_fast"] + 1, _to_int(cfg.get("macd_slow"), 26))
    cfg["macd_signal"] = max(2, _to_int(cfg.get("macd_signal"), 9))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["stop_atr"] = max(0.2, _to_float(cfg.get("stop_atr"), 1.4))
    cfg["min_stop_pct"] = max(0.01, _to_float(cfg.get("min_stop_pct"), 0.18))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _to_float(cfg.get("max_stop_pct"), 1.8))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.8))
    cfg["use_take_profit"] = _to_bool(cfg.get("use_take_profit"), False)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 8))
    cfg["exit_on_midline"] = _to_bool(cfg.get("exit_on_midline"), True)
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


def _sma(values, period, i):
    if i + 1 < period:
        return None
    window = values[i + 1 - period:i + 1]
    return sum(window) / period


def _stdev(values, period, i):
    mean = _sma(values, period, i)
    if mean is None:
        return None
    window = values[i + 1 - period:i + 1]
    variance = sum((value - mean) ** 2 for value in window) / period
    return math.sqrt(variance)


def _rsi(values, period):
    if not values:
        return []
    out = [50.0]
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, len(values)):
        change = values[i] - values[i - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        if i <= period:
            avg_gain += gain
            avg_loss += loss
            if i == period:
                avg_gain /= period
                avg_loss /= period
        else:
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
        if i < period:
            out.append(50.0)
        elif avg_loss == 0:
            out.append(100.0)
        else:
            rs = avg_gain / avg_loss
            out.append(100.0 - 100.0 / (1.0 + rs))
    return out


def _atr(candles, period):
    if not candles:
        return []
    trs = [0.0]
    for i in range(1, len(candles)):
        high = float(candles[i]["h"])
        low = float(candles[i]["l"])
        prev_close = float(candles[i - 1]["c"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return _ema(trs, period)


def _bands(closes, cfg):
    middle = []
    upper = []
    lower = []
    width = []
    for i, close in enumerate(closes):
        ma = _sma(closes, cfg["bb_period"], i)
        sd = _stdev(closes, cfg["bb_period"], i)
        if ma is None or sd is None or ma <= 0:
            middle.append(close)
            upper.append(close)
            lower.append(close)
            width.append(0.0)
            continue
        up = ma + sd * cfg["bb_std_mult"]
        lo = ma - sd * cfg["bb_std_mult"]
        middle.append(ma)
        upper.append(up)
        lower.append(lo)
        width.append((up - lo) / ma * 100.0)
    return middle, upper, lower, width


def _percentile_threshold(values, pct):
    nums = sorted(value for value in values if value > 0 and math.isfinite(value))
    if not nums:
        return None
    index = min(len(nums) - 1, max(0, int((len(nums) - 1) * pct)))
    return nums[index]


def _series(candles, cfg):
    closes = [float(c["c"]) for c in candles]
    ema_filter = _ema(closes, cfg["ema_filter_period"])
    fast = _ema(closes, cfg["macd_fast"])
    slow = _ema(closes, cfg["macd_slow"])
    macd = [f - s for f, s in zip(fast, slow)]
    signal = _ema(macd, cfg["macd_signal"])
    hist = [m - s for m, s in zip(macd, signal)]
    middle, upper, lower, width = _bands(closes, cfg)
    return {
        "close": closes,
        "ema_filter": ema_filter,
        "rsi": _rsi(closes, cfg["rsi_period"]),
        "macd_hist": hist,
        "atr": _atr(candles, cfg["atr_period"]),
        "middle": middle,
        "upper": upper,
        "lower": lower,
        "width": width,
    }


def _ready(candles, cfg):
    return len(candles) >= max(
        cfg["squeeze_lookback"] + cfg["bb_period"] + 2,
        cfg["ema_filter_period"] + 2,
        cfg["macd_slow"] + cfg["macd_signal"] + 2,
        cfg["atr_period"] + 2,
    )


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _risk_levels(side, entry, atr_value, cfg):
    atr_distance = max(0.0, atr_value) * cfg["stop_atr"]
    min_distance = entry * cfg["min_stop_pct"] / 100.0
    max_distance = entry * cfg["max_stop_pct"] / 100.0
    distance = max(min_distance, min(atr_distance if atr_distance > 0 else min_distance, max_distance))
    if side == "BUY":
        return entry - distance, entry + distance * cfg["reward_risk"]
    return entry + distance, entry - distance * cfg["reward_risk"]


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []
    data = _series(candles, cfg)
    limit = min(500, len(candles))
    start = len(candles) - limit

    def points(values):
        return [{"time": candles[start + i]["t"], "value": values[start + i]} for i in range(limit)]

    return [
        {"type": "plot", "title": "BB Upper", "points": points(data["upper"]), "color": "#60a5fa", "linewidth": 1},
        {"type": "plot", "title": "BB Middle", "points": points(data["middle"]), "color": "#94a3b8", "linewidth": 1},
        {"type": "plot", "title": "BB Lower", "points": points(data["lower"]), "color": "#60a5fa", "linewidth": 1},
    ]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    data = _series(candles, cfg)
    idx = len(candles) - 1
    close_price = data["close"][-1]
    prev_close = data["close"][-2]
    upper = data["upper"][-1]
    prev_upper = data["upper"][-2]
    lower = data["lower"][-1]
    prev_lower = data["lower"][-2]
    middle = data["middle"][-1]
    width = data["width"][-1]
    prev_width = data["width"][-2]
    atr_value = data["atr"][-1]
    rsi = data["rsi"][-1]
    macd_hist = data["macd_hist"][-1]
    current_side = getattr(portfolio, "side", None)

    if LAST_SIGNAL_BAR is not None and idx - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    width_window = data["width"][-cfg["squeeze_lookback"] - 1:-1]
    squeeze_threshold = _percentile_threshold(width_window, cfg["squeeze_percentile"])
    was_squeezed = squeeze_threshold is not None and prev_width <= squeeze_threshold
    expanding = width > prev_width

    long_signal = prev_close <= prev_upper and close_price > upper
    short_signal = prev_close >= prev_lower and close_price < lower
    if cfg["require_squeeze"]:
        long_signal = long_signal and was_squeezed
        short_signal = short_signal and was_squeezed
    if cfg["require_expansion"]:
        long_signal = long_signal and expanding
        short_signal = short_signal and expanding
    if cfg["use_ema_filter"]:
        long_signal = long_signal and close_price >= data["ema_filter"][-1]
        short_signal = short_signal and close_price <= data["ema_filter"][-1]
    long_signal = long_signal and rsi >= cfg["rsi_long_min"]
    short_signal = short_signal and rsi <= cfg["rsi_short_max"]
    if cfg["use_macd_filter"]:
        long_signal = long_signal and macd_hist > 0
        short_signal = short_signal and macd_hist < 0

    if long_signal and current_side != "BUY":
        sl, tp = _risk_levels("BUY", close_price, atr_value, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe("bollinger_squeeze.long", side="long", rsi=round(rsi, 2), width=round(width, 4))
        buy()
        return

    if cfg["allow_short"] and short_signal and current_side != "SELL":
        sl, tp = _risk_levels("SELL", close_price, atr_value, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe("bollinger_squeeze.short", side="short", rsi=round(rsi, 2), width=round(width, 4))
        sell()
        return

    if cfg["exit_on_midline"] and current_side == "BUY" and close_price < middle:
        LAST_SIGNAL_BAR = idx
        close()
        return

    if cfg["exit_on_midline"] and current_side == "SELL" and close_price > middle:
        LAST_SIGNAL_BAR = idx
        close()
        return

    hold()
