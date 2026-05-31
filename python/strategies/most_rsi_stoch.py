# name: MOST RSI Stoch Trend
# desc: MOST MA 5 percent 2 temelli trend stratejisi; opsiyonel RSI ve Stoch RSI filtreleri kullanir
# author: NexusTrade
# version: 1.0

import builtins as _builtins


SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "close": [],
    "ma": [],
    "atr": [],
    "rsi": [],
    "avg_gain": [],
    "avg_loss": [],
    "stoch_raw": [],
    "stoch_k": [],
    "stoch_d": [],
    "long_stop": [],
    "short_stop": [],
    "most": [],
    "direction": [],
}

LAST_SIGNAL_BAR = None


def initialize():
    return {
        "ma_period": 5,
        "most_percent": 2.0,
        "ma_type": "ema",
        "allow_short": True,
        "entry_mode": "flip_reclaim",
        "cooldown_bars": 3,
        "use_rsi_filter": False,
        "rsi_period": 14,
        "rsi_long_min": 50.0,
        "rsi_long_max": 82.0,
        "rsi_short_min": 18.0,
        "rsi_short_max": 50.0,
        "use_stoch_rsi_filter": False,
        "stoch_rsi_period": 14,
        "stoch_k_period": 3,
        "stoch_d_period": 3,
        "stoch_long_min": 20.0,
        "stoch_long_max": 92.0,
        "stoch_short_min": 8.0,
        "stoch_short_max": 80.0,
        "require_stoch_cross": False,
        "atr_period": 14,
        "stop_mode": "most_atr",
        "stop_atr": 1.0,
        "min_stop_pct": 0.25,
        "max_stop_pct": 3.0,
        "use_take_profit": False,
        "reward_risk": 1.5,
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

    cfg["ma_period"] = max(1, _to_int(cfg.get("ma_period"), 5))
    cfg["most_percent"] = max(0.05, _to_float(cfg.get("most_percent"), 2.0))
    cfg["ma_type"] = str(cfg.get("ma_type") or "ema").strip().lower()
    if cfg["ma_type"] not in ("ema", "sma"):
        cfg["ma_type"] = "ema"
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["entry_mode"] = str(cfg.get("entry_mode") or "flip_reclaim").strip().lower()
    if cfg["entry_mode"] not in ("flip", "flip_reclaim", "trend"):
        cfg["entry_mode"] = "flip_reclaim"
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 3))

    cfg["use_rsi_filter"] = _to_bool(cfg.get("use_rsi_filter"), False)
    cfg["rsi_period"] = max(2, _to_int(cfg.get("rsi_period"), 14))
    cfg["rsi_long_min"] = _to_float(cfg.get("rsi_long_min"), 50.0)
    cfg["rsi_long_max"] = _to_float(cfg.get("rsi_long_max"), 82.0)
    cfg["rsi_short_min"] = _to_float(cfg.get("rsi_short_min"), 18.0)
    cfg["rsi_short_max"] = _to_float(cfg.get("rsi_short_max"), 50.0)

    cfg["use_stoch_rsi_filter"] = _to_bool(cfg.get("use_stoch_rsi_filter"), False)
    cfg["stoch_rsi_period"] = max(2, _to_int(cfg.get("stoch_rsi_period"), 14))
    cfg["stoch_k_period"] = max(1, _to_int(cfg.get("stoch_k_period"), 3))
    cfg["stoch_d_period"] = max(1, _to_int(cfg.get("stoch_d_period"), 3))
    cfg["stoch_long_min"] = _to_float(cfg.get("stoch_long_min"), 20.0)
    cfg["stoch_long_max"] = _to_float(cfg.get("stoch_long_max"), 92.0)
    cfg["stoch_short_min"] = _to_float(cfg.get("stoch_short_min"), 8.0)
    cfg["stoch_short_max"] = _to_float(cfg.get("stoch_short_max"), 80.0)
    cfg["require_stoch_cross"] = _to_bool(cfg.get("require_stoch_cross"), False)

    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["stop_mode"] = str(cfg.get("stop_mode") or "most_atr").strip().lower()
    if cfg["stop_mode"] not in ("most", "atr", "most_atr"):
        cfg["stop_mode"] = "most_atr"
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 1.0))
    cfg["min_stop_pct"] = max(0.02, _to_float(cfg.get("min_stop_pct"), 0.25))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _to_float(cfg.get("max_stop_pct"), 3.0))
    cfg["use_take_profit"] = _to_bool(cfg.get("use_take_profit"), False)
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.5))
    cfg["exit_on_opposite_signal"] = _to_bool(cfg.get("exit_on_opposite_signal"), True)
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


def _ema_next(previous, value, period):
    alpha = 2.0 / (period + 1.0)
    return float(value) * alpha + float(previous) * (1.0 - alpha)


def _sma(values, period, index):
    start = max(0, index - period + 1)
    window = values[start:index + 1]
    return sum(window) / len(window) if window else 0.0


def _series_signature(cfg):
    return (
        cfg["ma_period"],
        cfg["most_percent"],
        cfg["ma_type"],
        cfg["rsi_period"],
        cfg["stoch_rsi_period"],
        cfg["stoch_k_period"],
        cfg["stoch_d_period"],
        cfg["atr_period"],
    )


def _reset_series_cache(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in (
        "ma",
        "close",
        "atr",
        "rsi",
        "avg_gain",
        "avg_loss",
        "stoch_raw",
        "stoch_k",
        "stoch_d",
        "long_stop",
        "short_stop",
        "most",
        "direction",
    ):
        SERIES_CACHE[key] = []


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

    ma = SERIES_CACHE["ma"]
    close_values = SERIES_CACHE["close"]
    atr = SERIES_CACHE["atr"]
    rsi = SERIES_CACHE["rsi"]
    avg_gain = SERIES_CACHE["avg_gain"]
    avg_loss = SERIES_CACHE["avg_loss"]
    stoch_raw = SERIES_CACHE["stoch_raw"]
    stoch_k = SERIES_CACHE["stoch_k"]
    stoch_d = SERIES_CACHE["stoch_d"]
    long_stop = SERIES_CACHE["long_stop"]
    short_stop = SERIES_CACHE["short_stop"]
    most = SERIES_CACHE["most"]
    direction = SERIES_CACHE["direction"]

    percent = cfg["most_percent"] / 100.0

    for i in range(count, len(candles)):
        close = float(candles[i]["c"])
        close_values.append(close)
        high = float(candles[i]["h"])
        low = float(candles[i]["l"])

        if i == 0:
            ma_value = close
            atr_value = 0.0
            avg_gain_value = 0.0
            avg_loss_value = 0.0
            rsi_value = 50.0
        else:
            ma_value = (
                _ema_next(ma[-1], close, cfg["ma_period"])
                if cfg["ma_type"] == "ema"
                else _sma(close_values, cfg["ma_period"], i)
            )
            prev_close = close_values[i - 1]
            tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
            atr_value = _ema_next(atr[-1], tr, cfg["atr_period"])

            change = close - prev_close
            gain = max(change, 0.0)
            loss = max(-change, 0.0)
            if i == 1:
                avg_gain_value = gain
                avg_loss_value = loss
            elif i <= cfg["rsi_period"]:
                avg_gain_value = (avg_gain[-1] * (i - 1) + gain) / i
                avg_loss_value = (avg_loss[-1] * (i - 1) + loss) / i
            else:
                avg_gain_value = (avg_gain[-1] * (cfg["rsi_period"] - 1) + gain) / cfg["rsi_period"]
                avg_loss_value = (avg_loss[-1] * (cfg["rsi_period"] - 1) + loss) / cfg["rsi_period"]
            if avg_loss_value == 0:
                rsi_value = 100.0 if avg_gain_value > 0 else 50.0
            else:
                rs = avg_gain_value / avg_loss_value
                rsi_value = 100.0 - 100.0 / (1.0 + rs)

        ma.append(ma_value)
        atr.append(atr_value)
        avg_gain.append(avg_gain_value)
        avg_loss.append(avg_loss_value)
        rsi.append(rsi_value)

        rsi_start = max(0, i - cfg["stoch_rsi_period"] + 1)
        rsi_window = rsi[rsi_start:i + 1]
        rsi_low = min(rsi_window)
        rsi_high = max(rsi_window)
        raw = 50.0 if rsi_high == rsi_low else (rsi_value - rsi_low) / (rsi_high - rsi_low) * 100.0
        stoch_raw.append(raw)
        k_start = max(0, i - cfg["stoch_k_period"] + 1)
        k_value = sum(stoch_raw[k_start:i + 1]) / len(stoch_raw[k_start:i + 1])
        stoch_k.append(k_value)
        d_start = max(0, i - cfg["stoch_d_period"] + 1)
        d_value = sum(stoch_k[d_start:i + 1]) / len(stoch_k[d_start:i + 1])
        stoch_d.append(d_value)

        base_long = ma_value * (1.0 - percent)
        base_short = ma_value * (1.0 + percent)
        if i == 0:
            long_value = base_long
            short_value = base_short
            dir_value = 1 if close >= ma_value else -1
        else:
            prev_long = long_stop[-1]
            prev_short = short_stop[-1]
            prev_dir = direction[-1]
            long_value = max(base_long, prev_long) if ma_value > prev_long else base_long
            short_value = min(base_short, prev_short) if ma_value < prev_short else base_short
            if prev_dir == -1 and ma_value > prev_short:
                dir_value = 1
            elif prev_dir == 1 and ma_value < prev_long:
                dir_value = -1
            else:
                dir_value = prev_dir

        long_stop.append(long_value)
        short_stop.append(short_value)
        direction.append(dir_value)
        most.append(long_value if dir_value == 1 else short_value)

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return {
        "ma": ma,
        "atr": atr,
        "rsi": rsi,
        "stoch_k": stoch_k,
        "stoch_d": stoch_d,
        "most": most,
        "direction": direction,
    }


def _full_series(candles, cfg):
    saved = {key: SERIES_CACHE[key] for key in SERIES_CACHE}
    try:
        _reset_series_cache(_series_signature(cfg))
        return _cached_series(candles, cfg)
    finally:
        for key, value in saved.items():
            SERIES_CACHE[key] = value


def _ready(candles, cfg):
    return len(candles) >= max(
        cfg["ma_period"] + 2,
        cfg["rsi_period"] + cfg["stoch_rsi_period"] + cfg["stoch_d_period"] + 2,
        cfg["atr_period"] + 2,
    )


def _passes_filters(side, series, cfg):
    rsi = series["rsi"][-1]
    k = series["stoch_k"][-1]
    d = series["stoch_d"][-1]
    prev_k = series["stoch_k"][-2]
    prev_d = series["stoch_d"][-2]

    if cfg["use_rsi_filter"]:
        if side == "BUY" and not (cfg["rsi_long_min"] <= rsi <= cfg["rsi_long_max"]):
            return False
        if side == "SELL" and not (cfg["rsi_short_min"] <= rsi <= cfg["rsi_short_max"]):
            return False

    if cfg["use_stoch_rsi_filter"]:
        if side == "BUY":
            in_zone = cfg["stoch_long_min"] <= k <= cfg["stoch_long_max"]
            momentum = k > d
            crossed = prev_k <= prev_d and k > d
        else:
            in_zone = cfg["stoch_short_min"] <= k <= cfg["stoch_short_max"]
            momentum = k < d
            crossed = prev_k >= prev_d and k < d
        if not in_zone:
            return False
        if cfg["require_stoch_cross"]:
            return crossed
        return momentum

    return True


def _signals(candles, series, cfg):
    idx = len(candles) - 1
    close = float(candles[-1]["c"])
    prev_close = float(candles[-2]["c"])
    ma = series["ma"]
    direction = series["direction"]
    most = series["most"]

    flipped_long = direction[-2] <= 0 and direction[-1] > 0
    flipped_short = direction[-2] >= 0 and direction[-1] < 0
    reclaimed_long = direction[-1] > 0 and prev_close <= ma[-2] and close > ma[-1]
    reclaimed_short = direction[-1] < 0 and prev_close >= ma[-2] and close < ma[-1]

    if cfg["entry_mode"] == "flip":
        long_signal = flipped_long
        short_signal = flipped_short
    elif cfg["entry_mode"] == "trend":
        long_signal = direction[-1] > 0 and close > ma[-1] and close > most[-1]
        short_signal = direction[-1] < 0 and close < ma[-1] and close < most[-1]
    else:
        long_signal = flipped_long or reclaimed_long
        short_signal = flipped_short or reclaimed_short

    return long_signal, short_signal, idx


def _risk_levels(side, entry, series, cfg):
    atr = max(0.0, float(series["atr"][-1]))
    most = float(series["most"][-1])
    min_distance = entry * cfg["min_stop_pct"] / 100.0
    max_distance = entry * cfg["max_stop_pct"] / 100.0

    candidates = []
    if cfg["stop_mode"] in ("most", "most_atr"):
        if side == "BUY" and most < entry:
            candidates.append(entry - most)
        if side == "SELL" and most > entry:
            candidates.append(most - entry)
    if cfg["stop_mode"] in ("atr", "most_atr") and atr > 0:
        candidates.append(atr * cfg["stop_atr"])

    distance = min(candidates) if candidates else min_distance
    distance = max(min_distance, min(distance, max_distance))

    if side == "BUY":
        sl = entry - distance
        tp = entry + distance * cfg["reward_risk"]
    else:
        sl = entry + distance
        tp = entry - distance * cfg["reward_risk"]
    return sl, tp


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []
    series = _full_series(candles, cfg)
    limit = 500
    ma = series["ma"][-limit:]
    most = series["most"][-limit:]

    signal_labels = []
    start = max(1, len(candles) - limit)
    for i in range(start, len(candles)):
        sub = {key: values[:i + 1] for key, values in series.items()}
        if len(sub["ma"]) < 2:
            continue
        long_signal, short_signal, _idx = _signals(candles[:i + 1], sub, cfg)
        if long_signal and _passes_filters("BUY", sub, cfg):
            signal_labels.append({
                "type": "label",
                "point": {"time": candles[i]["t"], "price": candles[i]["l"]},
                "text": "MOST BUY",
                "color": "#22c55e",
                "textcolor": "#07110b",
                "style": "label_up",
            })
        elif short_signal and _passes_filters("SELL", sub, cfg):
            signal_labels.append({
                "type": "label",
                "point": {"time": candles[i]["t"], "price": candles[i]["h"]},
                "text": "MOST SELL",
                "color": "#ef4444",
                "textcolor": "#140606",
                "style": "label_down",
            })

    return [
        {
            "type": "plot",
            "title": f"MOST MA {cfg['ma_period']}",
            "points": [{"time": candles[len(candles) - len(ma) + i]["t"], "value": value} for i, value in enumerate(ma)],
            "color": "#38bdf8",
            "linewidth": 1,
        },
        {
            "type": "plot",
            "title": f"MOST {cfg['most_percent']}%",
            "points": [{"time": candles[len(candles) - len(most) + i]["t"], "value": value} for i, value in enumerate(most)],
            "color": "#f59e0b",
            "linewidth": 2,
        },
        *signal_labels[-80:],
    ]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    series = _cached_series(candles, cfg)
    long_signal, short_signal, idx = _signals(candles, series, cfg)
    current_side = getattr(portfolio, "side", None)
    close_price = float(candles[-1]["c"])

    if LAST_SIGNAL_BAR is not None and idx - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    if long_signal and current_side != "BUY" and _passes_filters("BUY", series, cfg):
        sl, tp = _risk_levels("BUY", close_price, series, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe(
            "most.long",
            side="long",
            ma_period=cfg["ma_period"],
            most_percent=cfg["most_percent"],
            rsi=round(series["rsi"][-1], 2),
            stoch_k=round(series["stoch_k"][-1], 2),
        )
        buy()
        return

    if short_signal and current_side == "BUY" and not cfg["allow_short"]:
        LAST_SIGNAL_BAR = idx
        _observe(
            "most.close_long",
            side="long",
            ma_period=cfg["ma_period"],
            most_percent=cfg["most_percent"],
            rsi=round(series["rsi"][-1], 2),
            stoch_k=round(series["stoch_k"][-1], 2),
        )
        close()
        return

    if cfg["allow_short"] and short_signal and current_side != "SELL" and _passes_filters("SELL", series, cfg):
        sl, tp = _risk_levels("SELL", close_price, series, cfg)
        set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe(
            "most.short",
            side="short",
            ma_period=cfg["ma_period"],
            most_percent=cfg["most_percent"],
            rsi=round(series["rsi"][-1], 2),
            stoch_k=round(series["stoch_k"][-1], 2),
        )
        sell()
        return

    hold()
