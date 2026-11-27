# name: Smart Money Concepts
# desc: LuxAlgo SMC mantigindan uyarlanan BOS/CHoCH, order block, EQH/EQL ve FVG tabanli evrensel strateji
# author: NexusTrade
# version: 0.1
#
# Derived from the user-supplied "Smart Money Concepts [LuxAlgo]" Pine script.
# Original script attribution: LuxAlgo, CC BY-NC-SA 4.0.

import builtins as _builtins
from indicators.bars import bar_number


BULLISH_LEG = 1
BEARISH_LEG = 0
BULLISH = 1
BEARISH = -1

GREEN = "#089981"
RED = "#F23645"
BLUE = "#2157f3"
GRAY = "#878b94"

_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "state": None,
}

LAST_SIGNAL_INDEX = None


def initialize():
    return {
        "signal_scope": "swing",          # swing, internal, both
        "signal_tag": "CHoCH",            # CHoCH, BOS, ALL
        "swing_length": 50,
        "internal_length": 5,
        "allow_short": True,
        "confluence_filter": False,
        "equal_length": 3,
        "equal_threshold": 0.1,
        "detect_fvg": True,
        "fvg_auto_threshold": True,
        "order_block_filter": "atr",      # atr, range
        "order_block_mitigation": "highlow",
        "stop_source": "structure",       # structure, internal, swing, order_block, atr
        "atr_period": 14,
        "stop_atr": 1.5,
        "max_stop_pct": 4.0,
        "min_stop_pct": 0.15,
        "reward_risk": 2.0,
        "use_take_profit": True,
        "cooldown_bars": 5,
        "exit_on_opposite_signal": True,
        "draw_last": 80,
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

    cfg["signal_scope"] = str(cfg.get("signal_scope") or "swing").lower()
    cfg["signal_tag"] = str(cfg.get("signal_tag") or "CHoCH").upper()
    cfg["swing_length"] = max(10, _to_int(cfg.get("swing_length"), 50))
    cfg["internal_length"] = max(2, _to_int(cfg.get("internal_length"), 5))
    cfg["equal_length"] = max(1, _to_int(cfg.get("equal_length"), 3))
    cfg["equal_threshold"] = max(0.0, min(0.5, _to_float(cfg.get("equal_threshold"), 0.1)))
    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["confluence_filter"] = _to_bool(cfg.get("confluence_filter"), False)
    cfg["detect_fvg"] = _to_bool(cfg.get("detect_fvg"), True)
    cfg["fvg_auto_threshold"] = _to_bool(cfg.get("fvg_auto_threshold"), True)
    cfg["order_block_filter"] = str(cfg.get("order_block_filter") or "atr").lower()
    cfg["order_block_mitigation"] = str(cfg.get("order_block_mitigation") or "highlow").lower()
    cfg["stop_source"] = str(cfg.get("stop_source") or "structure").lower()
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 14))
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 1.5))
    cfg["max_stop_pct"] = max(0.2, _to_float(cfg.get("max_stop_pct"), 4.0))
    cfg["min_stop_pct"] = max(0.01, _to_float(cfg.get("min_stop_pct"), 0.15))
    cfg["reward_risk"] = max(0.2, _to_float(cfg.get("reward_risk"), 2.0))
    cfg["use_take_profit"] = _to_bool(cfg.get("use_take_profit"), True)
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 5))
    cfg["exit_on_opposite_signal"] = _to_bool(cfg.get("exit_on_opposite_signal"), True)
    cfg["draw_last"] = max(10, _to_int(cfg.get("draw_last"), 80))
    return cfg


def _signature(cfg):
    return (
        cfg["swing_length"],
        cfg["internal_length"],
        cfg["equal_length"],
        cfg["equal_threshold"],
        cfg["confluence_filter"],
        cfg["detect_fvg"],
        cfg["fvg_auto_threshold"],
        cfg["order_block_filter"],
        cfg["order_block_mitigation"],
        cfg["atr_period"],
    )


def _pivot():
    return {
        "current": None,
        "last": None,
        "crossed": True,
        "time": None,
        "index": None,
    }


def _new_state():
    return {
        "legs": {"swing": 0, "internal": 0, "equal": 0},
        "trend": {"swing": 0, "internal": 0},
        "pivots": {
            "swing_high": _pivot(),
            "swing_low": _pivot(),
            "internal_high": _pivot(),
            "internal_low": _pivot(),
            "equal_high": _pivot(),
            "equal_low": _pivot(),
        },
        "events": [],
        "order_blocks": {"swing": [], "internal": []},
        "highs": [],
        "lows": [],
        "closes": [],
        "opens": [],
        "times": [],
        "parsed_highs": [],
        "parsed_lows": [],
        "atr200": [],
        "atr_stop": [],
        "cum_tr": 0.0,
        "cum_abs_delta": 0.0,
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


def _rma_next(prev, value, period):
    if prev is None:
        return float(value)
    return float(prev) + (float(value) - float(prev)) / float(period)


def _true_range(candles, i):
    high = float(candles[i]["h"])
    low = float(candles[i]["l"])
    if i == 0:
        return high - low
    prev_close = float(candles[i - 1]["c"])
    return max(high - low, abs(high - prev_close), abs(low - prev_close))


def _detect_leg(state, size, i):
    if i < size:
        return None

    pivot_index = i - size
    high_at_pivot = state["highs"][pivot_index]
    low_at_pivot = state["lows"][pivot_index]
    future_highs = state["highs"][pivot_index + 1 : i + 1]
    future_lows = state["lows"][pivot_index + 1 : i + 1]
    if not future_highs or not future_lows:
        return None

    if high_at_pivot > max(future_highs):
        return BEARISH_LEG
    if low_at_pivot < min(future_lows):
        return BULLISH_LEG
    return None


def _update_pivot(pivot, value, time_value, index_value):
    pivot["last"] = pivot["current"]
    pivot["current"] = value
    pivot["crossed"] = False
    pivot["time"] = time_value
    pivot["index"] = index_value


def _add_event(state, event):
    state["events"].append(event)
    if len(state["events"]) > 1000:
        del state["events"][:200]


def _current_atr(state):
    if state["atr_stop"]:
        return max(0.0, float(state["atr_stop"][-1]))
    return 0.0


def _get_structure(state, cfg, candles, i, scope, size, equal_high_low=False):
    new_leg = _detect_leg(state, size, i)
    if new_leg is None:
        return

    previous_leg = state["legs"][scope]
    if new_leg == previous_leg:
        return

    state["legs"][scope] = new_leg
    pivot_index = i - size
    pivot_time = candles[pivot_index]["t"]

    if new_leg == BULLISH_LEG:
        pivot_key = "equal_low" if equal_high_low else f"{scope}_low"
        pivot = state["pivots"][pivot_key]
        level = float(candles[pivot_index]["l"])
        if equal_high_low and pivot["current"] is not None:
            if abs(pivot["current"] - level) < cfg["equal_threshold"] * max(state["atr200"][-1], 0.0):
                _add_event(state, {
                    "kind": "equal",
                    "tag": "EQL",
                    "side": "bullish",
                    "level": level,
                    "time": candles[i]["t"],
                    "index": i,
                    "pivot_time": pivot["time"],
                    "pivot_index": pivot["index"],
                })
        _update_pivot(pivot, level, pivot_time, pivot_index)
    else:
        pivot_key = "equal_high" if equal_high_low else f"{scope}_high"
        pivot = state["pivots"][pivot_key]
        level = float(candles[pivot_index]["h"])
        if equal_high_low and pivot["current"] is not None:
            if abs(pivot["current"] - level) < cfg["equal_threshold"] * max(state["atr200"][-1], 0.0):
                _add_event(state, {
                    "kind": "equal",
                    "tag": "EQH",
                    "side": "bearish",
                    "level": level,
                    "time": candles[i]["t"],
                    "index": i,
                    "pivot_time": pivot["time"],
                    "pivot_index": pivot["index"],
                })
        _update_pivot(pivot, level, pivot_time, pivot_index)


def _cross_over(prev_close, close, level):
    return level is not None and prev_close <= level < close


def _cross_under(prev_close, close, level):
    return level is not None and prev_close >= level > close


def _store_order_block(state, candles, scope, pivot, bias, i):
    pivot_index = pivot.get("index")
    if pivot_index is None:
        return
    start = max(0, int(pivot_index))
    end = max(start + 1, i)
    highs = state["parsed_highs"][start:end]
    lows = state["parsed_lows"][start:end]
    if not highs or not lows:
        return

    if bias == BEARISH:
        local_index = highs.index(max(highs))
    else:
        local_index = lows.index(min(lows))
    parsed_index = start + local_index
    block = {
        "high": state["parsed_highs"][parsed_index],
        "low": state["parsed_lows"][parsed_index],
        "time": candles[parsed_index]["t"],
        "index": parsed_index,
        "bias": bias,
    }
    blocks = state["order_blocks"][scope]
    blocks.insert(0, block)
    del blocks[100:]


def _display_structure(state, cfg, candles, i, scope):
    if i == 0:
        return
    close = state["closes"][i]
    prev_close = state["closes"][i - 1]
    open_price = state["opens"][i]
    high = state["highs"][i]
    low = state["lows"][i]

    bullish_bar = True
    bearish_bar = True
    if cfg["confluence_filter"]:
        upper_wick = high - max(close, open_price)
        lower_wick = min(close, open_price) - low
        bullish_bar = upper_wick > lower_wick
        bearish_bar = upper_wick < lower_wick

    high_pivot = state["pivots"][f"{scope}_high"]
    high_level = high_pivot["current"]
    extra_bull = bullish_bar
    if scope == "internal":
        extra_bull = (
            high_level is not None
            and high_level != state["pivots"]["swing_high"]["current"]
            and bullish_bar
        )

    if high_level is not None and not high_pivot["crossed"] and extra_bull and _cross_over(prev_close, close, high_level):
        tag = "CHoCH" if state["trend"][scope] == BEARISH else "BOS"
        high_pivot["crossed"] = True
        state["trend"][scope] = BULLISH
        _add_event(state, {
            "kind": "structure",
            "scope": scope,
            "tag": tag,
            "side": "bullish",
            "level": high_level,
            "time": candles[i]["t"],
            "index": i,
            "pivot_time": high_pivot["time"],
            "pivot_index": high_pivot["index"],
        })
        _store_order_block(state, candles, scope, high_pivot, BULLISH, i)

    low_pivot = state["pivots"][f"{scope}_low"]
    low_level = low_pivot["current"]
    extra_bear = bearish_bar
    if scope == "internal":
        extra_bear = (
            low_level is not None
            and low_level != state["pivots"]["swing_low"]["current"]
            and bearish_bar
        )

    if low_level is not None and not low_pivot["crossed"] and extra_bear and _cross_under(prev_close, close, low_level):
        tag = "CHoCH" if state["trend"][scope] == BULLISH else "BOS"
        low_pivot["crossed"] = True
        state["trend"][scope] = BEARISH
        _add_event(state, {
            "kind": "structure",
            "scope": scope,
            "tag": tag,
            "side": "bearish",
            "level": low_level,
            "time": candles[i]["t"],
            "index": i,
            "pivot_time": low_pivot["time"],
            "pivot_index": low_pivot["index"],
        })
        _store_order_block(state, candles, scope, low_pivot, BEARISH, i)


def _delete_order_blocks(state, cfg, candles, i, scope):
    close = state["closes"][i]
    high = state["highs"][i]
    low = state["lows"][i]
    source_bear = close if cfg["order_block_mitigation"] == "close" else high
    source_bull = close if cfg["order_block_mitigation"] == "close" else low

    remaining = []
    for block in state["order_blocks"][scope]:
        crossed = (
            (block["bias"] == BEARISH and source_bear > block["high"]) or
            (block["bias"] == BULLISH and source_bull < block["low"])
        )
        if crossed:
            _add_event(state, {
                "kind": "order_block_break",
                "scope": scope,
                "side": "bearish" if block["bias"] == BEARISH else "bullish",
                "level": block["high"] if block["bias"] == BEARISH else block["low"],
                "time": candles[i]["t"],
                "index": i,
                "block_time": block["time"],
                "block_index": block["index"],
            })
        else:
            remaining.append(block)
    state["order_blocks"][scope] = remaining


def _detect_fvg(state, cfg, candles, i):
    if not cfg["detect_fvg"] or i < 2:
        return

    high_2 = state["highs"][i - 2]
    low_2 = state["lows"][i - 2]
    current_high = state["highs"][i]
    current_low = state["lows"][i]
    last_close = state["closes"][i - 1]
    last_open = state["opens"][i - 1]
    if last_open <= 0:
        return
    bar_delta = (last_close - last_open) / last_open * 100.0
    threshold = 0.0
    if cfg["fvg_auto_threshold"] and i > 0:
        threshold = state["cum_abs_delta"] / float(i + 1) * 2.0

    if current_low > high_2 and last_close > high_2 and bar_delta > threshold:
        _add_event(state, {
            "kind": "fvg",
            "side": "bullish",
            "top": current_low,
            "bottom": high_2,
            "level": (current_low + high_2) / 2.0,
            "time": candles[i]["t"],
            "index": i,
            "pivot_time": candles[i - 2]["t"],
            "pivot_index": i - 2,
        })
    elif current_high < low_2 and last_close < low_2 and -bar_delta > threshold:
        _add_event(state, {
            "kind": "fvg",
            "side": "bearish",
            "top": low_2,
            "bottom": current_high,
            "level": (low_2 + current_high) / 2.0,
            "time": candles[i]["t"],
            "index": i,
            "pivot_time": candles[i - 2]["t"],
            "pivot_index": i - 2,
        })


def _process_candle(state, cfg, candles, i):
    candle = candles[i]
    high = float(candle["h"])
    low = float(candle["l"])
    open_price = float(candle["o"])
    close = float(candle["c"])
    tr = _true_range(candles, i)

    state["highs"].append(high)
    state["lows"].append(low)
    state["opens"].append(open_price)
    state["closes"].append(close)
    state["times"].append(candle["t"])
    state["cum_tr"] += tr
    state["cum_abs_delta"] += abs((close - open_price) / open_price * 100.0) if open_price > 0 else 0.0

    prev_atr200 = state["atr200"][-1] if state["atr200"] else None
    prev_atr_stop = state["atr_stop"][-1] if state["atr_stop"] else None
    atr200 = _rma_next(prev_atr200, tr, 200)
    atr_stop = _rma_next(prev_atr_stop, tr, cfg["atr_period"])
    state["atr200"].append(atr200)
    state["atr_stop"].append(atr_stop)

    range_mean = state["cum_tr"] / float(max(1, i + 1))
    volatility = atr200 if cfg["order_block_filter"] == "atr" else range_mean
    high_volatility_bar = (high - low) >= 2.0 * max(volatility, 0.0)
    state["parsed_highs"].append(low if high_volatility_bar else high)
    state["parsed_lows"].append(high if high_volatility_bar else low)

    _get_structure(state, cfg, candles, i, "swing", cfg["swing_length"], False)
    _get_structure(state, cfg, candles, i, "internal", cfg["internal_length"], False)
    _get_structure(state, cfg, candles, i, "equal", cfg["equal_length"], True)

    _display_structure(state, cfg, candles, i, "internal")
    _display_structure(state, cfg, candles, i, "swing")

    _delete_order_blocks(state, cfg, candles, i, "internal")
    _delete_order_blocks(state, cfg, candles, i, "swing")
    _detect_fvg(state, cfg, candles, i)


def _analysis(candles, cfg):
    sig = _signature(cfg)
    count = _CACHE["count"]
    state = _CACHE["state"]
    can_extend = (
        _CACHE["signature"] == sig
        and state is not None
        and count <= len(candles)
        and (count == 0 or candles[count - 1].get("t") == _CACHE["last_t"])
    )

    if not can_extend:
        state = _new_state()
        count = 0
        _CACHE["signature"] = sig

    for i in range(count, len(candles)):
        _process_candle(state, cfg, candles, i)

    _CACHE["state"] = state
    _CACHE["count"] = len(candles)
    _CACHE["last_t"] = candles[-1].get("t") if candles else None
    return state


def _event_matches(event, cfg):
    if event.get("kind") != "structure":
        return False

    scope = event.get("scope")
    if cfg["signal_scope"] not in ("both", "all") and scope != cfg["signal_scope"]:
        return False

    tag = str(event.get("tag") or "").upper()
    if cfg["signal_tag"] != "ALL" and tag != cfg["signal_tag"]:
        return False

    return True


def _latest_signal_event(state, cfg, index):
    for event in reversed(state["events"]):
        if event.get("index") != index:
            if event.get("index", -1) < index:
                return None
            continue
        if _event_matches(event, cfg):
            return event
    return None


def _nearest_order_block_stop(state, side, price, scope):
    blocks = state["order_blocks"].get(scope, [])
    for block in blocks:
        if side == "BUY" and block["bias"] == BULLISH and block["low"] < price:
            return block["low"]
        if side == "SELL" and block["bias"] == BEARISH and block["high"] > price:
            return block["high"]
    return None


def _structure_stop(state, cfg, side, price, scope):
    source = cfg["stop_source"]
    scopes = []
    if source == "internal":
        scopes = ["internal"]
    elif source == "swing":
        scopes = ["swing"]
    elif source == "order_block":
        scopes = [scope, "internal", "swing"]
    else:
        scopes = [scope, "internal", "swing"]

    if source == "order_block":
        for item in scopes:
            stop = _nearest_order_block_stop(state, side, price, item)
            if stop is not None:
                return stop

    for item in scopes:
        if side == "BUY":
            pivot = state["pivots"].get(f"{item}_low")
            level = pivot.get("current") if pivot else None
            if level is not None and level < price:
                return level
        else:
            pivot = state["pivots"].get(f"{item}_high")
            level = pivot.get("current") if pivot else None
            if level is not None and level > price:
                return level
    return None


def _risk_levels(state, cfg, event, candle):
    side = "BUY" if event.get("side") == "bullish" else "SELL"
    price = float(candle.close)
    atr = _current_atr(state)

    stop = None
    if cfg["stop_source"] != "atr":
        stop = _structure_stop(state, cfg, side, price, event.get("scope") or "swing")
    if stop is None:
        stop = price - atr * cfg["stop_atr"] if side == "BUY" else price + atr * cfg["stop_atr"]

    if side == "BUY" and stop >= price:
        stop = price - atr * cfg["stop_atr"]
    if side == "SELL" and stop <= price:
        stop = price + atr * cfg["stop_atr"]

    distance = abs(price - stop)
    if price <= 0 or distance <= 0:
        return None, None

    pct = distance / price * 100.0
    if pct > cfg["max_stop_pct"]:
        distance = price * cfg["max_stop_pct"] / 100.0
        stop = price - distance if side == "BUY" else price + distance
    elif pct < cfg["min_stop_pct"]:
        distance = price * cfg["min_stop_pct"] / 100.0
        stop = price - distance if side == "BUY" else price + distance

    target = None
    if cfg["use_take_profit"]:
        target_distance = distance * cfg["reward_risk"]
        target = price + target_distance if side == "BUY" else price - target_distance
    return stop, target


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not candles:
        return []
    state = _analysis(candles, cfg)
    events = [e for e in state["events"] if e.get("kind") in ("structure", "equal", "fvg")]
    events = events[-cfg["draw_last"]:]
    drawings = []

    for idx, event in enumerate(events):
        side = event.get("side")
        bullish = side == "bullish"
        color = GREEN if bullish else RED
        if event.get("kind") == "fvg":
            color = "#38bdf8" if bullish else "#f97316"
        level = event.get("level")
        time_value = event.get("time")
        pivot_time = event.get("pivot_time") or time_value
        if level is None or time_value is None:
            continue

        group = f"smc-{event.get('index', idx)}"
        if event.get("kind") in ("structure", "equal"):
            drawings.append({
                "type": "line",
                "first": {"time": pivot_time, "price": level},
                "second": {"time": time_value, "price": level},
                "xloc": "bar_time",
                "color": color,
                "style": "dashed" if event.get("scope") == "internal" else "solid",
                "width": 1,
                "group": group,
            })
        else:
            drawings.append({
                "type": "line",
                "first": {"time": pivot_time, "price": event.get("top", level)},
                "second": {"time": time_value, "price": event.get("top", level)},
                "xloc": "bar_time",
                "color": color,
                "style": "dotted",
                "width": 1,
                "group": group,
            })
            drawings.append({
                "type": "line",
                "first": {"time": pivot_time, "price": event.get("bottom", level)},
                "second": {"time": time_value, "price": event.get("bottom", level)},
                "xloc": "bar_time",
                "color": color,
                "style": "dotted",
                "width": 1,
                "group": group,
            })

        label = event.get("tag") or ("FVG" if event.get("kind") == "fvg" else "SMC")
        if event.get("scope") == "internal":
            label = f"i{label}"
        drawings.append({
            "type": "label",
            "point": {"time": time_value, "price": level},
            "text": label,
            "color": color,
            "textcolor": "#0b1120",
            "style": "label_up" if bullish else "label_down",
            "size": "small",
            "group": group,
        })
    return drawings


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_INDEX

    cfg = _config(config)
    candles = _candles()
    if len(candles) < max(cfg["swing_length"], cfg["internal_length"], cfg["equal_length"]) + 3:
        hold()
        return

    state = _analysis(candles, cfg)
    index = len(candles) - 1
    bar = bar_number(candles)
    event = _latest_signal_event(state, cfg, index)
    if event is None:
        hold()
        return

    side = "BUY" if event.get("side") == "bullish" else "SELL"
    if side == "SELL" and not cfg["allow_short"]:
        hold()
        return

    if LAST_SIGNAL_INDEX is not None and bar - LAST_SIGNAL_INDEX < cfg["cooldown_bars"]:
        hold()
        return

    stop, target = _risk_levels(state, cfg, event, candle)
    if stop is not None:
        set_sl(price=stop)
    if target is not None:
        set_tp(price=target)

    _set_meta(
        strategy="smart_money_concepts",
        event=event.get("tag"),
        scope=event.get("scope"),
        side=event.get("side"),
        level=event.get("level"),
    )
    _observe(
        f"smc.{event.get('scope')}.{event.get('side')}.{event.get('tag')}",
        side="long" if side == "BUY" else "short",
        level=event.get("level"),
    )

    current_side = getattr(portfolio, "side", None)
    if side == "BUY" and current_side != "BUY":
        LAST_SIGNAL_INDEX = bar
        buy()
    elif side == "SELL" and current_side != "SELL":
        LAST_SIGNAL_INDEX = bar
        sell()
    else:
        hold()
