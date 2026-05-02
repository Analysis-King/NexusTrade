# name: RSI (Relative Strength Index)
# desc: Momentum indikatoru, asiri alim/satim tespiti

def calculate(closes, period=14):
    """
    RSI hesapla.
    Donus: float (0-100)
    """
    if len(closes) < period + 1:
        return 50.0
    slice_  = closes[-(period + 1):]
    changes = [slice_[i+1] - slice_[i] for i in range(len(slice_)-1)]
    gains   = [max(0, c) for c in changes]
    losses  = [abs(min(0, c)) for c in changes]
    avg_g   = sum(gains) / period
    avg_l   = sum(losses) / period
    if avg_l == 0:
        return 100.0
    return round(100 - 100 / (1 + avg_g / avg_l), 2)

def calculate_arr(closes, period=14):
    """
    Tum mumlar icin RSI dizisi hesapla.
    Donus: [None, None, ..., 45.2, 52.1, ...]
    """
    result = []
    for i in range(len(closes)):
        if i < period:
            result.append(None)
        else:
            result.append(calculate(closes[:i+1], period))
    return result
