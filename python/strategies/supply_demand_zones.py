# name: Automatic Supply Demand Zones
# desc: Base + impulse supply/demand zone detector with freshness, strength and retest entries
# author: NexusTrade
# version: 1.0

import builtins as _builtins
from indicators.bars import bar_number

LAST_SIGNAL_BAR = None
TRADED_ZONES = set()
OBSERVED_ZONES = set()
ZONE_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "zones": [],
    "seen": set(),
    "atr": [],
    "volume_sma": [],
}


def initialize():
    return {
        "atr_period": 14,
        "volume_ma_period": 20,
        "base_min_bars": 2,
        "base_max_bars": 6,
        "base_max_atr": 0.85,
        "zone_max_atr": 1.7,
        "impulse_atr": 1.35,
        "min_body_ratio": 0.55,
        "min_departure_atr": 0.45,
        "min_volume_ratio": 0.85,
        "zone_padding_atr": 0.08,
        "invalidation_atr": 0.08,
        "test_gap_bars": 3,
        "max_tests": 1,
        "fresh_only": False,
        "min_entry_age_bars": 4,
        "max_zone_age_bars": 420,
        "range_filter": True,
        "range_lookback": 120,
        "demand_max_range_pos": 0.48,
        "supply_min_range_pos": 0.52,
        "min_strength": 58.0,
        "max_zones": 20,
        "max_scan_candles": 1800,
        "entry_mode": "rejection",
        "min_rejection_body_ratio": 0.25,
        "stop_buffer_atr": 0.16,
        "reward_risk": 1.8,
        "target_mode": "opposite_zone_or_rr",
        "min_reward_risk": 1.0,
        "cooldown_bars": 5,
        "allow_short": True,
        "exit_on_opposite_signal": True,
        "htf_filter": "off",
        "htf_timeframe": "4h",
        "htf_fast_period": 21,
        "htf_slow_period": 55,
        "htf_slope_lookback": 6,
        "draw_history_bars": 800,
        "draw_max_zones": 12,
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

    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["volume_ma_period"] = max(2, _to_int(cfg.get("volume_ma_period"), 20))
    cfg["base_min_bars"] = max(1, _to_int(cfg.get("base_min_bars"), 2))
    cfg["base_max_bars"] = max(cfg["base_min_bars"], _to_int(cfg.get("base_max_bars"), 6))
    cfg["base_max_atr"] = max(0.1, _to_float(cfg.get("base_max_atr"), 0.85))
    cfg["zone_max_atr"] = max(0.2, _to_float(cfg.get("zone_max_atr"), 1.7))
    cfg["impulse_atr"] = max(0.2, _to_float(cfg.get("impulse_atr"), 1.35))
    cfg["min_body_ratio"] = max(0.0, min(1.0, _to_float(cfg.get("min_body_ratio"), 0.55)))
    cfg["min_departure_atr"] = max(0.0, _to_float(cfg.get("min_departure_atr"), 0.45))
    cfg["min_volume_ratio"] = max(0.0, _to_float(cfg.get("min_volume_ratio"), 0.85))
    cfg["zone_padding_atr"] = max(0.0, _to_float(cfg.get("zone_padding_atr"), 0.08))
    cfg["invalidation_atr"] = max(0.0, _to_float(cfg.get("invalidation_atr"), 0.08))
    cfg["test_gap_bars"] = max(1, _to_int(cfg.get("test_gap_bars"), 3))
    cfg["max_tests"] = max(0, _to_int(cfg.get("max_tests"), 1))
    cfg["fresh_only"] = _to_bool(cfg.get("fresh_only"), False)
    cfg["min_entry_age_bars"] = max(0, _to_int(cfg.get("min_entry_age_bars"), 4))
    cfg["max_zone_age_bars"] = max(5, _to_int(cfg.get("max_zone_age_bars"), 420))
    cfg["range_filter"] = _to_bool(cfg.get("range_filter"), True)
    cfg["range_lookback"] = max(10, _to_int(cfg.get("range_lookback"), 120))
    cfg["demand_max_range_pos"] = max(0.0, min(1.0, _to_float(cfg.get("demand_max_range_pos"), 0.48)))
    cfg["supply_min_range_pos"] = max(0.0, min(1.0, _to_float(cfg.get("supply_min_range_pos"), 0.52)))
    cfg["min_strength"] = max(0.0, min(100.0, _to_float(cfg.get("min_strength"), 58.0)))
    cfg["max_zones"] = max(1, _to_int(cfg.get("max_zones"), 20))
    cfg["max_scan_candles"] = max(100, _to_int(cfg.get("max_scan_candles"), 1800))
    cfg["entry_mode"] = str(cfg.get("entry_mode") or "rejection").strip().lower()
    if cfg["entry_mode"] not in ("touch", "rejection", "close_outside"):
        cfg["entry_mode"] = "rejection"
    cfg["min_rejection_body_ratio"] = max(0.0, min(1.0, _to_float(cfg.get("min_rejection_body_ratio"), 0.25)))
    cfg["stop_buffer_atr"] = max(0.0, _to_float(cfg.get("stop_buffer_atr"), 0.16))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 1.8))
    cfg["target_mode"] = str(cfg.get("target_mode") or "opposite_zone_or_rr").strip().lower()
    if cfg["target_mode"] not in ("rr", "opposite_zone", "opposite_zone_or_rr"):
        cfg["target_mode"] = "opposite_zone_or_rr"
    cfg["min_reward_risk"] = max(0.0, _to_float(cfg.get("min_reward_risk"), 1.0))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 5))
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["exit_on_opposite_signal"] = _to_bool(cfg.get("exit_on_opposite_signal"), True)
    cfg["htf_filter"] = str(cfg.get("htf_filter") or "off").strip().lower()
    if cfg["htf_filter"] in ("trend", "directional"):
        cfg["htf_filter"] = "with_trend"
    if cfg["htf_filter"] not in ("off", "with_trend", "reversal"):
        cfg["htf_filter"] = "off"
    cfg["htf_timeframe"] = str(cfg.get("htf_timeframe") or "4h").strip().lower()
    cfg["htf_fast_period"] = max(2, _to_int(cfg.get("htf_fast_period"), 21))
    cfg["htf_slow_period"] = max(cfg["htf_fast_period"] + 1, _to_int(cfg.get("htf_slow_period"), 55))
    cfg["htf_slope_lookback"] = max(1, _to_int(cfg.get("htf_slope_lookback"), 6))
    cfg["draw_history_bars"] = max(80, _to_int(cfg.get("draw_history_bars"), 800))
    cfg["draw_max_zones"] = max(1, _to_int(cfg.get("draw_max_zones"), 12))
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


def _sma(values, period):
    out = [None] * len(values)
    running = 0.0
    for idx, value in enumerate(values):
        running += float(value)
        if idx >= period:
            running -= float(values[idx - period])
        if idx >= period - 1:
            out[idx] = running / period
    return out


def _timeframe_ms(value):
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text.isdigit():
        return int(text) * 60_000
    unit = text[-1]
    raw = text[:-1]
    try:
        amount = float(raw)
    except (TypeError, ValueError):
        return None
    factors = {"m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}
    factor = factors.get(unit)
    return int(amount * factor) if factor else None


def _aggregate_completed(candles, timeframe_ms):
    if not candles or not timeframe_ms:
        return []
    groups = []
    for candle in candles:
        bucket = int(candle.get("t", 0)) // timeframe_ms
        if not groups or groups[-1]["bucket"] != bucket:
            groups.append({
                "bucket": bucket,
                "t": candle.get("t"),
                "o": _to_float(candle.get("o")),
                "h": _to_float(candle.get("h")),
                "l": _to_float(candle.get("l")),
                "c": _to_float(candle.get("c")),
                "v": _to_float(candle.get("v")),
            })
        else:
            groups[-1]["h"] = max(groups[-1]["h"], _to_float(candle.get("h")))
            groups[-1]["l"] = min(groups[-1]["l"], _to_float(candle.get("l")))
            groups[-1]["c"] = _to_float(candle.get("c"))
            groups[-1]["v"] += _to_float(candle.get("v"))
    return groups[:-1]


def _htf_regime(candles, cfg):
    if cfg["htf_filter"] == "off":
        return "unknown"
    groups = _aggregate_completed(candles, _timeframe_ms(cfg["htf_timeframe"]))
    required = max(cfg["htf_fast_period"], cfg["htf_slow_period"]) + cfg["htf_slope_lookback"]
    if len(groups) < required:
        return "unknown"
    closes = [_to_float(group.get("c")) for group in groups]
    fast = _ema(closes, cfg["htf_fast_period"])
    slow = _ema(closes, cfg["htf_slow_period"])
    idx = len(groups) - 1
    slope_idx = max(0, idx - cfg["htf_slope_lookback"])
    slope_base = slow[slope_idx]
    slope_pct = 0.0 if slope_base == 0 else (slow[idx] / slope_base - 1.0) * 100.0
    close = closes[idx]
    if close > fast[idx] and fast[idx] > slow[idx] and slope_pct > 0:
        return "strong_bull"
    if close > slow[idx] and slope_pct >= 0:
        return "bull"
    if close < fast[idx] and fast[idx] < slow[idx] and slope_pct < 0:
        return "strong_bear"
    if close < slow[idx] and slope_pct <= 0:
        return "bear"
    return "mixed"


def _htf_allows(side, regime, cfg):
    mode = cfg["htf_filter"]
    if mode == "off" or regime == "unknown":
        return True
    bullish = regime in ("strong_bull", "bull")
    bearish = regime in ("strong_bear", "bear")
    if mode == "with_trend":
        return (side == "BUY" and bullish) or (side == "SELL" and bearish)
    if mode == "reversal":
        return (side == "BUY" and bearish) or (side == "SELL" and bullish)
    return True


def _range(candle):
    return max(0.0, _to_float(candle.get("h")) - _to_float(candle.get("l")))


def _body(candle):
    return abs(_to_float(candle.get("c")) - _to_float(candle.get("o")))


def _body_ratio(candle):
    rng = _range(candle)
    return 0.0 if rng <= 0 else _body(candle) / rng


def _close_position(candle):
    rng = _range(candle)
    if rng <= 0:
        return 0.5
    return (_to_float(candle.get("c")) - _to_float(candle.get("l"))) / rng


def _base_candidate(candles, impulse_i, length, atr_value, cfg):
    start = impulse_i - length
    if start < 0:
        return None
    base = candles[start:impulse_i]
    if not base or atr_value <= 0:
        return None
    high = max(_to_float(c.get("h")) for c in base)
    low = min(_to_float(c.get("l")) for c in base)
    height = high - low
    if height <= 0 or height > atr_value * cfg["zone_max_atr"]:
        return None
    avg_range = sum(_range(c) for c in base) / len(base)
    if avg_range > atr_value * cfg["base_max_atr"]:
        return None
    body_high = max(max(_to_float(c.get("o")), _to_float(c.get("c"))) for c in base)
    body_low = min(min(_to_float(c.get("o")), _to_float(c.get("c"))) for c in base)
    return {
        "start_i": start,
        "end_i": impulse_i - 1,
        "high": high,
        "low": low,
        "body_high": body_high,
        "body_low": body_low,
        "height": height,
        "avg_range": avg_range,
        "length": length,
    }


def _score_zone(side, base, impulse, atr_value, volume_ratio, cfg):
    impulse_range = _range(impulse)
    departure = (
        _to_float(impulse.get("c")) - base["high"]
        if side == "demand"
        else base["low"] - _to_float(impulse.get("c"))
    )
    impulse_score = min(30.0, (impulse_range / atr_value) * 12.0) if atr_value > 0 else 0.0
    departure_score = min(25.0, (max(0.0, departure) / atr_value) * 18.0) if atr_value > 0 else 0.0
    tight_score = max(0.0, 20.0 * (1.0 - base["height"] / max(atr_value * cfg["zone_max_atr"], 0.000001)))
    volume_score = min(15.0, max(0.0, volume_ratio - 0.6) * 12.0)
    base_score = min(10.0, float(base["length"]) * 2.0)
    return max(0.0, min(100.0, impulse_score + departure_score + tight_score + volume_score + base_score))


def _detect_zone_at(candles, i, atr_values, volume_sma, cfg):
    if i <= cfg["base_max_bars"]:
        return []
    impulse = candles[i]
    atr_value = atr_values[i] if i < len(atr_values) else 0.0
    if atr_value <= 0:
        return []
    volume_avg = volume_sma[i - 1] if i - 1 < len(volume_sma) else None
    volume_ratio = 1.0
    if volume_avg and volume_avg > 0:
        volume_ratio = _to_float(impulse.get("v")) / volume_avg

    impulse_range = _range(impulse)
    body_ratio = _body_ratio(impulse)
    close_pos = _close_position(impulse)
    if impulse_range < atr_value * cfg["impulse_atr"]:
        return []
    if body_ratio < cfg["min_body_ratio"] or volume_ratio < cfg["min_volume_ratio"]:
        return []

    found = []
    for side in ("demand", "supply"):
        if side == "demand" and close_pos < 0.62:
            continue
        if side == "supply" and close_pos > 0.38:
            continue
        best = None
        for length in range(cfg["base_min_bars"], cfg["base_max_bars"] + 1):
            base = _base_candidate(candles, i, length, atr_value, cfg)
            if base is None:
                continue
            close = _to_float(impulse.get("c"))
            if side == "demand":
                departure = close - base["high"]
                if departure < atr_value * cfg["min_departure_atr"]:
                    continue
                top = max(base["high"], base["body_high"]) + atr_value * cfg["zone_padding_atr"]
                bottom = base["low"] - atr_value * cfg["zone_padding_atr"]
            else:
                departure = base["low"] - close
                if departure < atr_value * cfg["min_departure_atr"]:
                    continue
                top = base["high"] + atr_value * cfg["zone_padding_atr"]
                bottom = min(base["low"], base["body_low"]) - atr_value * cfg["zone_padding_atr"]
            score = _score_zone(side, base, impulse, atr_value, volume_ratio, cfg)
            candidate = {
                "id": f"{side}:{base['start_i']}:{base['end_i']}:{i}",
                "type": side,
                "side": "BUY" if side == "demand" else "SELL",
                "start_i": base["start_i"],
                "end_i": base["end_i"],
                "origin_i": i,
                "start_t": candles[base["start_i"]].get("t"),
                "origin_t": impulse.get("t"),
                "top": top,
                "bottom": bottom,
                "mid": (top + bottom) / 2.0,
                "height": top - bottom,
                "atr": atr_value,
                "strength": score,
                "raw_strength": score,
                "volume_ratio": volume_ratio,
                "departure_atr": departure / atr_value if atr_value > 0 else 0.0,
                "tests": 0,
                "last_test_i": None,
                "active": True,
            }
            if best is None or candidate["strength"] > best["strength"]:
                best = candidate
        if best is not None:
            found.append(best)
    return found


def _touches(zone, candle):
    high = _to_float(candle.get("h"))
    low = _to_float(candle.get("l"))
    return low <= zone["top"] and high >= zone["bottom"]


def _update_zone(zone, candle, i, atr_value, cfg):
    if not zone.get("active"):
        return
    close = _to_float(candle.get("c"))
    invalid_buffer = atr_value * cfg["invalidation_atr"]
    if zone["type"] == "demand" and close < zone["bottom"] - invalid_buffer:
        zone["active"] = False
        zone["invalidated_i"] = i
        return
    if zone["type"] == "supply" and close > zone["top"] + invalid_buffer:
        zone["active"] = False
        zone["invalidated_i"] = i
        return
    if i <= zone["origin_i"] + 1:
        return
    if _touches(zone, candle):
        last = zone.get("last_test_i")
        if last is None or i - last >= cfg["test_gap_bars"]:
            zone["tests"] += 1
            zone["last_test_i"] = i
            zone["strength"] = max(0.0, zone["raw_strength"] - zone["tests"] * 12.0)


def scan_zones(candles, config=None):
    cfg = _config(config)
    source = candles[-cfg["max_scan_candles"]:]
    if len(source) < cfg["atr_period"] + cfg["base_max_bars"] + 3:
        return []

    atr_values = _atr(source, cfg["atr_period"])
    volumes = [_to_float(c.get("v")) for c in source]
    volume_sma = _sma(volumes, cfg["volume_ma_period"])
    zones = []
    seen = set()

    for i in range(len(source)):
        atr_value = atr_values[i] if i < len(atr_values) else 0.0
        for zone in zones:
            _update_zone(zone, source[i], i, atr_value, cfg)

        for zone in _detect_zone_at(source, i, atr_values, volume_sma, cfg):
            key = (zone["type"], zone["start_i"], zone["end_i"], round(zone["top"], 8), round(zone["bottom"], 8))
            if key in seen:
                continue
            seen.add(key)
            zones.append(zone)

        zones = [z for z in zones if z.get("active") or i - z.get("origin_i", i) < 20]
        if len(zones) > cfg["max_zones"] * 3:
            zones = sorted(zones, key=lambda z: (z.get("active", False), z.get("strength", 0), z.get("origin_i", 0)), reverse=True)[:cfg["max_zones"] * 2]

    last_i = len(source) - 1
    active = []
    for zone in zones:
        if not zone.get("active"):
            continue
        if last_i - zone["origin_i"] > cfg["max_zone_age_bars"]:
            continue
        if cfg["fresh_only"] and zone.get("tests", 0) > 0:
            continue
        if zone.get("tests", 0) > cfg["max_tests"]:
            continue
        if zone.get("strength", 0) < cfg["min_strength"]:
            continue
        active.append(zone)
    return sorted(active, key=lambda z: (z["strength"], z["origin_i"]), reverse=True)[:cfg["max_zones"]]


def _zone_signature(cfg):
    return (
        cfg["atr_period"],
        cfg["volume_ma_period"],
        cfg["base_min_bars"],
        cfg["base_max_bars"],
        cfg["base_max_atr"],
        cfg["zone_max_atr"],
        cfg["impulse_atr"],
        cfg["min_body_ratio"],
        cfg["min_departure_atr"],
        cfg["min_volume_ratio"],
        cfg["zone_padding_atr"],
        cfg["invalidation_atr"],
        cfg["test_gap_bars"],
        cfg["max_tests"],
        cfg["fresh_only"],
        cfg["min_entry_age_bars"],
        cfg["max_zone_age_bars"],
        cfg["range_filter"],
        cfg["range_lookback"],
        cfg["demand_max_range_pos"],
        cfg["supply_min_range_pos"],
        cfg["min_strength"],
        cfg["max_zones"],
    )


def _reset_zone_cache(signature):
    ZONE_CACHE["signature"] = signature
    ZONE_CACHE["count"] = 0
    ZONE_CACHE["last_t"] = None
    ZONE_CACHE["zones"] = []
    ZONE_CACHE["seen"] = set()
    ZONE_CACHE["atr"] = []
    ZONE_CACHE["volume_sma"] = []


def scan_zones_cached(candles, config=None):
    cfg = _config(config)
    if len(candles) < cfg["atr_period"] + cfg["base_max_bars"] + 3:
        return []

    signature = _zone_signature(cfg)
    if ZONE_CACHE["signature"] != signature:
        _reset_zone_cache(signature)

    count = ZONE_CACHE["count"]
    if count > 0:
        changed_stream = (
            len(candles) < count or
            count > len(candles) or
            candles[count - 1].get("t") != ZONE_CACHE["last_t"]
        )
        if changed_stream:
            _reset_zone_cache(signature)
            count = 0

    zones = ZONE_CACHE["zones"]
    seen = ZONE_CACHE["seen"]
    atr_values = ZONE_CACHE["atr"]
    volume_sma = ZONE_CACHE["volume_sma"]

    for i in range(count, len(candles)):
        candle = candles[i]
        if i == 0:
            atr_values.append(0.0)
        else:
            high = _to_float(candle.get("h"))
            low = _to_float(candle.get("l"))
            prev_close = _to_float(candles[i - 1].get("c"))
            tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
            previous = atr_values[-1] if atr_values else tr
            atr_values.append(_ema_next(previous, tr, cfg["atr_period"]))

        if i + 1 >= cfg["volume_ma_period"]:
            start = max(0, i + 1 - cfg["volume_ma_period"])
            volumes = [_to_float(c.get("v")) for c in candles[start:i + 1]]
            volume_sma.append(sum(volumes) / len(volumes) if volumes else None)
        else:
            volume_sma.append(None)

        atr_value = atr_values[i] if i < len(atr_values) else 0.0
        for zone in zones:
            _update_zone(zone, candle, i, atr_value, cfg)

        for zone in _detect_zone_at(candles, i, atr_values, volume_sma, cfg):
            key = (zone["type"], zone["start_i"], zone["end_i"], round(zone["top"], 8), round(zone["bottom"], 8))
            if key in seen:
                continue
            seen.add(key)
            zones.append(zone)

        if len(zones) > cfg["max_zones"] * 4:
            min_origin = max(0, i - cfg["max_zone_age_bars"] - 20)
            zones = [
                z for z in zones
                if z.get("active") or z.get("origin_i", 0) >= min_origin
            ]
            zones = sorted(
                zones,
                key=lambda z: (z.get("active", False), z.get("strength", 0), z.get("origin_i", 0)),
                reverse=True,
            )[:cfg["max_zones"] * 3]
            ZONE_CACHE["zones"] = zones

    ZONE_CACHE["count"] = len(candles)
    ZONE_CACHE["last_t"] = candles[-1].get("t") if candles else None

    last_i = len(candles) - 1
    active = []
    for zone in zones:
        if not zone.get("active"):
            continue
        if last_i - zone["origin_i"] > cfg["max_zone_age_bars"]:
            continue
        if cfg["fresh_only"] and zone.get("tests", 0) > 0:
            continue
        if zone.get("tests", 0) > cfg["max_tests"]:
            continue
        if zone.get("strength", 0) < cfg["min_strength"]:
            continue
        active.append(zone)
    return sorted(active, key=lambda z: (z["strength"], z["origin_i"]), reverse=True)[:cfg["max_zones"]]


def _entry_ok(zone, candle, cfg):
    if not _touches(zone, candle):
        return False
    close = _to_float(candle.get("c"))
    open_price = _to_float(candle.get("o"))
    body_ratio = _body_ratio(candle)
    if cfg["entry_mode"] == "touch":
        return True
    if zone["type"] == "demand":
        if cfg["entry_mode"] == "close_outside":
            return close > zone["top"]
        return close > zone["top"] and close >= open_price and body_ratio >= cfg["min_rejection_body_ratio"]
    if cfg["entry_mode"] == "close_outside":
        return close < zone["bottom"]
    return close < zone["bottom"] and close <= open_price and body_ratio >= cfg["min_rejection_body_ratio"]


def _range_location_ok(zone, candles, cfg):
    if not cfg["range_filter"]:
        return True
    lookback = cfg["range_lookback"]
    if len(candles) < max(lookback, 2):
        return True
    window = candles[-lookback:]
    high = max(_to_float(c.get("h")) for c in window)
    low = min(_to_float(c.get("l")) for c in window)
    span = high - low
    if span <= 0:
        return True
    pos = (zone["mid"] - low) / span
    if zone["type"] == "demand":
        return pos <= cfg["demand_max_range_pos"]
    return pos >= cfg["supply_min_range_pos"]


def _nearest_opposite_target(zone, zones, entry):
    if zone["type"] == "demand":
        candidates = [z["bottom"] for z in zones if z["type"] == "supply" and z["bottom"] > entry]
        return min(candidates) if candidates else None
    candidates = [z["top"] for z in zones if z["type"] == "demand" and z["top"] < entry]
    return max(candidates) if candidates else None


def _risk_levels(zone, zones, candle, atr_value, cfg):
    side = zone["side"]
    entry = _to_float(candle.get("c"))
    buffer = atr_value * cfg["stop_buffer_atr"]
    if side == "BUY":
        sl = zone["bottom"] - buffer
        rr_tp = entry + abs(entry - sl) * cfg["reward_risk"]
    else:
        sl = zone["top"] + buffer
        rr_tp = entry - abs(sl - entry) * cfg["reward_risk"]

    target = None
    if cfg["target_mode"] in ("opposite_zone", "opposite_zone_or_rr"):
        target = _nearest_opposite_target(zone, zones, entry)
    if target is None and cfg["target_mode"] == "opposite_zone":
        return None, None
    if target is None:
        target = rr_tp

    reward = abs(target - entry)
    risk = abs(entry - sl)
    if risk <= 0 or reward <= 0:
        return None, None
    if reward / risk < cfg["min_reward_risk"]:
        if cfg["target_mode"] == "opposite_zone_or_rr":
            target = rr_tp
            reward = abs(target - entry)
        if reward / risk < cfg["min_reward_risk"]:
            return None, None
    return sl, target


def _observe_zone(zone, cfg):
    if zone["id"] in OBSERVED_ZONES:
        return
    OBSERVED_ZONES.add(zone["id"])
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(
            f"supply_demand.{zone['type']}",
            side="long" if zone["side"] == "BUY" else "short",
            zone_type=zone["type"],
            strength=round(zone["strength"], 2),
            tests=zone["tests"],
            top=round(zone["top"], 8),
            bottom=round(zone["bottom"], 8),
            departure_atr=round(zone["departure_atr"], 3),
            volume_ratio=round(zone["volume_ratio"], 3),
        )


def _set_meta(zone, regime):
    fn = getattr(_builtins, "set_meta", None)
    if callable(fn):
        fn(
            setup="supply_demand_zone",
            zone_type=zone["type"],
            strength=round(zone["strength"], 2),
            tests=zone["tests"],
            top=round(zone["top"], 8),
            bottom=round(zone["bottom"], 8),
            departure_atr=round(zone["departure_atr"], 3),
            volume_ratio=round(zone["volume_ratio"], 3),
            htf_regime=regime,
        )


def _draw_zone(zone, candles, cfg):
    color = "#22c55e" if zone["type"] == "demand" else "#ef4444"
    label_style = "label_up" if zone["type"] == "demand" else "label_down"
    first_time = zone.get("start_t")
    end_time = candles[-1].get("t") if candles else zone.get("origin_t")
    if first_time is None or end_time is None:
        return []
    text = f"{zone['type']} {int(round(zone['strength']))} T{zone['tests']}"
    group = f"sd.{zone['id']}"
    return [
        {"type": "line", "first": {"time": first_time, "price": zone["top"]}, "second": {"time": end_time, "price": zone["top"]}, "color": color, "style": "dashed", "width": 1, "group": group},
        {"type": "line", "first": {"time": first_time, "price": zone["bottom"]}, "second": {"time": end_time, "price": zone["bottom"]}, "color": color, "style": "dotted", "width": 1, "group": group},
        {"type": "line", "first": {"time": first_time, "price": zone["top"]}, "second": {"time": first_time, "price": zone["bottom"]}, "color": color, "style": "dotted", "width": 1, "group": group},
        {"type": "line", "first": {"time": end_time, "price": zone["top"]}, "second": {"time": end_time, "price": zone["bottom"]}, "color": color, "style": "dotted", "width": 1, "group": group},
        {"type": "label", "point": {"time": end_time, "price": zone["mid"]}, "text": text, "color": color, "textcolor": "#0f172a", "style": label_style, "size": "small", "group": group},
    ]


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    source = candles[-cfg["draw_history_bars"]:]
    zones = scan_zones(source, cfg)[:cfg["draw_max_zones"]]
    drawings = []
    for zone in zones:
        drawings.extend(_draw_zone(zone, source, cfg))
    return drawings


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if len(candles) < cfg["atr_period"] + cfg["base_max_bars"] + 5:
        hold()
        return

    zones = scan_zones_cached(candles, cfg)
    for zone in zones:
        _observe_zone(zone, cfg)

    if bool(getattr(portfolio, "has_position", False)):
        hold()
        return

    index = len(candles) - 1
    bar = bar_number(candles)
    if LAST_SIGNAL_BAR is not None and bar - LAST_SIGNAL_BAR <= cfg["cooldown_bars"]:
        hold()
        return

    atr_values = _atr(candles[-max(cfg["atr_period"] * 4, 80):], cfg["atr_period"])
    atr_value = atr_values[-1] if atr_values else 0.0
    regime = _htf_regime(candles, cfg)

    candidates = []
    raw = candles[-1]
    for zone in zones:
        if index - zone["origin_i"] < cfg["min_entry_age_bars"]:
            continue
        if zone["side"] == "SELL" and not cfg["allow_short"]:
            continue
        if zone["id"] in TRADED_ZONES:
            continue
        if not _range_location_ok(zone, candles, cfg):
            continue
        if not _htf_allows(zone["side"], regime, cfg):
            continue
        if not _entry_ok(zone, raw, cfg):
            continue
        sl, tp = _risk_levels(zone, zones, raw, atr_value, cfg)
        if sl is None or tp is None:
            continue
        distance = abs(_to_float(raw.get("c")) - zone["mid"])
        candidates.append((zone["strength"], -zone["tests"], -distance, zone, sl, tp))

    if not candidates:
        hold()
        return

    candidates.sort(reverse=True)
    _, _, _, zone, sl, tp = candidates[0]
    set_sl(price=sl)
    set_tp(price=tp)
    _set_meta(zone, regime)
    LAST_SIGNAL_BAR = bar
    TRADED_ZONES.add(zone["id"])
    if zone["side"] == "BUY":
        buy()
    else:
        sell()
