# name: EMA (Exponential Moving Average)
# desc: Ustel hareketli ortalama

def calculate_arr(closes, period):
    """
    Tum mumlar icin EMA dizisi.
    Donus: [None, None, ..., 42100.5, 42150.2, ...]
    """
    k      = 2 / (period + 1)
    result = []
    ema    = None
    for i, v in enumerate(closes):
        if i < period - 1:
            result.append(None)
            continue
        if ema is None:
            ema = sum(closes[:period]) / period
        else:
            ema = v * k + ema * (1 - k)
        result.append(ema)
    return result

def calculate(closes, period):
    """
    Son EMA degerini don.
    """
    arr = calculate_arr(closes, period)
    return next((v for v in reversed(arr) if v is not None), 0)
