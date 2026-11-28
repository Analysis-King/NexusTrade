# Test stratejisi: kararini sadece mum penceresinden ve portfoy durumundan verir (ic durum yok).
# Son `lookback` mumun en yuksegi/en dusugu kirilinca giris; hedef kapanistan %target_pct uzakta.
# signal_key ile ayni gun ayni yonde tek islem (portfoyun tekrar sinyali kuralini calistirir).


def initialize():
    return {'lookback': 20, 'target_pct': 3.0}


def on_candle(candle, portfolio, config):
    candles = indicators.candles()
    lookback = int(config.get('lookback', 20))
    if len(candles) <= lookback or portfolio.has_position:
        hold()
        return
    previous = candles[-lookback - 1:-1]
    high_bar = max(previous, key=lambda c: c['h'])
    low_bar = min(previous, key=lambda c: c['l'])
    target = float(config.get('target_pct', 3.0)) / 100.0
    close = candle.close
    if close > high_bar['h']:
        set_tp(price=close * (1 + target))
        set_meta(quality=round((close - high_bar['h']) / high_bar['h'] * 100, 6), signal_key=f"up-{candle.time // 86_400_000}")
        buy()
    elif close < low_bar['l']:
        set_tp(price=close * (1 - target))
        set_meta(quality=round((low_bar['l'] - close) / low_bar['l'] * 100, 6), signal_key=f"down-{candle.time // 86_400_000}")
        sell()
    else:
        hold()
