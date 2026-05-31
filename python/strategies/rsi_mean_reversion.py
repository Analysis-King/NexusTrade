# name: RSI Mean Reversion
# desc: RSI asiri alim/satim bolgesinde ters islem
# author: NexusTrade

import builtins as _builtins


def _observe(name, side=None, **meta):
    fn = getattr(_builtins, "observe", None)
    if callable(fn):
        fn(name, side=side, **meta)


def initialize():
    config = {
        'rsi_period':  14,
        'oversold':    30,
        'overbought':  70,
        'allow_short': True,
        'exit_on_midline': True,
        'stop_loss_pct': 2.0,
        'take_profit_pct': 4.0,
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
    allow_short = bool(config.get('allow_short', True))
    exit_on_midline = bool(config.get('exit_on_midline', True))
    current_side = getattr(portfolio, 'side', None)

    if rsi < config['oversold']:
        _observe('rsi.oversold', side='long', rsi=round(rsi, 4))
    if rsi > config['overbought']:
        _observe('rsi.overbought', side='short', rsi=round(rsi, 4))

    set_sl(pct=config.get('stop_loss_pct', 2.0))
    set_tp(pct=config.get('take_profit_pct', 4.0))

    if rsi < config['oversold'] and current_side != 'BUY':
        buy()
    elif allow_short and rsi > config['overbought'] and current_side != 'SELL':
        sell()
    elif exit_on_midline and current_side == 'BUY' and rsi >= 50:
        close()
    elif exit_on_midline and current_side == 'SELL' and rsi <= 50:
        close()
    else:
        hold()
