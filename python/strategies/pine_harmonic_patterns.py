# name: Pine Harmonik Pattern
# desc: PineScript coklu zigzag mantigiyla harmonik pattern stratejisi
# author: NexusTrade
# version: 1.0

import builtins as _builtins
import importlib.util as _importlib_util
import os as _os


def _load_smc_module():
    path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "smart_money_concepts.py")
    if not _os.path.exists(path):
        return None
    spec = _importlib_util.spec_from_file_location("_nexus_smc_filter", path)
    if spec is None or spec.loader is None:
        return None
    module = _importlib_util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    _SMC = _load_smc_module()
except Exception:
    _SMC = None

LAST_SIGNAL_KEY = None
OBSERVED_KEYS = set()
ACTIVE_TRADE = None
LEARNING_STATE = {
    "seen": set(),
    "open": [],
    "stats": {},
}
SCAN_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "states": {},
}

PATTERN_NAMES = (
    "Gartley",
    "Yengec",
    "Derin Yengec",
    "Yarasa",
    "Alt Yarasa",
    "Kelebek",
    "Shark",
    "Cypher",
    "Nenstar",
    "Black Swan",
    "White Swan",
    "3 Basamak",
    "5-0",
    "ABCD",
    "AB=CD",
    "ABCD Uzanti",
    "Ikili Tepe/Dip",
)

DEFAULT_ENABLED_PATTERNS = tuple(
    name for name in PATTERN_NAMES if name != "Ikili Tepe/Dip"
)

PATTERN_DRAW_COLORS = (
    "#22c55e",
    "#ef4444",
    "#38bdf8",
    "#f59e0b",
    "#a78bfa",
    "#ec4899",
    "#14b8a6",
    "#f97316",
    "#84cc16",
    "#eab308",
)


def initialize():
    return {
        "error_percent": 10.0,
        "zigzag_lengths": [5, 10, 15, 20, 25],
        "enabled_zigzags": [True, True, True, True, True],
        "max_pivot_size": 100,
        "allow_repaint": True,
        "wait_for_confirmation": False,
        "recent_signal_bars": 8,
        "min_quality": 0,
        "allow_short": True,
        "max_scan_candles": 1800,
        "max_draw_patterns": 20,
        "draw_historical_patterns": True,
        "draw_history_bars": 500,
        "max_risk_per_reward": 40.0,
        "enable_double_top_bottom": False,
        "take_profit_mode": "target_1",
        "stop_loss_mode": "target_risk",
        "stop_loss_target_ratio": 1.0,
        "min_reward_risk": 0.75,
        "exit_mode": "single",
        "trail_trigger_mode": "target_1",
        "trail_take_profit_mode": "target_2",
        "breakeven_buffer_pct": 0.05,
        "trail_atr_period": 14,
        "trail_atr_mult": 1.2,
        "trend_filter": "off",
        "trend_ema_period": 100,
        "rsi_filter": False,
        "rsi_period": 14,
        "rsi_long_max": 45.0,
        "rsi_short_min": 55.0,
        "adx_filter": False,
        "adx_period": 14,
        "min_adx": 18.0,
        "max_adx": 100.0,
        "atr_pct_filter": False,
        "atr_pct_period": 14,
        "min_atr_pct": 0.0,
        "max_atr_pct": 100.0,
        "volume_filter": False,
        "volume_ma_period": 20,
        "min_volume_ratio": 1.0,
        "ema_slope_filter": False,
        "ema_slope_mode": "with_trend",
        "ema_slope_period": 100,
        "min_ema_slope_pct": 0.0,
        "dema_filter": "off",
        "dema_fast_period": 20,
        "dema_slow_period": 30,
        "dema_source": "close",
        "htf_regime_filter": "off",
        "htf_timeframe": "4h",
        "htf_fast_period": 21,
        "htf_slow_period": 55,
        "htf_slope_lookback": 6,
        "htf_long_regime": "any",
        "htf_short_regime": "any",
        "htf_allow_unknown": True,
        "enabled_patterns": list(DEFAULT_ENABLED_PATTERNS),
        "trade_filters": [],
        "blocked_trade_filters": [],
        "smc_filter": "off",
        "smc_scope": "swing",
        "smc_tag": "CHoCH",
        "smc_lookback_bars": 20,
        "smc_swing_length": 50,
        "smc_internal_length": 5,
        "smc_confluence_filter": False,
        "learning_filter": False,
        "learning_group": "pattern_length_direction",
        "learning_min_samples": 4,
        "learning_min_win_rate": 55.0,
        "learning_min_expectancy_r": 0.0,
        "learning_horizon_bars": 96,
        "learning_max_open": 300,
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


def _as_bool(value, fallback=True):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in ("0", "false", "no", "hayir", "kapali")
    if value is None:
        return fallback
    return bool(value)


def _series_candles():
    try:
        return indicators.candles()
    except Exception:
        return []


def _normalize_regime_rule(value):
    text = str(value or "any").strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "all": "any",
        "off": "any",
        "none": "any",
        "long": "bull",
        "short": "bear",
        "up": "bull",
        "down": "bear",
        "boğa": "bull",
        "boga": "bull",
        "ayı": "bear",
        "ayi": "bear",
        "bullish": "bull",
        "bearish": "bear",
        "bull_mixed": "bull_or_mixed",
        "bear_mixed": "bear_or_mixed",
        "bull_or_neutral": "bull_or_mixed",
        "bear_or_neutral": "bear_or_mixed",
    }
    return aliases.get(text, text)


def _cfg(config):
    merged = initialize()
    if isinstance(config, dict):
        merged.update(config)

    lengths = merged.get("zigzag_lengths") or [5, 10, 15, 20, 25]
    if isinstance(lengths, str):
        lengths = [p.strip() for p in lengths.split(",") if p.strip()]
    merged["zigzag_lengths"] = [_to_int(v, 5) for v in lengths if _to_int(v, 0) > 0]

    enabled = merged.get("enabled_zigzags") or []
    if isinstance(enabled, str):
        enabled = [p.strip() for p in enabled.split(",") if p.strip()]
    enabled = [_as_bool(v, True) for v in enabled]
    if len(enabled) < len(merged["zigzag_lengths"]):
        enabled.extend([True] * (len(merged["zigzag_lengths"]) - len(enabled)))
    merged["enabled_zigzags"] = enabled

    enabled_patterns = merged.get("enabled_patterns")
    if isinstance(enabled_patterns, str):
        enabled_patterns = [p.strip() for p in enabled_patterns.split(",") if p.strip()]
    if not enabled_patterns:
        enabled_patterns = list(DEFAULT_ENABLED_PATTERNS)
    enable_double_top_bottom = _as_bool(merged.get("enable_double_top_bottom"), False)
    if not enable_double_top_bottom:
        enabled_patterns = [p for p in enabled_patterns if p != "Ikili Tepe/Dip"]
    merged["enabled_patterns"] = set(enabled_patterns)
    merged["enable_double_top_bottom"] = enable_double_top_bottom
    merged["trade_filters"] = _parse_trade_filters(merged.get("trade_filters"))
    merged["blocked_trade_filters"] = _parse_trade_filters(merged.get("blocked_trade_filters"))

    merged["error_percent"] = _to_float(merged.get("error_percent"), 10.0)
    merged["max_pivot_size"] = max(6, _to_int(merged.get("max_pivot_size"), 100))
    merged["recent_signal_bars"] = max(0, _to_int(merged.get("recent_signal_bars"), 8))
    merged["min_quality"] = max(0, _to_float(merged.get("min_quality"), 0))
    merged["max_scan_candles"] = max(100, _to_int(merged.get("max_scan_candles"), 1800))
    merged["max_draw_patterns"] = max(0, _to_int(merged.get("max_draw_patterns"), 20))
    merged["draw_historical_patterns"] = _as_bool(merged.get("draw_historical_patterns"), True)
    merged["draw_history_bars"] = max(40, _to_int(merged.get("draw_history_bars"), 500))
    merged["max_risk_per_reward"] = _to_float(merged.get("max_risk_per_reward"), 40.0)
    merged["take_profit_mode"] = str(merged.get("take_profit_mode") or "target_1").strip().lower()
    merged["stop_loss_mode"] = str(merged.get("stop_loss_mode") or "target_risk").strip().lower()
    merged["stop_loss_target_ratio"] = max(0.1, _to_float(merged.get("stop_loss_target_ratio"), 1.0))
    merged["exit_mode"] = str(merged.get("exit_mode") or "single").strip().lower()
    if merged["exit_mode"] not in ("single", "tp2_trail", "target_trail"):
        merged["exit_mode"] = "single"
    merged["trail_trigger_mode"] = str(merged.get("trail_trigger_mode") or "target_1").strip().lower()
    merged["trail_take_profit_mode"] = str(merged.get("trail_take_profit_mode") or "target_2").strip().lower()
    merged["breakeven_buffer_pct"] = max(0.0, _to_float(merged.get("breakeven_buffer_pct"), 0.05))
    merged["trail_atr_period"] = max(2, _to_int(merged.get("trail_atr_period"), 14))
    merged["trail_atr_mult"] = max(0.1, _to_float(merged.get("trail_atr_mult"), 1.2))
    merged["trend_filter"] = str(merged.get("trend_filter") or "off").strip().lower()
    if merged["trend_filter"] not in ("off", "with_trend", "reversal"):
        merged["trend_filter"] = "off"
    merged["trend_ema_period"] = max(2, _to_int(merged.get("trend_ema_period"), 100))
    merged["rsi_filter"] = _as_bool(merged.get("rsi_filter"), False)
    merged["rsi_period"] = max(2, _to_int(merged.get("rsi_period"), 14))
    merged["rsi_long_max"] = _to_float(merged.get("rsi_long_max"), 45.0)
    merged["rsi_short_min"] = _to_float(merged.get("rsi_short_min"), 55.0)
    merged["adx_filter"] = _as_bool(merged.get("adx_filter"), False)
    merged["adx_period"] = max(2, _to_int(merged.get("adx_period"), 14))
    merged["min_adx"] = max(0.0, _to_float(merged.get("min_adx"), 18.0))
    merged["max_adx"] = max(merged["min_adx"], _to_float(merged.get("max_adx"), 100.0))
    merged["atr_pct_filter"] = _as_bool(merged.get("atr_pct_filter"), False)
    merged["atr_pct_period"] = max(2, _to_int(merged.get("atr_pct_period"), 14))
    merged["min_atr_pct"] = max(0.0, _to_float(merged.get("min_atr_pct"), 0.0))
    merged["max_atr_pct"] = max(merged["min_atr_pct"], _to_float(merged.get("max_atr_pct"), 100.0))
    merged["volume_filter"] = _as_bool(merged.get("volume_filter"), False)
    merged["volume_ma_period"] = max(2, _to_int(merged.get("volume_ma_period"), 20))
    merged["min_volume_ratio"] = max(0.0, _to_float(merged.get("min_volume_ratio"), 1.0))
    merged["ema_slope_filter"] = _as_bool(merged.get("ema_slope_filter"), False)
    merged["ema_slope_mode"] = str(merged.get("ema_slope_mode") or "with_trend").strip().lower()
    if merged["ema_slope_mode"] not in ("with_trend", "reversal"):
        merged["ema_slope_mode"] = "with_trend"
    merged["ema_slope_period"] = max(2, _to_int(merged.get("ema_slope_period"), 100))
    merged["min_ema_slope_pct"] = max(0.0, _to_float(merged.get("min_ema_slope_pct"), 0.0))
    merged["dema_filter"] = str(merged.get("dema_filter") or "off").strip().lower()
    if merged["dema_filter"] == "trend":
        merged["dema_filter"] = "with_trend"
    if merged["dema_filter"] not in ("off", "with_trend", "reversal"):
        merged["dema_filter"] = "off"
    merged["dema_fast_period"] = max(2, _to_int(merged.get("dema_fast_period"), 20))
    merged["dema_slow_period"] = max(2, _to_int(merged.get("dema_slow_period"), 30))
    if merged["dema_fast_period"] == merged["dema_slow_period"]:
        merged["dema_slow_period"] = merged["dema_fast_period"] + 1
    merged["dema_source"] = str(merged.get("dema_source") or "close").strip().lower()
    merged["htf_regime_filter"] = str(merged.get("htf_regime_filter") or "off").strip().lower()
    if merged["htf_regime_filter"] == "trend":
        merged["htf_regime_filter"] = "with_trend"
    if merged["htf_regime_filter"] == "directional":
        merged["htf_regime_filter"] = "with_trend"
    if merged["htf_regime_filter"] == "prefer_trend":
        merged["htf_regime_filter"] = "prefer_with_trend"
    if merged["htf_regime_filter"] == "prefer_directional":
        merged["htf_regime_filter"] = "prefer_with_trend"
    if merged["htf_regime_filter"] not in (
        "off",
        "with_trend",
        "reversal",
        "custom",
        "prefer_with_trend",
        "prefer_reversal",
    ):
        merged["htf_regime_filter"] = "off"
    merged["htf_timeframe"] = str(merged.get("htf_timeframe") or "4h").strip().lower()
    merged["htf_fast_period"] = max(2, _to_int(merged.get("htf_fast_period"), 21))
    merged["htf_slow_period"] = max(merged["htf_fast_period"] + 1, _to_int(merged.get("htf_slow_period"), 55))
    merged["htf_slope_lookback"] = max(1, _to_int(merged.get("htf_slope_lookback"), 6))
    merged["htf_long_regime"] = _normalize_regime_rule(merged.get("htf_long_regime"))
    merged["htf_short_regime"] = _normalize_regime_rule(merged.get("htf_short_regime"))
    merged["htf_allow_unknown"] = _as_bool(merged.get("htf_allow_unknown"), True)
    merged["smc_filter"] = str(merged.get("smc_filter") or "off").strip().lower()
    if merged["smc_filter"] not in ("off", "same_direction", "opposite_direction"):
        merged["smc_filter"] = "off"
    merged["smc_scope"] = str(merged.get("smc_scope") or "swing").strip().lower()
    if merged["smc_scope"] not in ("swing", "internal", "both", "all"):
        merged["smc_scope"] = "swing"
    merged["smc_tag"] = str(merged.get("smc_tag") or "CHoCH").strip().upper()
    if merged["smc_tag"] not in ("CHOCH", "BOS", "ALL"):
        merged["smc_tag"] = "CHOCH"
    if merged["smc_tag"] == "CHOCH":
        merged["smc_tag"] = "CHoCH"
    merged["smc_lookback_bars"] = max(0, _to_int(merged.get("smc_lookback_bars"), 20))
    merged["smc_swing_length"] = max(10, _to_int(merged.get("smc_swing_length"), 50))
    merged["smc_internal_length"] = max(2, _to_int(merged.get("smc_internal_length"), 5))
    merged["smc_confluence_filter"] = _as_bool(merged.get("smc_confluence_filter"), False)
    merged["learning_filter"] = _as_bool(merged.get("learning_filter"), False)
    merged["learning_group"] = str(merged.get("learning_group") or "pattern_length_direction").strip().lower()
    if merged["learning_group"] not in ("pattern", "pattern_direction", "pattern_length", "pattern_length_direction"):
        merged["learning_group"] = "pattern_length_direction"
    merged["learning_min_samples"] = max(1, _to_int(merged.get("learning_min_samples"), 4))
    merged["learning_min_win_rate"] = max(0.0, _to_float(merged.get("learning_min_win_rate"), 55.0))
    merged["learning_min_expectancy_r"] = _to_float(merged.get("learning_min_expectancy_r"), 0.0)
    merged["learning_horizon_bars"] = max(1, _to_int(merged.get("learning_horizon_bars"), 96))
    merged["learning_max_open"] = max(20, _to_int(merged.get("learning_max_open"), 300))
    config_has_allow_repaint = isinstance(config, dict) and "allow_repaint" in config
    if config_has_allow_repaint:
        merged["allow_repaint"] = _as_bool(merged.get("allow_repaint"), True)
        merged["wait_for_confirmation"] = not merged["allow_repaint"]
    else:
        merged["wait_for_confirmation"] = _as_bool(merged.get("wait_for_confirmation"), False)
        merged["allow_repaint"] = not merged["wait_for_confirmation"]
    merged["allow_short"] = _as_bool(merged.get("allow_short"), True)
    return merged


def _norm_text(value):
    return str(value or "").strip().lower().replace("_", " ").replace("-", " ")


def _parse_trade_filters(value):
    if not value:
        return []
    if isinstance(value, str):
        raw_items = [p.strip() for p in value.split(";") if p.strip()]
    elif isinstance(value, (list, tuple, set)):
        raw_items = list(value)
    else:
        raw_items = [value]

    filters = []
    for item in raw_items:
        parsed = {}
        if isinstance(item, dict):
            parsed = dict(item)
        elif isinstance(item, str):
            parts = [p.strip() for p in item.replace("|", ":").split(":") if p.strip()]
            if parts:
                parsed["pattern"] = parts[0]
            for part in parts[1:]:
                clean = part.strip().lower()
                if clean.startswith("l") and clean[1:].isdigit():
                    parsed["zigzag_length"] = int(clean[1:])
                elif clean.isdigit():
                    parsed["zigzag_length"] = int(clean)
                elif clean in ("long", "buy", "bull", "bullish", "alis", "al"):
                    parsed["direction"] = "bullish"
                elif clean in ("short", "sell", "bear", "bearish", "satis", "sat"):
                    parsed["direction"] = "bearish"
        else:
            continue

        pattern = parsed.get("pattern") or parsed.get("name")
        length = parsed.get("zigzag_length", parsed.get("length"))
        direction = parsed.get("direction", parsed.get("side"))
        filter_item = {}
        if pattern not in (None, ""):
            filter_item["pattern"] = _norm_text(pattern)
        if length not in (None, ""):
            filter_item["zigzag_length"] = _to_int(length, 0)
        if direction not in (None, ""):
            d = _norm_text(direction)
            if d in ("long", "buy", "bull", "bullish", "alis", "al"):
                d = "bullish"
            elif d in ("short", "sell", "bear", "bearish", "satis", "sat"):
                d = "bearish"
            filter_item["direction"] = d
        if filter_item:
            filters.append(filter_item)
    return filters


def _filter_matches(pattern, filter_item):
    if not filter_item:
        return True
    if "pattern" in filter_item and _norm_text(pattern.get("name")) != filter_item["pattern"]:
        return False
    if "zigzag_length" in filter_item and _to_int(pattern.get("zigzag_length"), 0) != filter_item["zigzag_length"]:
        return False
    if "direction" in filter_item and _norm_text(pattern.get("direction")) != filter_item["direction"]:
        return False
    return True


def _passes_trade_filters(pattern, cfg):
    blocked = cfg.get("blocked_trade_filters") or []
    if any(_filter_matches(pattern, item) for item in blocked):
        return False
    allowed = cfg.get("trade_filters") or []
    if not allowed:
        return True
    return any(_filter_matches(pattern, item) for item in allowed)


def _fibo(from_price, to_price, ratio):
    return to_price + (from_price - to_price) * ratio


def _between(value, low, high, err_min, err_max):
    return value >= low * err_min and value <= high * err_max


def _target(value, target, err_min, err_max):
    return _between(value, target, target, err_min, err_max)


def _safe_div(num, den):
    return None if den == 0 else abs(num) / abs(den)


def _ema_value(values, period):
    if not values or len(values) < period:
        return None
    alpha = 2.0 / (period + 1.0)
    ema = sum(values[:period]) / period
    for value in values[period:]:
        ema = value * alpha + ema * (1.0 - alpha)
    return ema


def _rsi_value(values, period):
    if len(values) <= period:
        return None
    gains = []
    losses = []
    for idx in range(1, period + 1):
        change = values[idx] - values[idx - 1]
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    for idx in range(period + 1, len(values)):
        change = values[idx] - values[idx - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _atr_pct_value(candles, period):
    if len(candles) <= period:
        return None
    trs = []
    start = max(1, len(candles) - period)
    for idx in range(start, len(candles)):
        high = _to_float(candles[idx].get("h"))
        low = _to_float(candles[idx].get("l"))
        prev_close = _to_float(candles[idx - 1].get("c"))
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    close = _to_float(candles[-1].get("c"))
    if not trs or close <= 0:
        return None
    return (sum(trs) / len(trs)) / close * 100.0


def _volume_ratio(candles, period):
    if len(candles) <= period:
        return None
    volumes = [_to_float(c.get("v")) for c in candles[-period - 1:-1]]
    avg_volume = sum(volumes) / len(volumes) if volumes else 0.0
    current = _to_float(candles[-1].get("v"))
    if avg_volume <= 0:
        return None
    return current / avg_volume


def _adx_value(candles, period):
    if len(candles) < period * 2 + 1:
        return None
    highs = [_to_float(c.get("h")) for c in candles]
    lows = [_to_float(c.get("l")) for c in candles]
    closes = [_to_float(c.get("c")) for c in candles]
    trs = []
    plus_dms = []
    minus_dms = []
    for idx in range(1, len(candles)):
        up_move = highs[idx] - highs[idx - 1]
        down_move = lows[idx - 1] - lows[idx]
        plus_dms.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dms.append(down_move if down_move > up_move and down_move > 0 else 0.0)
        trs.append(max(
            highs[idx] - lows[idx],
            abs(highs[idx] - closes[idx - 1]),
            abs(lows[idx] - closes[idx - 1]),
        ))

    if len(trs) < period:
        return None
    tr_smooth = sum(trs[:period])
    plus_smooth = sum(plus_dms[:period])
    minus_smooth = sum(minus_dms[:period])
    dx_values = []
    for idx in range(period, len(trs)):
        tr_smooth = tr_smooth - (tr_smooth / period) + trs[idx]
        plus_smooth = plus_smooth - (plus_smooth / period) + plus_dms[idx]
        minus_smooth = minus_smooth - (minus_smooth / period) + minus_dms[idx]
        if tr_smooth <= 0:
            continue
        plus_di = 100.0 * plus_smooth / tr_smooth
        minus_di = 100.0 * minus_smooth / tr_smooth
        denom = plus_di + minus_di
        if denom > 0:
            dx_values.append(abs(plus_di - minus_di) / denom * 100.0)
    if len(dx_values) < period:
        return None
    adx = sum(dx_values[:period]) / period
    for value in dx_values[period:]:
        adx = ((adx * (period - 1)) + value) / period
    return adx


def _ema_slope_pct(values, period):
    if len(values) < period + 5:
        return None
    current = _ema_value(values, period)
    previous = _ema_value(values[:-5], period)
    if current is None or previous is None or previous == 0:
        return None
    return (current - previous) / previous * 100.0


def _ema_series_seeded(values, period):
    if not values:
        return []
    alpha = 2.0 / (period + 1.0)
    out = [float(values[0])]
    for value in values[1:]:
        out.append(float(value) * alpha + out[-1] * (1.0 - alpha))
    return out


def _dema_series(values, period):
    ema1 = _ema_series_seeded(values, period)
    ema2 = _ema_series_seeded(ema1, period)
    return [(2.0 * a) - b for a, b in zip(ema1, ema2)]


def _dema_context(candles, cfg):
    if cfg.get("dema_filter") == "off":
        return {}
    fast_period = cfg.get("dema_fast_period", 20)
    slow_period = cfg.get("dema_slow_period", 30)
    if len(candles) < max(fast_period, slow_period) * 3:
        return {"dema_trend": "unknown"}
    values = [_to_float(c.get("c")) for c in candles]
    fast = _dema_series(values, fast_period)
    slow = _dema_series(values, slow_period)
    if not fast or not slow:
        return {"dema_trend": "unknown"}
    if fast[-1] > slow[-1]:
        return {"dema_trend": "bull"}
    if fast[-1] < slow[-1]:
        return {"dema_trend": "bear"}
    return {"dema_trend": "mixed"}


def _ema_series(values, period):
    if not values:
        return []
    output = [None] * len(values)
    if len(values) < period:
        return output
    alpha = 2.0 / (period + 1.0)
    ema = sum(values[:period]) / period
    output[period - 1] = ema
    for idx in range(period, len(values)):
        ema = values[idx] * alpha + ema * (1.0 - alpha)
        output[idx] = ema
    return output


def _timeframe_ms(value):
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text.isdigit():
        return int(text) * 60_000
    unit = text[-1]
    amount = text[:-1]
    try:
        number = float(amount)
    except (TypeError, ValueError):
        return None
    multipliers = {
        "m": 60_000,
        "h": 3_600_000,
        "d": 86_400_000,
        "w": 604_800_000,
    }
    multiplier = multipliers.get(unit)
    if multiplier is None:
        return None
    return int(number * multiplier)


def _aggregate_completed_htf(candles, timeframe_ms):
    if not candles or not timeframe_ms or timeframe_ms <= 0:
        return []
    groups = []
    for candle in candles:
        t = _to_int(candle.get("t"), 0)
        bucket = t // timeframe_ms
        high = _to_float(candle.get("h"))
        low = _to_float(candle.get("l"))
        close = _to_float(candle.get("c"))
        volume = _to_float(candle.get("v"))
        if not groups or groups[-1]["bucket"] != bucket:
            groups.append({
                "bucket": bucket,
                "t": t,
                "o": _to_float(candle.get("o")),
                "h": high,
                "l": low,
                "c": close,
                "v": volume,
            })
        else:
            group = groups[-1]
            group["h"] = max(group["h"], high)
            group["l"] = min(group["l"], low)
            group["c"] = close
            group["v"] += volume
    return groups[:-1]


def _htf_regime(candles, cfg):
    timeframe_ms = _timeframe_ms(cfg.get("htf_timeframe", "4h"))
    groups = _aggregate_completed_htf(candles, timeframe_ms)
    fast_period = cfg.get("htf_fast_period", 21)
    slow_period = cfg.get("htf_slow_period", 55)
    lookback = cfg.get("htf_slope_lookback", 6)
    if len(groups) < max(fast_period, slow_period) + lookback:
        return "unknown"

    closes = [_to_float(group.get("c")) for group in groups]
    fast = _ema_series(closes, fast_period)
    slow = _ema_series(closes, slow_period)
    idx = len(groups) - 1
    fast_value = fast[idx]
    slow_value = slow[idx]
    if fast_value is None or slow_value is None:
        return "unknown"

    slope_idx = max(0, idx - lookback)
    slope_base = slow[slope_idx] if slope_idx < len(slow) else None
    slope_pct = 0.0 if not slope_base else (slow_value / slope_base - 1.0) * 100.0
    close = closes[idx]
    if close > fast_value and fast_value > slow_value and slope_pct > 0:
        return "strong_bull"
    if close > slow_value and slope_pct >= 0:
        return "bull"
    if close < fast_value and fast_value < slow_value and slope_pct < 0:
        return "strong_bear"
    if close < slow_value and slope_pct <= 0:
        return "bear"
    return "mixed"


def _market_context(candles, cfg):
    context = {}
    if cfg.get("htf_regime_filter") != "off":
        context["htf_regime"] = _htf_regime(candles, cfg)
        context["htf_timeframe"] = cfg.get("htf_timeframe", "4h")
    context.update(_dema_context(candles, cfg))
    return context


def _regime_rule_allows(rule, regime, allow_unknown=True):
    if regime == "unknown":
        return bool(allow_unknown)
    normalized = _normalize_regime_rule(rule)
    if "," in normalized:
        return any(
            _regime_rule_allows(part.strip(), regime, allow_unknown)
            for part in normalized.split(",")
            if part.strip()
        )
    sets = {
        "any": {"strong_bull", "bull", "mixed", "bear", "strong_bear"},
        "bull": {"strong_bull", "bull"},
        "bear": {"strong_bear", "bear"},
        "mixed": {"mixed"},
        "strong_bull": {"strong_bull"},
        "strong_bear": {"strong_bear"},
        "bull_or_mixed": {"strong_bull", "bull", "mixed"},
        "bear_or_mixed": {"strong_bear", "bear", "mixed"},
        "not_bull": {"mixed", "bear", "strong_bear"},
        "not_bear": {"strong_bull", "bull", "mixed"},
        "trend": {"strong_bull", "bull", "strong_bear", "bear"},
        "strong": {"strong_bull", "strong_bear"},
    }
    allowed = sets.get(normalized)
    if allowed is None:
        return regime == normalized
    return regime in allowed


def _passes_htf_regime(pattern, cfg, context):
    mode = cfg.get("htf_regime_filter", "off")
    if mode == "off":
        return True
    if mode in ("prefer_with_trend", "prefer_reversal"):
        return True
    direction = pattern.get("direction")
    regime = (context or {}).get("htf_regime", "unknown")
    if mode == "with_trend":
        rule = "bull" if direction == "bullish" else "bear"
    elif mode == "reversal":
        rule = "bear" if direction == "bullish" else "bull"
    else:
        rule = cfg.get("htf_long_regime") if direction == "bullish" else cfg.get("htf_short_regime")
    return _regime_rule_allows(rule, regime, cfg.get("htf_allow_unknown", True))


def _passes_dema_filter(pattern, cfg, context):
    mode = cfg.get("dema_filter", "off")
    if mode == "off":
        return True
    trend = (context or {}).get("dema_trend", "unknown")
    if trend == "unknown":
        return True
    direction = pattern.get("direction")
    with_trend = (
        (direction == "bullish" and trend == "bull") or
        (direction == "bearish" and trend == "bear")
    )
    if mode == "with_trend":
        return with_trend
    if mode == "reversal":
        return not with_trend and trend in ("bull", "bear")
    return True


def _htf_preference_score(pattern, cfg, context):
    mode = cfg.get("htf_regime_filter", "off")
    if mode not in ("prefer_with_trend", "prefer_reversal"):
        return 0
    direction = pattern.get("direction")
    regime = (context or {}).get("htf_regime", "unknown")
    if mode == "prefer_with_trend":
        rule = "bull" if direction == "bullish" else "bear"
    else:
        rule = "bear" if direction == "bullish" else "bull"
    return 1 if _regime_rule_allows(rule, regime, cfg.get("htf_allow_unknown", True)) else 0


def _pattern_priority(pattern, cfg, context):
    return (
        _htf_preference_score(pattern, cfg, context),
        pattern.get("signal_i", 0),
        pattern.get("D", {}).get("i", 0),
        pattern.get("quality", 0),
    )


def _passes_market_filters(pattern, candles, cfg, context=None):
    closes = [_to_float(c.get("c")) for c in candles]
    direction = pattern.get("direction")
    close = closes[-1] if closes else None

    if not _passes_htf_regime(pattern, cfg, context or {}):
        return False

    if not _passes_dema_filter(pattern, cfg, context or {}):
        return False

    trend_mode = cfg.get("trend_filter")
    if trend_mode != "off":
        ema = _ema_value(closes, cfg.get("trend_ema_period", 100))
        if ema is not None and close is not None:
            with_trend = (
                (direction == "bullish" and close >= ema) or
                (direction == "bearish" and close <= ema)
            )
            if trend_mode == "with_trend" and not with_trend:
                return False
            if trend_mode == "reversal" and with_trend:
                return False

    if cfg.get("rsi_filter"):
        rsi = _rsi_value(closes, cfg.get("rsi_period", 14))
        if rsi is not None:
            if direction == "bullish" and rsi > cfg.get("rsi_long_max", 45.0):
                return False
            if direction == "bearish" and rsi < cfg.get("rsi_short_min", 55.0):
                return False

    if cfg.get("adx_filter"):
        adx = _adx_value(candles, cfg.get("adx_period", 14))
        if adx is not None and (adx < cfg.get("min_adx", 18.0) or adx > cfg.get("max_adx", 100.0)):
            return False

    if cfg.get("atr_pct_filter"):
        atr_pct = _atr_pct_value(candles, cfg.get("atr_pct_period", 14))
        if atr_pct is not None and (atr_pct < cfg.get("min_atr_pct", 0.0) or atr_pct > cfg.get("max_atr_pct", 100.0)):
            return False

    if cfg.get("volume_filter"):
        ratio = _volume_ratio(candles, cfg.get("volume_ma_period", 20))
        if ratio is not None and ratio < cfg.get("min_volume_ratio", 1.0):
            return False

    if cfg.get("ema_slope_filter"):
        slope = _ema_slope_pct(closes, cfg.get("ema_slope_period", 100))
        if slope is not None:
            bullish_slope = slope >= cfg.get("min_ema_slope_pct", 0.0)
            bearish_slope = slope <= -cfg.get("min_ema_slope_pct", 0.0)
            mode = cfg.get("ema_slope_mode", "with_trend")
            if mode == "reversal":
                if direction == "bullish" and not bearish_slope:
                    return False
                if direction == "bearish" and not bullish_slope:
                    return False
            else:
                if direction == "bullish" and not bullish_slope:
                    return False
                if direction == "bearish" and not bearish_slope:
                    return False

    return True


def _smc_runtime_config(cfg):
    if _SMC is None:
        return None
    smc_cfg = _SMC.initialize()
    smc_cfg.update({
        "signal_scope": cfg.get("smc_scope", "swing"),
        "signal_tag": cfg.get("smc_tag", "CHoCH"),
        "swing_length": cfg.get("smc_swing_length", 50),
        "internal_length": cfg.get("smc_internal_length", 5),
        "confluence_filter": cfg.get("smc_confluence_filter", False),
        "allow_short": True,
    })
    return _SMC._config(smc_cfg)


def _recent_smc_events(candles, cfg):
    if cfg.get("smc_filter") == "off":
        return []
    smc_cfg = _smc_runtime_config(cfg)
    if smc_cfg is None:
        return []
    min_required = max(
        smc_cfg.get("swing_length", 50),
        smc_cfg.get("internal_length", 5),
        smc_cfg.get("equal_length", 3),
    ) + 3
    if len(candles) < min_required:
        return []
    try:
        state = _SMC._analysis(candles, smc_cfg)
    except Exception:
        return []

    index = len(candles) - 1
    min_index = max(0, index - cfg.get("smc_lookback_bars", 20))
    events = []
    for event in reversed(state.get("events", [])):
        event_index = event.get("index")
        if event_index is None or event_index > index:
            continue
        if event_index < min_index:
            break
        if _SMC._event_matches(event, smc_cfg):
            events.append(event)
    return events


def _passes_smc_filter(pattern, smc_events, cfg):
    mode = cfg.get("smc_filter")
    if mode == "off":
        return True
    if not smc_events:
        return False

    wanted_side = "bullish" if pattern.get("direction") == "bullish" else "bearish"
    if mode == "same_direction":
        return any(event.get("side") == wanted_side for event in smc_events)
    if mode == "opposite_direction":
        return any(event.get("side") != wanted_side for event in smc_events)
    return True


def _point(candles, idx, price, direction):
    candle = candles[idx]
    return {
        "i": idx,
        "t": candle.get("t"),
        "c": price,
        "type": "H" if direction > 0 else "L",
    }


def build_zigzag(candles, length, max_pivot_size=100):
    pivots = []
    bars = []
    dirs = []
    prev_dir = 0

    for i, candle in enumerate(candles):
        start = max(0, i - length + 1)
        window = candles[start:i + 1]
        high = _to_float(candle.get("h"))
        low = _to_float(candle.get("l"))
        max_high = max(_to_float(c.get("h")) for c in window)
        min_low = min(_to_float(c.get("l")) for c in window)

        phigh = high if high == max_high else None
        plow = low if low == min_low else None

        cur_dir = prev_dir
        if plow is not None and phigh is None:
            cur_dir = -1
        if phigh is not None and plow is None:
            cur_dir = 1

        direction_changed = cur_dir != prev_dir
        if (phigh is not None or plow is not None) and cur_dir != 0:
            value = phigh if cur_dir == 1 else plow
            if value is None:
                value = high if cur_dir == 1 else low
            bar = i
            new_dir = cur_dir

            if not direction_changed and len(pivots) >= 1:
                pivot = pivots.pop(0)
                pivotbar = bars.pop(0)
                pivotdir = dirs.pop(0)
                use_old = value * pivotdir < pivot * pivotdir
                if use_old:
                    value = pivot
                    bar = pivotbar

            if len(pivots) >= 2:
                last_point = pivots[1]
                new_dir = cur_dir * 2 if cur_dir * value > cur_dir * last_point else cur_dir

            pivots.insert(0, value)
            bars.insert(0, bar)
            dirs.insert(0, new_dir)

            while len(pivots) > max_pivot_size:
                pivots.pop()
                bars.pop()
                dirs.pop()

        prev_dir = cur_dir

    return pivots, bars, dirs


def _zigzag_signature(cfg):
    return (
        tuple(cfg["zigzag_lengths"]),
        tuple(cfg["enabled_zigzags"]),
        cfg["max_pivot_size"],
        cfg["wait_for_confirmation"],
    )


def _reset_scan_cache(signature):
    SCAN_CACHE["signature"] = signature
    SCAN_CACHE["count"] = 0
    SCAN_CACHE["last_t"] = None
    SCAN_CACHE["states"] = {}


def _new_zigzag_state():
    return {
        "pivots": [],
        "bars": [],
        "dirs": [],
        "prev_dir": 0,
        "processed": 0,
    }


def _update_zigzag_state(state, candles, length, max_pivot_size=100):
    pivots = state["pivots"]
    bars = state["bars"]
    dirs = state["dirs"]
    prev_dir = state["prev_dir"]

    for i in range(state["processed"], len(candles)):
        candle = candles[i]
        start = max(0, i - length + 1)
        window = candles[start:i + 1]
        high = _to_float(candle.get("h"))
        low = _to_float(candle.get("l"))
        max_high = max(_to_float(c.get("h")) for c in window)
        min_low = min(_to_float(c.get("l")) for c in window)

        phigh = high if high == max_high else None
        plow = low if low == min_low else None

        cur_dir = prev_dir
        if plow is not None and phigh is None:
            cur_dir = -1
        if phigh is not None and plow is None:
            cur_dir = 1

        direction_changed = cur_dir != prev_dir
        if (phigh is not None or plow is not None) and cur_dir != 0:
            value = phigh if cur_dir == 1 else plow
            if value is None:
                value = high if cur_dir == 1 else low
            bar = i
            new_dir = cur_dir

            if not direction_changed and len(pivots) >= 1:
                pivot = pivots.pop(0)
                pivotbar = bars.pop(0)
                pivotdir = dirs.pop(0)
                use_old = value * pivotdir < pivot * pivotdir
                if use_old:
                    value = pivot
                    bar = pivotbar

            if len(pivots) >= 2:
                last_point = pivots[1]
                new_dir = cur_dir * 2 if cur_dir * value > cur_dir * last_point else cur_dir

            pivots.insert(0, value)
            bars.insert(0, bar)
            dirs.insert(0, new_dir)

            while len(pivots) > max_pivot_size:
                pivots.pop()
                bars.pop()
                dirs.pop()

        prev_dir = cur_dir

    state["prev_dir"] = prev_dir
    state["processed"] = len(candles)
    return pivots, bars, dirs


def scan_patterns_cached(candles, config=None):
    cfg = _cfg(config)
    if not candles:
        return []

    signature = _zigzag_signature(cfg)
    if SCAN_CACHE["signature"] != signature:
        _reset_scan_cache(signature)

    count = SCAN_CACHE["count"]
    if count > 0:
        changed_stream = (
            len(candles) < count or
            count > len(candles) or
            candles[count - 1].get("t") != SCAN_CACHE["last_t"]
        )
        if changed_stream:
            _reset_scan_cache(signature)

    all_patterns = []
    seen = set()
    states = SCAN_CACHE["states"]

    for idx, length in enumerate(cfg["zigzag_lengths"]):
        if idx < len(cfg["enabled_zigzags"]) and not cfg["enabled_zigzags"][idx]:
            continue
        state = states.setdefault(length, _new_zigzag_state())
        pivots, bars, dirs = _update_zigzag_state(state, candles, length, cfg["max_pivot_size"])
        patterns = _detect_from_zigzag(candles, length, pivots, bars, dirs, cfg)
        for pattern in patterns:
            key = (pattern["name"], pattern["zigzag_length"], pattern["D"]["i"], pattern["signal_i"], pattern["direction"])
            if key in seen:
                continue
            seen.add(key)
            all_patterns.append(pattern)

    SCAN_CACHE["count"] = len(candles)
    SCAN_CACHE["last_t"] = candles[-1].get("t")
    return sorted(all_patterns, key=lambda p: (p["signal_i"], p["D"]["i"], p["quality"]), reverse=True)


def _score_ratio(value, low, high, err_min, err_max):
    if value is None:
        return 0.0
    lo = low * err_min
    hi = high * err_max
    if hi <= lo:
        return 100.0 if value == lo else 0.0
    mid = (lo + hi) / 2.0
    half = (hi - lo) / 2.0
    return max(0.0, 100.0 - abs(value - mid) / half * 100.0)


def _quality(ratios, checks, err_min, err_max):
    scores = []
    for key, low, high in checks:
        scores.append(_score_ratio(ratios.get(key), low, high, err_min, err_max))
    return round(sum(scores) / len(scores), 1) if scores else 100.0


def _clean_levels(values):
    levels = []
    for raw in values or []:
        value = _to_float(raw, None)
        if value is not None and value > 0:
            levels.append(value)
    return levels


def _profit_levels(direction, entry, values):
    levels = _clean_levels(values)
    if entry is None:
        return sorted(levels, reverse=direction < 0)

    if direction > 0:
        return sorted(level for level in levels if level > entry)
    if direction < 0:
        return sorted((level for level in levels if level < entry), reverse=True)
    return levels


def _add_pattern(results, enabled, name, direction, length, candles, points, signal, ratios, targets, zone, checks, err_min, err_max):
    if name not in enabled:
        return

    x, a, b, c, d, y = points
    q = _quality(ratios, checks, err_min, err_max)
    target_levels = _profit_levels(direction, d[0], targets)
    results.append({
        "name": name,
        "direction": "bullish" if direction > 0 else "bearish",
        "dir": direction,
        "quality": q,
        "zigzag_length": length,
        "signal_i": signal[1],
        "signal_t": candles[signal[1]].get("t"),
        "X": _point(candles, x[1], x[0], x[2]),
        "A": _point(candles, a[1], a[0], a[2]),
        "B": _point(candles, b[1], b[0], b[2]),
        "C": _point(candles, c[1], c[0], c[2]),
        "D": _point(candles, d[1], d[0], d[2]),
        "Y": _point(candles, y[1], y[0], y[2]),
        "targets": [round(t, 8) for t in target_levels],
        "confirmation_zone": [round(z, 8) for z in _clean_levels(zone)],
        "ratios": {k: round(v, 6) for k, v in ratios.items() if v is not None},
    })


def _detect_from_zigzag(candles, length, pivots, bars, dirs, config):
    start = 1 if config["wait_for_confirmation"] else 0
    if len(pivots) < 6 + start:
        return []

    d = (pivots[start + 0], bars[start + 0], dirs[start + 0])
    c = (pivots[start + 1], bars[start + 1], dirs[start + 1])
    b = (pivots[start + 2], bars[start + 2], dirs[start + 2])
    a = (pivots[start + 3], bars[start + 3], dirs[start + 3])
    x = (pivots[start + 4], bars[start + 4], dirs[start + 4])
    y = (pivots[start + 5], bars[start + 5], dirs[start + 5])

    high_point = max(x[0], a[0], b[0], c[0], d[0])
    low_point = min(x[0], a[0], b[0], c[0], d[0])
    direction = 1 if c[0] > d[0] else -1

    ratios = {
        "xab": _safe_div(b[0] - a[0], x[0] - a[0]),
        "abc": _safe_div(c[0] - b[0], a[0] - b[0]),
        "bcd": _safe_div(d[0] - c[0], b[0] - c[0]),
        "xad": _safe_div(d[0] - a[0], x[0] - a[0]),
        "xcd": _safe_div(d[0] - c[0], x[0] - c[0]),
        "yxa": _safe_div(a[0] - x[0], y[0] - x[0]),
    }
    if any(v is None for v in ratios.values()):
        return []

    ab_time = abs(a[1] - b[1])
    cd_time = abs(c[1] - d[1])
    ab_price = abs(a[0] - b[0])
    cd_price = abs(c[0] - d[0])
    time_ratio = None if ab_time == 0 else cd_time / ab_time
    price_ratio = None if ab_price == 0 else cd_price / ab_price
    ratios["time"] = time_ratio
    ratios["price"] = price_ratio

    abcd_direction = 0
    if a[0] < b[0] and a[0] < c[0] and c[0] < b[0] and c[0] < d[0] and a[0] < d[0] and b[0] < d[0]:
        abcd_direction = 1
    elif a[0] > b[0] and a[0] > c[0] and c[0] > b[0] and c[0] > d[0] and a[0] > d[0] and b[0] > d[0]:
        abcd_direction = -1

    risk = abs(b[0] - d[0])
    reward = abs(c[0] - d[0])
    risk_per_reward = 100.0 if risk + reward == 0 else risk * 100.0 / (risk + reward)

    err_min = (100.0 - config["error_percent"]) / 100.0
    err_max = (100.0 + config["error_percent"]) / 100.0
    enabled = config["enabled_patterns"]
    results = []
    points = (x, a, b, c, d, y)
    signal = (pivots[0], bars[0], dirs[0])

    if b[0] < high_point and b[0] > low_point:
        if (_target(ratios["xab"], 0.618, err_min, err_max) and
                _between(ratios["abc"], 0.382, 0.886, err_min, err_max) and
                _between(ratios["bcd"], 1.272, 1.618, err_min, err_max) and
                _target(ratios["xad"], 0.786, err_min, err_max)):
            zone = [
                max(_fibo(x[0], a[0], 0.786), _fibo(b[0], c[0], 1.272)) if x[0] > a[0] else min(_fibo(x[0], a[0], 0.786), _fibo(b[0], c[0], 1.272)),
                min(_fibo(x[0], a[0], 0.786), _fibo(b[0], c[0], 1.618)) if x[0] > a[0] else max(_fibo(x[0], a[0], 0.786), _fibo(b[0], c[0], 1.618)),
            ]
            _add_pattern(results, enabled, "Gartley", direction, length, candles, points, signal, ratios,
                         [_fibo(a[0], d[0], 0.382), _fibo(a[0], d[0], 0.618)], zone,
                         [("xab", 0.618, 0.618), ("abc", 0.382, 0.886), ("bcd", 1.272, 1.618), ("xad", 0.786, 0.786)], err_min, err_max)

        if (_between(ratios["xab"], 0.382, 0.618, err_min, err_max) and
                _between(ratios["abc"], 0.382, 0.886, err_min, err_max) and
                _between(ratios["bcd"], 2.24, 3.618, err_min, err_max) and
                _target(ratios["xad"], 1.618, err_min, err_max)):
            zone = [
                max(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 2.24)) if x[0] > a[0] else min(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 2.24)),
                min(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 3.618)) if x[0] > a[0] else max(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 3.618)),
            ]
            _add_pattern(results, enabled, "Yengec", direction, length, candles, points, signal, ratios, [b[0], a[0]], zone,
                         [("xab", 0.382, 0.618), ("abc", 0.382, 0.886), ("bcd", 2.24, 3.618), ("xad", 1.618, 1.618)], err_min, err_max)

        if (_target(ratios["xab"], 0.886, err_min, err_max) and
                _between(ratios["abc"], 0.382, 0.886, err_min, err_max) and
                _between(ratios["bcd"], 2.00, 3.618, err_min, err_max) and
                _target(ratios["xad"], 1.618, err_min, err_max)):
            zone = [
                max(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 2.00)) if x[0] > a[0] else min(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 2.00)),
                min(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 3.618)) if x[0] > a[0] else max(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 3.618)),
            ]
            _add_pattern(results, enabled, "Derin Yengec", direction, length, candles, points, signal, ratios, [b[0], a[0]], zone,
                         [("xab", 0.886, 0.886), ("abc", 0.382, 0.886), ("bcd", 2.00, 3.618), ("xad", 1.618, 1.618)], err_min, err_max)

        if (_between(ratios["xab"], 0.382, 0.50, err_min, err_max) and
                _between(ratios["abc"], 0.382, 0.886, err_min, err_max) and
                _between(ratios["bcd"], 1.618, 2.618, err_min, err_max) and
                _target(ratios["xad"], 0.886, err_min, err_max)):
            zone = [
                max(_fibo(x[0], a[0], 0.886), _fibo(b[0], c[0], 1.618)) if x[0] > a[0] else min(_fibo(x[0], a[0], 0.886), _fibo(b[0], c[0], 1.618)),
                min(_fibo(x[0], a[0], 0.886), _fibo(b[0], c[0], 2.618)) if x[0] > a[0] else max(_fibo(x[0], a[0], 0.886), _fibo(b[0], c[0], 2.618)),
            ]
            _add_pattern(results, enabled, "Yarasa", direction, length, candles, points, signal, ratios,
                         [_fibo(a[0], d[0], 0.382), _fibo(a[0], d[0], 0.618)], zone,
                         [("xab", 0.382, 0.50), ("abc", 0.382, 0.886), ("bcd", 1.618, 2.618), ("xad", 0.886, 0.886)], err_min, err_max)

        if (_target(ratios["xab"], 0.382, err_min, err_max) and
                _between(ratios["abc"], 0.382, 0.886, err_min, err_max) and
                _between(ratios["bcd"], 2.00, 3.618, err_min, err_max) and
                _target(ratios["xad"], 1.13, err_min, err_max)):
            zone = [
                max(_fibo(x[0], a[0], 1.13), _fibo(b[0], c[0], 2.00)) if x[0] > a[0] else min(_fibo(x[0], a[0], 1.13), _fibo(b[0], c[0], 2.00)),
                min(_fibo(x[0], a[0], 1.13), _fibo(b[0], c[0], 3.618)) if x[0] > a[0] else max(_fibo(x[0], a[0], 1.13), _fibo(b[0], c[0], 3.618)),
            ]
            _add_pattern(results, enabled, "Alt Yarasa", direction, length, candles, points, signal, ratios,
                         [_fibo(a[0], d[0], 0.382), _fibo(a[0], d[0], 0.618)], zone,
                         [("xab", 0.382, 0.382), ("abc", 0.382, 0.886), ("bcd", 2.00, 3.618), ("xad", 1.13, 1.13)], err_min, err_max)

        if (_target(ratios["xab"], 0.786, err_min, err_max) and
                _between(ratios["abc"], 0.382, 0.886, err_min, err_max) and
                _between(ratios["bcd"], 1.618, 2.618, err_min, err_max) and
                _between(ratios["xad"], 1.272, 1.618, err_min, err_max)):
            zone = [
                max(_fibo(x[0], a[0], 1.272), _fibo(b[0], c[0], 1.618)) if x[0] > a[0] else min(_fibo(x[0], a[0], 1.272), _fibo(b[0], c[0], 1.618)),
                min(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 2.618)) if x[0] > a[0] else max(_fibo(x[0], a[0], 1.618), _fibo(b[0], c[0], 2.618)),
            ]
            _add_pattern(results, enabled, "Kelebek", direction, length, candles, points, signal, ratios, [b[0], a[0]], zone,
                         [("xab", 0.786, 0.786), ("abc", 0.382, 0.886), ("bcd", 1.618, 2.618), ("xad", 1.272, 1.618)], err_min, err_max)

        if (_between(ratios["xab"], 0.382, 0.618, err_min, err_max) and
                _between(ratios["abc"], 1.13, 1.618, err_min, err_max) and
                _between(ratios["bcd"], 1.618, 2.24, err_min, err_max) and
                _between(ratios["xcd"], 0.886, 1.13, err_min, err_max)):
            zone = [
                max(_fibo(x[0], c[0], 0.886), _fibo(b[0], c[0], 1.618)) if x[0] > a[0] else min(_fibo(x[0], c[0], 0.886), _fibo(b[0], c[0], 1.618)),
                min(_fibo(x[0], c[0], 1.13), _fibo(b[0], c[0], 2.24)) if x[0] > a[0] else max(_fibo(x[0], c[0], 1.13), _fibo(b[0], c[0], 2.24)),
            ]
            _add_pattern(results, enabled, "Shark", direction, length, candles, points, signal, ratios,
                         [_fibo(c[0], d[0], 0.382), _fibo(c[0], d[0], 0.618)], zone,
                         [("xab", 0.382, 0.618), ("abc", 1.13, 1.618), ("bcd", 1.618, 2.24), ("xcd", 0.886, 1.13)], err_min, err_max)

        if (_between(ratios["xab"], 0.382, 0.618, err_min, err_max) and
                _between(ratios["abc"], 1.272, 1.414, err_min, err_max) and
                _between(ratios["bcd"], 1.272, 2.00, err_min, err_max) and
                _target(ratios["xcd"], 0.786, err_min, err_max)):
            zone = [
                max(_fibo(x[0], c[0], 0.786), _fibo(b[0], c[0], 1.272)) if x[0] > a[0] else min(_fibo(x[0], c[0], 0.786), _fibo(b[0], c[0], 1.272)),
                min(_fibo(x[0], c[0], 0.786), _fibo(b[0], c[0], 2.00)) if x[0] > a[0] else max(_fibo(x[0], c[0], 0.786), _fibo(b[0], c[0], 2.00)),
            ]
            _add_pattern(results, enabled, "Cypher", direction, length, candles, points, signal, ratios,
                         [_fibo(c[0], d[0], 0.382), _fibo(c[0], d[0], 0.618)], zone,
                         [("xab", 0.382, 0.618), ("abc", 1.272, 1.414), ("bcd", 1.272, 2.00), ("xcd", 0.786, 0.786)], err_min, err_max)

        if (_between(ratios["xab"], 0.382, 0.786, err_min, err_max) and
                _between(ratios["abc"], 1.13, 1.414, err_min, err_max) and
                _between(ratios["bcd"], 1.272, 2.618, err_min, err_max) and
                _between(ratios["xcd"], 1.13, 1.272, err_min, err_max)):
            zone = [
                max(_fibo(x[0], c[0], 1.13), _fibo(b[0], c[0], 1.272)) if x[0] > a[0] else min(_fibo(x[0], c[0], 1.13), _fibo(b[0], c[0], 1.272)),
                min(_fibo(x[0], c[0], 1.272), _fibo(b[0], c[0], 2.618)) if x[0] > a[0] else max(_fibo(x[0], c[0], 1.272), _fibo(b[0], c[0], 2.618)),
            ]
            _add_pattern(results, enabled, "Nenstar", direction, length, candles, points, signal, ratios, [b[0], a[0]], zone,
                         [("xab", 0.382, 0.786), ("abc", 1.13, 1.414), ("bcd", 1.272, 2.618), ("xcd", 1.13, 1.272)], err_min, err_max)

        if (_between(ratios["xab"], 0.382, 0.725, err_min, err_max) and
                _between(ratios["abc"], 2.00, 4.237, err_min, err_max) and
                _between(ratios["bcd"], 0.5, 0.886, err_min, err_max) and
                _between(ratios["xcd"], 0.32, 0.886, err_min, err_max)):
            zone = [
                max(_fibo(x[0], c[0], 0.382), _fibo(b[0], c[0], 0.5)) if x[0] > a[0] else min(_fibo(x[0], c[0], 0.382), _fibo(b[0], c[0], 0.5)),
                min(_fibo(x[0], c[0], 0.886), _fibo(b[0], c[0], 0.886)) if x[0] > a[0] else max(_fibo(x[0], c[0], 0.886), _fibo(b[0], c[0], 0.886)),
            ]
            _add_pattern(results, enabled, "Black Swan", direction, length, candles, points, signal, ratios,
                         [_fibo(c[0], d[0], 0.382), _fibo(c[0], d[0], 0.618)], zone,
                         [("xab", 0.382, 0.725), ("abc", 2.00, 4.237), ("bcd", 0.5, 0.886), ("xcd", 0.32, 0.886)], err_min, err_max)

        if (_between(ratios["xab"], 1.382, 2.618, err_min, err_max) and
                _between(ratios["abc"], 0.236, 0.5, err_min, err_max) and
                _between(ratios["bcd"], 1.128, 2.00, err_min, err_max) and
                _between(ratios["xad"], 1.128, 2.618, err_min, err_max)):
            zone = [
                max(_fibo(x[0], a[0], 1.128), _fibo(b[0], c[0], 1.128)) if x[0] > a[0] else min(_fibo(x[0], a[0], 1.128), _fibo(b[0], c[0], 1.128)),
                min(_fibo(x[0], a[0], 2.618), _fibo(b[0], c[0], 2.00)) if x[0] > a[0] else max(_fibo(x[0], a[0], 2.618), _fibo(b[0], c[0], 2.00)),
            ]
            _add_pattern(results, enabled, "White Swan", direction, length, candles, points, signal, ratios,
                         [_fibo(c[0], d[0], 0.382), _fibo(c[0], d[0], 0.618)], zone,
                         [("xab", 1.382, 2.618), ("abc", 0.236, 0.5), ("bcd", 1.128, 2.00), ("xad", 1.128, 2.618)], err_min, err_max)

    if (_target(ratios["yxa"], 0.618, err_min, err_max) and
            _between(ratios["xab"], 1.27, 1.618, err_min, err_max) and
            _target(ratios["abc"], 0.618, err_min, err_max) and
            _between(ratios["bcd"], 1.27, 1.618, err_min, err_max)):
        _add_pattern(results, enabled, "3 Basamak", direction, length, candles, points, signal, ratios, [c[0], a[0]], [],
                     [("yxa", 0.618, 0.618), ("xab", 1.27, 1.618), ("abc", 0.618, 0.618), ("bcd", 1.27, 1.618)], err_min, err_max)

    if (_between(ratios["xab"], 1.13, 1.618, err_min, err_max) and
            _between(ratios["abc"], 1.618, 2.24, err_min, err_max) and
            _target(ratios["bcd"], 0.5, err_min, err_max)):
        target = _fibo(b[0], c[0], 0.5)
        _add_pattern(results, enabled, "5-0", direction, length, candles, points, signal, ratios,
                     [_fibo(c[0], d[0], 1.272), _fibo(c[0], d[0], 1.682)], [target, target],
                     [("xab", 1.13, 1.618), ("abc", 1.618, 2.24), ("bcd", 0.5, 0.5)], err_min, err_max)

    if (_between(ratios["abc"], 0.618, 0.786, err_min, err_max) and
            _between(ratios["bcd"], 1.272, 1.618, err_min, err_max) and
            abcd_direction != 0):
        _add_pattern(results, enabled, "ABCD", direction, length, candles, points, signal, ratios, [c[0], b[0]], [],
                     [("abc", 0.618, 0.786), ("bcd", 1.272, 1.618)], err_min, err_max)

    if (time_ratio is not None and price_ratio is not None and
            _between(time_ratio, 1.0, 1.0, err_min, err_max) and
            _between(price_ratio, 1.0, 1.0, err_min, err_max) and
            abcd_direction != 0):
        _add_pattern(results, enabled, "AB=CD", direction, length, candles, points, signal, ratios, [c[0], b[0]], [],
                     [("time", 1.0, 1.0), ("price", 1.0, 1.0)], err_min, err_max)

    if (price_ratio is not None and
            _between(price_ratio, 1.272, 1.618, err_min, err_max) and
            _between(ratios["abc"], 0.618, 0.786, err_min, err_max) and
            abcd_direction != 0):
        _add_pattern(results, enabled, "ABCD Uzanti", direction, length, candles, points, signal, ratios, [c[0], b[0]], [],
                     [("price", 1.272, 1.618), ("abc", 0.618, 0.786)], err_min, err_max)

    is_double = ((d[2] == 1 and b[2] == 2 and c[2] == -1) or
                 (d[2] == -1 and b[2] == -2 and c[2] == 1))
    if (config["enable_double_top_bottom"] and
            "Ikili Tepe/Dip" in enabled and
            is_double and
            risk_per_reward < config["max_risk_per_reward"]):
        name = "Ikili Dip" if direction > 0 else "Ikili Tepe"
        before_count = len(results)
        _add_pattern(results, enabled, "Ikili Tepe/Dip", direction, length, candles, points, signal, ratios, [c[0], a[0]], [],
                     [("bcd", 0.0, 10.0)], err_min, err_max)
        if len(results) > before_count:
            results[-1]["name"] = name

    return [p for p in results if p["quality"] >= config["min_quality"]]


def scan_patterns(candles, config=None):
    cfg = _cfg(config)
    if not candles:
        return []

    scan_candles = candles[-cfg["max_scan_candles"]:]
    offset = len(candles) - len(scan_candles)
    all_patterns = []
    seen = set()

    for idx, length in enumerate(cfg["zigzag_lengths"]):
        if idx < len(cfg["enabled_zigzags"]) and not cfg["enabled_zigzags"][idx]:
            continue
        pivots, bars, dirs = build_zigzag(scan_candles, length, cfg["max_pivot_size"])
        patterns = _detect_from_zigzag(scan_candles, length, pivots, bars, dirs, cfg)
        for pattern in patterns:
            for key in ("X", "A", "B", "C", "D", "Y"):
                pattern[key]["i"] += offset
            pattern["signal_i"] += offset
            key = (pattern["name"], pattern["zigzag_length"], pattern["D"]["i"], pattern["signal_i"], pattern["direction"])
            if key in seen:
                continue
            seen.add(key)
            all_patterns.append(pattern)

    return sorted(all_patterns, key=lambda p: (p["signal_i"], p["D"]["i"], p["quality"]), reverse=True)


def scan_historical_patterns(candles, config=None):
    cfg = _cfg(config)
    if not candles:
        return []

    limit = cfg["max_scan_candles"]
    if len(candles) > limit:
        offset = len(candles) - limit
        candles = candles[-limit:]
    else:
        offset = 0

    found = []
    seen = set()
    active = {}
    min_bars = max(max(cfg["zigzag_lengths"]) * 3, 40)
    for end in range(min_bars, len(candles) + 1):
        current = scan_patterns(candles[:end], cfg)
        if not current:
            continue
        signal_patterns = [p for p in current if p["signal_i"] == end - 1]
        for pattern in signal_patterns:
            key = _pattern_key(pattern)
            if key in seen:
                continue
            seen.add(key)
            if offset:
                pattern = dict(pattern)
                pattern["signal_i"] += offset
                for point_key in ("X", "A", "B", "C", "D", "Y"):
                    pattern[point_key] = dict(pattern[point_key])
                    pattern[point_key]["i"] += offset
            cancel_key = _cancel_key(pattern)
            old_index = active.get(cancel_key)
            if old_index is not None:
                found[old_index] = None
            active[cancel_key] = len(found)
            found.append(pattern)

    return sorted([p for p in found if p is not None], key=lambda p: (p["signal_i"], p["quality"]), reverse=True)


def _latest_trade_pattern(candles, config):
    patterns = _latest_trade_patterns(candles, config)
    return patterns[0] if patterns else None


def _latest_trade_patterns(candles, config):
    found = scan_patterns_cached(candles, config)
    if not found:
        return []

    cfg = _cfg(config)
    last_index = len(candles) - 1
    recent = [p for p in found if last_index - p["signal_i"] <= cfg["recent_signal_bars"]]
    if not recent:
        return []
    return sorted(recent, key=lambda p: (p["signal_i"], p["D"]["i"], p["quality"]), reverse=True)


def _pattern_key(pattern):
    return (
        pattern.get("name"),
        pattern.get("zigzag_length"),
        pattern.get("direction"),
        pattern["X"]["i"],
        pattern["A"]["i"],
        pattern["B"]["i"],
        pattern["C"]["i"],
        pattern["D"]["i"],
    )


def _learning_bucket(pattern, cfg):
    group = cfg.get("learning_group", "pattern_length_direction")
    parts = [str(pattern.get("name") or "pattern")]
    if group in ("pattern_length", "pattern_length_direction"):
        parts.append(f"L{pattern.get('zigzag_length')}")
    if group in ("pattern_direction", "pattern_length_direction"):
        parts.append(str(pattern.get("direction") or "none"))
    return "|".join(parts)


def _candle_value(candle, key, fallback=None):
    if isinstance(candle, dict):
        return candle.get(key, fallback)
    return getattr(candle, key, fallback)


def _learning_register(patterns, cfg):
    max_open = cfg.get("learning_max_open", 300)
    for pattern in patterns:
        key = _pattern_key(pattern)
        if key in LEARNING_STATE["seen"]:
            continue
        LEARNING_STATE["seen"].add(key)
        sl_price, tp_price = _entry_trade_levels(pattern, cfg)
        entry = pattern.get("D", {}).get("c")
        direction = pattern.get("direction")
        if entry is None or sl_price is None or tp_price is None or direction not in ("bullish", "bearish"):
            continue
        if direction == "bullish" and not (sl_price < entry < tp_price):
            continue
        if direction == "bearish" and not (tp_price < entry < sl_price):
            continue
        LEARNING_STATE["open"].append({
            "key": key,
            "bucket": _learning_bucket(pattern, cfg),
            "direction": direction,
            "entry": float(entry),
            "sl": float(sl_price),
            "tp": float(tp_price),
            "start_i": int(pattern.get("signal_i", pattern.get("D", {}).get("i", 0)) or 0),
        })
    if len(LEARNING_STATE["open"]) > max_open:
        LEARNING_STATE["open"] = LEARNING_STATE["open"][-max_open:]


def _learning_record(trade, won):
    entry = float(trade["entry"])
    sl_price = float(trade["sl"])
    tp_price = float(trade["tp"])
    risk = abs(entry - sl_price)
    reward = abs(tp_price - entry)
    r_value = (reward / risk) if won and risk > 0 else -1.0
    bucket = trade["bucket"]
    stats = LEARNING_STATE["stats"].setdefault(bucket, {
        "count": 0,
        "wins": 0,
        "losses": 0,
        "sum_r": 0.0,
    })
    stats["count"] += 1
    stats["wins"] += 1 if won else 0
    stats["losses"] += 0 if won else 1
    stats["sum_r"] += r_value


def _learning_update(candle, candles, cfg):
    if not LEARNING_STATE["open"]:
        return
    high = float(_candle_value(candle, "h", _candle_value(candle, "high", 0)) or 0)
    low = float(_candle_value(candle, "l", _candle_value(candle, "low", 0)) or 0)
    close = float(_candle_value(candle, "c", _candle_value(candle, "close", 0)) or 0)
    current_i = len(candles) - 1
    horizon = cfg.get("learning_horizon_bars", 96)
    remaining = []
    for trade in LEARNING_STATE["open"]:
        direction = trade["direction"]
        hit_tp = high >= trade["tp"] if direction == "bullish" else low <= trade["tp"]
        hit_sl = low <= trade["sl"] if direction == "bullish" else high >= trade["sl"]
        if hit_tp or hit_sl:
            _learning_record(trade, bool(hit_tp and not hit_sl))
            continue
        if current_i - trade.get("start_i", current_i) >= horizon:
            won = close > trade["entry"] if direction == "bullish" else close < trade["entry"]
            _learning_record(trade, won)
            continue
        remaining.append(trade)
    LEARNING_STATE["open"] = remaining


def _passes_learning_filter(pattern, cfg):
    if not cfg.get("learning_filter"):
        return True
    stats = LEARNING_STATE["stats"].get(_learning_bucket(pattern, cfg))
    if not stats or stats.get("count", 0) < cfg.get("learning_min_samples", 4):
        return False
    count = max(1, stats.get("count", 0))
    win_rate = stats.get("wins", 0) * 100.0 / count
    expectancy = stats.get("sum_r", 0.0) / count
    return (
        win_rate >= cfg.get("learning_min_win_rate", 55.0)
        and expectancy >= cfg.get("learning_min_expectancy_r", 0.0)
    )


def _cancel_key(pattern):
    if pattern.get("name") in ("ABCD", "AB=CD", "ABCD Uzanti", "Ikili Tepe", "Ikili Dip"):
        return (
            pattern.get("name"),
            pattern.get("zigzag_length"),
            pattern.get("direction"),
            pattern["A"]["i"],
            pattern["B"]["i"],
            pattern["C"]["i"],
        )
    return (
        pattern.get("name"),
        pattern.get("zigzag_length"),
        pattern.get("direction"),
        pattern["X"]["i"],
        pattern["A"]["i"],
        pattern["B"]["i"],
        pattern["C"]["i"],
    )


def _observation_name(pattern):
    clean = str(pattern.get("name") or "pattern").lower().replace(" ", "_").replace("-", "_")
    length = pattern.get("zigzag_length")
    return f"harmonic.{clean}.l{length}" if length else f"harmonic.{clean}"


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _set_trade_meta(pattern, context=None):
    fn = getattr(_builtins, "set_meta", None)
    if callable(fn):
        meta = {
            "pattern": pattern.get("name"),
            "direction": pattern.get("direction"),
            "zigzag_length": pattern.get("zigzag_length"),
            "quality": pattern.get("quality"),
            "signal_i": pattern.get("signal_i"),
            "d_time": pattern.get("D", {}).get("t"),
        }
        if isinstance(context, dict):
            meta.update({
                "htf_regime": context.get("htf_regime"),
                "htf_timeframe": context.get("htf_timeframe"),
                "dema_trend": context.get("dema_trend"),
            })
        fn(**meta)


def _draw_point(pattern, key):
    point = pattern.get(key) or {}
    return {"time": point.get("t"), "price": point.get("c")}


def _pattern_group(pattern):
    return ".".join(str(part) for part in (
        pattern.get("name", "pattern"),
        pattern.get("zigzag_length", "z"),
        pattern.get("direction", "dir"),
        pattern.get("signal_i", "s"),
        pattern.get("D", {}).get("i", "d"),
    ))


def _pattern_color(pattern):
    key = _pattern_group(pattern)
    index = sum(ord(char) for char in key) % len(PATTERN_DRAW_COLORS)
    return PATTERN_DRAW_COLORS[index]


def _bar_ms(pattern):
    steps = []
    for first, second in (("X", "A"), ("A", "B"), ("B", "C"), ("C", "D")):
        p1 = pattern.get(first) or {}
        p2 = pattern.get(second) or {}
        t1 = p1.get("t")
        t2 = p2.get("t")
        i1 = p1.get("i")
        i2 = p2.get("i")
        if t1 is None or t2 is None or i1 is None or i2 is None:
            continue
        bars = abs(i2 - i1)
        if bars > 0:
            step = abs(t2 - t1) / bars
            if step > 0:
                steps.append(step)
    return int(steps[-1]) if steps else 3_600_000


def _level_drawings(group, pattern, price, text, color, style="dashed"):
    if price is None or price <= 0:
        return []
    d = pattern.get("D") or {}
    d_time = d.get("t")
    if d_time is None:
        return []
    end_time = d_time + _bar_ms(pattern) * 30
    point = {"time": end_time, "price": price}
    return [
        {
            "type": "line",
            "first": {"time": d_time, "price": price},
            "second": point,
            "color": color,
            "style": style,
            "width": 1,
            "group": group,
        },
        {
            "type": "label",
            "point": point,
            "text": text,
            "color": color,
            "textcolor": "#0f172a",
            "style": "label_down",
            "size": "small",
            "group": group,
        },
    ]


def _pct_level(entry, direction, pct, is_target):
    if entry is None or pct is None or pct <= 0:
        return None
    if direction == "bullish":
        return entry * (1 + pct / 100.0) if is_target else entry * (1 - pct / 100.0)
    return entry * (1 - pct / 100.0) if is_target else entry * (1 + pct / 100.0)


def _valid_level(pattern, values, index, is_target=True):
    entry = pattern.get("D", {}).get("c")
    direction = pattern.get("direction")
    if entry is None:
        return None
    candidates = []
    for raw in values or []:
        value = _to_float(raw, None)
        if value is None or value <= 0:
            continue
        if direction == "bullish" and ((is_target and value > entry) or (not is_target and value < entry)):
            candidates.append(value)
        elif direction == "bearish" and ((is_target and value < entry) or (not is_target and value > entry)):
            candidates.append(value)
    if not candidates:
        return None
    safe_index = max(0, min(index, len(candidates) - 1))
    return candidates[safe_index]


def _target_price(pattern, mode):
    value = str(mode or "").strip().lower()
    if value in ("target_1", "hedef_1", "h1", "t1"):
        return _valid_level(pattern, pattern.get("targets"), 0, True)
    if value in ("target_2", "hedef_2", "h2", "t2"):
        return _valid_level(pattern, pattern.get("targets"), 1, True)
    return None


def _trail_take_profit(pattern, cfg):
    mode = str(cfg.get("trail_take_profit_mode") or "").strip().lower()
    if mode in ("", "none", "off", "disabled", "trail_only", "takip"):
        return None
    return _target_price(pattern, mode)


def _target_risk_stop(pattern, tp_price, ratio):
    entry = pattern.get("D", {}).get("c")
    direction = pattern.get("direction")
    if entry is None or tp_price is None:
        return None
    distance = abs(tp_price - entry)
    if distance <= 0:
        return None
    if direction == "bullish":
        return entry - distance * ratio
    if direction == "bearish":
        return entry + distance * ratio
    return None


def _stop_price(pattern, mode, cfg=None, tp_price=None):
    cfg = cfg if isinstance(cfg, dict) else {}
    value = str(mode or "").strip().lower()
    if value in ("strategy", "auto", "default", ""):
        value = "target_risk"
    if value in ("target_risk", "target_ratio", "target_distance", "risk_reward", "orantili", "1r"):
        if tp_price is None:
            tp_price = _target_price(pattern, cfg.get("take_profit_mode"))
        return _target_risk_stop(pattern, tp_price, _to_float(cfg.get("stop_loss_target_ratio"), 1.0))
    if value in ("confirmation_zone", "zone", "teyit"):
        return _valid_level(pattern, pattern.get("confirmation_zone"), 0, False)
    if value in ("x_point", "x", "x_invalidated"):
        return pattern.get("X", {}).get("c")
    if value in ("bot_percent", "percent", "pct", "yuzde"):
        return _pct_level(
            pattern.get("D", {}).get("c"),
            pattern.get("direction"),
            _to_float(cfg.get("stop_loss_pct"), None),
            False,
        )
    return None


def _trade_levels(pattern, cfg):
    tp_price = _target_price(pattern, cfg.get("take_profit_mode"))
    sl_price = _stop_price(pattern, cfg.get("stop_loss_mode"), cfg, tp_price)
    return sl_price, tp_price


def _entry_trade_levels(pattern, cfg):
    if cfg.get("exit_mode") == "target_trail":
        trigger = _target_price(pattern, cfg.get("trail_trigger_mode") or "target_1")
        tp_price = _trail_take_profit(pattern, cfg)
        sl_price = _stop_price(pattern, cfg.get("stop_loss_mode"), cfg, trigger)
        return sl_price, tp_price
    if cfg.get("exit_mode") != "tp2_trail":
        return _trade_levels(pattern, cfg)
    tp1 = _target_price(pattern, "target_1")
    tp2 = _target_price(pattern, "target_2") or tp1
    sl_price = _stop_price(pattern, cfg.get("stop_loss_mode"), cfg, tp1)
    return sl_price, tp2


def _apply_trade_levels(pattern, cfg):
    sl_price, tp_price = _entry_trade_levels(pattern, cfg)
    if tp_price is not None:
        set_tp(price=tp_price)
    if sl_price is not None:
        set_sl(price=sl_price)


def _atr_value(candles, period):
    if len(candles) < 2:
        return None
    trs = []
    start = max(1, len(candles) - period)
    for idx in range(start, len(candles)):
        high = float(candles[idx]["h"])
        low = float(candles[idx]["l"])
        prev_close = float(candles[idx - 1]["c"])
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return sum(trs) / len(trs) if trs else None


def _start_active_trade(pattern, cfg):
    global ACTIVE_TRADE
    sl_price, tp_price = _entry_trade_levels(pattern, cfg)
    ACTIVE_TRADE = {
        "direction": pattern.get("direction"),
        "entry": None,
        "sl": sl_price,
        "tp": tp_price,
        "tp1": _target_price(pattern, "target_1"),
        "tp2": _target_price(pattern, "target_2") or _target_price(pattern, "target_1"),
        "trail_trigger": _target_price(pattern, cfg.get("trail_trigger_mode") or "target_1") if cfg.get("exit_mode") == "target_trail" else _target_price(pattern, "target_1"),
        "trail_reached": False,
    }


def _manage_active_trade(candle, candles, cfg):
    global ACTIVE_TRADE
    if cfg.get("exit_mode") not in ("tp2_trail", "target_trail") or ACTIVE_TRADE is None:
        hold()
        return

    direction = ACTIVE_TRADE.get("direction")
    entry = ACTIVE_TRADE.get("entry")
    if entry is None:
        entry = float(candle.open)
        ACTIVE_TRADE["entry"] = entry

    trigger = ACTIVE_TRADE.get("trail_trigger") or ACTIVE_TRADE.get("tp1")
    tp_price = ACTIVE_TRADE.get("tp")
    if tp_price is not None:
        set_tp(price=tp_price)

    if trigger is not None:
        if direction == "bullish" and float(candle.high) >= float(trigger):
            ACTIVE_TRADE["trail_reached"] = True
        elif direction == "bearish" and float(candle.low) <= float(trigger):
            ACTIVE_TRADE["trail_reached"] = True

    if not ACTIVE_TRADE.get("trail_reached"):
        hold()
        return

    buffer_pct = cfg.get("breakeven_buffer_pct", 0.05) / 100.0
    atr = _atr_value(candles, cfg.get("trail_atr_period", 14))
    current_sl = ACTIVE_TRADE.get("sl")
    close = float(candle.close)
    if direction == "bullish":
        breakeven = entry * (1.0 - buffer_pct)
        trail = close - atr * cfg.get("trail_atr_mult", 1.2) if atr is not None else breakeven
        candidates = [v for v in (current_sl, breakeven, trail) if v is not None and v < entry]
        if candidates:
            next_sl = max(candidates)
            ACTIVE_TRADE["sl"] = next_sl
            set_sl(price=next_sl)
    elif direction == "bearish":
        breakeven = entry * (1.0 + buffer_pct)
        trail = close + atr * cfg.get("trail_atr_mult", 1.2) if atr is not None else breakeven
        candidates = [v for v in (current_sl, breakeven, trail) if v is not None and v > entry]
        if candidates:
            next_sl = min(candidates)
            ACTIVE_TRADE["sl"] = next_sl
            set_sl(price=next_sl)
    hold()


def _pattern_drawings(pattern, config=None):
    color = _pattern_color(pattern)
    helper_color = color
    group = _pattern_group(pattern)
    drawings = []
    for first, second in (("X", "A"), ("A", "B"), ("B", "C"), ("C", "D")):
        drawings.append({
            "type": "line",
            "first": _draw_point(pattern, first),
            "second": _draw_point(pattern, second),
            "color": color,
            "style": "solid",
            "width": 1,
            "group": group,
        })
    for first, second in (("X", "B"), ("B", "D")):
        drawings.append({
            "type": "line",
            "first": _draw_point(pattern, first),
            "second": _draw_point(pattern, second),
            "color": helper_color,
            "style": "dotted",
            "width": 1,
            "group": group,
        })
    drawings.append({
        "type": "label",
        "point": _draw_point(pattern, "D"),
        "text": f"{pattern.get('direction', '')} {pattern.get('name', '')} L{pattern.get('zigzag_length', '')}".strip(),
        "color": color,
        "textcolor": "#0f172a",
        "style": "label_up" if pattern.get("direction") == "bullish" else "label_down",
        "size": "small",
        "group": group,
    })

    for idx, target in enumerate((pattern.get("targets") or [])[:2], start=1):
        drawings.extend(_level_drawings(group, pattern, _to_float(target, None), f"Hedef {idx}", "#38bdf8"))

    for idx, zone_price in enumerate((pattern.get("confirmation_zone") or [])[:2], start=1):
        drawings.extend(_level_drawings(group, pattern, _to_float(zone_price, None), f"Teyit {idx}", "#f59e0b", "dotted"))

    cfg = _cfg(config)
    sl_price, tp_price = _trade_levels(pattern, cfg)
    drawings.extend(_level_drawings(group, pattern, sl_price, "SL", "#ef4444"))
    drawings.extend(_level_drawings(group, pattern, tp_price, "TP", "#22c55e"))
    return drawings


def _draw_pattern(pattern):
    line_obj = getattr(_builtins, "line", None)
    label_obj = getattr(_builtins, "label", None)
    line_new = getattr(line_obj, "new", None)
    label_new = getattr(label_obj, "new", None)

    for drawing in _pattern_drawings(pattern):
        if drawing["type"] == "line" and callable(line_new):
            line_new(
                drawing["first"],
                drawing["second"],
                color=drawing["color"],
                style=drawing["style"],
                width=drawing["width"],
                group=drawing.get("group"),
            )
        elif drawing["type"] == "label" and callable(label_new):
            label_new(
                drawing["point"],
                text=drawing["text"],
                color=drawing["color"],
                textcolor=drawing["textcolor"],
                style=drawing["style"],
                size=drawing["size"],
                group=drawing.get("group"),
            )


def draw(candles, indicators, patterns, config=None):
    cfg = _cfg(config)
    source = candles[-cfg["draw_history_bars"]:] if cfg["draw_historical_patterns"] else candles
    found = scan_historical_patterns(source, cfg) if cfg["draw_historical_patterns"] else _latest_trade_patterns(source, cfg)
    if not found:
        return []
    drawings = []
    for pattern in found[:cfg["max_draw_patterns"]]:
        drawings.extend(_pattern_drawings(pattern, cfg))
    return drawings


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_KEY
    global OBSERVED_KEYS
    global ACTIVE_TRADE

    candles = _series_candles()
    if len(candles) < 40:
        hold()
        return

    cfg = _cfg(config)
    _learning_update(candle, candles, cfg)
    patterns = _latest_trade_patterns(candles, cfg)
    market_context = _market_context(candles, cfg)

    for observed in patterns:
        observed_key = _pattern_key(observed)
        if observed_key in OBSERVED_KEYS:
            continue
        OBSERVED_KEYS.add(observed_key)
        _observe(
            _observation_name(observed),
            side="long" if observed["direction"] == "bullish" else "short",
            pattern=observed["name"],
            direction=observed["direction"],
            zigzag_length=observed["zigzag_length"],
            quality=observed["quality"],
            repaint=cfg["allow_repaint"],
            d_time=observed["D"]["t"],
            htf_regime=market_context.get("htf_regime"),
            htf_timeframe=market_context.get("htf_timeframe"),
            dema_trend=market_context.get("dema_trend"),
        )
    _learning_register(patterns, cfg)

    if bool(getattr(portfolio, "has_position", False)):
        if ACTIVE_TRADE is not None:
            _manage_active_trade(candle, candles, cfg)
        else:
            hold()
        return

    if ACTIVE_TRADE is not None:
        ACTIVE_TRADE = None

    if not patterns:
        hold()
        return

    smc_events = _recent_smc_events(candles, cfg)
    trade_patterns = [
        p for p in patterns
        if (
            (cfg["allow_short"] or p.get("direction") == "bullish")
            and
            _passes_trade_filters(p, cfg)
            and _passes_learning_filter(p, cfg)
            and _passes_market_filters(p, candles, cfg, market_context)
            and _passes_smc_filter(p, smc_events, cfg)
        )
    ]
    if not trade_patterns:
        hold()
        return

    trade_patterns.sort(key=lambda p: _pattern_priority(p, cfg, market_context), reverse=True)
    pattern = trade_patterns[0]

    signal_key = _pattern_key(pattern)
    if signal_key == LAST_SIGNAL_KEY:
        hold()
        return

    LAST_SIGNAL_KEY = signal_key
    if pattern["direction"] == "bullish":
        _apply_trade_levels(pattern, cfg)
        _start_active_trade(pattern, cfg)
        _set_trade_meta(pattern, market_context)
        buy()
    elif cfg["allow_short"]:
        _apply_trade_levels(pattern, cfg)
        _start_active_trade(pattern, cfg)
        _set_trade_meta(pattern, market_context)
        sell()
    else:
        hold()
