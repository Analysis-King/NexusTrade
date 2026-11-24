# name: Reees Harmonic System
# desc: Reees Harmonic Pattern Detection scriptinin NexusTrade icin Python strateji uyarlamasi
# author: NexusTrade
# version: 0.1
# source: TradingView Pine script "Harmonic Pattern Detection, Prediction, and Backtesting System"

import builtins as _builtins
import math

from strategies import pine_harmonic_patterns as base


LAST_SIGNAL_KEY = None
OBSERVED_KEYS = set()


BASE_NAME_TO_REEES = {
    "Gartley": "Gartley",
    "Yarasa": "Bat",
    "Kelebek": "Butterfly",
    "Yengec": "Crab",
    "Shark": "Shark",
    "Cypher": "Cypher",
}

REEES_NAME_TO_BASE = {value: key for key, value in BASE_NAME_TO_REEES.items()}

TARGET_DEFAULTS = {
    "Gartley": (".382 AD", ".618 AD"),
    "Bat": (".382 AD", ".618 AD"),
    "Butterfly": ("B", "A"),
    "Crab": ("B", "A"),
    "Shark": (".382 CD", ".618 CD"),
    "Cypher": (".382 CD", ".618 CD"),
}

FIB = {
    0.382: 0.3819660112501052,
    0.618: 0.6180339887498948,
    0.786: 0.7861513777574233,
    0.886: 0.8866517793121622,
    1.272: 1.2720196495140689,
    1.414: 1.4142135623730950,
    1.618: 1.6180339887498948,
    2.618: 2.6180339887498948,
}


def initialize():
    return {
        "include_bullish": True,
        "include_bearish": True,
        "include_gartley": True,
        "include_bat": True,
        "include_butterfly": True,
        "include_crab": True,
        "include_shark": True,
        "include_cypher": True,
        "only_high_scoring": True,
        "min_score_after_d": 85.0,
        "allowed_fib_error_pct": 15.0,
        "allowed_asymmetry_pct": 250.0,
        "pivot_lengths": [3, 4, 5, 6, 7, 8, 9, 10, 13, 16, 20],
        "allow_repaint": False,
        "pattern_validation_bars": 1,
        "max_scan_candles": 900,
        "recent_signal_bars": 2,
        "enter_after_c": False,
        "enter_after_d": True,
        "entry_limit_pct_away_from_d": 1.0,
        "respect_entry_limit": True,
        "entry_time_limit_mult": 0.5,
        "pattern_time_limit_mult": 3.0,
        "stop_pct": 75.0,
        "stop_basis": "target_1_distance",
        "take_profit": "target_1",
        "min_reward_risk": 0.5,
        "exit_on_opposite_signal": True,
        "draw_historical_patterns": True,
        "draw_history_bars": 520,
        "max_draw_patterns": 20,
        "gartley_target_1": TARGET_DEFAULTS["Gartley"][0],
        "gartley_target_2": TARGET_DEFAULTS["Gartley"][1],
        "bat_target_1": TARGET_DEFAULTS["Bat"][0],
        "bat_target_2": TARGET_DEFAULTS["Bat"][1],
        "butterfly_target_1": TARGET_DEFAULTS["Butterfly"][0],
        "butterfly_target_2": TARGET_DEFAULTS["Butterfly"][1],
        "crab_target_1": TARGET_DEFAULTS["Crab"][0],
        "crab_target_2": TARGET_DEFAULTS["Crab"][1],
        "shark_target_1": TARGET_DEFAULTS["Shark"][0],
        "shark_target_2": TARGET_DEFAULTS["Shark"][1],
        "cypher_target_1": TARGET_DEFAULTS["Cypher"][0],
        "cypher_target_2": TARGET_DEFAULTS["Cypher"][1],
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
        return value.strip().lower() not in ("0", "false", "no", "hayir", "kapali", "off")
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

    for key in (
        "include_bullish",
        "include_bearish",
        "include_gartley",
        "include_bat",
        "include_butterfly",
        "include_crab",
        "include_shark",
        "include_cypher",
        "only_high_scoring",
        "allow_repaint",
        "enter_after_c",
        "enter_after_d",
        "respect_entry_limit",
        "exit_on_opposite_signal",
        "draw_historical_patterns",
    ):
        cfg[key] = _to_bool(cfg.get(key), bool(initialize().get(key)))

    cfg["pivot_lengths"] = [
        max(2, _to_int(value, 5))
        for value in _list_value(cfg.get("pivot_lengths"), initialize()["pivot_lengths"])
    ]
    cfg["allowed_fib_error_pct"] = max(0.0, min(50.0, _to_float(cfg.get("allowed_fib_error_pct"), 15.0)))
    cfg["allowed_asymmetry_pct"] = max(0.0, _to_float(cfg.get("allowed_asymmetry_pct"), 250.0))
    cfg["min_score_after_d"] = max(0.0, min(100.0, _to_float(cfg.get("min_score_after_d"), 85.0)))
    cfg["pattern_validation_bars"] = max(0, _to_int(cfg.get("pattern_validation_bars"), 1))
    cfg["max_scan_candles"] = max(120, _to_int(cfg.get("max_scan_candles"), 900))
    cfg["recent_signal_bars"] = max(0, _to_int(cfg.get("recent_signal_bars"), 2))
    cfg["entry_limit_pct_away_from_d"] = max(0.0, _to_float(cfg.get("entry_limit_pct_away_from_d"), 1.0))
    cfg["entry_time_limit_mult"] = max(0.0, _to_float(cfg.get("entry_time_limit_mult"), 0.5))
    cfg["pattern_time_limit_mult"] = max(0.1, _to_float(cfg.get("pattern_time_limit_mult"), 3.0))
    cfg["stop_pct"] = max(0.0, _to_float(cfg.get("stop_pct"), 75.0))
    cfg["stop_basis"] = str(cfg.get("stop_basis") or "target_1_distance").strip().lower()
    cfg["take_profit"] = str(cfg.get("take_profit") or "target_1").strip().lower()
    cfg["min_reward_risk"] = max(0.0, _to_float(cfg.get("min_reward_risk"), 0.5))
    cfg["draw_history_bars"] = max(40, _to_int(cfg.get("draw_history_bars"), 520))
    cfg["max_draw_patterns"] = max(0, _to_int(cfg.get("max_draw_patterns"), 20))
    return cfg


def _base_config(cfg):
    enabled = []
    include_map = {
        "Gartley": "include_gartley",
        "Bat": "include_bat",
        "Butterfly": "include_butterfly",
        "Crab": "include_crab",
        "Shark": "include_shark",
        "Cypher": "include_cypher",
    }
    for reees_name, key in include_map.items():
        if cfg.get(key):
            enabled.append(REEES_NAME_TO_BASE[reees_name])

    return {
        "error_percent": cfg["allowed_fib_error_pct"],
        "zigzag_lengths": cfg["pivot_lengths"],
        "enabled_zigzags": [True] * len(cfg["pivot_lengths"]),
        "allow_repaint": cfg["allow_repaint"],
        "wait_for_confirmation": not cfg["allow_repaint"],
        "recent_signal_bars": cfg["recent_signal_bars"],
        "min_quality": 0,
        "enabled_patterns": enabled,
        "enable_double_top_bottom": False,
        "max_scan_candles": cfg["max_scan_candles"],
        "draw_historical_patterns": cfg["draw_historical_patterns"],
        "draw_history_bars": cfg["draw_history_bars"],
        "max_draw_patterns": cfg["max_draw_patterns"],
    }


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


def _point_price(pattern, key):
    value = pattern.get(key, {}).get("c")
    return _to_float(value, None)


def _point_index(pattern, key):
    value = pattern.get(key, {}).get("i")
    return _to_int(value, None)


def _safe_abs_diff(a, b):
    if a is None or b is None:
        return None
    return abs(float(a) - float(b))


def _safe_ratio(num, denom):
    if num is None or denom is None or denom == 0:
        return None
    return abs(float(num)) / abs(float(denom))


def _fib(value):
    return FIB.get(value, value)


def _near_ratio(value, target, pct_err):
    if value is None:
        return False
    target = _fib(target)
    return target * (1.0 - pct_err / 100.0) <= value <= target * (1.0 + pct_err / 100.0)


def _near_any(value, targets, pct_err):
    if value is None:
        return False
    if len(targets) >= 2:
        low = min(_fib(target) for target in targets)
        high = max(_fib(target) for target in targets)
        return low * (1.0 - pct_err / 100.0) <= value <= high * (1.0 + pct_err / 100.0)
    return any(_near_ratio(value, target, pct_err) for target in targets)


def _leg_symmetry_ok(pattern, cfg):
    x = _point_index(pattern, "X")
    a = _point_index(pattern, "A")
    b = _point_index(pattern, "B")
    c = _point_index(pattern, "C")
    d = _point_index(pattern, "D")
    if None in (x, a, b, c, d):
        return False

    legs = [
        abs(a - x),
        abs(b - a),
        abs(c - b),
        abs(d - c),
    ]
    if any(value <= 0 for value in legs):
        return False

    asym = cfg["allowed_asymmetry_pct"] / 100.0
    for idx, value in enumerate(legs):
        others = [leg for j, leg in enumerate(legs) if j != idx]
        avg = sum(others) / len(others)
        if value > avg * (1.0 + asym) or value < avg * (1.0 - asym):
            return False
    return True


def _reees_ratios(pattern):
    x = _point_price(pattern, "X")
    a = _point_price(pattern, "A")
    b = _point_price(pattern, "B")
    c = _point_price(pattern, "C")
    d = _point_price(pattern, "D")
    xa = _safe_abs_diff(x, a)
    ab = _safe_abs_diff(a, b)
    bc = _safe_abs_diff(b, c)
    cd = _safe_abs_diff(c, d)
    ad = _safe_abs_diff(a, d)
    xc = _safe_abs_diff(x, c)
    return {
        "ab_xa": _safe_ratio(ab, xa),
        "bc_ab": _safe_ratio(bc, ab),
        "cd_bc": _safe_ratio(cd, bc),
        "ad_xa": _safe_ratio(ad, xa),
        "cd_xc": _safe_ratio(cd, xc),
    }


def _reees_type_valid(reees_name, ratios, cfg):
    err = cfg["allowed_fib_error_pct"]
    ab_xa = ratios.get("ab_xa")
    bc_ab = ratios.get("bc_ab")
    cd_bc = ratios.get("cd_bc")
    ad_xa = ratios.get("ad_xa")
    cd_xc = ratios.get("cd_xc")

    if reees_name == "Gartley":
        return (
            _near_ratio(ab_xa, 0.618, err)
            and _near_any(bc_ab, (0.382, 0.886), err)
            and _near_any(cd_bc, (1.272, 1.618), err)
            and _near_ratio(ad_xa, 0.786, err)
        )
    if reees_name == "Bat":
        return (
            _near_any(ab_xa, (0.382, 0.5), err)
            and _near_any(bc_ab, (0.382, 0.886), err)
            and _near_any(cd_bc, (1.618, 2.618), err)
            and _near_ratio(ad_xa, 0.886, err)
        )
    if reees_name == "Butterfly":
        return (
            _near_ratio(ab_xa, 0.786, err)
            and _near_any(bc_ab, (0.382, 0.886), err)
            and _near_any(cd_bc, (1.618, 2.618), err)
            and _near_any(ad_xa, (1.272, 1.618), err)
        )
    if reees_name == "Crab":
        return (
            _near_any(ab_xa, (0.382, 0.618), err)
            and _near_any(bc_ab, (0.382, 0.886), err)
            and _near_any(cd_bc, (2.24, 3.618), err)
            and _near_ratio(ad_xa, 1.618, err)
        )
    if reees_name == "Shark":
        return (
            ab_xa is not None
            and ab_xa < 1.0
            and _near_any(bc_ab, (1.13, 1.618), err)
            and _near_any(cd_bc, (1.618, 2.24), err)
            and _near_any(cd_xc, (0.886, 1.13), err)
        )
    if reees_name == "Cypher":
        return (
            _near_any(ab_xa, (0.382, 0.618), err)
            and _near_any(bc_ab, (1.272, 1.414), err)
            and _near_ratio(cd_xc, 0.786, err)
        )
    return False


def _nearest_error(value, targets):
    if value is None:
        return 1.0
    if len(targets) >= 2:
        low = min(_fib(target) for target in targets)
        high = max(_fib(target) for target in targets)
        if low <= value <= high:
            return 0.0
        if value < low and low:
            return abs(value - low) / low
        if high:
            return abs(value - high) / high
        return 1.0
    errors = []
    for target in targets:
        precise = _fib(target)
        if precise:
            errors.append(abs(value - precise) / precise)
    return min(errors) if errors else 1.0


def _reees_score(pattern, ratios, cfg):
    name = BASE_NAME_TO_REEES.get(pattern.get("name"), pattern.get("name"))
    checks = {
        "Gartley": (
            (ratios.get("ab_xa"), (0.618,)),
            (ratios.get("bc_ab"), (0.382, 0.886)),
            (ratios.get("cd_bc"), (1.272, 1.618)),
            (ratios.get("ad_xa"), (0.786,)),
        ),
        "Bat": (
            (ratios.get("ab_xa"), (0.382, 0.5)),
            (ratios.get("bc_ab"), (0.382, 0.886)),
            (ratios.get("cd_bc"), (1.618, 2.618)),
            (ratios.get("ad_xa"), (0.886,)),
        ),
        "Butterfly": (
            (ratios.get("ab_xa"), (0.786,)),
            (ratios.get("bc_ab"), (0.382, 0.886)),
            (ratios.get("cd_bc"), (1.618, 2.618)),
            (ratios.get("ad_xa"), (1.272, 1.618)),
        ),
        "Crab": (
            (ratios.get("ab_xa"), (0.382, 0.618)),
            (ratios.get("bc_ab"), (0.382, 0.886)),
            (ratios.get("cd_bc"), (2.24, 3.618)),
            (ratios.get("ad_xa"), (1.618,)),
        ),
        "Shark": (
            (ratios.get("bc_ab"), (1.13, 1.618)),
            (ratios.get("cd_bc"), (1.618, 2.24)),
            (ratios.get("cd_xc"), (0.886, 1.13)),
        ),
        "Cypher": (
            (ratios.get("ab_xa"), (0.382, 0.618)),
            (ratios.get("bc_ab"), (1.272, 1.414)),
            (ratios.get("cd_xc"), (0.786,)),
        ),
    }.get(name, ())
    if not checks:
        return _to_float(pattern.get("quality"), 0.0)
    avg_error = sum(_nearest_error(value, targets) for value, targets in checks) / len(checks)
    score = max(0.0, 100.0 * (1.0 - avg_error / max(0.01, cfg["allowed_fib_error_pct"] / 100.0)))
    return min(100.0, score)


def _passes_reees_validation(pattern, cfg):
    reees_name = BASE_NAME_TO_REEES.get(pattern.get("name"), pattern.get("name"))
    if reees_name not in TARGET_DEFAULTS:
        return False
    if not _leg_symmetry_ok(pattern, cfg):
        return False
    ratios = _reees_ratios(pattern)
    if not _reees_type_valid(reees_name, ratios, cfg):
        return False
    pattern["reees_ratios"] = {key: round(value, 6) for key, value in ratios.items() if value is not None}
    pattern["reees_score"] = round(_reees_score(pattern, ratios, cfg), 2)
    pattern["quality"] = max(_to_float(pattern.get("quality"), 0.0), pattern["reees_score"])
    return True


def _profit_sign(pattern):
    return 1.0 if pattern.get("direction") == "bullish" else -1.0


def _ratio_token(token):
    token = str(token or "").strip()
    if not token:
        return None
    if token.startswith("."):
        token = "0" + token
    return _to_float(token, None)


def _profit_target(pattern, spec):
    text = str(spec or "").strip()
    if not text or text.lower() == "none":
        return None

    upper = text.upper().replace("\u00a0", " ")
    for point_name in ("A", "B", "C"):
        if upper == point_name:
            return _point_price(pattern, point_name)

    parts = upper.split()
    if len(parts) != 2:
        return None
    ratio = _ratio_token(parts[0])
    leg = parts[1]
    if ratio is None:
        return None

    entry = _point_price(pattern, "D")
    sign = _profit_sign(pattern)
    if entry is None:
        return None

    if leg == "AD":
        distance = _safe_abs_diff(_point_price(pattern, "A"), entry)
    elif leg == "XA":
        distance = _safe_abs_diff(_point_price(pattern, "X"), _point_price(pattern, "A"))
    elif leg == "CD":
        distance = _safe_abs_diff(_point_price(pattern, "C"), entry)
    else:
        return None

    if distance is None or distance <= 0:
        return None
    return entry + sign * ratio * distance


def _target_specs(pattern, cfg):
    reees_name = BASE_NAME_TO_REEES.get(pattern.get("name"), pattern.get("name"))
    key = reees_name.lower()
    if key == "butterfly":
        prefix = "butterfly"
    else:
        prefix = key
    default_t1, default_t2 = TARGET_DEFAULTS.get(reees_name, (".618 AD", "1.272 AD"))
    return (
        cfg.get(f"{prefix}_target_1") or default_t1,
        cfg.get(f"{prefix}_target_2") or default_t2,
    )


def _valid_profit_level(pattern, price):
    entry = _point_price(pattern, "D")
    if price is None or entry is None:
        return None
    if pattern.get("direction") == "bullish" and price > entry:
        return price
    if pattern.get("direction") == "bearish" and price < entry:
        return price
    return None


def _targets(pattern, cfg):
    spec_1, spec_2 = _target_specs(pattern, cfg)
    target_1 = _valid_profit_level(pattern, _profit_target(pattern, spec_1))
    target_2 = _valid_profit_level(pattern, _profit_target(pattern, spec_2))
    if target_1 is None:
        fallback = pattern.get("targets") or []
        target_1 = base._valid_level(pattern, fallback, 0, True) if fallback else None
    if target_2 is None:
        fallback = pattern.get("targets") or []
        target_2 = base._valid_level(pattern, fallback, 1, True) if fallback else None
    return target_1, target_2


def _entry_profit_ok(direction, entry, price):
    if entry is None or price is None:
        return False
    if direction == "bullish":
        return price > entry
    if direction == "bearish":
        return price < entry
    return False


def _selected_tp(target_1, target_2, cfg, entry=None, direction=None):
    preferred = [target_2, target_1] if cfg["take_profit"] in ("target_2", "t2", "hedef_2") else [target_1, target_2]
    for target in preferred:
        if entry is None or direction is None:
            if target is not None:
                return target
        elif _entry_profit_ok(direction, entry, target):
            return target
    return None


def _stop_price(pattern, entry, target_1, cfg):
    if entry is None:
        return None

    direction = pattern.get("direction")
    sign = _profit_sign(pattern)
    basis = cfg["stop_basis"]
    stop_pct = cfg["stop_pct"] / 100.0

    if basis in ("target_1_distance", "target_distance", "t1_distance", "default"):
        if target_1 is None:
            return None
        risk = abs(target_1 - entry) * stop_pct
        return entry - sign * risk

    if basis in ("entry_pct", "entry_percent", "pct"):
        risk = abs(entry) * stop_pct
        return entry - sign * risk

    if basis in ("point_d_pct", "d_pct"):
        d_price = _point_price(pattern, "D")
        if d_price is None:
            return None
        risk = abs(d_price) * stop_pct
        return d_price - sign * risk

    if basis in ("x_or_d_pct", "x_or_d"):
        x_price = _point_price(pattern, "X")
        d_price = _point_price(pattern, "D")
        if x_price is None or d_price is None:
            return None
        ref = min(x_price, d_price) if direction == "bullish" else max(x_price, d_price)
        return ref - sign * abs(ref) * stop_pct

    return _stop_price(pattern, entry, target_1, {**cfg, "stop_basis": "target_1_distance"})


def _entry_ok(pattern, entry, cfg):
    if not cfg["enter_after_d"]:
        return False
    if not cfg["respect_entry_limit"]:
        return True

    d_price = _point_price(pattern, "D")
    if d_price is None or d_price <= 0 or entry is None:
        return False
    distance_pct = abs(entry - d_price) / d_price * 100.0
    return distance_pct <= cfg["entry_limit_pct_away_from_d"]


def _pattern_key(pattern):
    return (
        pattern.get("name"),
        pattern.get("direction"),
        pattern.get("zigzag_length"),
        pattern.get("signal_i"),
        pattern.get("X", {}).get("i"),
        pattern.get("A", {}).get("i"),
        pattern.get("B", {}).get("i"),
        pattern.get("C", {}).get("i"),
        pattern.get("D", {}).get("i"),
    )


def _enrich(pattern, cfg, current_entry=None):
    item = dict(pattern)
    item["reees_name"] = BASE_NAME_TO_REEES.get(item.get("name"), item.get("name"))
    item["quality"] = max(_to_float(item.get("quality"), 0.0), _to_float(item.get("reees_score"), 0.0))
    target_1, target_2 = _targets(item, cfg)
    entry = _to_float(current_entry, None)
    if entry is None:
        entry = _point_price(item, "D")
    tp = _selected_tp(target_1, target_2, cfg, entry, item.get("direction"))
    stop_reference = target_1 if _entry_profit_ok(item.get("direction"), entry, target_1) else tp
    sl = _stop_price(item, entry, stop_reference, cfg)
    risk = abs(entry - sl) if entry is not None and sl is not None else None
    reward = abs(tp - entry) if entry is not None and tp is not None else None
    rr = reward / risk if risk and reward is not None else 0.0
    item.update({
        "entry": entry,
        "target_1": target_1,
        "target_2": target_2,
        "tp": tp,
        "sl": sl,
        "rr": rr,
        "entry_ok": _entry_ok(item, entry, cfg),
    })
    return item


def _passes_basic_filters(pattern, cfg):
    if pattern.get("direction") == "bullish" and not cfg["include_bullish"]:
        return False
    if pattern.get("direction") == "bearish" and not cfg["include_bearish"]:
        return False
    if not _passes_reees_validation(pattern, cfg):
        return False
    if cfg["only_high_scoring"] and _to_float(pattern.get("quality"), 0.0) < cfg["min_score_after_d"]:
        return False
    return True


def _scan(candles, cfg, historical=False, current_entry=None):
    if len(candles) < max(cfg["pivot_lengths"]) * 3 + 5:
        return []
    base_cfg = _base_config(cfg)
    raw = base.scan_historical_patterns(candles, base_cfg) if historical else base.scan_patterns(candles, base_cfg)
    found = []
    for pattern in raw:
        if not _passes_basic_filters(pattern, cfg):
            continue
        found.append(_enrich(pattern, cfg, current_entry))
    return found


def scan_historical_patterns(candles, config=None):
    cfg = _config(config)
    return _scan(candles or [], cfg, historical=True)


def _trade_candidates(candles, cfg):
    current_entry = _to_float(candles[-1].get("c"), None)
    last_index = len(candles) - 1
    candidates = []
    for pattern in _scan(candles, cfg, historical=False, current_entry=current_entry):
        if last_index - int(pattern.get("signal_i", -10**9)) > cfg["recent_signal_bars"]:
            continue
        if not pattern.get("entry_ok"):
            continue
        if pattern.get("tp") is None or pattern.get("sl") is None:
            continue
        if pattern.get("rr", 0.0) < cfg["min_reward_risk"]:
            continue
        candidates.append(pattern)
    candidates.sort(key=lambda item: (item.get("quality", 0), item.get("rr", 0), item.get("signal_i", 0)), reverse=True)
    return candidates


def _side(pattern):
    return "long" if pattern.get("direction") == "bullish" else "short"


def _observe_pattern(pattern):
    global OBSERVED_KEYS
    key = _pattern_key(pattern)
    if key in OBSERVED_KEYS:
        return
    OBSERVED_KEYS.add(key)
    _observe(
        f"reees_harmonic.{str(pattern.get('reees_name')).lower()}",
        side=_side(pattern),
        pattern=pattern.get("reees_name"),
        direction=pattern.get("direction"),
        score=round(_to_float(pattern.get("quality"), 0.0), 2),
        rr=round(_to_float(pattern.get("rr"), 0.0), 3),
        zigzag_length=pattern.get("zigzag_length"),
        d_time=pattern.get("D", {}).get("t"),
    )


def _set_trade_levels(pattern):
    if pattern.get("tp") is not None:
        set_tp(price=pattern["tp"])
    if pattern.get("sl") is not None:
        set_sl(price=pattern["sl"])


def _set_pattern_meta(pattern):
    _set_meta(
        strategy="reees_harmonic_system",
        pattern=pattern.get("reees_name"),
        direction=pattern.get("direction"),
        score=round(_to_float(pattern.get("quality"), 0.0), 2),
        rr=round(_to_float(pattern.get("rr"), 0.0), 3),
        entry=round(_to_float(pattern.get("entry"), 0.0), 8),
        sl=round(_to_float(pattern.get("sl"), 0.0), 8),
        tp=round(_to_float(pattern.get("tp"), 0.0), 8),
        target1=round(_to_float(pattern.get("target_1"), 0.0), 8),
        target2=round(_to_float(pattern.get("target_2"), 0.0), 8),
        zigzag_length=pattern.get("zigzag_length"),
        d_time=pattern.get("D", {}).get("t"),
    )


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_KEY

    cfg = _config(config)
    candles = _candles()
    if len(candles) < max(cfg["pivot_lengths"]) * 3 + 5:
        hold()
        return

    candidates = _trade_candidates(candles, cfg)
    for pattern in candidates:
        _observe_pattern(pattern)

    has_position = bool(getattr(portfolio, "has_position", False))
    current_side = getattr(portfolio, "side", None)
    if has_position:
        if candidates:
            best = candidates[0]
            same_side = (
                (current_side == "BUY" and best.get("direction") == "bullish")
                or (current_side == "SELL" and best.get("direction") == "bearish")
            )
            opposite = (
                (current_side == "BUY" and best.get("direction") == "bearish")
                or (current_side == "SELL" and best.get("direction") == "bullish")
            )
            if same_side:
                _set_trade_levels(best)
                _set_pattern_meta(best)
                hold()
                return
            if cfg["exit_on_opposite_signal"] and opposite:
                _set_pattern_meta(best)
                close()
                return
        hold()
        return

    if not candidates:
        hold()
        return

    pattern = candidates[0]
    key = _pattern_key(pattern)
    if key == LAST_SIGNAL_KEY:
        hold()
        return

    LAST_SIGNAL_KEY = key
    _set_trade_levels(pattern)
    _set_pattern_meta(pattern)
    if pattern.get("direction") == "bullish":
        buy()
    elif pattern.get("direction") == "bearish":
        sell()
    else:
        hold()


def _draw_point(pattern, key):
    point = pattern.get(key) or {}
    return {"time": point.get("t"), "price": point.get("c")}


def _line(group, first, second, color, style="solid", width=2):
    return {
        "type": "line",
        "first": first,
        "second": second,
        "color": color,
        "style": style,
        "width": width,
        "group": group,
    }


def _label(group, point, text, color, style, size="small"):
    return {
        "type": "label",
        "point": point,
        "text": text,
        "color": color,
        "textcolor": "#0f172a",
        "style": style,
        "size": size,
        "group": group,
    }


def _level_drawings(group, pattern, price, title, color, style="dashed"):
    if price is None:
        return []
    start = pattern.get("D", {}).get("t")
    end = pattern.get("signal_t") or start
    if start is None or end is None:
        return []
    if end <= start:
        end = start + 1
    return [
        _line(group, {"time": start, "price": price}, {"time": end, "price": price}, color, style, 1),
        _label(group, {"time": end, "price": price}, title, color, "label_left", "tiny"),
    ]


def _pattern_drawings(pattern):
    color = "#22c55e" if pattern.get("direction") == "bullish" else "#ef4444"
    helper = "#94a3b8"
    group = (
        f"reees-{pattern.get('reees_name')}-{pattern.get('direction')}-"
        f"{pattern.get('zigzag_length')}-{pattern.get('D', {}).get('i')}"
    )
    drawings = []
    for first, second in (("X", "A"), ("A", "B"), ("B", "C"), ("C", "D")):
        drawings.append(_line(group, _draw_point(pattern, first), _draw_point(pattern, second), color, "solid", 2))
    for first, second in (("X", "B"), ("B", "D")):
        drawings.append(_line(group, _draw_point(pattern, first), _draw_point(pattern, second), helper, "dotted", 1))

    label_style = "label_up" if pattern.get("direction") == "bullish" else "label_down"
    drawings.append(_label(
        group,
        _draw_point(pattern, "D"),
        f"{pattern.get('direction')} {pattern.get('reees_name')} {round(_to_float(pattern.get('quality'), 0.0), 1)}",
        color,
        label_style,
        "small",
    ))
    drawings.extend(_level_drawings(group, pattern, pattern.get("target_1"), "T1", "#38bdf8"))
    drawings.extend(_level_drawings(group, pattern, pattern.get("target_2"), "T2", "#60a5fa"))
    drawings.extend(_level_drawings(group, pattern, pattern.get("sl"), "SL", "#ef4444"))
    drawings.extend(_level_drawings(group, pattern, pattern.get("tp"), "TP", "#22c55e"))
    return drawings


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    source = candles[-cfg["draw_history_bars"]:] if cfg["draw_historical_patterns"] else candles
    found = _scan(source or [], cfg, historical=cfg["draw_historical_patterns"])
    if not found:
        return []
    drawings = []
    for pattern in found[:cfg["max_draw_patterns"]]:
        drawings.extend(_pattern_drawings(pattern))
    return drawings
