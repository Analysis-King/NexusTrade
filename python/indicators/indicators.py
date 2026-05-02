"""
NexusTrade — Teknik Indikatörler
=================================
Tüm strateji dosyaları bu modülü import edebilir.

Kullanim:
    from indicators.indicators import calc_rsi, calc_ema, calc_bb, calc_macd, calc_atr
"""

import math


def calc_sma(data, period):
    if len(data) < period:
        return 0
    return sum(data[-period:]) / period


def calc_ema_arr(data, period):
    k      = 2 / (period + 1)
    result = []
    ema    = None
    for i, v in enumerate(data):
        if i < period - 1:
            result.append(None)
            continue
        if ema is None:
            ema = sum(data[:period]) / period
        else:
            ema = v * k + ema * (1 - k)
        result.append(ema)
    return result


def calc_ema(data, period):
    arr = calc_ema_arr(data, period)
    return next((v for v in reversed(arr) if v is not None), 0)


def calc_rsi(data, period=14):
    if len(data) < period + 1:
        return 50
    slice_   = data[-(period + 1):]
    changes  = [slice_[i+1] - slice_[i] for i in range(len(slice_)-1)]
    gains    = [max(0, c) for c in changes]
    losses   = [abs(min(0, c)) for c in changes]
    avg_g    = sum(gains) / period
    avg_l    = sum(losses) / period
    if avg_l == 0:
        return 100
    return round(100 - 100 / (1 + avg_g / avg_l), 2)


def calc_rsi_arr(data, period=14):
    result = []
    for i in range(len(data)):
        if i < period:
            result.append(None)
            continue
        result.append(calc_rsi(data[:i+1], period))
    return result


def calc_bb(data, period=20, std=2):
    if len(data) < period:
        return None
    slice_ = data[-period:]
    mean   = sum(slice_) / period
    sd     = math.sqrt(sum((v - mean)**2 for v in slice_) / period) * std
    return {'upper': mean + sd, 'mid': mean, 'lower': mean - sd}


def calc_bb_arr(data, period=20, std=2):
    result = []
    for i in range(len(data)):
        if i < period - 1:
            result.append(None)
            continue
        result.append(calc_bb(data[:i+1], period, std))
    return result


def calc_macd(data, fast=12, slow=26, signal=9):
    ema_fast  = calc_ema_arr(data, fast)
    ema_slow  = calc_ema_arr(data, slow)
    macd_line = [f - s if f is not None and s is not None else None
                 for f, s in zip(ema_fast, ema_slow)]
    valid     = [v for v in macd_line if v is not None]
    sig_arr   = calc_ema_arr(valid, signal)
    last_m    = valid[-1] if valid else 0
    last_s    = next((v for v in reversed(sig_arr) if v is not None), 0)
    return {'line': last_m, 'signal': last_s, 'histogram': last_m - last_s}


def calc_atr(candles, period=14):
    trs = []
    for i, c in enumerate(candles):
        if i == 0:
            trs.append(c['h'] - c['l'])
        else:
            prev = candles[i-1]
            trs.append(max(
                c['h'] - c['l'],
                abs(c['h'] - prev['c']),
                abs(c['l'] - prev['c'])
            ))
    return calc_sma(trs, period)
