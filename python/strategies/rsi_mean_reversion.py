# name: RSI Mean Reversion
# desc: RSI asiri alim/satim bolgesinde ters islem
# author: NexusTrade

def initialize():
    config = {
        'rsi_period':  14,
        'oversold':    30,
        'overbought':  70,
    }
    return config


def draw(candles, indicators, patterns):
    """
    RSI degerlerini grafik alt panelinde goster.
    Al/sat sinyallerini grafik uzerine isaretle.
    """
    rsi_values = indicators['rsiArr']
    signals    = []

    for i, c in enumerate(candles):
        rsi = rsi_values[i] if i < len(rsi_values) else None
        if rsi is None:
            continue
        if rsi < 30:
            signals.append({'t': c['t'], 'price': c['l'], 'side': 'buy',  'label': f'RSI {rsi:.0f}'})
        elif rsi > 70:
            signals.append({'t': c['t'], 'price': c['h'], 'side': 'sell', 'label': f'RSI {rsi:.0f}'})

    return [
        {
            'type':  'signals',
            'signals': signals[-20:],  # Son 20 sinyal
        }
    ]


def on_candle(candle, portfolio, config):
    rsi = indicators.rsi(config['rsi_period'])

    if rsi < config['oversold'] and not portfolio.has_position:
        buy()
        set_sl(pct=2.0)
        set_tp(pct=4.0)
    elif rsi > config['overbought'] and portfolio.has_position:
        sell()
    else:
        hold()
