# name: SMA (Simple Moving Average)
# desc: Basit hareketli ortalama

def calculate(closes, period):
    """
    Son SMA degerini don.
    """
    if len(closes) < period:
        return 0
    return sum(closes[-period:]) / period

def calculate_arr(closes, period):
    """
    Tum mumlar icin SMA dizisi.
    """
    result = []
    for i in range(len(closes)):
        if i < period - 1:
            result.append(None)
        else:
            result.append(sum(closes[i-period+1:i+1]) / period)
    return result
