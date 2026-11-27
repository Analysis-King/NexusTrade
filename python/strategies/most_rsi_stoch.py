# name: MOST RSI Stoch Trend
# desc: MOST MA 5 percent 2 temelli trend stratejisi; opsiyonel RSI ve Stoch RSI filtreleri kullanir
# author: NexusTrade
# version: 1.0

import builtins as _builtins
from indicators.bars import bar_number


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
    "adx": [],
    "plus_di": [],
    "minus_di": [],
    "smooth_tr": [],
    "smooth_plus": [],
    "smooth_minus": [],
    "volume_ma": [],
    "long_stop": [],
    "short_stop": [],
    "most": [],
    "direction": [],
}

LAST_SIGNAL_BAR = None
ENTRY_BAR = None


def initialize():
    return {
        "ma_period": 5,
        "most_percent": 2.0,
        "most_mode": "fixed",
        "most_atr_multiplier": 1.5,
        "min_most_percent": 0.5,
        "max_most_percent": 4.0,
        "ma_type": "ema",
        "allow_long": True,
        "allow_short": True,
        "entry_mode": "flip_reclaim",
        "long_entry_mode": "",
        "short_entry_mode": "",
        "min_trend_age_bars": 0,
        "max_trend_age_bars": 0,
        "exit_on_color_flip": False,
        "exit_mode": "none",
        "max_hold_bars": 0,
        "trail_mode": "none",
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
        "use_regime_filter": False,
        "adx_period": 14,
        "min_adx": 18.0,
        "min_di_spread": 0.0,
        "require_di_direction": True,
        "volume_period": 30,
        "min_volume_ratio": 0.0,
        "min_atr_pct": 0.0,
        "max_atr_pct": 0.0,
        "require_rejection_candle": False,
        "min_rejection_body_ratio": 0.0,
        "max_retest_penetration_atr": 0.0,
        "min_close_distance_atr": 0.0,
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
    cfg["most_mode"] = str(cfg.get("most_mode") or "fixed").strip().lower()
    if cfg["most_mode"] not in ("fixed", "atr"):
        cfg["most_mode"] = "fixed"
    cfg["most_atr_multiplier"] = max(0.05, _to_float(cfg.get("most_atr_multiplier"), 1.5))
    cfg["min_most_percent"] = max(0.05, _to_float(cfg.get("min_most_percent"), 0.5))
    cfg["max_most_percent"] = max(
        cfg["min_most_percent"],
        _to_float(cfg.get("max_most_percent"), 4.0),
    )
    cfg["ma_type"] = str(cfg.get("ma_type") or "ema").strip().lower()
    if cfg["ma_type"] not in ("ema", "sma"):
        cfg["ma_type"] = "ema"
    cfg["allow_long"] = _to_bool(cfg.get("allow_long"), True)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["entry_mode"] = str(cfg.get("entry_mode") or "flip_reclaim").strip().lower()
    if cfg["entry_mode"] not in (
        "flip",
        "flip_reclaim",
        "trend",
        "retest_rejection",
        "retest_confirmation",
    ):
        cfg["entry_mode"] = "flip_reclaim"
    valid_entry_modes = {
        "flip",
        "flip_reclaim",
        "trend",
        "retest_rejection",
        "retest_confirmation",
    }
    cfg["long_entry_mode"] = str(cfg.get("long_entry_mode") or cfg["entry_mode"]).strip().lower()
    cfg["short_entry_mode"] = str(cfg.get("short_entry_mode") or cfg["entry_mode"]).strip().lower()
    if cfg["long_entry_mode"] not in valid_entry_modes:
        cfg["long_entry_mode"] = cfg["entry_mode"]
    if cfg["short_entry_mode"] not in valid_entry_modes:
        cfg["short_entry_mode"] = cfg["entry_mode"]
    cfg["min_trend_age_bars"] = max(0, _to_int(cfg.get("min_trend_age_bars"), 0))
    cfg["max_trend_age_bars"] = max(0, _to_int(cfg.get("max_trend_age_bars"), 0))
    cfg["exit_on_color_flip"] = _to_bool(cfg.get("exit_on_color_flip"), False)
    cfg["exit_mode"] = str(cfg.get("exit_mode") or "none").strip().lower()
    if cfg["exit_mode"] not in ("none", "color_flip", "most_cross", "ma_cross"):
        cfg["exit_mode"] = "none"
    cfg["max_hold_bars"] = max(0, _to_int(cfg.get("max_hold_bars"), 0))
    cfg["trail_mode"] = str(cfg.get("trail_mode") or "none").strip().lower()
    if cfg["trail_mode"] not in ("none", "most"):
        cfg["trail_mode"] = "none"
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
    cfg["use_regime_filter"] = _to_bool(cfg.get("use_regime_filter"), False)
    cfg["adx_period"] = max(2, _to_int(cfg.get("adx_period"), 14))
    cfg["min_adx"] = max(0.0, _to_float(cfg.get("min_adx"), 18.0))
    cfg["min_di_spread"] = max(0.0, _to_float(cfg.get("min_di_spread"), 0.0))
    cfg["require_di_direction"] = _to_bool(cfg.get("require_di_direction"), True)
    cfg["volume_period"] = max(2, _to_int(cfg.get("volume_period"), 30))
    cfg["min_volume_ratio"] = max(0.0, _to_float(cfg.get("min_volume_ratio"), 0.0))
    cfg["min_atr_pct"] = max(0.0, _to_float(cfg.get("min_atr_pct"), 0.0))
    cfg["max_atr_pct"] = max(0.0, _to_float(cfg.get("max_atr_pct"), 0.0))
    cfg["require_rejection_candle"] = _to_bool(cfg.get("require_rejection_candle"), False)
    cfg["min_rejection_body_ratio"] = min(
        1.0,
        max(0.0, _to_float(cfg.get("min_rejection_body_ratio"), 0.0)),
    )
    cfg["max_retest_penetration_atr"] = max(
        0.0,
        _to_float(cfg.get("max_retest_penetration_atr"), 0.0),
    )
    cfg["min_close_distance_atr"] = max(0.0, _to_float(cfg.get("min_close_distance_atr"), 0.0))
    cfg["stop_mode"] = str(cfg.get("stop_mode") or "most_atr").strip().lower()
    if cfg["stop_mode"] not in ("none", "most", "atr", "most_atr"):
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
        cfg["most_mode"],
        cfg["most_atr_multiplier"],
        cfg["min_most_percent"],
        cfg["max_most_percent"],
        cfg["ma_type"],
        cfg["rsi_period"],
        cfg["stoch_rsi_period"],
        cfg["stoch_k_period"],
        cfg["stoch_d_period"],
        cfg["atr_period"],
        cfg["adx_period"],
        cfg["volume_period"],
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
        "adx",
        "plus_di",
        "minus_di",
        "smooth_tr",
        "smooth_plus",
        "smooth_minus",
        "volume_ma",
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
    adx = SERIES_CACHE["adx"]
    plus_di = SERIES_CACHE["plus_di"]
    minus_di = SERIES_CACHE["minus_di"]
    smooth_tr = SERIES_CACHE["smooth_tr"]
    smooth_plus = SERIES_CACHE["smooth_plus"]
    smooth_minus = SERIES_CACHE["smooth_minus"]
    volume_ma = SERIES_CACHE["volume_ma"]
    long_stop = SERIES_CACHE["long_stop"]
    short_stop = SERIES_CACHE["short_stop"]
    most = SERIES_CACHE["most"]
    direction = SERIES_CACHE["direction"]

    for i in range(count, len(candles)):
        close = float(candles[i]["c"])
        close_values.append(close)
        high = float(candles[i]["h"])
        low = float(candles[i]["l"])
        volume = float(candles[i].get("v", 0.0))

        if i == 0:
            ma_value = close
            atr_value = 0.0
            adx_value = 0.0
            plus_di_value = 0.0
            minus_di_value = 0.0
            smooth_tr_value = 0.0
            smooth_plus_value = 0.0
            smooth_minus_value = 0.0
            volume_ma_value = volume
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
            prev_high = float(candles[i - 1]["h"])
            prev_low = float(candles[i - 1]["l"])
            up = high - prev_high
            down = prev_low - low
            plus_dm = up if up > down and up > 0 else 0.0
            minus_dm = down if down > up and down > 0 else 0.0
            smooth_tr_value = _ema_next(smooth_tr[-1], tr, cfg["adx_period"])
            smooth_plus_value = _ema_next(smooth_plus[-1], plus_dm, cfg["adx_period"])
            smooth_minus_value = _ema_next(smooth_minus[-1], minus_dm, cfg["adx_period"])
            if smooth_tr_value <= 0:
                plus_di_value = 0.0
                minus_di_value = 0.0
            else:
                plus_di_value = 100.0 * smooth_plus_value / smooth_tr_value
                minus_di_value = 100.0 * smooth_minus_value / smooth_tr_value
            di_total = plus_di_value + minus_di_value
            dx = 0.0 if di_total <= 0 else 100.0 * abs(plus_di_value - minus_di_value) / di_total
            adx_value = _ema_next(adx[-1], dx, cfg["adx_period"])
            volume_ma_value = _ema_next(volume_ma[-1], volume, cfg["volume_period"])

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
        adx.append(adx_value)
        plus_di.append(plus_di_value)
        minus_di.append(minus_di_value)
        smooth_tr.append(smooth_tr_value)
        smooth_plus.append(smooth_plus_value)
        smooth_minus.append(smooth_minus_value)
        volume_ma.append(volume_ma_value)
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

        if cfg["most_mode"] == "atr" and ma_value > 0:
            most_percent = atr_value * cfg["most_atr_multiplier"] / ma_value * 100.0
            most_percent = max(
                cfg["min_most_percent"],
                min(most_percent, cfg["max_most_percent"]),
            )
        else:
            most_percent = cfg["most_percent"]
        percent = most_percent / 100.0
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
        "adx": adx,
        "plus_di": plus_di,
        "minus_di": minus_di,
        "volume_ma": volume_ma,
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
        cfg["adx_period"] * 2 + 2,
        cfg["volume_period"] + 2,
    )


def _passes_filters(side, candles, series, cfg):
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
            if not crossed:
                return False
        elif not momentum:
            return False

    if cfg["use_regime_filter"]:
        close = max(1e-12, float(candles[-1]["c"]))
        atr = max(0.0, float(series["atr"][-1]))
        atr_pct = atr / close * 100.0
        adx = float(series["adx"][-1])
        plus_di = float(series["plus_di"][-1])
        minus_di = float(series["minus_di"][-1])
        di_spread = abs(plus_di - minus_di)
        volume_ma = max(1e-12, float(series["volume_ma"][-1]))
        volume_ratio = float(candles[-1].get("v", 0.0)) / volume_ma

        if adx < cfg["min_adx"] or di_spread < cfg["min_di_spread"]:
            return False
        if cfg["require_di_direction"]:
            if side == "BUY" and plus_di <= minus_di:
                return False
            if side == "SELL" and minus_di <= plus_di:
                return False
        if cfg["min_atr_pct"] > 0 and atr_pct < cfg["min_atr_pct"]:
            return False
        if cfg["max_atr_pct"] > 0 and atr_pct > cfg["max_atr_pct"]:
            return False
        if cfg["min_volume_ratio"] > 0 and volume_ratio < cfg["min_volume_ratio"]:
            return False

        if cfg["entry_mode"] == "retest_rejection" and atr > 0:
            open_price = float(candles[-1]["o"])
            high = float(candles[-1]["h"])
            low = float(candles[-1]["l"])
            most = float(series["most"][-1])
            candle_range = max(1e-12, high - low)
            body_ratio = abs(close - open_price) / candle_range
            penetration_atr = (most - low) / atr if side == "BUY" else (high - most) / atr
            close_distance_atr = abs(close - most) / atr
            if cfg["require_rejection_candle"]:
                if side == "BUY" and close <= open_price:
                    return False
                if side == "SELL" and close >= open_price:
                    return False
            if body_ratio < cfg["min_rejection_body_ratio"]:
                return False
            if (
                cfg["max_retest_penetration_atr"] > 0
                and penetration_atr > cfg["max_retest_penetration_atr"]
            ):
                return False
            if close_distance_atr < cfg["min_close_distance_atr"]:
                return False

    return True


def _signals(candles, series, cfg):
    idx = len(candles) - 1
    close = float(candles[-1]["c"])
    prev_close = float(candles[-2]["c"])
    open_price = float(candles[-1]["o"])
    high = float(candles[-1]["h"])
    low = float(candles[-1]["l"])
    ma = series["ma"]
    direction = series["direction"]
    most = series["most"]

    flipped_long = direction[-2] <= 0 and direction[-1] > 0
    flipped_short = direction[-2] >= 0 and direction[-1] < 0
    reclaimed_long = direction[-1] > 0 and prev_close <= ma[-2] and close > ma[-1]
    reclaimed_short = direction[-1] < 0 and prev_close >= ma[-2] and close < ma[-1]
    trend_age = 0
    current_direction = direction[-1]
    for pos in range(len(direction) - 2, -1, -1):
        if direction[pos] != current_direction:
            break
        trend_age += 1

    retest_long = (
        direction[-2] > 0
        and direction[-1] > 0
        and open_price > most[-1]
        and low <= most[-1]
        and close > most[-1]
    )
    retest_short = (
        direction[-2] < 0
        and direction[-1] < 0
        and open_price < most[-1]
        and high >= most[-1]
        and close < most[-1]
    )
    prev_open = float(candles[-2]["o"])
    prev_high = float(candles[-2]["h"])
    prev_low = float(candles[-2]["l"])
    prior_long_retest = (
        direction[-3] > 0
        and direction[-2] > 0
        and prev_open > most[-2]
        and prev_low <= most[-2]
        and prev_close > most[-2]
    )
    prior_short_retest = (
        direction[-3] < 0
        and direction[-2] < 0
        and prev_open < most[-2]
        and prev_high >= most[-2]
        and prev_close < most[-2]
    )
    confirmation_long = direction[-1] > 0 and prior_long_retest and close > prev_high
    confirmation_short = direction[-1] < 0 and prior_short_retest and close < prev_low

    def select_signal(mode, side):
        if mode == "flip":
            return flipped_long if side == "long" else flipped_short
        if mode == "retest_rejection":
            return retest_long if side == "long" else retest_short
        if mode == "retest_confirmation":
            return confirmation_long if side == "long" else confirmation_short
        if mode == "trend":
            if side == "long":
                return direction[-1] > 0 and close > ma[-1] and close > most[-1]
            return direction[-1] < 0 and close < ma[-1] and close < most[-1]
        return (flipped_long or reclaimed_long) if side == "long" else (flipped_short or reclaimed_short)

    long_signal = select_signal(cfg["long_entry_mode"], "long")
    short_signal = select_signal(cfg["short_entry_mode"], "short")

    if cfg["min_trend_age_bars"] > 0 and trend_age < cfg["min_trend_age_bars"]:
        long_signal = False
        short_signal = False
    if cfg["max_trend_age_bars"] > 0 and trend_age > cfg["max_trend_age_bars"]:
        long_signal = False
        short_signal = False

    return long_signal, short_signal, idx


def _risk_levels(side, entry, series, cfg):
    if cfg["stop_mode"] == "none":
        return None, None

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
        if long_signal and _passes_filters("BUY", candles[:i + 1], sub, cfg):
            signal_labels.append({
                "type": "label",
                "point": {"time": candles[i]["t"], "price": candles[i]["l"]},
                "text": "MOST BUY",
                "color": "#22c55e",
                "textcolor": "#07110b",
                "style": "label_up",
            })
        elif short_signal and _passes_filters("SELL", candles[:i + 1], sub, cfg):
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
    global LAST_SIGNAL_BAR, ENTRY_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    series = _cached_series(candles, cfg)
    long_signal, short_signal, _ = _signals(candles, series, cfg)
    bar = bar_number(candles)
    current_side = getattr(portfolio, "side", None)
    close_price = float(candles[-1]["c"])
    if current_side not in ("BUY", "SELL"):
        ENTRY_BAR = None

    direction = series["direction"]
    flipped_long = direction[-2] <= 0 and direction[-1] > 0
    flipped_short = direction[-2] >= 0 and direction[-1] < 0
    should_exit = False
    if current_side in ("BUY", "SELL"):
        if cfg["exit_on_color_flip"] or cfg["exit_mode"] == "color_flip":
            should_exit = (
                (current_side == "BUY" and flipped_short)
                or (current_side == "SELL" and flipped_long)
            )
        elif cfg["exit_mode"] == "most_cross":
            should_exit = (
                (current_side == "BUY" and close_price < float(series["most"][-1]))
                or (current_side == "SELL" and close_price > float(series["most"][-1]))
            )
        elif cfg["exit_mode"] == "ma_cross":
            should_exit = (
                (current_side == "BUY" and close_price < float(series["ma"][-1]))
                or (current_side == "SELL" and close_price > float(series["ma"][-1]))
            )
        if cfg["max_hold_bars"] > 0 and ENTRY_BAR is not None and bar - ENTRY_BAR >= cfg["max_hold_bars"]:
            should_exit = True
        if should_exit:
            LAST_SIGNAL_BAR = bar
            ENTRY_BAR = None
            close()
            return

    if LAST_SIGNAL_BAR is not None and bar - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    if cfg["allow_long"] and long_signal and current_side != "BUY" and _passes_filters("BUY", candles, series, cfg):
        sl, tp = _risk_levels("BUY", close_price, series, cfg)
        if sl is not None:
            set_sl(price=sl)
        if cfg["use_take_profit"] and tp is not None:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        ENTRY_BAR = bar
        _observe(
            "most.long",
            side="long",
            ma_period=cfg["ma_period"],
            most_percent=cfg["most_percent"],
            rsi=round(series["rsi"][-1], 2),
            stoch_k=round(series["stoch_k"][-1], 2),
            adx=round(series["adx"][-1], 2),
        )
        buy()
        return

    if short_signal and current_side == "BUY" and not cfg["allow_short"]:
        LAST_SIGNAL_BAR = bar
        ENTRY_BAR = None
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

    if cfg["allow_short"] and short_signal and current_side != "SELL" and _passes_filters("SELL", candles, series, cfg):
        sl, tp = _risk_levels("SELL", close_price, series, cfg)
        if sl is not None:
            set_sl(price=sl)
        if cfg["use_take_profit"] and tp is not None:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = bar
        ENTRY_BAR = bar
        _observe(
            "most.short",
            side="short",
            ma_period=cfg["ma_period"],
            most_percent=cfg["most_percent"],
            rsi=round(series["rsi"][-1], 2),
            stoch_k=round(series["stoch_k"][-1], 2),
            adx=round(series["adx"][-1], 2),
        )
        sell()
        return

    hold()
