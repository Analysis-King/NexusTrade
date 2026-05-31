# name: TradingView Popular Suite
# desc: SuperTrend, UT Bot, PMax, SSL/QQE, HalfTrend, HMA+SuperTrend ve AlphaTrend mantiklarini tek evrensel stratejide dener
# author: NexusTrade
# version: 1.0

import builtins as _builtins
import math


LAST_SIGNAL_BAR = None

SERIES_CACHE = {
    "signature": None,
    "count": 0,
    "last_t": None,
    "open": [],
    "high": [],
    "low": [],
    "close": [],
    "atr": [],
    "ema_filter": [],
    "fast_ema": [],
    "slow_ema": [],
    "macd_signal": [],
    "macd_hist": [],
    "baseline": [],
    "hma_raw": [],
    "hma": [],
    "rsi": [],
    "avg_gain": [],
    "avg_loss": [],
    "qqe": [],
    "super_upper": [],
    "super_lower": [],
    "supertrend": [],
    "super_dir": [],
    "ut_stop": [],
    "pmax_ma": [],
    "pmax_long": [],
    "pmax_short": [],
    "pmax": [],
    "pmax_dir": [],
    "ssl_high": [],
    "ssl_low": [],
    "ssl_line": [],
    "ssl_dir": [],
    "half_line": [],
    "half_dir": [],
    "alpha": [],
    "alpha_dir": [],
    "chandelier_long": [],
    "chandelier_short": [],
    "chandelier_line": [],
    "chandelier_dir": [],
    "range_abs": [],
    "range_smooth": [],
    "range_filter": [],
    "range_dir": [],
    "tenkan": [],
    "kijun": [],
    "span_a": [],
    "span_b": [],
    "ichimoku_dir": [],
}


def initialize():
    return {
        "mode": "supertrend",
        "allow_short": True,
        "cooldown_bars": 2,
        "use_ema_filter": False,
        "ema_filter_period": 200,
        "use_rsi_filter": False,
        "rsi_period": 14,
        "rsi_long_min": 50.0,
        "rsi_short_max": 50.0,
        "use_qqe_filter": False,
        "qqe_smooth": 5,
        "use_macd_filter": False,
        "macd_fast": 12,
        "macd_slow": 26,
        "macd_signal": 9,
        "atr_period": 10,
        "supertrend_mult": 3.0,
        "ut_atr_period": 10,
        "ut_key": 1.0,
        "pmax_ma_period": 10,
        "pmax_atr_mult": 3.0,
        "ssl_period": 10,
        "baseline_period": 60,
        "hma_period": 50,
        "halftrend_amplitude": 6,
        "alpha_coeff": 1.0,
        "alpha_rsi_level": 50.0,
        "chandelier_period": 22,
        "chandelier_mult": 3.0,
        "range_period": 20,
        "range_mult": 3.0,
        "tenkan_period": 9,
        "kijun_period": 26,
        "senkou_b_period": 52,
        "stop_atr": 1.0,
        "min_stop_pct": 0.18,
        "max_stop_pct": 1.6,
        "use_stop_loss": True,
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

    modes = (
        "supertrend",
        "supertrend_macd",
        "hma_supertrend",
        "ut_bot",
        "pmax",
        "ssl_qqe",
        "halftrend",
        "alpha_trend",
        "chandelier",
        "range_filter",
        "ichimoku",
    )
    cfg["mode"] = str(cfg.get("mode") or "supertrend").strip().lower()
    if cfg["mode"] not in modes:
        cfg["mode"] = "supertrend"

    cfg["allow_short"] = _to_bool(cfg.get("allow_short"), True)
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 2))
    cfg["use_ema_filter"] = _to_bool(cfg.get("use_ema_filter"), False)
    cfg["ema_filter_period"] = max(2, _to_int(cfg.get("ema_filter_period"), 200))
    cfg["use_rsi_filter"] = _to_bool(cfg.get("use_rsi_filter"), False)
    cfg["rsi_period"] = max(2, _to_int(cfg.get("rsi_period"), 14))
    cfg["rsi_long_min"] = _to_float(cfg.get("rsi_long_min"), 50.0)
    cfg["rsi_short_max"] = _to_float(cfg.get("rsi_short_max"), 50.0)
    cfg["use_qqe_filter"] = _to_bool(cfg.get("use_qqe_filter"), False)
    cfg["qqe_smooth"] = max(1, _to_int(cfg.get("qqe_smooth"), 5))
    cfg["use_macd_filter"] = _to_bool(cfg.get("use_macd_filter"), False)
    cfg["macd_fast"] = max(2, _to_int(cfg.get("macd_fast"), 12))
    cfg["macd_slow"] = max(cfg["macd_fast"] + 1, _to_int(cfg.get("macd_slow"), 26))
    cfg["macd_signal"] = max(1, _to_int(cfg.get("macd_signal"), 9))
    cfg["atr_period"] = max(2, _to_int(cfg.get("atr_period"), 10))
    cfg["supertrend_mult"] = max(0.2, _to_float(cfg.get("supertrend_mult"), 3.0))
    cfg["ut_atr_period"] = max(2, _to_int(cfg.get("ut_atr_period"), cfg["atr_period"]))
    cfg["ut_key"] = max(0.2, _to_float(cfg.get("ut_key"), 1.0))
    cfg["pmax_ma_period"] = max(1, _to_int(cfg.get("pmax_ma_period"), 10))
    cfg["pmax_atr_mult"] = max(0.2, _to_float(cfg.get("pmax_atr_mult"), 3.0))
    cfg["ssl_period"] = max(2, _to_int(cfg.get("ssl_period"), 10))
    cfg["baseline_period"] = max(2, _to_int(cfg.get("baseline_period"), 60))
    cfg["hma_period"] = max(2, _to_int(cfg.get("hma_period"), 50))
    cfg["halftrend_amplitude"] = max(2, _to_int(cfg.get("halftrend_amplitude"), 6))
    cfg["alpha_coeff"] = max(0.1, _to_float(cfg.get("alpha_coeff"), 1.0))
    cfg["alpha_rsi_level"] = _to_float(cfg.get("alpha_rsi_level"), 50.0)
    cfg["chandelier_period"] = max(2, _to_int(cfg.get("chandelier_period"), 22))
    cfg["chandelier_mult"] = max(0.2, _to_float(cfg.get("chandelier_mult"), 3.0))
    cfg["range_period"] = max(2, _to_int(cfg.get("range_period"), 20))
    cfg["range_mult"] = max(0.2, _to_float(cfg.get("range_mult"), 3.0))
    cfg["tenkan_period"] = max(2, _to_int(cfg.get("tenkan_period"), 9))
    cfg["kijun_period"] = max(cfg["tenkan_period"], _to_int(cfg.get("kijun_period"), 26))
    cfg["senkou_b_period"] = max(cfg["kijun_period"], _to_int(cfg.get("senkou_b_period"), 52))
    cfg["stop_atr"] = max(0.1, _to_float(cfg.get("stop_atr"), 1.0))
    cfg["min_stop_pct"] = max(0.02, _to_float(cfg.get("min_stop_pct"), 0.18))
    cfg["max_stop_pct"] = max(cfg["min_stop_pct"], _to_float(cfg.get("max_stop_pct"), 1.6))
    cfg["use_stop_loss"] = _to_bool(cfg.get("use_stop_loss"), True)
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


def _rma_next(previous, value, period):
    return (float(previous) * (period - 1) + float(value)) / period


def _window(values, period, index):
    return values[max(0, index - period + 1):index + 1]


def _sma(values, period, index):
    w = _window(values, period, index)
    return sum(w) / len(w) if w else 0.0


def _wma(values, period, index):
    w = _window(values, period, index)
    if not w:
        return 0.0
    denom = len(w) * (len(w) + 1) / 2.0
    return sum(value * (weight + 1) for weight, value in enumerate(w)) / denom


def _series_signature(cfg):
    return (
        cfg["mode"],
        cfg["ema_filter_period"],
        cfg["rsi_period"],
        cfg["qqe_smooth"],
        cfg["macd_fast"],
        cfg["macd_slow"],
        cfg["macd_signal"],
        cfg["atr_period"],
        cfg["supertrend_mult"],
        cfg["ut_atr_period"],
        cfg["ut_key"],
        cfg["pmax_ma_period"],
        cfg["pmax_atr_mult"],
        cfg["ssl_period"],
        cfg["baseline_period"],
        cfg["hma_period"],
        cfg["halftrend_amplitude"],
        cfg["alpha_coeff"],
        cfg["alpha_rsi_level"],
        cfg["chandelier_period"],
        cfg["chandelier_mult"],
        cfg["range_period"],
        cfg["range_mult"],
        cfg["tenkan_period"],
        cfg["kijun_period"],
        cfg["senkou_b_period"],
    )


def _reset_series_cache(signature):
    SERIES_CACHE["signature"] = signature
    SERIES_CACHE["count"] = 0
    SERIES_CACHE["last_t"] = None
    for key in SERIES_CACHE:
        if key not in ("signature", "count", "last_t"):
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

    o = SERIES_CACHE["open"]
    h = SERIES_CACHE["high"]
    l = SERIES_CACHE["low"]
    c = SERIES_CACHE["close"]
    atr = SERIES_CACHE["atr"]
    ema_filter = SERIES_CACHE["ema_filter"]
    fast_ema = SERIES_CACHE["fast_ema"]
    slow_ema = SERIES_CACHE["slow_ema"]
    macd_signal = SERIES_CACHE["macd_signal"]
    macd_hist = SERIES_CACHE["macd_hist"]
    baseline = SERIES_CACHE["baseline"]
    hma_raw = SERIES_CACHE["hma_raw"]
    hma = SERIES_CACHE["hma"]
    rsi = SERIES_CACHE["rsi"]
    avg_gain = SERIES_CACHE["avg_gain"]
    avg_loss = SERIES_CACHE["avg_loss"]
    qqe = SERIES_CACHE["qqe"]
    super_upper = SERIES_CACHE["super_upper"]
    super_lower = SERIES_CACHE["super_lower"]
    supertrend = SERIES_CACHE["supertrend"]
    super_dir = SERIES_CACHE["super_dir"]
    ut_stop = SERIES_CACHE["ut_stop"]
    pmax_ma = SERIES_CACHE["pmax_ma"]
    pmax_long = SERIES_CACHE["pmax_long"]
    pmax_short = SERIES_CACHE["pmax_short"]
    pmax = SERIES_CACHE["pmax"]
    pmax_dir = SERIES_CACHE["pmax_dir"]
    ssl_high = SERIES_CACHE["ssl_high"]
    ssl_low = SERIES_CACHE["ssl_low"]
    ssl_line = SERIES_CACHE["ssl_line"]
    ssl_dir = SERIES_CACHE["ssl_dir"]
    half_line = SERIES_CACHE["half_line"]
    half_dir = SERIES_CACHE["half_dir"]
    alpha = SERIES_CACHE["alpha"]
    alpha_dir = SERIES_CACHE["alpha_dir"]
    chandelier_long = SERIES_CACHE["chandelier_long"]
    chandelier_short = SERIES_CACHE["chandelier_short"]
    chandelier_line = SERIES_CACHE["chandelier_line"]
    chandelier_dir = SERIES_CACHE["chandelier_dir"]
    range_abs = SERIES_CACHE["range_abs"]
    range_smooth = SERIES_CACHE["range_smooth"]
    range_filter = SERIES_CACHE["range_filter"]
    range_dir = SERIES_CACHE["range_dir"]
    tenkan = SERIES_CACHE["tenkan"]
    kijun = SERIES_CACHE["kijun"]
    span_a = SERIES_CACHE["span_a"]
    span_b = SERIES_CACHE["span_b"]
    ichimoku_dir = SERIES_CACHE["ichimoku_dir"]

    hma_half = max(1, cfg["hma_period"] // 2)
    hma_sqrt = max(1, int(math.sqrt(cfg["hma_period"])))

    for i in range(count, len(candles)):
        candle = candles[i]
        oi = float(candle["o"])
        hi = float(candle["h"])
        lo = float(candle["l"])
        ci = float(candle["c"])
        o.append(oi)
        h.append(hi)
        l.append(lo)
        c.append(ci)

        if i == 0:
            tr = hi - lo
            atr_value = tr
            gain_avg = 0.0
            loss_avg = 0.0
            rsi_value = 50.0
            fast = ci
            slow = ci
            macd_sig = 0.0
            base = ci
            emaf = ci
            pma = ci
        else:
            prev_close = c[i - 1]
            tr = max(hi - lo, abs(hi - prev_close), abs(lo - prev_close))
            atr_value = _rma_next(atr[-1], tr, cfg["atr_period"])
            change = ci - prev_close
            gain = max(change, 0.0)
            loss = max(-change, 0.0)
            if i == 1:
                gain_avg = gain
                loss_avg = loss
            elif i <= cfg["rsi_period"]:
                gain_avg = (avg_gain[-1] * (i - 1) + gain) / i
                loss_avg = (avg_loss[-1] * (i - 1) + loss) / i
            else:
                gain_avg = _rma_next(avg_gain[-1], gain, cfg["rsi_period"])
                loss_avg = _rma_next(avg_loss[-1], loss, cfg["rsi_period"])
            if loss_avg == 0:
                rsi_value = 100.0 if gain_avg > 0 else 50.0
            else:
                rs = gain_avg / loss_avg
                rsi_value = 100.0 - 100.0 / (1.0 + rs)
            fast = _ema_next(fast_ema[-1], ci, cfg["macd_fast"])
            slow = _ema_next(slow_ema[-1], ci, cfg["macd_slow"])
            macd_line = fast - slow
            macd_sig = _ema_next(macd_signal[-1], macd_line, cfg["macd_signal"])
            base = _ema_next(baseline[-1], ci, cfg["baseline_period"])
            emaf = _ema_next(ema_filter[-1], ci, cfg["ema_filter_period"])
            pma = _ema_next(pmax_ma[-1], ci, cfg["pmax_ma_period"])

        atr.append(atr_value)
        avg_gain.append(gain_avg)
        avg_loss.append(loss_avg)
        rsi.append(rsi_value)
        fast_ema.append(fast)
        slow_ema.append(slow)
        macd_line = fast - slow
        macd_signal.append(macd_sig)
        macd_hist.append(macd_line - macd_sig)
        baseline.append(base)
        ema_filter.append(emaf)
        pmax_ma.append(pma)
        qqe.append(rsi_value if i == 0 else _ema_next(qqe[-1], rsi_value, cfg["qqe_smooth"]))

        wma_half = _wma(c, hma_half, i)
        wma_full = _wma(c, cfg["hma_period"], i)
        raw = 2.0 * wma_half - wma_full
        hma_raw.append(raw)
        hma.append(_wma(hma_raw, hma_sqrt, i))

        src = (hi + lo) / 2.0
        basic_upper = src + cfg["supertrend_mult"] * atr_value
        basic_lower = src - cfg["supertrend_mult"] * atr_value
        if i == 0:
            final_upper = basic_upper
            final_lower = basic_lower
            st_dir = 1 if ci >= src else -1
        else:
            prev_upper = super_upper[-1]
            prev_lower = super_lower[-1]
            prev_close = c[i - 1]
            final_upper = basic_upper if basic_upper < prev_upper or prev_close > prev_upper else prev_upper
            final_lower = basic_lower if basic_lower > prev_lower or prev_close < prev_lower else prev_lower
            prev_st = supertrend[-1]
            if prev_st == prev_upper:
                st_dir = 1 if ci > final_upper else -1
            else:
                st_dir = -1 if ci < final_lower else 1
        super_upper.append(final_upper)
        super_lower.append(final_lower)
        super_dir.append(st_dir)
        supertrend.append(final_lower if st_dir == 1 else final_upper)

        n_loss = cfg["ut_key"] * atr_value
        if i == 0:
            ustop = ci - n_loss
        else:
            prev_stop = ut_stop[-1]
            prev_close = c[i - 1]
            if ci > prev_stop and prev_close > prev_stop:
                ustop = max(prev_stop, ci - n_loss)
            elif ci < prev_stop and prev_close < prev_stop:
                ustop = min(prev_stop, ci + n_loss)
            elif ci > prev_stop:
                ustop = ci - n_loss
            else:
                ustop = ci + n_loss
        ut_stop.append(ustop)

        p_long_base = pma - cfg["pmax_atr_mult"] * atr_value
        p_short_base = pma + cfg["pmax_atr_mult"] * atr_value
        if i == 0:
            p_long = p_long_base
            p_short = p_short_base
            p_dir = 1 if ci >= pma else -1
        else:
            p_long = max(p_long_base, pmax_long[-1]) if pma > pmax_long[-1] else p_long_base
            p_short = min(p_short_base, pmax_short[-1]) if pma < pmax_short[-1] else p_short_base
            if pmax_dir[-1] == -1 and pma > pmax_short[-1]:
                p_dir = 1
            elif pmax_dir[-1] == 1 and pma < pmax_long[-1]:
                p_dir = -1
            else:
                p_dir = pmax_dir[-1] if pmax_dir else 1
        pmax_long.append(p_long)
        pmax_short.append(p_short)
        pmax_dir.append(p_dir)
        pmax.append(p_long if p_dir == 1 else p_short)

        sh = _ema_next(ssl_high[-1], hi, cfg["ssl_period"]) if i > 0 else hi
        sl = _ema_next(ssl_low[-1], lo, cfg["ssl_period"]) if i > 0 else lo
        if i == 0:
            sdir = 1 if ci >= (sh + sl) / 2.0 else -1
        elif ci > sh:
            sdir = 1
        elif ci < sl:
            sdir = -1
        else:
            sdir = ssl_dir[-1]
        ssl_high.append(sh)
        ssl_low.append(sl)
        ssl_dir.append(sdir)
        ssl_line.append(sl if sdir == 1 else sh)

        amp = cfg["halftrend_amplitude"]
        high_ma = _sma(h, amp, i)
        low_ma = _sma(l, amp, i)
        if i == 0:
            hdir = 1 if ci >= (high_ma + low_ma) / 2.0 else -1
        elif half_dir[-1] <= 0 and ci > high_ma and ci > c[i - 1]:
            hdir = 1
        elif half_dir[-1] >= 0 and ci < low_ma and ci < c[i - 1]:
            hdir = -1
        else:
            hdir = half_dir[-1]
        half_dir.append(hdir)
        half_line.append(min(_window(l, amp, i)) if hdir == 1 else max(_window(h, amp, i)))

        up_t = lo - atr_value * cfg["alpha_coeff"]
        down_t = hi + atr_value * cfg["alpha_coeff"]
        if i == 0:
            alpha_value = up_t if rsi_value >= cfg["alpha_rsi_level"] else down_t
        elif rsi_value >= cfg["alpha_rsi_level"]:
            alpha_value = max(up_t, alpha[-1])
        else:
            alpha_value = min(down_t, alpha[-1])
        alpha.append(alpha_value)
        if i < 2:
            adir = 1 if ci >= alpha_value else -1
        elif alpha_value > alpha[-2]:
            adir = 1
        elif alpha_value < alpha[-2]:
            adir = -1
        else:
            adir = alpha_dir[-1]
        alpha_dir.append(adir)

        highest_ch = max(_window(h, cfg["chandelier_period"], i))
        lowest_ch = min(_window(l, cfg["chandelier_period"], i))
        ch_long = highest_ch - cfg["chandelier_mult"] * atr_value
        ch_short = lowest_ch + cfg["chandelier_mult"] * atr_value
        if i == 0:
            ch_dir = 1 if ci >= (ch_long + ch_short) / 2.0 else -1
        elif ci > chandelier_short[-1]:
            ch_dir = 1
        elif ci < chandelier_long[-1]:
            ch_dir = -1
        else:
            ch_dir = chandelier_dir[-1]
        chandelier_long.append(ch_long)
        chandelier_short.append(ch_short)
        chandelier_dir.append(ch_dir)
        chandelier_line.append(ch_long if ch_dir == 1 else ch_short)

        abs_change = 0.0 if i == 0 else abs(ci - c[i - 1])
        range_abs.append(abs_change)
        smooth_period = cfg["range_period"] * 2 - 1
        smooth_abs = abs_change if i == 0 else _ema_next(range_smooth[-1], abs_change, smooth_period)
        range_smooth.append(smooth_abs)
        range_size = smooth_abs * cfg["range_mult"]
        if i == 0:
            rf = ci
            rf_dir = 1
        else:
            prev_filter = range_filter[-1]
            if ci > prev_filter:
                rf = max(prev_filter, ci - range_size)
            elif ci < prev_filter:
                rf = min(prev_filter, ci + range_size)
            else:
                rf = prev_filter
            if rf > prev_filter:
                rf_dir = 1
            elif rf < prev_filter:
                rf_dir = -1
            else:
                rf_dir = range_dir[-1]
        range_filter.append(rf)
        range_dir.append(rf_dir)

        ten = (max(_window(h, cfg["tenkan_period"], i)) + min(_window(l, cfg["tenkan_period"], i))) / 2.0
        kij = (max(_window(h, cfg["kijun_period"], i)) + min(_window(l, cfg["kijun_period"], i))) / 2.0
        sb = (max(_window(h, cfg["senkou_b_period"], i)) + min(_window(l, cfg["senkou_b_period"], i))) / 2.0
        sa = (ten + kij) / 2.0
        cloud_top = max(sa, sb)
        cloud_bottom = min(sa, sb)
        if i == 0:
            idir = 1 if ci >= cloud_top else -1
        elif ten > kij and ci > cloud_top:
            idir = 1
        elif ten < kij and ci < cloud_bottom:
            idir = -1
        else:
            idir = ichimoku_dir[-1]
        tenkan.append(ten)
        kijun.append(kij)
        span_a.append(sa)
        span_b.append(sb)
        ichimoku_dir.append(idir)

    SERIES_CACHE["count"] = len(candles)
    SERIES_CACHE["last_t"] = candles[-1].get("t") if candles else None
    return SERIES_CACHE


def _ready(candles, cfg):
    return len(candles) >= max(
        cfg["ema_filter_period"] if cfg["use_ema_filter"] else 1,
        cfg["rsi_period"] + cfg["qqe_smooth"] + 2,
        cfg["macd_slow"] + cfg["macd_signal"] + 2,
        cfg["atr_period"] + 2,
        cfg["hma_period"] + 2,
        cfg["baseline_period"] + 2,
        cfg["chandelier_period"] + 2,
        cfg["range_period"] * 2 + 2,
        cfg["senkou_b_period"] + 2,
    )


def _cross_up(a, b):
    return len(a) >= 2 and len(b) >= 2 and a[-2] <= b[-2] and a[-1] > b[-1]


def _cross_down(a, b):
    return len(a) >= 2 and len(b) >= 2 and a[-2] >= b[-2] and a[-1] < b[-1]


def _passes_filters(side, series, cfg):
    close = series["close"][-1]
    if cfg["use_ema_filter"]:
        ema = series["ema_filter"][-1]
        if side == "BUY" and close < ema:
            return False
        if side == "SELL" and close > ema:
            return False
    if cfg["use_rsi_filter"]:
        rsi = series["rsi"][-1]
        if side == "BUY" and rsi < cfg["rsi_long_min"]:
            return False
        if side == "SELL" and rsi > cfg["rsi_short_max"]:
            return False
    if cfg["use_qqe_filter"]:
        qqe = series["qqe"][-1]
        prev = series["qqe"][-2]
        if side == "BUY" and not (qqe > 50.0 and qqe >= prev):
            return False
        if side == "SELL" and not (qqe < 50.0 and qqe <= prev):
            return False
    if cfg["use_macd_filter"]:
        hist = series["macd_hist"][-1]
        if side == "BUY" and hist <= 0:
            return False
        if side == "SELL" and hist >= 0:
            return False
    return True


def _mode_signal(series, cfg):
    mode = cfg["mode"]
    close = series["close"]

    if mode == "supertrend":
        long_signal = series["super_dir"][-2] <= 0 and series["super_dir"][-1] > 0
        short_signal = series["super_dir"][-2] >= 0 and series["super_dir"][-1] < 0
        return long_signal, short_signal, series["supertrend"][-1]

    if mode == "supertrend_macd":
        long_signal = series["super_dir"][-2] <= 0 and series["super_dir"][-1] > 0 and series["macd_hist"][-1] > 0
        short_signal = series["super_dir"][-2] >= 0 and series["super_dir"][-1] < 0 and series["macd_hist"][-1] < 0
        return long_signal, short_signal, series["supertrend"][-1]

    if mode == "hma_supertrend":
        hma = series["hma"]
        long_state = hma[-1] > hma[-2] and close[-1] > series["supertrend"][-1] and series["super_dir"][-1] > 0
        prev_long_state = hma[-2] > hma[-3] and close[-2] > series["supertrend"][-2] and series["super_dir"][-2] > 0
        short_state = hma[-1] < hma[-2] and close[-1] < series["supertrend"][-1] and series["super_dir"][-1] < 0
        prev_short_state = hma[-2] < hma[-3] and close[-2] < series["supertrend"][-2] and series["super_dir"][-2] < 0
        return long_state and not prev_long_state, short_state and not prev_short_state, series["supertrend"][-1]

    if mode == "ut_bot":
        long_signal = close[-2] <= series["ut_stop"][-2] and close[-1] > series["ut_stop"][-1]
        short_signal = close[-2] >= series["ut_stop"][-2] and close[-1] < series["ut_stop"][-1]
        return long_signal, short_signal, series["ut_stop"][-1]

    if mode == "pmax":
        ma = series["pmax_ma"]
        pmax = series["pmax"]
        long_signal = (series["pmax_dir"][-2] <= 0 and series["pmax_dir"][-1] > 0) or _cross_up(ma, pmax)
        short_signal = (series["pmax_dir"][-2] >= 0 and series["pmax_dir"][-1] < 0) or _cross_down(ma, pmax)
        return long_signal, short_signal, pmax[-1]

    if mode == "ssl_qqe":
        long_signal = series["ssl_dir"][-2] <= 0 and series["ssl_dir"][-1] > 0 and close[-1] > series["baseline"][-1]
        short_signal = series["ssl_dir"][-2] >= 0 and series["ssl_dir"][-1] < 0 and close[-1] < series["baseline"][-1]
        return long_signal, short_signal, series["ssl_line"][-1]

    if mode == "halftrend":
        long_signal = series["half_dir"][-2] <= 0 and series["half_dir"][-1] > 0
        short_signal = series["half_dir"][-2] >= 0 and series["half_dir"][-1] < 0
        return long_signal, short_signal, series["half_line"][-1]

    if mode == "chandelier":
        long_signal = series["chandelier_dir"][-2] <= 0 and series["chandelier_dir"][-1] > 0
        short_signal = series["chandelier_dir"][-2] >= 0 and series["chandelier_dir"][-1] < 0
        return long_signal, short_signal, series["chandelier_line"][-1]

    if mode == "range_filter":
        long_signal = series["range_dir"][-2] <= 0 and series["range_dir"][-1] > 0 and close[-1] > series["range_filter"][-1]
        short_signal = series["range_dir"][-2] >= 0 and series["range_dir"][-1] < 0 and close[-1] < series["range_filter"][-1]
        return long_signal, short_signal, series["range_filter"][-1]

    if mode == "ichimoku":
        long_signal = series["ichimoku_dir"][-2] <= 0 and series["ichimoku_dir"][-1] > 0
        short_signal = series["ichimoku_dir"][-2] >= 0 and series["ichimoku_dir"][-1] < 0
        return long_signal, short_signal, series["kijun"][-1]

    long_signal = series["alpha_dir"][-2] <= 0 and series["alpha_dir"][-1] > 0 and close[-1] > series["alpha"][-1]
    short_signal = series["alpha_dir"][-2] >= 0 and series["alpha_dir"][-1] < 0 and close[-1] < series["alpha"][-1]
    return long_signal, short_signal, series["alpha"][-1]


def _risk_levels(side, entry, risk_line, series, cfg):
    atr = max(0.0, float(series["atr"][-1]))
    min_distance = entry * cfg["min_stop_pct"] / 100.0
    max_distance = entry * cfg["max_stop_pct"] / 100.0
    candidates = []

    try:
        line_distance = entry - float(risk_line) if side == "BUY" else float(risk_line) - entry
        if line_distance > 0:
            candidates.append(line_distance)
    except Exception:
        pass
    if atr > 0:
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


def _full_series(candles, cfg):
    saved = {key: SERIES_CACHE[key] for key in SERIES_CACHE}
    try:
        _reset_series_cache(_series_signature(cfg))
        return _cached_series(candles, cfg)
    finally:
        for key, value in saved.items():
            SERIES_CACHE[key] = value


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if not _ready(candles, cfg):
        return []
    series = _full_series(candles, cfg)
    limit = 500
    line_by_mode = {
        "supertrend": "supertrend",
        "supertrend_macd": "supertrend",
        "hma_supertrend": "supertrend",
        "ut_bot": "ut_stop",
        "pmax": "pmax",
        "ssl_qqe": "ssl_line",
        "halftrend": "half_line",
        "alpha_trend": "alpha",
        "chandelier": "chandelier_line",
        "range_filter": "range_filter",
        "ichimoku": "kijun",
    }
    key = line_by_mode.get(cfg["mode"], "supertrend")
    values = series[key][-limit:]
    start = len(candles) - len(values)
    return [{
        "type": "plot",
        "title": cfg["mode"],
        "points": [{"time": candles[start + i]["t"], "value": value} for i, value in enumerate(values)],
        "color": "#38bdf8",
        "linewidth": 2,
    }]


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR

    cfg = _config(config)
    candles = _candles()
    if not _ready(candles, cfg):
        hold()
        return

    series = _cached_series(candles, cfg)
    long_signal, short_signal, risk_line = _mode_signal(series, cfg)
    idx = len(candles) - 1
    close_price = float(series["close"][-1])
    current_side = getattr(portfolio, "side", None)

    if LAST_SIGNAL_BAR is not None and idx - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    if long_signal and current_side != "BUY" and _passes_filters("BUY", series, cfg):
        sl, tp = _risk_levels("BUY", close_price, risk_line, series, cfg)
        if cfg["use_stop_loss"]:
            set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe(cfg["mode"] + ".long", side="long", rsi=round(series["rsi"][-1], 2))
        buy()
        return

    if short_signal and current_side == "BUY" and not cfg["allow_short"]:
        LAST_SIGNAL_BAR = idx
        _observe(cfg["mode"] + ".close_long", side="long", rsi=round(series["rsi"][-1], 2))
        close()
        return

    if cfg["allow_short"] and short_signal and current_side != "SELL" and _passes_filters("SELL", series, cfg):
        sl, tp = _risk_levels("SELL", close_price, risk_line, series, cfg)
        if cfg["use_stop_loss"]:
            set_sl(price=sl)
        if cfg["use_take_profit"]:
            set_tp(price=tp)
        LAST_SIGNAL_BAR = idx
        _observe(cfg["mode"] + ".short", side="short", rsi=round(series["rsi"][-1], 2))
        sell()
        return

    hold()
