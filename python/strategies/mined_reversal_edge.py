# name: Mined Reversal Edge
# desc: 50 sembollu sinyal madenciligi sonucunda bulunan genis volatilite + momentum toparlanmasi kosullarini dener
# author: NexusTrade
# version: 1.0

import builtins as _builtins
import math


LAST_SIGNAL_BAR = None
SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "rsi": [],
    "avg_gain": [],
    "avg_loss": [],
    "stoch": [],
    "macd_fast": [],
    "macd_slow": [],
    "macd_signal": [],
    "macd": [],
    "atr": [],
    "bb_width": [],
    "regime_fast": [],
    "regime_slow": [],
}


def initialize():
    return {
        "rsi_period": 14,
        "stoch_period": 14,
        "bb_period": 20,
        "bb_std": 2.0,
        "atr_period": 14,
        "long_rsi_max": 30.0,
        "long_stoch_min": 20.0,
        "long_stoch_max": 40.0,
        "long_min_bb_width": 10.0,
        "allow_long": True,
        "allow_short": True,
        "short_rsi_min": 40.0,
        "short_rsi_max": 50.0,
        "short_stoch_min": 60.0,
        "short_stoch_max": 80.0,
        "short_min_bb_width": 5.0,
        "short_max_bb_width": 10.0,
        "min_stop_pct": 0.35,
        "max_stop_pct": 1.4,
        "stop_atr_mult": 1.0,
        "reward_risk": 1.5,
        "cooldown_bars": 6,
        "max_hold_bars": 12,
        "exit_on_momentum_loss": True,
        "regime_filter": False,
        "regime_fast_period": 50,
        "regime_slow_period": 200,
        "regime_allow_mixed": True,
        "long_regime": "bull_or_mixed",
        "short_regime": "bear_or_mixed",
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
    cfg["rsi_period"] = max(2, _to_int(cfg.get("rsi_period"), 14))
    cfg["stoch_period"] = max(2, _to_int(cfg.get("stoch_period"), 14))
    cfg["bb_period"] = max(2, _to_int(cfg.get("bb_period"), 20))
    cfg["bb_std"] = max(0.2, _to_float(cfg.get("bb_std"), 2.0))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["long_rsi_max"] = _to_float(cfg.get("long_rsi_max"), 30.0)
    cfg["long_stoch_min"] = _to_float(cfg.get("long_stoch_min"), 20.0)
    cfg["long_stoch_max"] = _to_float(cfg.get("long_stoch_max"), 40.0)
    cfg["long_min_bb_width"] = max(0.0, _to_float(cfg.get("long_min_bb_width"), 10.0))
    cfg["allow_long"] = _to_bool(cfg.get("allow_long"), True)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["short_rsi_min"] = _to_float(cfg.get("short_rsi_min"), 40.0)
    cfg["short_rsi_max"] = _to_float(cfg.get("short_rsi_max"), 50.0)
    cfg["short_stoch_min"] = _to_float(cfg.get("short_stoch_min"), 60.0)
    cfg["short_stoch_max"] = _to_float(cfg.get("short_stoch_max"), 80.0)
    cfg["short_min_bb_width"] = max(0.0, _to_float(cfg.get("short_min_bb_width"), 5.0))
    cfg["short_max_bb_width"] = max(cfg["short_min_bb_width"], _to_float(cfg.get("short_max_bb_width"), 10.0))
    cfg["min_stop_pct"] = max(0.02, _to_float(cfg.get("min_stop_pct"), 0.35))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _to_float(cfg.get("max_stop_pct"), 1.4))
    cfg["stop_atr_mult"] = max(0.1, _to_float(cfg.get("stop_atr_mult"), 1.0))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.5))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 6))
    cfg["max_hold_bars"] = max(1, _to_int(cfg.get("max_hold_bars"), 12))
    cfg["exit_on_momentum_loss"] = _to_bool(cfg.get("exit_on_momentum_loss"), True)
    cfg["regime_filter"] = _to_bool(cfg.get("regime_filter"), False)
    cfg["regime_fast_period"] = max(2, _to_int(cfg.get("regime_fast_period"), 50))
    cfg["regime_slow_period"] = max(cfg["regime_fast_period"] + 1, _to_int(cfg.get("regime_slow_period"), 200))
    cfg["regime_allow_mixed"] = _to_bool(cfg.get("regime_allow_mixed"), True)
    cfg["long_regime"] = str(cfg.get("long_regime") or "bull_or_mixed").strip().lower()
    cfg["short_regime"] = str(cfg.get("short_regime") or "bear_or_mixed").strip().lower()
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


def _set_meta(**meta):
    fn = getattr(_builtins, "set_meta", None)
    if callable(fn):
        fn(**meta)


def _ema(values, period):
    out = []
    alpha = 2.0 / (period + 1.0)
    prev = None
    for value in values:
        value = float(value)
        prev = value if prev is None else value * alpha + prev * (1.0 - alpha)
        out.append(prev)
    return out


def _ema_next(previous, value, period):
    alpha = 2.0 / (period + 1.0)
    return float(value) * alpha + float(previous) * (1.0 - alpha)


def _rma(values, period):
    out = []
    prev = None
    for i, value in enumerate(values):
        value = float(value)
        if prev is None:
            prev = value
        elif i <= period:
            prev = (prev * (i - 1) + value) / i
        else:
            prev = (prev * (period - 1) + value) / period
        out.append(prev)
    return out


def _rma_next(previous, value, period, index):
    if index <= 0:
        return float(value)
    if index <= period:
        return (float(previous) * (index - 1) + float(value)) / index
    return (float(previous) * (period - 1) + float(value)) / period


def _sma(values, period):
    out = []
    total = 0.0
    for i, value in enumerate(values):
        total += float(value)
        if i >= period:
            total -= float(values[i - period])
        out.append(total / min(period, i + 1))
    return out


def _std(values, period):
    out = []
    for i in range(len(values)):
        window = [float(v) for v in values[max(0, i - period + 1):i + 1]]
        mean = sum(window) / len(window)
        out.append(math.sqrt(sum((value - mean) ** 2 for value in window) / len(window)))
    return out


def _rsi(closes, period):
    gains = [0.0]
    losses = [0.0]
    for i in range(1, len(closes)):
        change = float(closes[i]) - float(closes[i - 1])
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = _rma(gains, period)
    avg_loss = _rma(losses, period)
    out = []
    for gain, loss in zip(avg_gain, avg_loss):
        if loss == 0:
            out.append(100.0 if gain > 0 else 50.0)
        else:
            rs = gain / loss
            out.append(100.0 - 100.0 / (1.0 + rs))
    return out


def _stoch(candles, period):
    out = []
    for i, candle in enumerate(candles):
        window = candles[max(0, i - period + 1):i + 1]
        low = min(float(row["l"]) for row in window)
        high = max(float(row["h"]) for row in window)
        out.append(50.0 if high == low else (float(candle["c"]) - low) / (high - low) * 100.0)
    return out


def _macd_hist(closes):
    fast = _ema(closes, 12)
    slow = _ema(closes, 26)
    line = [a - b for a, b in zip(fast, slow)]
    signal = _ema(line, 9)
    return [a - b for a, b in zip(line, signal)]


def _atr(candles, period):
    tr = []
    for i, candle in enumerate(candles):
        high = float(candle["h"])
        low = float(candle["l"])
        prev = float(candles[i - 1]["c"]) if i else float(candle["c"])
        tr.append(max(high - low, abs(high - prev), abs(low - prev)))
    return _rma(tr, period)


def _series(candles, cfg):
    signature = (
        cfg["rsi_period"],
        cfg["stoch_period"],
        cfg["bb_period"],
        cfg["bb_std"],
        cfg["atr_period"],
        cfg["regime_fast_period"],
        cfg["regime_slow_period"],
    )
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

    for i in range(count, len(candles)):
        candle = candles[i]
        close_price = float(candle["c"])
        high = float(candle["h"])
        low = float(candle["l"])
        if i == 0:
            SERIES_CACHE["rsi"].append(50.0)
            SERIES_CACHE["avg_gain"].append(0.0)
            SERIES_CACHE["avg_loss"].append(0.0)
            SERIES_CACHE["stoch"].append(50.0)
            SERIES_CACHE["macd_fast"].append(close_price)
            SERIES_CACHE["macd_slow"].append(close_price)
            SERIES_CACHE["macd_signal"].append(0.0)
            SERIES_CACHE["macd"].append(0.0)
            SERIES_CACHE["atr"].append(high - low)
            SERIES_CACHE["bb_width"].append(0.0)
            SERIES_CACHE["regime_fast"].append(close_price)
            SERIES_CACHE["regime_slow"].append(close_price)
            continue

        prev_close = float(candles[i - 1]["c"])
        change = close_price - prev_close
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        avg_gain = _rma_next(SERIES_CACHE["avg_gain"][-1], gain, cfg["rsi_period"], i)
        avg_loss = _rma_next(SERIES_CACHE["avg_loss"][-1], loss, cfg["rsi_period"], i)
        SERIES_CACHE["avg_gain"].append(avg_gain)
        SERIES_CACHE["avg_loss"].append(avg_loss)
        if avg_loss == 0:
            SERIES_CACHE["rsi"].append(100.0 if avg_gain > 0 else 50.0)
        else:
            rs = avg_gain / avg_loss
            SERIES_CACHE["rsi"].append(100.0 - 100.0 / (1.0 + rs))

        stoch_window = candles[max(0, i - cfg["stoch_period"] + 1):i + 1]
        stoch_low = min(float(row["l"]) for row in stoch_window)
        stoch_high = max(float(row["h"]) for row in stoch_window)
        SERIES_CACHE["stoch"].append(50.0 if stoch_high == stoch_low else (close_price - stoch_low) / (stoch_high - stoch_low) * 100.0)

        macd_fast = _ema_next(SERIES_CACHE["macd_fast"][-1], close_price, 12)
        macd_slow = _ema_next(SERIES_CACHE["macd_slow"][-1], close_price, 26)
        macd_line = macd_fast - macd_slow
        macd_signal = _ema_next(SERIES_CACHE["macd_signal"][-1], macd_line, 9)
        SERIES_CACHE["macd_fast"].append(macd_fast)
        SERIES_CACHE["macd_slow"].append(macd_slow)
        SERIES_CACHE["macd_signal"].append(macd_signal)
        SERIES_CACHE["macd"].append(macd_line - macd_signal)

        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        SERIES_CACHE["atr"].append(_rma_next(SERIES_CACHE["atr"][-1], tr, cfg["atr_period"], i))

        bb_values = [float(row["c"]) for row in candles[max(0, i - cfg["bb_period"] + 1):i + 1]]
        basis = sum(bb_values) / len(bb_values)
        if basis:
            dev = math.sqrt(sum((value - basis) ** 2 for value in bb_values) / len(bb_values))
            SERIES_CACHE["bb_width"].append((2.0 * cfg["bb_std"] * dev) / basis * 100.0)
        else:
            SERIES_CACHE["bb_width"].append(0.0)

        SERIES_CACHE["regime_fast"].append(_ema_next(SERIES_CACHE["regime_fast"][-1], close_price, cfg["regime_fast_period"]))
        SERIES_CACHE["regime_slow"].append(_ema_next(SERIES_CACHE["regime_slow"][-1], close_price, cfg["regime_slow_period"]))

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return SERIES_CACHE


def _reset_series_cache(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in ("rsi", "avg_gain", "avg_loss", "stoch", "macd_fast", "macd_slow", "macd_signal", "macd", "atr", "bb_width", "regime_fast", "regime_slow"):
        SERIES_CACHE[key] = []


def _regime(close_price, data):
    fast = data["regime_fast"][-1]
    slow = data["regime_slow"][-1]
    if close_price > fast > slow:
        return "bull"
    if close_price < fast < slow:
        return "bear"
    return "mixed"


def _regime_allows(side, regime, cfg):
    if not cfg["regime_filter"]:
        return True
    rule = cfg["long_regime"] if side == "BUY" else cfg["short_regime"]
    if rule in ("any", "all", "off"):
        return True
    if rule == "bull":
        return regime == "bull"
    if rule == "bear":
        return regime == "bear"
    if rule == "mixed":
        return regime == "mixed"
    if rule == "bull_or_mixed":
        return regime == "bull" or (cfg["regime_allow_mixed"] and regime == "mixed")
    if rule == "bear_or_mixed":
        return regime == "bear" or (cfg["regime_allow_mixed"] and regime == "mixed")
    return True


def _risk(side, entry, atr_value, cfg):
    atr_pct = atr_value / entry * 100.0 if entry else cfg["min_stop_pct"]
    stop_pct = max(cfg["min_stop_pct"], min(cfg["max_stop_pct"], atr_pct * cfg["stop_atr_mult"]))
    stop_distance = entry * stop_pct / 100.0
    target_distance = stop_distance * cfg["reward_risk"]
    if side == "BUY":
        return entry - stop_distance, entry + target_distance, stop_pct
    return entry + stop_distance, entry - target_distance, stop_pct


def _ready(candles, cfg):
    return len(candles) >= max(cfg["bb_period"], cfg["atr_period"], cfg["rsi_period"], cfg["stoch_period"], 35) + 2


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    idx = len(candles) - 1
    data = _series(candles, cfg)
    close_price = float(candles[-1]["c"])
    rsi = data["rsi"][-1]
    stoch = data["stoch"][-1]
    macd = data["macd"][-1]
    prev_macd = data["macd"][-2]
    bb_width = data["bb_width"][-1]
    atr_value = data["atr"][-1]
    regime = _regime(close_price, data)
    current_side = getattr(portfolio, "side", None)

    bars_since_signal = idx - LAST_SIGNAL_BAR if LAST_SIGNAL_BAR is not None else None
    if bars_since_signal is not None and bars_since_signal < cfg["cooldown_bars"]:
        hold()
        return

    if getattr(portfolio, "has_position", False):
        if cfg["exit_on_momentum_loss"]:
            if current_side == "BUY" and rsi >= 50 and macd < prev_macd:
                close()
                return
            if current_side == "SELL" and rsi <= 50 and macd > prev_macd:
                close()
                return
        hold()
        return

    long_signal = (
        cfg["allow_long"] and
        rsi < cfg["long_rsi_max"] and
        cfg["long_stoch_min"] <= stoch < cfg["long_stoch_max"] and
        macd < 0 and
        macd > prev_macd and
        bb_width >= cfg["long_min_bb_width"] and
        _regime_allows("BUY", regime, cfg)
    )
    if long_signal:
        sl, tp, stop_pct = _risk("BUY", close_price, atr_value, cfg)
        set_sl(price=sl)
        set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _set_meta(last_signal="BUY", rsi=round(rsi, 2), stoch=round(stoch, 2), bb_width=round(bb_width, 3), regime=regime)
        _observe("mined_reversal.long", side="long", rsi=round(rsi, 2), stoch=round(stoch, 2), bb_width=round(bb_width, 3), stop_pct=round(stop_pct, 3))
        buy()
        return

    short_signal = (
        cfg["allow_short"] and
        cfg["short_rsi_min"] <= rsi < cfg["short_rsi_max"] and
        cfg["short_stoch_min"] <= stoch < cfg["short_stoch_max"] and
        macd > 0 and
        macd < prev_macd and
        cfg["short_min_bb_width"] <= bb_width < cfg["short_max_bb_width"] and
        _regime_allows("SELL", regime, cfg)
    )
    if short_signal:
        sl, tp, stop_pct = _risk("SELL", close_price, atr_value, cfg)
        set_sl(price=sl)
        set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _set_meta(last_signal="SELL", rsi=round(rsi, 2), stoch=round(stoch, 2), bb_width=round(bb_width, 3), regime=regime)
        _observe("mined_reversal.short", side="short", rsi=round(rsi, 2), stoch=round(stoch, 2), bb_width=round(bb_width, 3), stop_pct=round(stop_pct, 3))
        sell()
        return

    _set_meta(last_signal="HOLD", rsi=round(rsi, 2), stoch=round(stoch, 2), bb_width=round(bb_width, 3), regime=regime)
    hold()


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []
    data = _series(candles, cfg)
    signals = []
    for i, candle in enumerate(candles[-300:], start=max(0, len(candles) - 300)):
        if i < 1:
            continue
        rsi = data["rsi"][i]
        stoch = data["stoch"][i]
        macd = data["macd"][i]
        prev_macd = data["macd"][i - 1]
        bb_width = data["bb_width"][i]
        if rsi < cfg["long_rsi_max"] and cfg["long_stoch_min"] <= stoch < cfg["long_stoch_max"] and macd < 0 and macd > prev_macd and bb_width >= cfg["long_min_bb_width"]:
            signals.append({"t": candle["t"], "price": candle["l"], "side": "buy", "label": "Mined"})
        elif cfg["allow_short"] and cfg["short_rsi_min"] <= rsi < cfg["short_rsi_max"] and cfg["short_stoch_min"] <= stoch < cfg["short_stoch_max"] and macd > 0 and macd < prev_macd and cfg["short_min_bb_width"] <= bb_width < cfg["short_max_bb_width"]:
            signals.append({"t": candle["t"], "price": candle["h"], "side": "sell", "label": "Mined"})
    return [{"type": "signals", "signals": signals[-80:]}]
