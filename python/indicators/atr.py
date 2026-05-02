# name: ATR (Average True Range)
# desc: Volatilite olcumu

def calculate(candles, period=14):
    """
    Son ATR degerini don.
    candles: [{'h':..., 'l':..., 'c':...}, ...]
    """
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
    if len(trs) < period:
        return 0
    return sum(trs[-period:]) / period
