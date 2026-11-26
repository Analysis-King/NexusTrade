# name: Footprint Order Flow
# desc: Absorption, failed auction ve delta divergence kullanan saf order-flow stratejisi
# author: NexusTrade
# version: 1.0

LAST_ENTRY_T = None
REQUIRES_FOOTPRINT = True


def initialize():
    return {
        "min_history_bars": 5,
        "min_trades": 50,
        "min_total_notional": 0,
        "min_activity_ratio": 0.8,
        "imbalance_ratio": 3.0,
        "stacked_levels": 3,
        "enable_initiative": False,
        "enable_absorption": True,
        "enable_failed_auction": True,
        "enable_delta_divergence": True,
        "invert_signals": False,
        "min_confluence": 1,
        "initiative_delta_pct": 20.0,
        "absorption_delta_pct": 18.0,
        "delta_divergence_min_pct": 14.0,
        "auction_extreme_activity_ratio": 0.65,
        "rejection_wick_pct": 0.25,
        "poc_edge_threshold": 0.58,
        "allow_long": True,
        "allow_short": True,
        "exit_on_opposite": False,
        "risk_reward": 2.2,
        "stop_buffer_pct": 0.03,
        "min_stop_pct": 0.35,
        "max_stop_pct": 1.5,
        "cooldown_bars": 3,
        "observation_horizon_bars": 12,
    }


def _float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _int(value, fallback=0):
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


def _cfg(config):
    cfg = initialize()
    if isinstance(config, dict):
        cfg.update(config)
    cfg["min_history_bars"] = max(1, _int(cfg.get("min_history_bars"), 5))
    cfg["min_trades"] = max(1, _int(cfg.get("min_trades"), 50))
    cfg["min_total_notional"] = max(0.0, _float(cfg.get("min_total_notional"), 0.0))
    cfg["min_activity_ratio"] = max(0.0, _float(cfg.get("min_activity_ratio"), 0.8))
    cfg["imbalance_ratio"] = max(1.01, _float(cfg.get("imbalance_ratio"), 3.0))
    cfg["stacked_levels"] = max(1, _int(cfg.get("stacked_levels"), 3))
    cfg["enable_initiative"] = _bool(cfg.get("enable_initiative"), False)
    cfg["enable_absorption"] = _bool(cfg.get("enable_absorption"), True)
    cfg["enable_failed_auction"] = _bool(cfg.get("enable_failed_auction"), True)
    cfg["enable_delta_divergence"] = _bool(cfg.get("enable_delta_divergence"), True)
    cfg["invert_signals"] = _bool(cfg.get("invert_signals"), False)
    cfg["min_confluence"] = max(1, _int(cfg.get("min_confluence"), 1))
    cfg["initiative_delta_pct"] = max(0.1, _float(cfg.get("initiative_delta_pct"), 20.0))
    cfg["absorption_delta_pct"] = max(0.1, _float(cfg.get("absorption_delta_pct"), 18.0))
    cfg["delta_divergence_min_pct"] = max(0.1, _float(cfg.get("delta_divergence_min_pct"), 14.0))
    cfg["auction_extreme_activity_ratio"] = max(
        0.01, _float(cfg.get("auction_extreme_activity_ratio"), 0.65)
    )
    cfg["rejection_wick_pct"] = min(0.95, max(0.0, _float(cfg.get("rejection_wick_pct"), 0.25)))
    cfg["poc_edge_threshold"] = min(0.95, max(0.5, _float(cfg.get("poc_edge_threshold"), 0.58)))
    cfg["allow_long"] = _bool(cfg.get("allow_long"), True)
    cfg["allow_short"] = _bool(cfg.get("allow_short"), True)
    cfg["exit_on_opposite"] = _bool(cfg.get("exit_on_opposite"), True)
    cfg["risk_reward"] = max(0.2, _float(cfg.get("risk_reward"), 1.8))
    cfg["stop_buffer_pct"] = max(0.0, _float(cfg.get("stop_buffer_pct"), 0.03))
    cfg["min_stop_pct"] = max(0.01, _float(cfg.get("min_stop_pct"), 0.12))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _float(cfg.get("max_stop_pct"), 1.25))
    cfg["cooldown_bars"] = max(0, _int(cfg.get("cooldown_bars"), 2))
    return cfg


def _max_stacked(levels, side, ratio):
    longest = 0
    current = 0
    for level in levels:
        buy_volume = max(0.0, _float(level.get("buy_volume")))
        sell_volume = max(0.0, _float(level.get("sell_volume")))
        if side == "buy":
            imbalanced = buy_volume > 0 and buy_volume >= max(sell_volume, 1e-12) * ratio
        else:
            imbalanced = sell_volume > 0 and sell_volume >= max(buy_volume, 1e-12) * ratio
        current = current + 1 if imbalanced else 0
        longest = max(longest, current)
    return longest


def _median(values):
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _candle_value(candle, name):
    if isinstance(candle, dict):
        aliases = {
            "open": "o",
            "high": "h",
            "low": "l",
            "close": "c",
            "volume": "v",
            "time": "t",
        }
        return _float(candle.get(aliases.get(name, name)))
    return _float(getattr(candle, name, 0.0))


def _metrics(footprint, candle, cfg):
    levels = sorted(
        [level for level in footprint.get("levels") or [] if _float(level.get("price")) > 0],
        key=lambda level: _float(level.get("price")),
    )
    if not levels:
        return None

    low_price = _float(levels[0].get("price"))
    high_price = _float(levels[-1].get("price"))
    price_range = max(high_price - low_price, 1e-12)
    total_volume = max(_float(footprint.get("total_volume")), 1e-12)
    delta = _float(footprint.get("delta"))
    delta_pct = delta / total_volume * 100.0
    poc_price = _float(footprint.get("poc_price"), (low_price + high_price) / 2.0)
    poc_location = (poc_price - low_price) / price_range
    candle_open = _candle_value(candle, "open")
    candle_high = _candle_value(candle, "high")
    candle_low = _candle_value(candle, "low")
    candle_close = _candle_value(candle, "close")
    candle_range = max(candle_high - candle_low, 1e-12)
    close_location = (candle_close - low_price) / price_range
    lower_wick_pct = (min(candle_open, candle_close) - candle_low) / candle_range
    upper_wick_pct = (candle_high - max(candle_open, candle_close)) / candle_range
    stacked_buy = _max_stacked(levels, "buy", cfg["imbalance_ratio"])
    stacked_sell = _max_stacked(levels, "sell", cfg["imbalance_ratio"])
    median_level_volume = max(_median([_float(level.get("total_volume")) for level in levels]), 1e-12)
    low_extreme_activity = _float(levels[0].get("total_volume")) / median_level_volume
    high_extreme_activity = _float(levels[-1].get("total_volume")) / median_level_volume

    return {
        "low": low_price,
        "high": high_price,
        "delta_pct": delta_pct,
        "poc": poc_price,
        "poc_location": poc_location,
        "close_location": close_location,
        "lower_wick_pct": lower_wick_pct,
        "upper_wick_pct": upper_wick_pct,
        "low_extreme_activity": low_extreme_activity,
        "high_extreme_activity": high_extreme_activity,
        "stacked_buy": stacked_buy,
        "stacked_sell": stacked_sell,
    }


def _risk_prices(entry, side, metrics, cfg):
    min_distance = entry * cfg["min_stop_pct"] / 100.0
    max_distance = entry * cfg["max_stop_pct"] / 100.0
    buffer_distance = entry * cfg["stop_buffer_pct"] / 100.0
    if side == "long":
        raw_stop = metrics["low"] - buffer_distance
        distance = entry - raw_stop
    else:
        raw_stop = metrics["high"] + buffer_distance
        distance = raw_stop - entry
    distance = min(max(distance, min_distance), max_distance)
    if side == "long":
        return entry - distance, entry + distance * cfg["risk_reward"]
    return entry + distance, entry - distance * cfg["risk_reward"]


def _cooldown_ready(footprints, cfg):
    if LAST_ENTRY_T is None or cfg["cooldown_bars"] <= 0:
        return True
    recent_times = [int(item.get("t") or 0) for item in footprints[-(cfg["cooldown_bars"] + 1):]]
    return LAST_ENTRY_T not in recent_times


def _matching_candle(candles, footprint):
    target = int(footprint.get("t") or 0)
    for item in reversed(candles):
        if int(item.get("t") or 0) == target:
            return item
    return None


def on_candle(candle, portfolio, config):
    global LAST_ENTRY_T

    cfg = _cfg(config)
    footprint = indicators.footprint()
    footprints = [
        item for item in indicators.footprints()
        if isinstance(item, dict) and item.get("complete")
    ]
    candles = indicators.candles()
    if not isinstance(footprint, dict) or not footprint.get("complete"):
        hold()
        return
    if len(footprints) < cfg["min_history_bars"]:
        hold()
        return

    trades = _int(footprint.get("trades"))
    total_notional = _float(footprint.get("total_notional"))
    if trades < cfg["min_trades"] or total_notional < cfg["min_total_notional"]:
        hold()
        return

    recent_activity = [
        _float(item.get("total_notional"))
        for item in footprints[-cfg["min_history_bars"]:-1]
        if _float(item.get("total_notional")) > 0
    ]
    baseline_activity = _median(recent_activity)
    if baseline_activity > 0 and total_notional < baseline_activity * cfg["min_activity_ratio"]:
        hold()
        return

    metrics = _metrics(footprint, candle, cfg)
    if metrics is None:
        hold()
        return
    previous_footprint = footprints[-2] if len(footprints) >= 2 else None
    previous_candle = _matching_candle(candles, previous_footprint) if previous_footprint else None
    previous_metrics = (
        _metrics(previous_footprint, previous_candle, cfg)
        if previous_footprint and previous_candle
        else None
    )

    stacked = cfg["stacked_levels"]
    delta_pct = metrics["delta_pct"]
    upper_edge = cfg["poc_edge_threshold"]
    lower_edge = 1.0 - upper_edge

    initiative_long = cfg["enable_initiative"] and (
        delta_pct >= cfg["initiative_delta_pct"]
        and metrics["stacked_buy"] >= stacked
        and metrics["poc_location"] >= 0.5
    )
    initiative_short = cfg["enable_initiative"] and (
        delta_pct <= -cfg["initiative_delta_pct"]
        and metrics["stacked_sell"] >= stacked
        and metrics["poc_location"] <= 0.5
    )
    absorption_long = cfg["enable_absorption"] and (
        delta_pct <= -cfg["absorption_delta_pct"]
        and metrics["stacked_sell"] >= stacked
        and metrics["close_location"] >= upper_edge
        and metrics["lower_wick_pct"] >= cfg["rejection_wick_pct"]
        and _candle_value(candle, "close") > metrics["poc"]
    )
    absorption_short = cfg["enable_absorption"] and (
        delta_pct >= cfg["absorption_delta_pct"]
        and metrics["stacked_buy"] >= stacked
        and metrics["close_location"] <= lower_edge
        and metrics["upper_wick_pct"] >= cfg["rejection_wick_pct"]
        and _candle_value(candle, "close") < metrics["poc"]
    )
    failed_auction_long = cfg["enable_failed_auction"] and previous_candle is not None and (
        _candle_value(candle, "low") < _candle_value(previous_candle, "low")
        and _candle_value(candle, "close") > _candle_value(previous_candle, "low")
        and metrics["low_extreme_activity"] <= cfg["auction_extreme_activity_ratio"]
        and metrics["lower_wick_pct"] >= cfg["rejection_wick_pct"]
        and delta_pct <= 0
    )
    failed_auction_short = cfg["enable_failed_auction"] and previous_candle is not None and (
        _candle_value(candle, "high") > _candle_value(previous_candle, "high")
        and _candle_value(candle, "close") < _candle_value(previous_candle, "high")
        and metrics["high_extreme_activity"] <= cfg["auction_extreme_activity_ratio"]
        and metrics["upper_wick_pct"] >= cfg["rejection_wick_pct"]
        and delta_pct >= 0
    )
    delta_divergence_long = (
        cfg["enable_delta_divergence"]
        and previous_candle is not None
        and previous_metrics is not None
        and _candle_value(candle, "low") < _candle_value(previous_candle, "low")
        and delta_pct >= previous_metrics["delta_pct"] + cfg["delta_divergence_min_pct"]
        and metrics["close_location"] >= 0.45
    )
    delta_divergence_short = (
        cfg["enable_delta_divergence"]
        and previous_candle is not None
        and previous_metrics is not None
        and _candle_value(candle, "high") > _candle_value(previous_candle, "high")
        and delta_pct <= previous_metrics["delta_pct"] - cfg["delta_divergence_min_pct"]
        and metrics["close_location"] <= 0.55
    )

    long_setups = []
    short_setups = []
    for enabled, name in (
        (initiative_long, "initiative_buy"),
        (absorption_long, "sell_absorption"),
        (failed_auction_long, "failed_auction_long"),
        (delta_divergence_long, "delta_divergence_long"),
    ):
        if enabled:
            long_setups.append(name)
            observe(name, side="long", delta_pct=round(delta_pct, 2))
    for enabled, name in (
        (initiative_short, "initiative_sell"),
        (absorption_short, "buy_absorption"),
        (failed_auction_short, "failed_auction_short"),
        (delta_divergence_short, "delta_divergence_short"),
    ):
        if enabled:
            short_setups.append(name)
            observe(name, side="short", delta_pct=round(delta_pct, 2))

    long_signal = len(long_setups) >= cfg["min_confluence"]
    short_signal = len(short_setups) >= cfg["min_confluence"]
    if cfg["invert_signals"]:
        long_signal, short_signal = short_signal, long_signal
        long_setups, short_setups = (
            [f"inverse_{name}" for name in short_setups],
            [f"inverse_{name}" for name in long_setups],
        )

    if cfg["exit_on_opposite"] and portfolio.has_position:
        if portfolio.side == "BUY" and short_signal:
            close()
            return
        if portfolio.side == "SELL" and long_signal:
            close()
            return
        hold()
        return
    if portfolio.has_position or not _cooldown_ready(footprints, cfg):
        hold()
        return

    entry = _candle_value(candle, "close")
    signal_kind = None
    side = None
    if cfg["allow_long"] and long_signal and not short_signal:
        side = "long"
        signal_kind = "+".join(long_setups)
    elif cfg["allow_short"] and short_signal and not long_signal:
        side = "short"
        signal_kind = "+".join(short_setups)
    else:
        hold()
        return

    sl_price, tp_price = _risk_prices(entry, side, metrics, cfg)
    set_sl(price=sl_price)
    set_tp(price=tp_price)
    set_meta(
        pattern="Footprint Order Flow",
        setup=signal_kind,
        direction=side,
        delta_pct=round(delta_pct, 2),
        poc_price=metrics["poc"],
        stacked_buy=metrics["stacked_buy"],
        stacked_sell=metrics["stacked_sell"],
        footprint_trades=trades,
        footprint_notional=round(total_notional, 2),
    )
    LAST_ENTRY_T = int(footprint.get("t") or candle.time)
    if side == "long":
        buy()
    else:
        sell()


def draw(candles, ind_data, drawings, config=None):
    return []
