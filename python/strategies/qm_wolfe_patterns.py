# name: QM Wolfe Pattern Tester
# desc: Only QM and Wolfe patterns with separate observation stats and chart drawings
# author: NexusTrade
# version: 0.1

import builtins as _builtins

from strategies import orphan_market_reader as omr
from indicators.bars import bar_number


LAST_SIGNAL_KEY = None
LAST_SIGNAL_BAR = None
OBSERVED_KEYS = set()


def _defaults():
    cfg = omr.initialize()
    cfg.update({
        "pivot_depths": [8, 13, 21, 34],
        "pivot_min_leg_pct": 0.45,
        "pivot_min_leg_atr": 1.1,
        "pivot_min_bar_depth_mult": 0.65,
        "enabled_models": ["qm", "wolfe"],
        "enabled_setups": [
            "qm:long",
            "qm:short",
            "wolfe:long",
            "wolfe:short",
        ],
        "allow_long": True,
        "allow_short": True,
        "min_score": 72.0,
        "min_reward_risk": 1.0,
        "default_reward_risk": 1.6,
        "recent_signal_bars": 1,
        "qm_entry_mode": "confirmed",
        "qm_reclaim_window_bars": 80,
        "qm_reclaim_signal_bars": 3,
        "qm_require_divergence": False,
        "qm_require_reversal_candle": False,
        "wolfe_reclaim_window_bars": 120,
        "cooldown_bars": 6,
        "regime_filter": "soft",
        "min_interval_minutes": 0,
        "min_volume_ratio": 0.4,
        "max_stop_pct": 2.2,
        "min_net_reward_pct": 0.03,
        # Tarihsel formasyonlar inceleme icin tutulur; risk seviyeleri ise
        # grafik tarafinda yalnizca aktif pozisyondan cizilir.
        "draw_max_setups": 3,
        "draw_last_bars": 320,
        "draw_historical_levels": False,
    })
    return cfg


def initialize():
    global LAST_SIGNAL_KEY, LAST_SIGNAL_BAR, OBSERVED_KEYS
    LAST_SIGNAL_KEY = None
    LAST_SIGNAL_BAR = None
    OBSERVED_KEYS = set()
    return _defaults()


def _config(config):
    cfg = _defaults()
    if isinstance(config, dict):
        cfg.update(config)

    if not cfg.get("enabled_models"):
        cfg["enabled_models"] = ["qm", "wolfe"]
    if not cfg.get("enabled_setups"):
        cfg["enabled_setups"] = ["qm:long", "qm:short", "wolfe:long", "wolfe:short"]

    cfg = omr._config(cfg)
    cfg["qm_entry_mode"] = str(cfg.get("qm_entry_mode") or "confirmed").strip().lower()
    if cfg["qm_entry_mode"] not in ("confirmed", "reclaim", "both"):
        cfg["qm_entry_mode"] = "confirmed"
    cfg["qm_reclaim_window_bars"] = max(
        2,
        omr._to_int(cfg.get("qm_reclaim_window_bars"), 80),
    )
    cfg["qm_reclaim_signal_bars"] = max(
        0,
        omr._to_int(cfg.get("qm_reclaim_signal_bars"), 3),
    )
    cfg["qm_require_divergence"] = omr._to_bool(cfg.get("qm_require_divergence"), False)
    cfg["qm_require_reversal_candle"] = omr._to_bool(cfg.get("qm_require_reversal_candle"), False)
    cfg["wolfe_reclaim_window_bars"] = max(
        cfg["recent_signal_bars"],
        omr._to_int(cfg.get("wolfe_reclaim_window_bars"), 120),
    )
    return cfg


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def _set_meta(**meta):
    fn = getattr(_builtins, "set_meta", None)
    if callable(fn):
        fn(**meta)


def _signal_key(candidate):
    return (
        candidate["model"],
        candidate["side"],
        candidate.get("depth"),
        candidate.get("trigger_i"),
        round(candidate["sl"], 8),
        round(candidate["tp"], 8),
    )


def _dedupe_candidates(candidates):
    out = []
    seen = set()
    for candidate in candidates:
        key = _signal_key(candidate)
        if key in seen:
            continue
        seen.add(key)
        out.append(candidate)
    return out


def _historical_setup_key(candidate):
    """Ayni pivot omurgasinin mum mum tekrar cizilmesini engeller.

    QM'de besinci nokta ve hedef/stop, sonraki mumlarla ufak farklarla yeniden
    hesaplanabilir. Grafik icin 1-4 pivotlari formasyonun kimligidir; son
    gorulen varyasyonu tutmak hem formasyonu korur hem de etiket kopyalarini
    engeller.
    """
    points = candidate.get("points") or {}
    anchors = []
    for name in ("1", "2", "3", "4"):
        point = points.get(name)
        if not isinstance(point, dict):
            anchors = []
            break
        anchors.append((point.get("i"), round(float(point.get("p", 0)), 8)))
    if not anchors:
        anchors = sorted(
            (
                point.get("i"),
                round(float(point.get("p", 0)), 8),
            )
            for point in points.values()
            if isinstance(point, dict)
        )[:4]
    return (
        candidate.get("model"),
        candidate.get("side"),
        candidate.get("depth"),
        tuple(anchors),
    )


def _wolfe_points(candidate):
    points = candidate.get("points") or {}
    ordered = [
        points.get(str(index))
        for index in range(1, 6)
        if isinstance(points.get(str(index)), dict)
    ]
    if len(ordered) >= 5:
        return ordered[:5]

    fallback = [point for point in points.values() if isinstance(point, dict)]
    return fallback[:5]


def _line_price_at(point_a, point_b, index):
    a_index = omr._to_float(point_a.get("i"), None)
    b_index = omr._to_float(point_b.get("i"), None)
    a_price = omr._to_float(point_a.get("p"), None)
    b_price = omr._to_float(point_b.get("p"), None)
    if a_index is None or b_index is None or a_price is None or b_price is None:
        return None
    if abs(b_index - a_index) <= 1e-12:
        return b_price
    slope = (b_price - a_price) / (b_index - a_index)
    return a_price + slope * (index - a_index)


def _wolfe_long_reclaimed_13(candidate, candles):
    points = _wolfe_points(candidate)
    if len(points) < 5 or len(candles) < 2:
        return False, None

    p1, _, p3, _, p5 = points[:5]
    current_index = len(candles) - 1
    p5_index = omr._to_float(p5.get("i"), None)
    if p5_index is not None and current_index < p5_index:
        return False, None

    prev = candles[-2]
    current = candles[-1]
    prev_index = current_index - 1
    prev_line = _line_price_at(p1, p3, prev_index)
    current_line = _line_price_at(p1, p3, current_index)
    if prev_line is None or current_line is None:
        return False, None

    prev_close = omr._to_float(prev.get("c"), None)
    prev_low = omr._to_float(prev.get("l"), None)
    current_close = omr._to_float(current.get("c"), None)
    current_low = omr._to_float(current.get("l"), None)
    if prev_close is None or prev_low is None or current_close is None or current_low is None:
        return False, None

    dipped_below = prev_close <= prev_line or prev_low <= prev_line or current_low <= current_line
    reclaimed = current_close > current_line
    return dipped_below and reclaimed, current_line


def _entry_candidate(candidate, candles):
    if candidate.get("model") != "Wolfe" or candidate.get("side") != "long":
        return candidate

    allowed, line_price = _wolfe_long_reclaimed_13(candidate, candles)
    if not allowed:
        return None

    result = dict(candidate)
    meta = dict(result.get("meta") or {})
    meta["entry_rule"] = "wolfe_1_3_reclaim"
    if line_price is not None:
        meta["entry_line_13"] = round(line_price, 8)
    result["meta"] = meta
    result["reason"] = f"{result.get('reason', '')} + 1-3 cizgisi geri alindi".strip()
    return result


def _provisional_qm_candidates(candles, cfg):
    if "qm" not in cfg.get("enabled_models", set()) or len(candles) < 3:
        return []

    series = omr._series(candles, cfg)
    context_candles = candles[-len(series["atr"]):] if series["atr"] else candles
    context = omr._current_context(context_candles, series, cfg)
    context["last_index"] = len(candles) - 1
    last_i = len(candles) - 1
    current = candles[-1]
    previous = candles[-2]
    current_close = omr._to_float(current.get("c"), None)
    current_open = omr._to_float(current.get("o"), None)
    previous_close = omr._to_float(previous.get("c"), None)
    current_low = omr._to_float(current.get("l"), None)
    current_high = omr._to_float(current.get("h"), None)
    if None in (current_close, current_open, previous_close, current_low, current_high):
        return []

    found = []
    for depth, pivots in series["pivots"].items():
        if len(pivots) < 4:
            continue

        p1, p2, p3, p4 = pivots[-4:]
        types = [point["type"] for point in (p1, p2, p3, p4)]
        start_i = max(
            int(p4["i"]) + 1,
            last_i - cfg["qm_reclaim_window_bars"] + 1,
        )
        if start_i > last_i:
            continue

        if types == ["L", "H", "L", "H"] and p3["p"] < p1["p"] and p4["p"] > p2["p"]:
            p5_i = min(range(start_i, last_i + 1), key=lambda i: omr._to_float(candles[i].get("l")))
            p5_price = omr._to_float(candles[p5_i].get("l"))
            p5 = {"i": p5_i, "t": candles[p5_i].get("t"), "p": p5_price, "type": "L"}
            retest_ok = p5_price > p3["p"] and omr._near(p5_price, p1["p"], cfg["qm_retest_tolerance_pct"])
            reclaimed = current_close > p1["p"] and (previous_close <= p1["p"] or current_low <= p1["p"])
            recent_retest = last_i - p5_i <= cfg["qm_reclaim_signal_bars"]
            if retest_ok and reclaimed and recent_retest:
                div = omr._bullish_divergence(p3, p5, candles, series)
                if cfg["qm_require_divergence"] and not div:
                    continue
                if cfg["qm_require_reversal_candle"] and current_close <= current_open:
                    continue
                score = 66 + (10 if div else 0) + min(10, omr._pct(p4["p"], p2["p"]) * 2.0)
                candidate = omr._base_candidate(
                    "QM",
                    "long",
                    depth,
                    {"1": p1, "2": p2, "3": p3, "4": p4, "5": p5},
                    score,
                    last_i,
                    [p4["p"], p2["p"]],
                    p5["p"],
                    "5 noktasi sol omuz bolgesini test edip yukari geri aldi",
                    {
                        "entry_rule": "qm_level_reclaim",
                        "retest_pct": round(omr._pct(p5["p"], p1["p"]), 4),
                        "stop_mode": "retest",
                    },
                )
                finalized = omr._finalize_candidate(candidate, candles, cfg, context)
                if finalized is not None:
                    found.append(finalized)

        elif types == ["H", "L", "H", "L"] and p3["p"] > p1["p"] and p4["p"] < p2["p"]:
            p5_i = max(range(start_i, last_i + 1), key=lambda i: omr._to_float(candles[i].get("h")))
            p5_price = omr._to_float(candles[p5_i].get("h"))
            p5 = {"i": p5_i, "t": candles[p5_i].get("t"), "p": p5_price, "type": "H"}
            retest_ok = p5_price < p3["p"] and omr._near(p5_price, p1["p"], cfg["qm_retest_tolerance_pct"])
            reclaimed = current_close < p1["p"] and (previous_close >= p1["p"] or current_high >= p1["p"])
            recent_retest = last_i - p5_i <= cfg["qm_reclaim_signal_bars"]
            if retest_ok and reclaimed and recent_retest:
                div = omr._bearish_divergence(p3, p5, candles, series)
                if cfg["qm_require_divergence"] and not div:
                    continue
                if cfg["qm_require_reversal_candle"] and current_close >= current_open:
                    continue
                score = 66 + (10 if div else 0) + min(10, omr._pct(p4["p"], p2["p"]) * 2.0)
                candidate = omr._base_candidate(
                    "QM",
                    "short",
                    depth,
                    {"1": p1, "2": p2, "3": p3, "4": p4, "5": p5},
                    score,
                    last_i,
                    [p4["p"], p2["p"]],
                    p5["p"],
                    "5 noktasi sol omuz bolgesini test edip asagi geri aldi",
                    {
                        "entry_rule": "qm_level_reclaim",
                        "retest_pct": round(omr._pct(p5["p"], p1["p"]), 4),
                        "stop_mode": "retest",
                    },
                )
                finalized = omr._finalize_candidate(candidate, candles, cfg, context)
                if finalized is not None:
                    found.append(finalized)

    return _dedupe_candidates(found)


def _entry_candidates(candles, cfg, recent_candidates):
    qm_entry_mode = cfg.get("qm_entry_mode", "confirmed")
    scan_candidates = [
        candidate
        for candidate in recent_candidates
        if candidate.get("model") != "QM" or qm_entry_mode in ("confirmed", "both")
    ]
    recent_keys = {_signal_key(candidate) for candidate in recent_candidates}
    if qm_entry_mode in ("reclaim", "both"):
        reclaim_candidates = _provisional_qm_candidates(candles, cfg)
        scan_candidates.extend(reclaim_candidates)
        recent_keys.update(_signal_key(candidate) for candidate in reclaim_candidates)
    window = cfg.get("wolfe_reclaim_window_bars", cfg["recent_signal_bars"])
    if window > cfg["recent_signal_bars"] and "wolfe" in cfg.get("enabled_models", set()):
        extended_cfg = dict(cfg)
        extended_cfg["recent_signal_bars"] = window
        scan_candidates.extend(omr._scan_candidates(candles, extended_cfg))

    out = []
    for candidate in _dedupe_candidates(scan_candidates):
        is_wolfe_long = candidate.get("model") == "Wolfe" and candidate.get("side") == "long"
        if not is_wolfe_long and _signal_key(candidate) not in recent_keys:
            continue
        entry = _entry_candidate(candidate, candles)
        if entry is not None:
            out.append(entry)

    out.sort(key=lambda item: (item["score"], item["rr"], item["trigger_i"]), reverse=True)
    return out


def _observe_candidate(candidate):
    global OBSERVED_KEYS
    key = _signal_key(candidate)
    if key in OBSERVED_KEYS:
        return

    OBSERVED_KEYS.add(key)
    _observe(
        f"qm_wolfe.{candidate['model']}",
        side=candidate["side"],
        score=candidate["score"],
        rr=round(candidate["rr"], 3),
        depth=candidate.get("depth"),
        riskPct=round(candidate.get("risk_pct", 0), 4),
        rewardPct=round(candidate.get("reward_pct", 0), 4),
        reason=candidate.get("reason"),
    )


def _historical_candidates(candles, cfg):
    min_bars = max(cfg["ema_fast"], max(cfg["pivot_depths"]) * 3) + 5
    if len(candles) < min_bars:
        return []

    first_end = max(min_bars, len(candles) - cfg["draw_last_bars"])
    found_by_setup = {}
    for end in range(first_end, len(candles) + 1):
        historical = list(omr._scan_candidates(candles[:end], cfg))
        if cfg.get("qm_entry_mode") in ("reclaim", "both"):
            historical.extend(_provisional_qm_candidates(candles[:end], cfg))
        for candidate in historical:
            # Her mumdaki ayni QM/Wolfe varyasyonunu degil, ayni ana pivot
            # yapisinin en son halini ciziyoruz.
            found_by_setup[_historical_setup_key(candidate)] = candidate

    found = list(found_by_setup.values())
    found.sort(key=lambda item: item.get("trigger_i", 0))
    return found[-cfg["draw_max_setups"]:]


def _time_for_index(candles, index):
    if not candles:
        return None
    interval = candles[-1]["t"] - candles[-2]["t"] if len(candles) >= 2 else 0
    rounded = int(round(index))
    if 0 <= rounded < len(candles):
        return candles[rounded]["t"]
    return int(candles[0]["t"] + interval * index) if interval else candles[-1]["t"]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_KEY, LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = omr._candles()
    if len(candles) < max(cfg["ema_fast"], max(cfg["pivot_depths"]) * 3) + 5:
        hold()
        return

    candidates = omr._scan_candidates(candles, cfg)
    trade_candidates = _entry_candidates(candles, cfg, candidates)
    for candidate in _dedupe_candidates(candidates + trade_candidates):
        _observe_candidate(candidate)

    current_side = getattr(portfolio, "side", None)
    bar = bar_number(candles)

    if getattr(portfolio, "has_position", False):
        if cfg["exit_on_opposite_signal"] and trade_candidates:
            best = trade_candidates[0]
            opposite = (
                (current_side == "BUY" and best["side"] == "short")
                or (current_side == "SELL" and best["side"] == "long")
            )
            if opposite and best["score"] >= cfg["opposite_close_score"]:
                _set_meta(exit_reason="opposite_qm_wolfe", model=best["model"], score=best["score"])
                close()
                return
        hold()
        return

    if not trade_candidates:
        hold()
        return

    best = trade_candidates[0]
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
        setup=f"{best['model']}:{best['side']}",
        score=best["score"],
        rr=round(best["rr"], 3),
        riskPct=round(best["risk_pct"], 4),
        rewardPct=round(best["reward_pct"], 4),
        depth=best.get("depth"),
        reason=best["reason"],
        context=best["context"],
        entryRule=(best.get("meta") or {}).get("entry_rule"),
        entryLine13=(best.get("meta") or {}).get("entry_line_13"),
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

    candidates = _historical_candidates(candles, cfg)
    drawings = []
    palette = {
        ("QM", "long"): "#22c55e",
        ("QM", "short"): "#ef4444",
        ("Wolfe", "long"): "#38bdf8",
        ("Wolfe", "short"): "#f59e0b",
    }
    label_styles = {
        "long": "label_up",
        "short": "label_down",
    }
    first_line_time = candles[max(0, len(candles) - 40)]["t"]
    last_time = candles[-1]["t"]

    for index, candidate in enumerate(candidates):
        color = palette.get((candidate["model"], candidate["side"]), "#a78bfa")
        group = f"qm-wolfe-{candidate['model']}-{candidate['side']}-{candidate.get('depth')}-{index}"
        points = list((candidate.get("points") or {}).items())
        point_values = [p for _, p in points if isinstance(p, dict) and p.get("t") is not None]

        for p1, p2 in zip(point_values, point_values[1:]):
            drawings.append({
                "type": "line",
                "first": {"time": p1["t"], "price": p1["p"]},
                "second": {"time": p2["t"], "price": p2["p"]},
                "color": color,
                "style": "solid",
                "width": 2,
                "group": group,
                "role": "pattern_leg",
            })

        if candidate["model"] == "Wolfe" and len(point_values) >= 5:
            p1, p2, p3, p4, p5 = point_values[:5]
            intersection_i = (candidate.get("meta") or {}).get("intersection_i")
            intersection_price = (candidate.get("meta") or {}).get("intersection_price")
            intersection_time = (candidate.get("meta") or {}).get("intersection_time")
            if intersection_i is not None and intersection_price is not None:
                intersection_point = {
                    "time": int(intersection_time) if intersection_time is not None else _time_for_index(candles, float(intersection_i)),
                    "price": float(intersection_price),
                }
            else:
                intersection_point = None
            drawings.extend([
                {
                    "type": "line",
                    "first": {"time": p1["t"], "price": p1["p"]},
                    "second": intersection_point or {"time": p3["t"], "price": p3["p"]},
                    "color": color,
                    "style": "dashed",
                    "width": 1,
                    "group": group,
                    "role": "pattern_guide",
                },
                {
                    "type": "line",
                    "first": {"time": p2["t"], "price": p2["p"]},
                    "second": intersection_point or {"time": p4["t"], "price": p4["p"]},
                    "color": "#94a3b8",
                    "style": "dotted",
                    "width": 1,
                    "group": group,
                    "role": "pattern_guide",
                },
            ])
            if intersection_point:
                drawings.append({
                    "type": "label",
                    "point": intersection_point,
                    "text": "Wolfe kesisim",
                    "color": "#94a3b8",
                    "textcolor": "#0f172a",
                    "style": "label_left",
                    "size": "tiny",
                    "group": group,
                    "role": "pattern_intersection",
                })

        if point_values:
            anchor = point_values[-1]
            drawings.append({
                "type": "label",
                "point": {"time": anchor["t"], "price": anchor["p"]},
                "text": f"{candidate['side']} {candidate['model']} {candidate['score']}",
                "color": color,
                "textcolor": "#0f172a",
                "style": label_styles.get(candidate["side"], "label_up"),
                "size": "small",
                "group": group,
                "role": "pattern_label",
            })

        # Tarihsel formasyonlara ait seviyeler ayni fiyatta yigilip okunamaz
        # hale gelir. Acik pozisyonun tek Giriş/TP/SL seti arayuz tarafinda
        # cizilir. Bu opsiyon yalnizca elle inceleme gerektiginde acilabilir.
        if cfg.get("draw_historical_levels", False):
            for title, price, line_color in (
                ("SL", candidate["sl"], "#ef4444"),
                ("TP", candidate["tp"], "#22c55e"),
            ):
                drawings.append({
                    "type": "line",
                    "first": {"time": first_line_time, "price": price},
                    "second": {"time": last_time, "price": price},
                    "color": line_color,
                    "style": "dashed",
                    "width": 1,
                    "group": group,
                    "role": "strategy_stop" if title == "SL" else "strategy_target",
                })
                drawings.append({
                    "type": "label",
                    "point": {"time": last_time, "price": price},
                    "text": f"{candidate['model']} {title}",
                    "color": line_color,
                    "textcolor": "#0f172a",
                    "style": "label_left",
                    "size": "small",
                    "group": group,
                    "role": "strategy_stop" if title == "SL" else "strategy_target",
                })

    return drawings
