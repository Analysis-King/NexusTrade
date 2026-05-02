# name: Bollinger Bands
# desc: Volatilite bantlari

import math

def calculate(closes, period=20, std=2):
    """
    Son BB degerlerini don.
    Donus: {'upper': float, 'mid': float, 'lower': float}
    """
    if len(closes) < period:
        return None
    slice_ = closes[-period:]
    mean   = sum(slice_) / period
    sd     = math.sqrt(sum((v - mean)**2 for v in slice_) / period) * std
    return {'upper': mean + sd, 'mid': mean, 'lower': mean - sd}

def calculate_arr(closes, period=20, std=2):
    """
    Tum mumlar icin BB dizisi.
    Donus: [None, ..., {'upper':..., 'mid':..., 'lower':...}, ...]
    """
    result = []
    for i in range(len(closes)):
        if i < period - 1:
            result.append(None)
        else:
            result.append(calculate(closes[:i+1], period, std))
    return result
