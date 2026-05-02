# name: MACD (Moving Average Convergence Divergence)
# desc: Trend ve momentum indikatoru

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from indicators.ema import calculate_arr as ema_arr

def calculate(closes, fast=12, slow=26, signal=9):
    ema_fast  = ema_arr(closes, fast)
    ema_slow  = ema_arr(closes, slow)
    macd_line = [f - s if f is not None and s is not None else None
                 for f, s in zip(ema_fast, ema_slow)]
    valid     = [v for v in macd_line if v is not None]
    sig_arr   = ema_arr(valid, signal)
    last_m    = valid[-1] if valid else 0
    last_s    = next((v for v in reversed(sig_arr) if v is not None), 0)
    return {'line': last_m, 'signal': last_s, 'histogram': last_m - last_s}

def calculate_arr(closes, fast=12, slow=26, signal=9):
    ema_fast  = ema_arr(closes, fast)
    ema_slow  = ema_arr(closes, slow)
    macd_line = [f - s if f is not None and s is not None else None
                 for f, s in zip(ema_fast, ema_slow)]
    valid     = [v for v in macd_line if v is not None]
    sig_arr   = ema_arr(valid, signal)
    result = []
    sig_i  = 0
    for v in macd_line:
        if v is None:
            result.append(None)
        else:
            s = sig_arr[sig_i] if sig_i < len(sig_arr) else None
            result.append({'line': v, 'signal': s, 'histogram': v - s if s else v})
            sig_i += 1
    return result
