# name: Orphan Market Reader
# desc: Word notlarindaki maliyet/yelpaze, ABCD, QM, Wolfe, OBO/TOBO, ikili tepe/dip ve bayrak okumasini tek skor motorunda birlestirir
# author: NexusTrade
# version: 0.1

import builtins as _builtins
import math
from indicators.bars import bar_number


LAST_SIGNAL_KEY = None
LAST_SIGNAL_BAR = None
CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "pivots": {},
    "ema": {},
    "atr": [],
    "rsi": [],
    "volume_ma": [],
}


def initialize():
    return {
        "pivot_depths": [5, 8, 13],
        "pivot_engine": "legacy",
        "allow_repaint": False,
        "max_scan_candles": 700,
        "recent_signal_bars": 1,
        "min_score": 76.0,
        "min_reward_risk": 1.35,
        "default_reward_risk": 1.8,
        "allow_long": True,
        "allow_short": True,
        "exit_on_opposite_signal": True,
        "opposite_close_score": 82.0,
        "cooldown_bars": 8,
        "atr_period": 14,
        "rsi_period": 14,
        "volume_period": 30,
        "ema_fast": 55,
        "ema_slow": 200,
        "pivot_min_leg_pct": 0.0,
        "pivot_min_leg_atr": 0.0,
        "pivot_min_bar_depth_mult": 0.0,
        "major_zigzag_dev_pct": 0.75,
        "major_zigzag_atr_mult": 1.0,
        "major_zigzag_bar_depth_mult": 0.75,
        "regime_filter": "soft",
        "min_interval_minutes": 30,
        "min_volume_ratio": 0.55,
        "stop_buffer_atr": 0.18,
        "stop_atr_floor": 0.55,
        "min_stop_pct": 0.12,
        "min_signal_risk_pct": 0.0,
        "max_stop_pct": 2.0,
        "fee_bps": 10.0,
        "slippage_bps": 2.0,
        "min_net_reward_pct": 0.05,
        "shoulder_tolerance_pct": 1.3,
        "double_tolerance_pct": 0.7,
        "neck_break_buffer_pct": 0.03,
        "abcd_retrace_min": 0.50,
        "abcd_retrace_max": 0.886,
        "abcd_extension_min": 1.13,
        "abcd_extension_max": 2.05,
        "qm_retest_tolerance_pct": 1.2,
        "qm_stop_mode": "head",
        "wolfe_line_tolerance_pct": 1.8,
        "wolfe_max_intersection_span_mult": 2.0,
        "flag_lookback": 42,
        "flag_pullback_bars": 14,
        "flag_min_pole_atr": 3.0,
        "enabled_models": [
            "abcd",
            "qm",
            "wolfe",
        ],
        "enabled_setups": [
            "ABCD:long",
            "QM:long",
        ],
        "draw_setups": True,
        "draw_last_bars": 420,
        "draw_max_setups": 5,
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


def _list_value(value, fallback):
    if value is None:
        return list(fallback)
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return list(fallback)


def _config(config):
    cfg = initialize()
    if isinstance(config, dict):
        cfg.update(config)

    cfg["pivot_depths"] = [
        max(2, _to_int(value, 5))
        for value in _list_value(cfg.get("pivot_depths"), [5, 8, 13, 21])
    ]
    cfg["enabled_models"] = {
        str(value).strip().lower()
        for value in _list_value(cfg.get("enabled_models"), initialize()["enabled_models"])
        if str(value).strip()
    }
    cfg["enabled_setups"] = {
        str(value).strip().lower()
        for value in _list_value(cfg.get("enabled_setups"), initialize()["enabled_setups"])
        if str(value).strip()
    }
    cfg["allow_repaint"] = _to_bool(cfg.get("allow_repaint"), False)
    cfg["max_scan_candles"] = max(200, _to_int(cfg.get("max_scan_candles"), 700))
    cfg["recent_signal_bars"] = max(0, _to_int(cfg.get("recent_signal_bars"), 1))
    cfg["min_score"] = max(0.0, _to_float(cfg.get("min_score"), 76.0))
    cfg["min_reward_risk"] = max(0.0, _to_float(cfg.get("min_reward_risk"), 1.35))
    cfg["default_reward_risk"] = max(0.3, _to_float(cfg.get("default_reward_risk"), 1.8))
    cfg["allow_long"] = _to_bool(cfg.get("allow_long"), True)
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["exit_on_opposite_signal"] = _to_bool(cfg.get("exit_on_opposite_signal"), True)
    cfg["opposite_close_score"] = max(0.0, _to_float(cfg.get("opposite_close_score"), 82.0))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 4))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["rsi_period"] = max(2, _to_int(cfg.get("rsi_period"), 14))
    cfg["volume_period"] = max(2, _to_int(cfg.get("volume_period"), 30))
    cfg["ema_fast"] = max(2, _to_int(cfg.get("ema_fast"), 55))
    cfg["ema_slow"] = max(cfg["ema_fast"] + 1, _to_int(cfg.get("ema_slow"), 200))
    cfg["pivot_min_leg_pct"] = max(0.0, _to_float(cfg.get("pivot_min_leg_pct"), 0.0))
    cfg["pivot_min_leg_atr"] = max(0.0, _to_float(cfg.get("pivot_min_leg_atr"), 0.0))
    cfg["pivot_min_bar_depth_mult"] = max(0.0, _to_float(cfg.get("pivot_min_bar_depth_mult"), 0.0))
    cfg["pivot_engine"] = str(cfg.get("pivot_engine") or "legacy").strip().lower()
    if cfg["pivot_engine"] not in ("legacy", "major"):
        cfg["pivot_engine"] = "legacy"
    cfg["major_zigzag_dev_pct"] = max(0.0, _to_float(cfg.get("major_zigzag_dev_pct"), 0.75))
    cfg["major_zigzag_atr_mult"] = max(0.0, _to_float(cfg.get("major_zigzag_atr_mult"), 1.0))
    cfg["major_zigzag_bar_depth_mult"] = max(0.0, _to_float(cfg.get("major_zigzag_bar_depth_mult"), 0.75))
    cfg["regime_filter"] = str(cfg.get("regime_filter") or "soft").strip().lower()
    cfg["min_interval_minutes"] = max(0.0, _to_float(cfg.get("min_interval_minutes"), 30.0))
    cfg["min_volume_ratio"] = max(0.0, _to_float(cfg.get("min_volume_ratio"), 0.55))
    cfg["stop_buffer_atr"] = max(0.0, _to_float(cfg.get("stop_buffer_atr"), 0.18))
    cfg["stop_atr_floor"] = max(0.0, _to_float(cfg.get("stop_atr_floor"), 0.55))
    cfg["min_stop_pct"] = max(0.01, _to_float(cfg.get("min_stop_pct"), 0.12))
    cfg["min_signal_risk_pct"] = max(0.0, _to_float(cfg.get("min_signal_risk_pct"), 0.0))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _to_float(cfg.get("max_stop_pct"), 2.0))
    cfg["fee_bps"] = max(0.0, _to_float(cfg.get("fee_bps"), 10.0))
    cfg["slippage_bps"] = max(0.0, _to_float(cfg.get("slippage_bps"), 2.0))
    cfg["min_net_reward_pct"] = max(0.0, _to_float(cfg.get("min_net_reward_pct"), 0.05))
    cfg["shoulder_tolerance_pct"] = max(0.05, _to_float(cfg.get("shoulder_tolerance_pct"), 1.3))
    cfg["double_tolerance_pct"] = max(0.05, _to_float(cfg.get("double_tolerance_pct"), 0.7))
    cfg["neck_break_buffer_pct"] = max(0.0, _to_float(cfg.get("neck_break_buffer_pct"), 0.03))
    cfg["abcd_retrace_min"] = max(0.1, _to_float(cfg.get("abcd_retrace_min"), 0.50))
    cfg["abcd_retrace_max"] = max(cfg["abcd_retrace_min"], _to_float(cfg.get("abcd_retrace_max"), 0.886))
    cfg["abcd_extension_min"] = max(0.5, _to_float(cfg.get("abcd_extension_min"), 1.13))
    cfg["abcd_extension_max"] = max(cfg["abcd_extension_min"], _to_float(cfg.get("abcd_extension_max"), 2.05))
    cfg["qm_retest_tolerance_pct"] = max(0.05, _to_float(cfg.get("qm_retest_tolerance_pct"), 1.2))
    cfg["qm_stop_mode"] = str(cfg.get("qm_stop_mode") or "head").strip().lower()
    if cfg["qm_stop_mode"] not in ("head", "retest"):
        cfg["qm_stop_mode"] = "head"
    cfg["wolfe_line_tolerance_pct"] = max(0.05, _to_float(cfg.get("wolfe_line_tolerance_pct"), 1.8))
    cfg["wolfe_max_intersection_span_mult"] = max(1.0, _to_float(cfg.get("wolfe_max_intersection_span_mult"), 2.0))
    cfg["flag_lookback"] = max(15, _to_int(cfg.get("flag_lookback"), 42))
    cfg["flag_pullback_bars"] = max(5, _to_int(cfg.get("flag_pullback_bars"), 14))
    cfg["flag_min_pole_atr"] = max(0.5, _to_float(cfg.get("flag_min_pole_atr"), 3.0))
    cfg["draw_setups"] = _to_bool(cfg.get("draw_setups"), True)
    cfg["draw_last_bars"] = max(50, _to_int(cfg.get("draw_last_bars"), 420))
    cfg["draw_max_setups"] = max(0, _to_int(cfg.get("draw_max_setups"), 5))
    return cfg


def _candles():
    try:
        return indicators.candles()
    except Exception:
        return []


def _interval_minutes(candles):
    if len(candles) < 2:
        return None
    try:
        return abs(float(candles[-1].get("t")) - float(candles[-2].get("t"))) / 60000.0
    except Exception:
        return None


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


def _sma(values, period):
    out = []
    total = 0.0
    for i, value in enumerate(values):
        total += float(value)
        if i >= period:
            total -= float(values[i - period])
        out.append(total / min(period, i + 1))
    return out


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


def _atr(candles, period):
    tr = []
    for i, candle in enumerate(candles):
        high = _to_float(candle.get("h"))
        low = _to_float(candle.get("l"))
        prev = _to_float(candles[i - 1].get("c")) if i else _to_float(candle.get("c"))
        tr.append(max(high - low, abs(high - prev), abs(low - prev)))
    return _rma(tr, period)


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
        if loss <= 0:
            out.append(100.0 if gain > 0 else 50.0)
        else:
            out.append(100.0 - 100.0 / (1.0 + gain / loss))
    return out


def _signature(candles, cfg):
    return (
        tuple(cfg["pivot_depths"]),
        cfg["allow_repaint"],
        cfg["atr_period"],
        cfg["rsi_period"],
        cfg["volume_period"],
        cfg["ema_fast"],
        cfg["ema_slow"],
        cfg["pivot_min_leg_pct"],
        cfg["pivot_min_leg_atr"],
        cfg["pivot_min_bar_depth_mult"],
        cfg["pivot_engine"],
        cfg["major_zigzag_dev_pct"],
        cfg["major_zigzag_atr_mult"],
        cfg["major_zigzag_bar_depth_mult"],
        cfg["max_scan_candles"],
    )


def _series(candles, cfg):
    sig = _signature(candles, cfg)
    if CACHE["signature"] != sig or len(candles) < CACHE["count"]:
        CACHE["signature"] = sig
        CACHE["count"] = 0
        CACHE["last_t"] = None
        CACHE["pivots"] = {}
        CACHE["ema"] = {}
        CACHE["atr"] = []
        CACHE["rsi"] = []
        CACHE["volume_ma"] = []

    if CACHE["count"] == len(candles) and candles and CACHE["last_t"] == candles[-1].get("t"):
        return {
            "ema_fast": CACHE["ema"].get(cfg["ema_fast"], []),
            "ema_slow": CACHE["ema"].get(cfg["ema_slow"], []),
            "atr": CACHE["atr"],
            "rsi": CACHE["rsi"],
            "volume_ma": CACHE["volume_ma"],
            "pivots": CACHE["pivots"],
        }

    scan = candles[-cfg["max_scan_candles"]:]
    closes = [_to_float(c.get("c")) for c in scan]
    volumes = [_to_float(c.get("v")) for c in scan]
    CACHE["ema"][cfg["ema_fast"]] = _ema(closes, cfg["ema_fast"])
    CACHE["ema"][cfg["ema_slow"]] = _ema(closes, cfg["ema_slow"])
    CACHE["atr"] = _atr(scan, cfg["atr_period"])
    CACHE["rsi"] = _rsi(closes, cfg["rsi_period"])
    CACHE["volume_ma"] = _sma(volumes, cfg["volume_period"])
    builder = _build_major_zigzag_pivots if cfg["pivot_engine"] == "major" else _build_pivots
    CACHE["pivots"] = {
        depth: builder(scan, depth, cfg["allow_repaint"], offset=len(candles) - len(scan), cfg=cfg, atr_values=CACHE["atr"])
        for depth in cfg["pivot_depths"]
    }
    CACHE["count"] = len(candles)
    CACHE["last_t"] = candles[-1].get("t") if candles else None
    return {
        "ema_fast": CACHE["ema"].get(cfg["ema_fast"], []),
        "ema_slow": CACHE["ema"].get(cfg["ema_slow"], []),
        "atr": CACHE["atr"],
        "rsi": CACHE["rsi"],
        "volume_ma": CACHE["volume_ma"],
        "pivots": CACHE["pivots"],
    }


def _build_pivots(candles, depth, allow_repaint=False, offset=0, cfg=None, atr_values=None):
    if len(candles) < depth * 2 + 1:
        return []
    pivots = []
    last_confirmed = len(candles) - 1 if allow_repaint else len(candles) - depth - 1
    cfg = cfg or {}
    min_bars = int(math.ceil(depth * _to_float(cfg.get("pivot_min_bar_depth_mult"), 0.0)))
    for i in range(depth, max(depth, last_confirmed) + 1):
        window = candles[i - depth:i + depth + 1]
        high = _to_float(candles[i].get("h"))
        low = _to_float(candles[i].get("l"))
        is_high = high >= max(_to_float(c.get("h")) for c in window)
        is_low = low <= min(_to_float(c.get("l")) for c in window)
        atr_value = 0.0
        if atr_values and i < len(atr_values):
            atr_value = _to_float(atr_values[i], 0.0)
        if is_high and is_low:
            continue
        if is_high:
            _push_pivot(
                pivots,
                {"i": i + offset, "t": candles[i].get("t"), "p": high, "type": "H"},
                _pivot_min_move(high, atr_value, cfg),
                min_bars,
            )
        elif is_low:
            _push_pivot(
                pivots,
                {"i": i + offset, "t": candles[i].get("t"), "p": low, "type": "L"},
                _pivot_min_move(low, atr_value, cfg),
                min_bars,
            )
    return pivots


def _build_major_zigzag_pivots(candles, depth, allow_repaint=False, offset=0, cfg=None, atr_values=None):
    if len(candles) < depth * 2 + 1:
        return []

    cfg = cfg or {}
    pivots = []
    last_confirmed = len(candles) - 1 if allow_repaint else len(candles) - depth - 1
    if last_confirmed < depth:
        return []

    min_bars = int(math.ceil(depth * _to_float(cfg.get("major_zigzag_bar_depth_mult"), 0.75)))
    for i in range(depth, last_confirmed + 1):
        left = max(0, i - depth)
        right = min(len(candles), i + depth + 1)
        window = candles[left:right]
        high = _to_float(candles[i].get("h"))
        low = _to_float(candles[i].get("l"))
        is_high = high >= max(_to_float(c.get("h")) for c in window)
        is_low = low <= min(_to_float(c.get("l")) for c in window)
        if is_high and is_low:
            _push_major_double_pivot(pivots, candles[i], i + offset, high, low, depth, cfg, atr_values, i, min_bars)
            continue
        if is_high:
            _push_major_pivot(
                pivots,
                {"i": i + offset, "t": candles[i].get("t"), "p": high, "type": "H"},
                _major_min_move(high, atr_values, i, cfg),
                min_bars,
            )
        elif is_low:
            _push_major_pivot(
                pivots,
                {"i": i + offset, "t": candles[i].get("t"), "p": low, "type": "L"},
                _major_min_move(low, atr_values, i, cfg),
                min_bars,
            )
    return pivots


def _push_major_double_pivot(pivots, candle, index, high, low, depth, cfg, atr_values, local_i, min_bars):
    open_price = _to_float(candle.get("o"), _to_float(candle.get("c")))
    close_price = _to_float(candle.get("c"), open_price)
    if close_price >= open_price:
        ordered = (
            {"i": index, "t": candle.get("t"), "p": low, "type": "L"},
            {"i": index, "t": candle.get("t"), "p": high, "type": "H"},
        )
    else:
        ordered = (
            {"i": index, "t": candle.get("t"), "p": high, "type": "H"},
            {"i": index, "t": candle.get("t"), "p": low, "type": "L"},
        )
    for order_index, pivot in enumerate(ordered):
        _push_major_pivot(
            pivots,
            pivot,
            _major_min_move(pivot["p"], atr_values, local_i, cfg),
            min_bars if order_index == 0 else 0,
        )


def _major_min_move(price, atr_values, index, cfg):
    dev_move = abs(price) * _to_float(cfg.get("major_zigzag_dev_pct"), 0.75) / 100.0
    atr_value = 0.0
    if atr_values and index < len(atr_values):
        atr_value = _to_float(atr_values[index], 0.0)
    atr_move = atr_value * _to_float(cfg.get("major_zigzag_atr_mult"), 1.0)
    return max(dev_move, atr_move)


def _push_major_pivot(pivots, pivot, min_move=0.0, min_bars=0):
    if not pivots:
        pivots.append(pivot)
        return

    last = pivots[-1]
    if last["type"] == pivot["type"]:
        if pivot["type"] == "H" and pivot["p"] >= last["p"]:
            pivots[-1] = pivot
        elif pivot["type"] == "L" and pivot["p"] <= last["p"]:
            pivots[-1] = pivot
        return

    move = abs(pivot["p"] - last["p"])
    bars = abs(int(pivot["i"]) - int(last["i"]))
    if min_move > 0 and move < min_move:
        return
    if min_bars > 0 and bars < min_bars:
        return

    pivots.append(pivot)


def _pivot_min_move(price, atr_value, cfg):
    pct_move = abs(price) * _to_float(cfg.get("pivot_min_leg_pct"), 0.0) / 100.0
    atr_move = _to_float(atr_value, 0.0) * _to_float(cfg.get("pivot_min_leg_atr"), 0.0)
    return max(pct_move, atr_move)


def _push_pivot(pivots, pivot, min_move=0.0, min_bars=0):
    if not pivots:
        pivots.append(pivot)
        return
    last = pivots[-1]
    if last["type"] == pivot["type"]:
        if pivot["type"] == "H" and pivot["p"] >= last["p"]:
            pivots[-1] = pivot
        elif pivot["type"] == "L" and pivot["p"] <= last["p"]:
            pivots[-1] = pivot
        return
    move = abs(pivot["p"] - last["p"])
    bars = abs(int(pivot["i"]) - int(last["i"]))
    if min_move > 0 and move < min_move:
        return
    if min_bars > 0 and bars < min_bars and move < min_move * 1.6:
        return
    pivots.append(pivot)


def _pct(a, b):
    if b == 0:
        return 0.0
    return abs(a - b) / abs(b) * 100.0


def _near(a, b, tolerance_pct):
    return _pct(a, b) <= tolerance_pct


def _between(value, low, high):
    return value is not None and low <= value <= high


def _line_price(p1, p2, index):
    if p1["i"] == p2["i"]:
        return p2["p"]
    slope = (p2["p"] - p1["p"]) / float(p2["i"] - p1["i"])
    return p1["p"] + slope * (index - p1["i"])


def _line_intersection(p1, p2, p3, p4):
    if p1["i"] == p2["i"] or p3["i"] == p4["i"]:
        return None
    slope_a = (p2["p"] - p1["p"]) / float(p2["i"] - p1["i"])
    slope_b = (p4["p"] - p3["p"]) / float(p4["i"] - p3["i"])
    if abs(slope_a - slope_b) <= 1e-12:
        return None
    intercept_a = p1["p"] - slope_a * p1["i"]
    intercept_b = p3["p"] - slope_b * p3["i"]
    index = (intercept_b - intercept_a) / (slope_a - slope_b)
    price = slope_a * index + intercept_a
    return {"i": index, "p": price}


def _wolfe_intersection(p1, p2, p3, p4, p5, cfg):
    intersection = _line_intersection(p1, p3, p2, p4)
    if intersection is None:
        return None
    span = max(1.0, float(p5["i"] - p1["i"]))
    max_index = p1["i"] + span * cfg["wolfe_max_intersection_span_mult"]
    if intersection["i"] <= p5["i"] or intersection["i"] > max_index:
        return None

    t1 = _to_float(p1.get("t"), None)
    t5 = _to_float(p5.get("t"), None)
    if t1 is not None and t5 is not None and p5["i"] != p1["i"]:
        ms_per_bar = (t5 - t1) / float(p5["i"] - p1["i"])
        intersection_time = t1 + ms_per_bar * (intersection["i"] - p1["i"])
        max_time = t1 + (t5 - t1) * cfg["wolfe_max_intersection_span_mult"]
        if intersection_time <= t5 or intersection_time > max_time:
            return None
        intersection["t"] = intersection_time

    intersection["span_ratio"] = (intersection["i"] - p1["i"]) / span
    return intersection


def _retracement(a, b, c):
    denom = abs(a["p"] - b["p"])
    if denom <= 0:
        return None
    return abs(c["p"] - b["p"]) / denom


def _extension(b, c, d):
    denom = abs(c["p"] - b["p"])
    if denom <= 0:
        return None
    return abs(d["p"] - c["p"]) / denom


def _fibo(a, b, ratio):
    return a + (b - a) * ratio


def _project(from_price, to_price, ratio):
    return to_price + (to_price - from_price) * ratio


def _idx_local(global_i, candles, series):
    start = len(candles) - len(series)
    local = global_i - start
    return local if 0 <= local < len(series) else None


def _rsi_at(pivot, candles, series):
    idx = _idx_local(pivot["i"], candles, series["rsi"])
    if idx is None:
        return None
    return series["rsi"][idx]


def _current_context(candles, series, cfg):
    close = _to_float(candles[-1].get("c"))
    atr = series["atr"][-1] if series["atr"] else 0.0
    rsi = series["rsi"][-1] if series["rsi"] else 50.0
    ema_fast = series["ema_fast"][-1] if series["ema_fast"] else close
    ema_slow = series["ema_slow"][-1] if series["ema_slow"] else close
    volume = _to_float(candles[-1].get("v"))
    volume_ma = series["volume_ma"][-1] if series["volume_ma"] else volume
    if close > ema_fast > ema_slow:
        regime = "bull"
    elif close < ema_fast < ema_slow:
        regime = "bear"
    else:
        regime = "mixed"
    return {
        "close": close,
        "atr": atr,
        "rsi": rsi,
        "ema_fast": ema_fast,
        "ema_slow": ema_slow,
        "volume_ratio": volume / max(volume_ma, 1e-12),
        "regime": regime,
        "last_index": len(candles) - 1,
    }


def _score_ratio(value, low, high):
    if value is None:
        return 0.0
    mid = (low + high) / 2.0
    half = max((high - low) / 2.0, 1e-9)
    return max(0.0, 1.0 - abs(value - mid) / half)


def _base_candidate(model, side, depth, points, raw_score, trigger_i, targets, stop_ref, reason, meta=None):
    return {
        "model": model,
        "name": model,
        "side": side,
        "depth": depth,
        "points": points,
        "raw_score": raw_score,
        "trigger_i": trigger_i,
        "targets": targets or [],
        "stop_ref": stop_ref,
        "reason": reason,
        "meta": meta or {},
    }


def _detect_abcd(candles, pivots, depth, cfg, series):
    if len(pivots) < 4:
        return []
    out = []
    a, b, c, d = pivots[-4:]
    if [p["type"] for p in (a, b, c, d)] == ["H", "L", "H", "L"]:
        retrace = _retracement(a, b, c)
        ext = _extension(b, c, d)
        if (
            c["p"] < a["p"] and d["p"] < b["p"]
            and _between(retrace, cfg["abcd_retrace_min"], cfg["abcd_retrace_max"])
            and _between(ext, cfg["abcd_extension_min"], cfg["abcd_extension_max"])
        ):
            custom = 1.0 / max(retrace, 0.01)
            expected_custom = c["p"] - abs(c["p"] - b["p"]) * custom
            custom_fit = max(0.0, 1.0 - _pct(d["p"], expected_custom) / 3.0)
            div = _bullish_divergence(b, d, candles, series)
            score = 58 + 12 * _score_ratio(retrace, cfg["abcd_retrace_min"], cfg["abcd_retrace_max"])
            score += 10 * _score_ratio(ext, cfg["abcd_extension_min"], cfg["abcd_extension_max"])
            score += 7 * custom_fit + (8 if div else 0)
            out.append(_base_candidate(
                "ABCD",
                "long",
                depth,
                {"A": a, "B": b, "C": c, "D": d},
                score,
                d["i"] + depth,
                [c["p"], b["p"], a["p"]],
                d["p"],
                "C retrace + D extension + 1/C hedef kontrolu",
                {"retrace": round(retrace, 4), "extension": round(ext, 4), "one_over_c": round(custom, 4)},
            ))
    elif [p["type"] for p in (a, b, c, d)] == ["L", "H", "L", "H"]:
        retrace = _retracement(a, b, c)
        ext = _extension(b, c, d)
        if (
            c["p"] > a["p"] and d["p"] > b["p"]
            and _between(retrace, cfg["abcd_retrace_min"], cfg["abcd_retrace_max"])
            and _between(ext, cfg["abcd_extension_min"], cfg["abcd_extension_max"])
        ):
            custom = 1.0 / max(retrace, 0.01)
            expected_custom = c["p"] + abs(c["p"] - b["p"]) * custom
            custom_fit = max(0.0, 1.0 - _pct(d["p"], expected_custom) / 3.0)
            div = _bearish_divergence(b, d, candles, series)
            score = 58 + 12 * _score_ratio(retrace, cfg["abcd_retrace_min"], cfg["abcd_retrace_max"])
            score += 10 * _score_ratio(ext, cfg["abcd_extension_min"], cfg["abcd_extension_max"])
            score += 7 * custom_fit + (8 if div else 0)
            out.append(_base_candidate(
                "ABCD",
                "short",
                depth,
                {"A": a, "B": b, "C": c, "D": d},
                score,
                d["i"] + depth,
                [c["p"], b["p"], a["p"]],
                d["p"],
                "C retrace + D extension + 1/C hedef kontrolu",
                {"retrace": round(retrace, 4), "extension": round(ext, 4), "one_over_c": round(custom, 4)},
            ))
    return out


def _detect_qm(candles, pivots, depth, cfg, series):
    if len(pivots) < 5:
        return []
    p1, p2, p3, p4, p5 = pivots[-5:]
    types = [p["type"] for p in (p1, p2, p3, p4, p5)]
    out = []
    if types == ["L", "H", "L", "H", "L"]:
        retest_ok = _near(p5["p"], p1["p"], cfg["qm_retest_tolerance_pct"]) or p5["p"] < p1["p"]
        if p3["p"] < p1["p"] and p4["p"] > p2["p"] and retest_ok:
            div = _bullish_divergence(p3, p5, candles, series)
            score = 66 + (10 if div else 0) + min(10, _pct(p4["p"], p2["p"]) * 2.0)
            out.append(_base_candidate(
                "QM",
                "long",
                depth,
                {"1": p1, "2": p2, "3": p3, "4": p4, "5": p5},
                score,
                p5["i"] + depth,
                [p4["p"], p2["p"]],
                p5["p"] if cfg["qm_stop_mode"] == "retest" else min(p3["p"], p5["p"]),
                "3 noktasi 1 altinda, 4 noktasi 2 ustunde, 5 tekrar 1 bolgesinde",
                {
                    "retest_pct": round(_pct(p5["p"], p1["p"]), 4),
                    "stop_mode": cfg["qm_stop_mode"],
                },
            ))
    elif types == ["H", "L", "H", "L", "H"]:
        retest_ok = _near(p5["p"], p1["p"], cfg["qm_retest_tolerance_pct"]) or p5["p"] > p1["p"]
        if p3["p"] > p1["p"] and p4["p"] < p2["p"] and retest_ok:
            div = _bearish_divergence(p3, p5, candles, series)
            score = 66 + (10 if div else 0) + min(10, _pct(p4["p"], p2["p"]) * 2.0)
            out.append(_base_candidate(
                "QM",
                "short",
                depth,
                {"1": p1, "2": p2, "3": p3, "4": p4, "5": p5},
                score,
                p5["i"] + depth,
                [p4["p"], p2["p"]],
                p5["p"] if cfg["qm_stop_mode"] == "retest" else max(p3["p"], p5["p"]),
                "3 noktasi 1 ustunde, 4 noktasi 2 altinda, 5 tekrar 1 bolgesinde",
                {
                    "retest_pct": round(_pct(p5["p"], p1["p"]), 4),
                    "stop_mode": cfg["qm_stop_mode"],
                },
            ))
    return out


def _detect_wolfe(candles, pivots, depth, cfg, series):
    if len(pivots) < 5:
        return []
    p1, p2, p3, p4, p5 = pivots[-5:]
    types = [p["type"] for p in (p1, p2, p3, p4, p5)]
    out = []
    if types == ["H", "L", "H", "L", "H"]:
        line_13 = _line_price(p1, p3, p5["i"])
        intersection = _wolfe_intersection(p1, p2, p3, p4, p5, cfg)
        p4_inside = min(p1["p"], p2["p"]) <= p4["p"] <= max(p1["p"], p2["p"])
        near_line = _pct(p5["p"], line_13) <= cfg["wolfe_line_tolerance_pct"]
        if intersection and p3["p"] > p1["p"] and p5["p"] >= p3["p"] and p4_inside and near_line:
            score = 70 + max(0, 8 - _pct(p5["p"], line_13)) + (6 if _bearish_divergence(p3, p5, candles, series) else 0)
            out.append(_base_candidate(
                "Wolfe",
                "short",
                depth,
                {"1": p1, "2": p2, "3": p3, "4": p4, "5": p5},
                score,
                p5["i"] + depth,
                [p4["p"], _line_price(p1, p4, len(candles) - 1)],
                p5["p"],
                "5 dalga, 1-3 ve 2-4 cizgileri 1-5 suresinin en fazla 2 kati icinde kesisiyor",
                {
                    "line_13_error_pct": round(_pct(p5["p"], line_13), 4),
                    "intersection_i": round(intersection["i"], 4),
                    "intersection_price": round(intersection["p"], 8),
                    "intersection_time": int(intersection["t"]) if intersection.get("t") is not None else None,
                    "intersection_span_ratio": round(intersection["span_ratio"], 4),
                },
            ))
    elif types == ["L", "H", "L", "H", "L"]:
        line_13 = _line_price(p1, p3, p5["i"])
        intersection = _wolfe_intersection(p1, p2, p3, p4, p5, cfg)
        p4_inside = min(p1["p"], p2["p"]) <= p4["p"] <= max(p1["p"], p2["p"])
        near_line = _pct(p5["p"], line_13) <= cfg["wolfe_line_tolerance_pct"]
        if intersection and p3["p"] < p1["p"] and p5["p"] <= p3["p"] and p4_inside and near_line:
            score = 70 + max(0, 8 - _pct(p5["p"], line_13)) + (6 if _bullish_divergence(p3, p5, candles, series) else 0)
            out.append(_base_candidate(
                "Wolfe",
                "long",
                depth,
                {"1": p1, "2": p2, "3": p3, "4": p4, "5": p5},
                score,
                p5["i"] + depth,
                [p4["p"], _line_price(p1, p4, len(candles) - 1)],
                p5["p"],
                "5 dalga, 1-3 ve 2-4 cizgileri 1-5 suresinin en fazla 2 kati icinde kesisiyor",
                {
                    "line_13_error_pct": round(_pct(p5["p"], line_13), 4),
                    "intersection_i": round(intersection["i"], 4),
                    "intersection_price": round(intersection["p"], 8),
                    "intersection_time": int(intersection["t"]) if intersection.get("t") is not None else None,
                    "intersection_span_ratio": round(intersection["span_ratio"], 4),
                },
            ))
    return out


def _detect_obo_tobo(candles, pivots, depth, cfg, series):
    if len(pivots) < 5:
        return []
    p1, p2, p3, p4, p5 = pivots[-5:]
    types = [p["type"] for p in (p1, p2, p3, p4, p5)]
    close = _to_float(candles[-1].get("c"))
    out = []
    buffer = close * cfg["neck_break_buffer_pct"] / 100.0
    if types == ["H", "L", "H", "L", "H"]:
        neckline = _line_price(p2, p4, len(candles) - 1)
        shoulders_ok = _near(p1["p"], p5["p"], cfg["shoulder_tolerance_pct"])
        head_ok = p3["p"] > max(p1["p"], p5["p"])
        if shoulders_ok and head_ok and close < neckline - buffer:
            height = p3["p"] - min(p2["p"], p4["p"])
            score = 68 + min(10, height / max(close, 1e-12) * 600) + (8 if _bearish_divergence(p1, p5, candles, series) else 0)
            out.append(_base_candidate(
                "OBO",
                "short",
                depth,
                {"LS": p1, "N1": p2, "HEAD": p3, "N2": p4, "RS": p5},
                score,
                len(candles) - 1,
                [neckline - height, min(p2["p"], p4["p"])],
                max(p3["p"], p5["p"]),
                "boyun cizgisi kirilimi + omuz dengesi + bas yuksekligi",
                {"neckline": round(neckline, 8)},
            ))
    elif types == ["L", "H", "L", "H", "L"]:
        neckline = _line_price(p2, p4, len(candles) - 1)
        shoulders_ok = _near(p1["p"], p5["p"], cfg["shoulder_tolerance_pct"])
        head_ok = p3["p"] < min(p1["p"], p5["p"])
        if shoulders_ok and head_ok and close > neckline + buffer:
            height = max(p2["p"], p4["p"]) - p3["p"]
            score = 68 + min(10, height / max(close, 1e-12) * 600) + (8 if _bullish_divergence(p1, p5, candles, series) else 0)
            out.append(_base_candidate(
                "TOBO",
                "long",
                depth,
                {"LS": p1, "N1": p2, "HEAD": p3, "N2": p4, "RS": p5},
                score,
                len(candles) - 1,
                [neckline + height, max(p2["p"], p4["p"])],
                min(p3["p"], p5["p"]),
                "boyun cizgisi kirilimi + omuz dengesi + bas derinligi",
                {"neckline": round(neckline, 8)},
            ))
    return out


def _detect_double(candles, pivots, depth, cfg, series):
    if len(pivots) < 3:
        return []
    p1, p2, p3 = pivots[-3:]
    types = [p["type"] for p in (p1, p2, p3)]
    close = _to_float(candles[-1].get("c"))
    buffer = close * cfg["neck_break_buffer_pct"] / 100.0
    out = []
    if types == ["H", "L", "H"] and _near(p1["p"], p3["p"], cfg["double_tolerance_pct"]):
        if close < p2["p"] - buffer:
            height = max(p1["p"], p3["p"]) - p2["p"]
            score = 64 + min(12, height / max(close, 1e-12) * 700) + (8 if _bearish_divergence(p1, p3, candles, series) else 0)
            out.append(_base_candidate(
                "Ikili Tepe",
                "short",
                depth,
                {"T1": p1, "NECK": p2, "T2": p3},
                score,
                len(candles) - 1,
                [p2["p"] - height],
                max(p1["p"], p3["p"]),
                "es tepe + boyun kirilimi",
                {"neckline": round(p2["p"], 8)},
            ))
    elif types == ["L", "H", "L"] and _near(p1["p"], p3["p"], cfg["double_tolerance_pct"]):
        if close > p2["p"] + buffer:
            height = p2["p"] - min(p1["p"], p3["p"])
            score = 64 + min(12, height / max(close, 1e-12) * 700) + (8 if _bullish_divergence(p1, p3, candles, series) else 0)
            out.append(_base_candidate(
                "Ikili Dip",
                "long",
                depth,
                {"B1": p1, "NECK": p2, "B2": p3},
                score,
                len(candles) - 1,
                [p2["p"] + height],
                min(p1["p"], p3["p"]),
                "es dip + boyun kirilimi",
                {"neckline": round(p2["p"], 8)},
            ))
    return out


def _detect_cost_fan(candles, pivots, depth, cfg, series):
    if len(pivots) < 3:
        return []
    p1, p2, p3 = pivots[-3:]
    close = _to_float(candles[-1].get("c"))
    out = []
    if [p["type"] for p in (p1, p2, p3)] == ["H", "L", "H"]:
        retrace = _retracement(p1, p2, p3)
        cost = _fibo(p1["p"], p2["p"], 0.5)
        if _between(retrace, 0.382, 0.786) and close > p3["p"] and close > cost:
            score = 62 + 12 * _score_ratio(retrace, 0.382, 0.786)
            out.append(_base_candidate(
                "Maliyet Yelpaze",
                "long",
                depth,
                {"1": p1, "2": p2, "3": p3},
                score,
                len(candles) - 1,
                [p1["p"], _project(p2["p"], p3["p"], 1.0)],
                p2["p"],
                "1-2 maliyet bolgesi ustune geri alim",
                {"retrace": round(retrace, 4), "cost": round(cost, 8)},
            ))
    elif [p["type"] for p in (p1, p2, p3)] == ["L", "H", "L"]:
        retrace = _retracement(p1, p2, p3)
        cost = _fibo(p1["p"], p2["p"], 0.5)
        if _between(retrace, 0.382, 0.786) and close < p3["p"] and close < cost:
            score = 62 + 12 * _score_ratio(retrace, 0.382, 0.786)
            out.append(_base_candidate(
                "Maliyet Yelpaze",
                "short",
                depth,
                {"1": p1, "2": p2, "3": p3},
                score,
                len(candles) - 1,
                [p1["p"], _project(p2["p"], p3["p"], 1.0)],
                p2["p"],
                "1-2 maliyet bolgesi altina geri satis",
                {"retrace": round(retrace, 4), "cost": round(cost, 8)},
            ))
    return out


def _detect_flag(candles, cfg, series, context):
    lookback = cfg["flag_lookback"]
    pullback_bars = cfg["flag_pullback_bars"]
    if len(candles) < lookback + 5 or not series["atr"]:
        return []
    window = candles[-lookback:]
    pullback = candles[-pullback_bars:]
    pre = candles[-lookback:-pullback_bars]
    if len(pre) < 5 or len(pullback) < 5:
        return []
    atr_value = max(context["atr"], context["close"] * 0.001)
    pre_low = min(_to_float(c.get("l")) for c in pre)
    pre_high = max(_to_float(c.get("h")) for c in pre)
    close = context["close"]
    p_high = max(_to_float(c.get("h")) for c in pullback[:-1])
    p_low = min(_to_float(c.get("l")) for c in pullback[:-1])
    out = []

    up_pole = pre_high - pre_low
    if up_pole >= atr_value * cfg["flag_min_pole_atr"]:
        pole_high_i = max(range(len(pre)), key=lambda i: _to_float(pre[i].get("h")))
        pole_low_i = min(range(0, pole_high_i + 1), key=lambda i: _to_float(pre[i].get("l"))) if pole_high_i > 0 else 0
        if pole_low_i < pole_high_i and close > p_high and context["regime"] in ("bull", "mixed"):
            score = 63 + min(13, up_pole / atr_value) + min(6, context["volume_ratio"] * 2.0)
            out.append(_base_candidate(
                "Bayrak",
                "long",
                pullback_bars,
                {},
                score,
                len(candles) - 1,
                [close + up_pole * 0.8, close + up_pole],
                p_low,
                "direk sonrasi dar pullback ve ust kirilim",
                {"pole_atr": round(up_pole / atr_value, 4)},
            ))

    down_pole = pre_high - pre_low
    if down_pole >= atr_value * cfg["flag_min_pole_atr"]:
        pole_low_i = min(range(len(pre)), key=lambda i: _to_float(pre[i].get("l")))
        pole_high_i = max(range(0, pole_low_i + 1), key=lambda i: _to_float(pre[i].get("h"))) if pole_low_i > 0 else 0
        if pole_high_i < pole_low_i and close < p_low and context["regime"] in ("bear", "mixed"):
            score = 63 + min(13, down_pole / atr_value) + min(6, context["volume_ratio"] * 2.0)
            out.append(_base_candidate(
                "Ters Bayrak",
                "short",
                pullback_bars,
                {},
                score,
                len(candles) - 1,
                [close - down_pole * 0.8, close - down_pole],
                p_high,
                "dususe ait direk sonrasi dar pullback ve alt kirilim",
                {"pole_atr": round(down_pole / atr_value, 4)},
            ))
    return out


def _bullish_divergence(first_low, second_low, candles, series):
    r1 = _rsi_at(first_low, candles, series)
    r2 = _rsi_at(second_low, candles, series)
    return r1 is not None and r2 is not None and second_low["p"] <= first_low["p"] and r2 > r1


def _bearish_divergence(first_high, second_high, candles, series):
    r1 = _rsi_at(first_high, candles, series)
    r2 = _rsi_at(second_high, candles, series)
    return r1 is not None and r2 is not None and second_high["p"] >= first_high["p"] and r2 < r1


def _scan_candidates(candles, cfg):
    if len(candles) < max(cfg["pivot_depths"]) * 2 + 10:
        return []
    series = _series(candles, cfg)
    context = _current_context(candles[-len(series["atr"]):] if series["atr"] else candles, series, cfg)
    context["last_index"] = len(candles) - 1
    candidates = []
    enabled = cfg["enabled_models"]

    for depth, pivots in series["pivots"].items():
        if "abcd" in enabled:
            candidates.extend(_detect_abcd(candles, pivots, depth, cfg, series))
        if "qm" in enabled:
            candidates.extend(_detect_qm(candles, pivots, depth, cfg, series))
        if "wolfe" in enabled:
            candidates.extend(_detect_wolfe(candles, pivots, depth, cfg, series))
        if "obo_tobo" in enabled:
            candidates.extend(_detect_obo_tobo(candles, pivots, depth, cfg, series))
        if "double_top_bottom" in enabled:
            candidates.extend(_detect_double(candles, pivots, depth, cfg, series))
        if "cost_fan" in enabled:
            candidates.extend(_detect_cost_fan(candles, pivots, depth, cfg, series))

    if "flag" in enabled:
        candidates.extend(_detect_flag(candles, cfg, series, context))

    finalized = []
    seen = set()
    for candidate in candidates:
        result = _finalize_candidate(candidate, candles, cfg, context)
        if result is None:
            continue
        key = (
            result["model"],
            result["side"],
            result.get("depth"),
            result.get("trigger_i"),
            round(result["sl"], 8),
            round(result["tp"], 8),
        )
        if key in seen:
            continue
        seen.add(key)
        finalized.append(result)
    finalized.sort(key=lambda item: (item["score"], item["rr"], item["trigger_i"]), reverse=True)
    return finalized


def _finalize_candidate(candidate, candles, cfg, context):
    last_i = len(candles) - 1
    if last_i - int(candidate.get("trigger_i", -10**9)) > cfg["recent_signal_bars"]:
        return None
    side = candidate["side"]
    if not _setup_allowed(candidate, cfg):
        return None
    if side == "long" and not cfg["allow_long"]:
        return None
    if side == "short" and not cfg["allow_short"]:
        return None
    if context["volume_ratio"] < cfg["min_volume_ratio"]:
        return None

    entry = context["close"]
    atr_value = max(context["atr"], entry * cfg["min_stop_pct"] / 100.0)
    buffer = atr_value * cfg["stop_buffer_atr"]
    stop_ref = _to_float(candidate.get("stop_ref"), entry)
    if side == "long":
        sl = min(stop_ref - buffer, entry - atr_value * cfg["stop_atr_floor"])
        min_sl = entry * (1.0 - cfg["min_stop_pct"] / 100.0)
        sl = min(sl, min_sl)
        targets = sorted(_to_float(t, None) for t in candidate.get("targets", []) if _to_float(t, None) is not None and _to_float(t, None) > entry)
    else:
        sl = max(stop_ref + buffer, entry + atr_value * cfg["stop_atr_floor"])
        min_sl = entry * (1.0 + cfg["min_stop_pct"] / 100.0)
        sl = max(sl, min_sl)
        targets = sorted(
            (_to_float(t, None) for t in candidate.get("targets", []) if _to_float(t, None) is not None and _to_float(t, None) < entry),
            reverse=True,
        )

    risk = abs(entry - sl)
    if entry <= 0 or risk <= 0:
        return None
    risk_pct = risk / entry * 100.0
    if risk_pct < cfg["min_signal_risk_pct"]:
        return None
    if risk_pct > cfg["max_stop_pct"]:
        return None

    tp = None
    rr = 0.0
    for target in targets:
        reward = abs(target - entry)
        current_rr = reward / risk
        if current_rr >= cfg["min_reward_risk"]:
            tp = target
            rr = current_rr
            break
    if tp is None:
        rr = cfg["default_reward_risk"]
        tp = entry + risk * rr if side == "long" else entry - risk * rr

    reward_pct = abs(tp - entry) / entry * 100.0
    round_trip_cost_pct = (cfg["fee_bps"] * 2.0 + cfg["slippage_bps"] * 2.0) / 100.0
    if reward_pct - round_trip_cost_pct < cfg["min_net_reward_pct"]:
        return None

    score = float(candidate.get("raw_score") or 0.0)
    if cfg["regime_filter"] != "off":
        score += _regime_score(candidate, context, cfg)
    score += min(8.0, rr * 2.2)
    score += min(5.0, max(0.0, context["volume_ratio"] - 1.0) * 2.0)
    if risk_pct > cfg["max_stop_pct"] * 0.75:
        score -= 6.0
    if score < cfg["min_score"]:
        return None

    result = dict(candidate)
    result.update({
        "entry": entry,
        "sl": sl,
        "tp": tp,
        "rr": rr,
        "risk_pct": risk_pct,
        "reward_pct": reward_pct,
        "score": round(score, 2),
        "context": {
            "regime": context["regime"],
            "rsi": round(context["rsi"], 2),
            "volume_ratio": round(context["volume_ratio"], 3),
        },
    })
    return result


def _setup_allowed(candidate, cfg):
    enabled = cfg.get("enabled_setups") or set()
    if not enabled or "all" in enabled or "*" in enabled:
        return True
    model = str(candidate.get("model") or "").strip().lower()
    side = str(candidate.get("side") or "").strip().lower()
    keys = {
        f"{model}:{side}",
        f"{model}:all",
        f"{model}:*",
        side,
    }
    return any(key in enabled for key in keys)


def _regime_score(candidate, context, cfg):
    side = candidate["side"]
    model = candidate["model"].lower()
    regime = context["regime"]
    rsi = context["rsi"]
    continuation = "bayrak" in model
    if continuation:
        if side == "long" and regime == "bull":
            return 7.0
        if side == "short" and regime == "bear":
            return 7.0
        return -5.0 if cfg["regime_filter"] == "hard" else -1.5

    score = 0.0
    if side == "long":
        if regime == "bear":
            score += 4.0
        if rsi <= 38:
            score += 5.0
        if regime == "bull" and cfg["regime_filter"] == "hard":
            score -= 8.0
    else:
        if regime == "bull":
            score += 4.0
        if rsi >= 62:
            score += 5.0
        if regime == "bear" and cfg["regime_filter"] == "hard":
            score -= 8.0
    return score


def _signal_key(candidate):
    return (
        candidate["model"],
        candidate["side"],
        candidate.get("depth"),
        candidate.get("trigger_i"),
        round(candidate["sl"], 8),
        round(candidate["tp"], 8),
    )


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_KEY, LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if len(candles) < max(cfg["ema_fast"], max(cfg["pivot_depths"]) * 3) + 5:
        hold()
        return
    interval_minutes = _interval_minutes(candles)
    if interval_minutes is not None and interval_minutes < cfg["min_interval_minutes"]:
        hold()
        return

    candidates = _scan_candidates(candles, cfg)
    current_side = getattr(portfolio, "side", None)
    bar = bar_number(candles)

    if getattr(portfolio, "has_position", False):
        if cfg["exit_on_opposite_signal"] and candidates:
            best = candidates[0]
            opposite = (
                (current_side == "BUY" and best["side"] == "short")
                or (current_side == "SELL" and best["side"] == "long")
            )
            if opposite and best["score"] >= cfg["opposite_close_score"]:
                _set_meta(exit_reason="opposite_formasyon", model=best["model"], score=best["score"])
                close()
                return
        hold()
        return

    if not candidates:
        hold()
        return

    best = candidates[0]
    if LAST_SIGNAL_BAR is not None and bar - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return
    key = _signal_key(best)
    if LAST_SIGNAL_KEY == key:
        hold()
        return

    set_sl(price=best["sl"])
    set_tp(price=best["tp"])
    _set_meta(
        model=best["model"],
        score=best["score"],
        rr=round(best["rr"], 3),
        reason=best["reason"],
        riskPct=round(best["risk_pct"], 4),
        rewardPct=round(best["reward_pct"], 4),
        context=best["context"],
    )
    _observe(
        f"orphan.{best['model']}",
        side=best["side"],
        score=best["score"],
        rr=round(best["rr"], 3),
        depth=best.get("depth"),
        reason=best["reason"],
    )
    LAST_SIGNAL_KEY = key
    LAST_SIGNAL_BAR = bar
    if best["side"] == "long":
        buy()
    else:
        sell()


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not cfg["draw_setups"] or len(candles) < max(cfg["pivot_depths"]) * 3 + 5:
        return []
    interval_minutes = _interval_minutes(candles)
    if interval_minutes is not None and interval_minutes < cfg["min_interval_minutes"]:
        return []
    candidates = _scan_candidates(candles, cfg)[:cfg["draw_max_setups"]]
    drawings = []
    colors = {
        "long": "#22c55e",
        "short": "#ef4444",
    }
    for candidate in candidates:
        color = colors.get(candidate["side"], "#38bdf8")
        group = f"orphan-{candidate['model']}-{candidate.get('depth')}"
        points = list((candidate.get("points") or {}).values())
        points = [p for p in points if isinstance(p, dict) and p.get("t") is not None]
        for p1, p2 in zip(points, points[1:]):
            drawings.append({
                "type": "line",
                "first": {"time": p1["t"], "price": p1["p"]},
                "second": {"time": p2["t"], "price": p2["p"]},
                "color": color,
                "style": "solid",
                "width": 1,
                "group": group,
            })
        if points:
            anchor = points[-1]
            drawings.append({
                "type": "label",
                "point": {"time": anchor["t"], "price": anchor["p"]},
                "text": f"{candidate['side']} {candidate['model']} {candidate['score']}",
                "color": color,
                "textcolor": "#0f172a",
                "style": "label_up" if candidate["side"] == "long" else "label_down",
                "size": "small",
                "group": group,
            })
        last_time = candles[-1]["t"]
        for title, price, line_color in (
            ("SL", candidate["sl"], "#ef4444"),
            ("TP", candidate["tp"], "#22c55e"),
        ):
            drawings.append({
                "type": "line",
                "first": {"time": candles[max(0, len(candles) - 35)]["t"], "price": price},
                "second": {"time": last_time, "price": price},
                "color": line_color,
                "style": "dashed",
                "width": 1,
                "group": group,
            })
            drawings.append({
                "type": "label",
                "point": {"time": last_time, "price": price},
                "text": title,
                "color": line_color,
                "textcolor": "#0f172a",
                "style": "label_left",
                "size": "small",
                "group": group,
            })
    return drawings
