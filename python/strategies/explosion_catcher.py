# name: Explosion Catcher
# desc: Gun ici dipten sonra +5 hareketlerin erken +1/+2 safhasini RSI, Stoch, MACD, ROC, ADX, volatilite ve hacim skoruyla yakalamayi dener
# author: NexusTrade
# version: 1.0

import builtins as _builtins
import math


LAST_SIGNAL_BAR = None
LAST_ENTRY_BAR = None


def initialize():
    return {
        "lookback_bars": 360,
        "cooldown_bars": 12,
        "min_score": 15,
        "min_day_gain_pct": 2.0,
        "max_day_gain_pct": 2.4,
        "h1_rsi_min": 24.0,
        "h1_rsi_max": 58.0,
        "h1_stoch_max": 70.0,
        "h1_min_adx": 18.0,
        "h1_atr_expansion": 1.10,
        "h1_bb_expansion": 1.08,
        "m15_min_adx": 20.0,
        "m15_rsi_min": 42.0,
        "m15_rsi_max": 72.0,
        "m15_max_stoch": 88.0,
        "m15_atr_expansion": 1.05,
        "min_volume_ratio": 0.75,
        "stop_loss_pct": 1.0,
        "max_stop_pct": 1.5,
        "reward_risk": 2.2,
        "max_hold_bars": 48,
        "min_hold_bars": 4,
        "exit_on_momentum_loss": False,
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
    cfg["lookback_bars"] = max(180, _to_int(cfg.get("lookback_bars"), 360))
    cfg["cooldown_bars"] = max(0, _to_int(cfg.get("cooldown_bars"), 8))
    cfg["min_score"] = max(1, _to_int(cfg.get("min_score"), 11))
    cfg["min_day_gain_pct"] = max(0.0, _to_float(cfg.get("min_day_gain_pct"), 0.8))
    cfg["max_day_gain_pct"] = max(cfg["min_day_gain_pct"], _to_float(cfg.get("max_day_gain_pct"), 3.4))
    cfg["h1_rsi_min"] = _to_float(cfg.get("h1_rsi_min"), 24.0)
    cfg["h1_rsi_max"] = _to_float(cfg.get("h1_rsi_max"), 58.0)
    cfg["h1_stoch_max"] = _to_float(cfg.get("h1_stoch_max"), 70.0)
    cfg["h1_min_adx"] = _to_float(cfg.get("h1_min_adx"), 18.0)
    cfg["h1_atr_expansion"] = max(0.2, _to_float(cfg.get("h1_atr_expansion"), 1.10))
    cfg["h1_bb_expansion"] = max(0.2, _to_float(cfg.get("h1_bb_expansion"), 1.08))
    cfg["m15_min_adx"] = _to_float(cfg.get("m15_min_adx"), 20.0)
    cfg["m15_rsi_min"] = _to_float(cfg.get("m15_rsi_min"), 42.0)
    cfg["m15_rsi_max"] = _to_float(cfg.get("m15_rsi_max"), 72.0)
    cfg["m15_max_stoch"] = _to_float(cfg.get("m15_max_stoch"), 88.0)
    cfg["m15_atr_expansion"] = max(0.2, _to_float(cfg.get("m15_atr_expansion"), 1.05))
    cfg["min_volume_ratio"] = max(0.0, _to_float(cfg.get("min_volume_ratio"), 0.75))
    cfg["stop_loss_pct"] = max(0.1, _to_float(cfg.get("stop_loss_pct"), 1.15))
    cfg["max_stop_pct"] = max(cfg["stop_loss_pct"], _to_float(cfg.get("max_stop_pct"), 1.8))
    cfg["reward_risk"] = max(0.3, _to_float(cfg.get("reward_risk"), 2.0))
    cfg["max_hold_bars"] = max(1, _to_int(cfg.get("max_hold_bars"), 42))
    cfg["min_hold_bars"] = max(0, _to_int(cfg.get("min_hold_bars"), 4))
    cfg["exit_on_momentum_loss"] = _to_bool(cfg.get("exit_on_momentum_loss"), True)
    return cfg


def _candles():
    try:
        return indicators.candles()
    except Exception:
        return []


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
        out.append(total / min(i + 1, period))
    return out


def _std(values, period):
    out = []
    for i in range(len(values)):
        window = values[max(0, i - period + 1):i + 1]
        if len(window) < 2:
            out.append(0.0)
            continue
        mean = sum(window) / len(window)
        out.append(math.sqrt(sum((value - mean) ** 2 for value in window) / len(window)))
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


def _rsi(closes, period=14):
    out = []
    avg_gain = None
    avg_loss = None
    prev = None
    for i, value in enumerate(closes):
        if prev is None:
            out.append(50.0)
            prev = value
            continue
        change = value - prev
        prev = value
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        if avg_gain is None:
            avg_gain = gain
            avg_loss = loss
        elif i <= period:
            avg_gain = (avg_gain * (i - 1) + gain) / i
            avg_loss = (avg_loss * (i - 1) + loss) / i
        else:
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0:
            out.append(100.0 if avg_gain > 0 else 50.0)
        else:
            rs = avg_gain / avg_loss
            out.append(100.0 - 100.0 / (1.0 + rs))
    return out


def _true_range(candles):
    out = []
    prev_close = None
    for candle in candles:
        high = float(candle["h"])
        low = float(candle["l"])
        if prev_close is None:
            value = high - low
        else:
            value = max(high - low, abs(high - prev_close), abs(low - prev_close))
        out.append(value)
        prev_close = float(candle["c"])
    return out


def _macd(closes):
    fast = _ema(closes, 12)
    slow = _ema(closes, 26)
    line = [a - b for a, b in zip(fast, slow)]
    signal = _ema(line, 9)
    hist = [a - b for a, b in zip(line, signal)]
    return line, signal, hist


def _stoch(candles, period=14):
    raw = []
    for i, candle in enumerate(candles):
        window = candles[max(0, i - period + 1):i + 1]
        low = min(float(row["l"]) for row in window)
        high = max(float(row["h"]) for row in window)
        raw.append(50.0 if high == low else (float(candle["c"]) - low) / (high - low) * 100.0)
    k = _sma(raw, 3)
    d = _sma(k, 3)
    return k, d


def _adx(candles, period=14):
    plus_dm = []
    minus_dm = []
    tr = _true_range(candles)
    for i, candle in enumerate(candles):
        if i == 0:
            plus_dm.append(0.0)
            minus_dm.append(0.0)
            continue
        up = float(candle["h"]) - float(candles[i - 1]["h"])
        down = float(candles[i - 1]["l"]) - float(candle["l"])
        plus_dm.append(up if up > down and up > 0 else 0.0)
        minus_dm.append(down if down > up and down > 0 else 0.0)
    atr = _rma(tr, period)
    plus_rma = _rma(plus_dm, period)
    minus_rma = _rma(minus_dm, period)
    plus_di = []
    minus_di = []
    dx = []
    for atr_value, plus_value, minus_value in zip(atr, plus_rma, minus_rma):
        pdi = 0.0 if atr_value == 0 else 100.0 * plus_value / atr_value
        mdi = 0.0 if atr_value == 0 else 100.0 * minus_value / atr_value
        plus_di.append(pdi)
        minus_di.append(mdi)
        dx.append(0.0 if pdi + mdi == 0 else 100.0 * abs(pdi - mdi) / (pdi + mdi))
    return _rma(dx, period), plus_di, minus_di


def _mfi(candles, period=14):
    typical = [(float(c["h"]) + float(c["l"]) + float(c["c"])) / 3.0 for c in candles]
    pos = []
    neg = []
    for i, candle in enumerate(candles):
        raw = typical[i] * float(candle["v"])
        if i == 0:
            pos.append(0.0)
            neg.append(0.0)
        elif typical[i] > typical[i - 1]:
            pos.append(raw)
            neg.append(0.0)
        elif typical[i] < typical[i - 1]:
            pos.append(0.0)
            neg.append(raw)
        else:
            pos.append(0.0)
            neg.append(0.0)
    out = []
    for i in range(len(candles)):
        ps = sum(pos[max(0, i - period + 1):i + 1])
        ns = sum(neg[max(0, i - period + 1):i + 1])
        out.append(100.0 if ns == 0 and ps > 0 else 50.0 if ns == 0 else 100.0 - 100.0 / (1.0 + ps / ns))
    return out


def _cmf_adl(candles, period=20):
    mfv = []
    adl = []
    total = 0.0
    for candle in candles:
        high = float(candle["h"])
        low = float(candle["l"])
        close_price = float(candle["c"])
        volume = float(candle["v"])
        den = high - low
        mfm = 0.0 if den == 0 else ((close_price - low) - (high - close_price)) / den
        value = mfm * volume
        mfv.append(value)
        total += value
        adl.append(total)
    cmf = []
    for i in range(len(candles)):
        mfv_sum = sum(mfv[max(0, i - period + 1):i + 1])
        vol_sum = sum(float(row["v"]) for row in candles[max(0, i - period + 1):i + 1])
        cmf.append(0.0 if vol_sum == 0 else mfv_sum / vol_sum)
    return cmf, adl


def _vwap_daily(candles):
    out = []
    current_day = None
    pv = 0.0
    volume_sum = 0.0
    for candle in candles:
        day = _local_day(int(candle["t"]))
        if day != current_day:
            current_day = day
            pv = 0.0
            volume_sum = 0.0
        typical = (float(candle["h"]) + float(candle["l"]) + float(candle["c"])) / 3.0
        volume = float(candle["v"])
        pv += typical * volume
        volume_sum += volume
        out.append(typical if volume_sum == 0 else pv / volume_sum)
    return out


def _local_day(timestamp):
    return int((int(timestamp) + 3 * 60 * 60 * 1000) // 86400000)


def _rising(values, index, bars):
    return index - bars >= 0 and values[index] > values[index - bars]


def _cross_up(a, b, index, lookback=4):
    start = max(1, index - lookback + 1)
    for i in range(start, index + 1):
        if a[i - 1] <= b[i - 1] and a[i] > b[i]:
            return True
    return False


def _median(values):
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _aggregate_1h(candles):
    buckets = {}
    order = []
    for candle in candles:
        start = int(candle["t"]) // 3600000 * 3600000
        if start not in buckets:
            buckets[start] = {
                "t": start,
                "o": float(candle["o"]),
                "h": float(candle["h"]),
                "l": float(candle["l"]),
                "c": float(candle["c"]),
                "v": float(candle["v"]),
                "count": 1,
            }
            order.append(start)
        else:
            row = buckets[start]
            row["h"] = max(row["h"], float(candle["h"]))
            row["l"] = min(row["l"], float(candle["l"]))
            row["c"] = float(candle["c"])
            row["v"] += float(candle["v"])
            row["count"] += 1
    completed = []
    for start in order:
        row = buckets[start]
        if row["count"] >= 4:
            completed.append({key: row[key] for key in ("t", "o", "h", "l", "c", "v")})
    return completed


def _features(candles):
    closes = [float(c["c"]) for c in candles]
    volumes = [float(c["v"]) for c in candles]
    ema21 = _ema(closes, 21)
    ema50 = _ema(closes, 50)
    rsi = _rsi(closes)
    macd_line, macd_signal, macd_hist = _macd(closes)
    stoch_k, stoch_d = _stoch(candles)
    atr = _rma(_true_range(candles), 14)
    adx, plus_di, minus_di = _adx(candles)
    mfi = _mfi(candles)
    cmf, adl = _cmf_adl(candles)
    vwap = _vwap_daily(candles)
    vol_sma = _sma(volumes, 20)
    bb_mid = _sma(closes, 20)
    bb_std = _std(closes, 20)

    out = []
    for i, candle in enumerate(candles):
        close_price = closes[i]
        prev4 = closes[i - 4] if i >= 4 else closes[0]
        roc4 = 0.0 if prev4 == 0 else (close_price - prev4) / prev4 * 100.0
        upper = bb_mid[i] + 2.0 * bb_std[i]
        lower = bb_mid[i] - 2.0 * bb_std[i]
        width = 0.0 if bb_mid[i] == 0 else (upper - lower) / bb_mid[i] * 100.0
        pos = 0.5 if upper == lower else (close_price - lower) / (upper - lower)
        out.append({
            "t": int(candle["t"]),
            "close": close_price,
            "low": float(candle["l"]),
            "rsi": rsi[i],
            "rsi_rising": _rising(rsi, i, 4),
            "macd_hist": macd_hist[i],
            "macd_rising": _rising(macd_hist, i, 3),
            "macd_cross_up": _cross_up(macd_line, macd_signal, i, 4),
            "stoch_k": stoch_k[i],
            "stoch_d": stoch_d[i],
            "stoch_k_gt_d": stoch_k[i] > stoch_d[i],
            "stoch_rising": _rising(stoch_k, i, 3),
            "stoch_cross_up": _cross_up(stoch_k, stoch_d, i, 4),
            "roc4": roc4,
            "roc4_pos": roc4 > 0,
            "adx": adx[i],
            "plus_di_gt_minus": plus_di[i] > minus_di[i],
            "close_gt_ema21": close_price > ema21[i],
            "close_gt_ema50": close_price > ema50[i],
            "ema21": ema21[i],
            "atr_pct": 0.0 if close_price == 0 else atr[i] / close_price * 100.0,
            "bb_pos": pos,
            "bb_width": width,
            "vol_ratio": 1.0 if vol_sma[i] == 0 else volumes[i] / vol_sma[i],
            "mfi": mfi[i],
            "mfi_rising": _rising(mfi, i, 4),
            "cmf": cmf[i],
            "cmf_rising": _rising(cmf, i, 4),
            "adl_rising": _rising(adl, i, 5),
            "close_gt_vwap": close_price > vwap[i],
        })
    return out


def _day_gain(candles, close_price):
    if not candles:
        return 0.0, close_price
    day = _local_day(int(candles[-1]["t"]))
    lows = [float(c["l"]) for c in candles if _local_day(int(c["t"])) == day]
    day_low = min(lows) if lows else close_price
    return (close_price - day_low) / day_low * 100.0 if day_low else 0.0, day_low


def _score(m15, h1, m15_hist, h1_hist, cfg):
    score = 0
    reasons = []
    h1_atr_base = _median([row["atr_pct"] for row in h1_hist[-80:]])
    h1_bb_base = _median([row["bb_width"] for row in h1_hist[-80:]])
    m15_atr_base = _median([row["atr_pct"] for row in m15_hist[-120:]])

    def add(condition, reason, weight=1):
        nonlocal score
        if condition:
            score += weight
            reasons.append(reason)

    add(cfg["h1_rsi_min"] <= h1["rsi"] <= cfg["h1_rsi_max"], "1h_rsi_recovery")
    add(h1["stoch_k"] <= cfg["h1_stoch_max"], "1h_stoch_low_mid")
    add(h1["stoch_k_gt_d"] or h1["stoch_rising"], "1h_stoch_turn")
    add(h1["atr_pct"] >= h1_atr_base * cfg["h1_atr_expansion"], "1h_atr_expansion")
    add(h1["bb_width"] >= h1_bb_base * cfg["h1_bb_expansion"], "1h_bb_expansion")
    add(h1["adx"] >= cfg["h1_min_adx"], "1h_adx")
    add(h1["cmf_rising"] or h1["close_gt_vwap"], "1h_flow")

    add(m15["stoch_k_gt_d"], "15m_stoch_k_gt_d")
    add(m15["stoch_cross_up"], "15m_stoch_cross", 2)
    add(m15["stoch_rising"], "15m_stoch_rising")
    add(m15["stoch_k"] <= cfg["m15_max_stoch"], "15m_not_overheated")
    add(cfg["m15_rsi_min"] <= m15["rsi"] <= cfg["m15_rsi_max"], "15m_rsi_zone")
    add(m15["rsi_rising"], "15m_rsi_rising")
    add(m15["macd_rising"], "15m_macd_rising")
    add(m15["macd_cross_up"], "15m_macd_cross")
    add(m15["roc4_pos"], "15m_roc_positive")
    add(m15["adx"] >= cfg["m15_min_adx"], "15m_adx")
    add(m15["plus_di_gt_minus"], "15m_plus_di")
    add(m15["close_gt_ema21"], "15m_ema21_reclaim")
    add(m15["atr_pct"] >= m15_atr_base * cfg["m15_atr_expansion"], "15m_atr_expansion")
    add(m15["vol_ratio"] >= cfg["min_volume_ratio"], "15m_volume_ok")
    add(m15["mfi_rising"], "15m_mfi_rising")
    add(m15["cmf_rising"] or m15["adl_rising"], "15m_flow_rising")
    return score, reasons


def _risk(entry, m15, candles, cfg):
    atr_pct = max(0.0, float(m15["atr_pct"]))
    atr_stop = min(cfg["max_stop_pct"], max(cfg["stop_loss_pct"], atr_pct * 1.8))
    recent = candles[-12:]
    swing_low = min(float(c["l"]) for c in recent) if recent else entry * (1.0 - atr_stop / 100.0)
    swing_pct = max(0.0, (entry - swing_low) / entry * 100.0)
    distance_pct = min(cfg["max_stop_pct"], max(cfg["stop_loss_pct"], min(atr_stop, swing_pct or atr_stop)))
    sl = entry * (1.0 - distance_pct / 100.0)
    tp = entry * (1.0 + distance_pct * cfg["reward_risk"] / 100.0)
    return sl, tp, distance_pct


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def on_candle(candle, portfolio, config):
    global LAST_SIGNAL_BAR, LAST_ENTRY_BAR

    cfg = _config(config)
    all_candles = _candles()
    if len(all_candles) < 220:
        hold()
        return

    idx = len(all_candles) - 1
    current_side = getattr(portfolio, "side", None)
    has_position = bool(getattr(portfolio, "has_position", False))
    if not has_position:
        LAST_ENTRY_BAR = None

    recent = all_candles[-cfg["lookback_bars"]:]
    h1_candles = _aggregate_1h(recent)
    if len(h1_candles) < 80:
        hold()
        return

    m15_features = _features(recent)
    h1_features = _features(h1_candles)
    m15 = m15_features[-1]
    h1 = h1_features[-1]
    close_price = float(candle.close)
    day_gain, day_low = _day_gain(recent, close_price)

    if has_position and current_side == "BUY":
        bars_held = idx - LAST_ENTRY_BAR if LAST_ENTRY_BAR is not None else 0
        stale = bars_held >= cfg["max_hold_bars"]
        loss = (
            cfg["exit_on_momentum_loss"] and
            bars_held >= cfg["min_hold_bars"] and
            m15["stoch_k"] < m15["stoch_d"] and
            not m15["macd_rising"] and
            close_price < m15["ema21"]
        )
        if stale or loss:
            LAST_SIGNAL_BAR = idx
            _observe("explosion.exit", side="long", reason="stale" if stale else "momentum_loss")
            close()
            return
        hold()
        return

    if LAST_SIGNAL_BAR is not None and idx - LAST_SIGNAL_BAR < cfg["cooldown_bars"]:
        hold()
        return

    if day_gain < cfg["min_day_gain_pct"] or day_gain > cfg["max_day_gain_pct"]:
        hold()
        return

    score, reasons = _score(m15, h1, m15_features, h1_features, cfg)
    if score < cfg["min_score"]:
        hold()
        return

    sl, tp, risk_pct = _risk(close_price, m15, recent, cfg)
    set_sl(price=sl)
    set_tp(price=tp)
    LAST_SIGNAL_BAR = idx
    LAST_ENTRY_BAR = idx
    _observe(
        "explosion.entry",
        side="long",
        score=score,
        day_gain=round(day_gain, 3),
        day_low=round(day_low, 8),
        risk_pct=round(risk_pct, 3),
        reasons=",".join(reasons[:12]),
    )
    buy()


def draw(candles, indicators, patterns, config=None):
    cfg = _config(config)
    if len(candles) < 220:
        return []
    recent = candles[-cfg["lookback_bars"]:]
    features = _features(recent)
    points = [{"time": row["t"], "value": row["ema21"]} for row in features[-300:]]
    return [{
        "type": "plot",
        "title": "Explosion EMA21",
        "points": points,
        "color": "#38bdf8",
        "linewidth": 2,
    }]
