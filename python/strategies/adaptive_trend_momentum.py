# name: Adaptive Trend Momentum
# desc: ROC momentum entries with volatility-adaptive trailing stops
# author: NexusTrade
# version: 1.0

import builtins as _builtins


LAST_SIGNAL_BAR = None
ENTRY_BAR = None
HIGHEST_PRICE = None
LOWEST_PRICE = None
ACTIVE_STOP = None
SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "atr": [],
    "ema": [],
    "volume_ma": [],
}


def initialize():
    return {
        "momentum_lookback": 28,
        "long_threshold_pct": 3.0,
        "short_threshold_pct": 4.0,
        "require_threshold_cross": False,
        "atr_period": 14,
        "initial_stop_atr": 2.5,
        "trail_atr": 2.5,
        "min_atr_pct": 0.0,
        "max_atr_pct": 0.0,
        "use_regime_filter": False,
        "regime_ema_period": 100,
        "volume_period": 20,
        "min_volume_ratio": 0.0,
        "allow_long": True,
        "allow_short": True,
        "exit_on_momentum_flip": False,
        "max_hold_bars": 0,
        "cooldown_bars": 4,
    }


def _float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _bool(value, fallback=False):
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

    cfg["momentum_lookback"] = max(2, _int(cfg.get("momentum_lookback"), 28))
    cfg["long_threshold_pct"] = max(0.0, _float(cfg.get("long_threshold_pct"), 3.0))
    cfg["short_threshold_pct"] = max(0.0, _float(cfg.get("short_threshold_pct"), 4.0))
    cfg["require_threshold_cross"] = _bool(cfg.get("require_threshold_cross"), False)
    cfg["atr_period"] = max(2, _int(cfg.get("atr_period"), 14))
    cfg["initial_stop_atr"] = max(0.2, _float(cfg.get("initial_stop_atr"), 2.5))
    cfg["trail_atr"] = max(0.2, _float(cfg.get("trail_atr"), 2.5))
    cfg["min_atr_pct"] = max(0.0, _float(cfg.get("min_atr_pct"), 0.0))
    cfg["max_atr_pct"] = max(0.0, _float(cfg.get("max_atr_pct"), 0.0))
    cfg["use_regime_filter"] = _bool(cfg.get("use_regime_filter"), False)
    cfg["regime_ema_period"] = max(2, _int(cfg.get("regime_ema_period"), 100))
    cfg["volume_period"] = max(2, _int(cfg.get("volume_period"), 20))
    cfg["min_volume_ratio"] = max(0.0, _float(cfg.get("min_volume_ratio"), 0.0))
    cfg["allow_long"] = _bool(cfg.get("allow_long"), True)
    cfg["allow_short"] = _bool(cfg.get("allow_short"), True)
    cfg["exit_on_momentum_flip"] = _bool(cfg.get("exit_on_momentum_flip"), False)
    cfg["max_hold_bars"] = max(0, _int(cfg.get("max_hold_bars"), 0))
    cfg["cooldown_bars"] = max(0, _int(cfg.get("cooldown_bars"), 4))
    return cfg


def _candles():
    try:
        return indicators.candles()
    except Exception:
        return []


def _ema_next(previous, value, period):
    alpha = 2.0 / (period + 1.0)
    return float(value) * alpha + float(previous) * (1.0 - alpha)


def _signature(cfg):
    return cfg["atr_period"], cfg["regime_ema_period"], cfg["volume_period"]


def _reset_cache(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    SERIES_CACHE["atr"] = []
    SERIES_CACHE["ema"] = []
    SERIES_CACHE["volume_ma"] = []


def _series(candles, cfg):
    signature = _signature(cfg)
    if SERIES_CACHE["signature"] != signature:
        _reset_cache(signature)

    count = SERIES_CACHE["count"]
    if count > 0 and (
        len(candles) < count
        or candles[count - 1].get("t") != SERIES_CACHE["last_t"]
    ):
        _reset_cache(signature)
        count = 0

    for index in range(count, len(candles)):
        close_price = _float(candles[index].get("c"))
        volume = _float(candles[index].get("v"))
        if index == 0 or not SERIES_CACHE["atr"]:
            SERIES_CACHE["atr"].append(0.0)
            SERIES_CACHE["ema"].append(close_price)
            SERIES_CACHE["volume_ma"].append(volume)
            continue

        high = _float(candles[index].get("h"))
        low = _float(candles[index].get("l"))
        prev_close = _float(candles[index - 1].get("c"))
        true_range = max(high - low, abs(high - prev_close), abs(low - prev_close))
        SERIES_CACHE["atr"].append(
            _ema_next(SERIES_CACHE["atr"][-1], true_range, cfg["atr_period"])
        )
        SERIES_CACHE["ema"].append(
            _ema_next(SERIES_CACHE["ema"][-1], close_price, cfg["regime_ema_period"])
        )

        start = max(0, index - cfg["volume_period"] + 1)
        window = candles[start:index + 1]
        SERIES_CACHE["volume_ma"].append(
            sum(_float(item.get("v")) for item in window) / len(window)
        )

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return SERIES_CACHE


def _momentum(closes, index, lookback):
    reference = closes[index - lookback]
    if reference <= 0:
        return 0.0
    return (closes[index] / reference - 1.0) * 100.0


def _ready(candles, cfg):
    return len(candles) >= max(
        cfg["momentum_lookback"] + 2,
        cfg["atr_period"] * 3,
        cfg["regime_ema_period"] if cfg["use_regime_filter"] else 2,
        cfg["volume_period"],
    ) + 2


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _set_meta(**meta):
    fn = getattr(_builtins, "set_meta", None)
    if callable(fn):
        fn(**meta)


def _clear_position_state():
    global ENTRY_BAR, HIGHEST_PRICE, LOWEST_PRICE, ACTIVE_STOP
    ENTRY_BAR = None
    HIGHEST_PRICE = None
    LOWEST_PRICE = None
    ACTIVE_STOP = None


def _manage_position(candles, idx, side, atr_value, momentum, cfg):
    global HIGHEST_PRICE, LOWEST_PRICE, ACTIVE_STOP

    high = _float(candles[-1].get("h"))
    low = _float(candles[-1].get("l"))
    HIGHEST_PRICE = high if HIGHEST_PRICE is None else max(HIGHEST_PRICE, high)
    LOWEST_PRICE = low if LOWEST_PRICE is None else min(LOWEST_PRICE, low)

    if side == "BUY":
        proposed = HIGHEST_PRICE - atr_value * cfg["trail_atr"]
        ACTIVE_STOP = proposed if ACTIVE_STOP is None else max(ACTIVE_STOP, proposed)
    else:
        proposed = LOWEST_PRICE + atr_value * cfg["trail_atr"]
        ACTIVE_STOP = proposed if ACTIVE_STOP is None else min(ACTIVE_STOP, proposed)
    set_sl(price=ACTIVE_STOP)

    if cfg["max_hold_bars"] > 0 and ENTRY_BAR is not None:
        if idx - ENTRY_BAR >= cfg["max_hold_bars"]:
            close()
            return True

    if cfg["exit_on_momentum_flip"]:
        if side == "BUY" and momentum < 0:
            close()
            return True
        if side == "SELL" and momentum > 0:
            close()
            return True
    return False


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR, ENTRY_BAR, HIGHEST_PRICE, LOWEST_PRICE, ACTIVE_STOP

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    idx = len(candles) - 1
    closes = [_float(item.get("c")) for item in candles]
    close_price = closes[-1]
    series = _series(candles, cfg)
    atr_value = series["atr"][-1]
    if close_price <= 0 or atr_value <= 0:
        hold()
        return

    momentum = _momentum(closes, idx, cfg["momentum_lookback"])
    previous_momentum = _momentum(closes, idx - 1, cfg["momentum_lookback"])
    atr_pct = atr_value / close_price * 100.0
    volume_ma = series["volume_ma"][-1]
    volume_ratio = _float(candles[-1].get("v")) / max(volume_ma, 1e-12)
    current_side = getattr(portfolio, "side", None)

    if current_side in ("BUY", "SELL"):
        if _manage_position(candles, idx, current_side, atr_value, momentum, cfg):
            return
        _set_meta(
            setup="adaptive_trend",
            momentum_pct=round(momentum, 4),
            atr_pct=round(atr_pct, 4),
            trailing_stop=round(ACTIVE_STOP, 8),
        )
        hold()
        return

    _clear_position_state()
    if LAST_SIGNAL_BAR is not None and idx - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return
    if atr_pct < cfg["min_atr_pct"]:
        hold()
        return
    if cfg["max_atr_pct"] > 0 and atr_pct > cfg["max_atr_pct"]:
        hold()
        return
    if volume_ratio < cfg["min_volume_ratio"]:
        hold()
        return

    ema_value = series["ema"][-1]
    long_signal = cfg["allow_long"] and momentum >= cfg["long_threshold_pct"]
    short_signal = cfg["allow_short"] and momentum <= -cfg["short_threshold_pct"]
    if cfg["require_threshold_cross"]:
        long_signal = long_signal and previous_momentum < cfg["long_threshold_pct"]
        short_signal = short_signal and previous_momentum > -cfg["short_threshold_pct"]
    if cfg["use_regime_filter"]:
        long_signal = long_signal and close_price > ema_value
        short_signal = short_signal and close_price < ema_value

    if long_signal:
        initial_stop = close_price - atr_value * cfg["initial_stop_atr"]
        set_sl(price=initial_stop)
        LAST_SIGNAL_BAR = idx
        ENTRY_BAR = idx
        HIGHEST_PRICE = _float(candles[-1].get("h"))
        LOWEST_PRICE = _float(candles[-1].get("l"))
        ACTIVE_STOP = initial_stop
        _observe(
            "adaptive_trend.long",
            side="long",
            momentum_pct=round(momentum, 4),
            atr_pct=round(atr_pct, 4),
            volume_ratio=round(volume_ratio, 4),
        )
        _set_meta(setup="adaptive_trend", direction="long", momentum_pct=round(momentum, 4))
        buy()
        return

    if short_signal:
        initial_stop = close_price + atr_value * cfg["initial_stop_atr"]
        set_sl(price=initial_stop)
        LAST_SIGNAL_BAR = idx
        ENTRY_BAR = idx
        HIGHEST_PRICE = _float(candles[-1].get("h"))
        LOWEST_PRICE = _float(candles[-1].get("l"))
        ACTIVE_STOP = initial_stop
        _observe(
            "adaptive_trend.short",
            side="short",
            momentum_pct=round(momentum, 4),
            atr_pct=round(atr_pct, 4),
            volume_ratio=round(volume_ratio, 4),
        )
        _set_meta(setup="adaptive_trend", direction="short", momentum_pct=round(momentum, 4))
        sell()
        return

    _set_meta(setup="adaptive_trend", momentum_pct=round(momentum, 4), atr_pct=round(atr_pct, 4))
    hold()


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []
    closes = [_float(item.get("c")) for item in candles]
    ema = []
    for value in closes:
        ema.append(value if not ema else _ema_next(ema[-1], value, cfg["regime_ema_period"]))
    start = max(0, len(candles) - 500)
    drawings = [{
        "type": "plot",
        "title": f"Regime EMA {cfg['regime_ema_period']}",
        "points": [
            {"time": candles[index]["t"], "value": ema[index]}
            for index in range(start, len(candles))
        ],
        "color": "#f59e0b",
        "linewidth": 1,
    }]
    return drawings
