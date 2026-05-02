"""
NexusTrade — Indicator Worker
==============================
server.js tarafindan spawn edilir.
Her indikatör istegini ilgili indicators/*.py dosyasina yonlendirir.

Protokol:
    server.js -> worker: {"cmd": "calculate", "indicator": "rsi", "closes": [...], "params": {...}}
    worker -> server.js: {"result": ...}

    server.js -> worker: {"cmd": "calculate_arr", "indicator": "ema", "closes": [...], "params": {"period": 9}}
    worker -> server.js: {"result": [...]}

    server.js -> worker: {"cmd": "list"}
    worker -> server.js: {"indicators": ["rsi", "ema", "sma", "bb", "macd", "atr"]}
"""

import sys
import os
import json
import importlib.util
import traceback

sys.path.insert(0, os.path.dirname(__file__))

INDICATORS_DIR = os.path.join(os.path.dirname(__file__), 'indicators')
SUPPORTED = ['rsi', 'ema', 'sma', 'bb', 'macd', 'atr']

def load_indicator(name):
    filepath = os.path.join(INDICATORS_DIR, f"{name}.py")
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Indikatör bulunamadi: {filepath}")
    spec   = importlib.util.spec_from_file_location(name, filepath)
    module = importlib.util.module_from_spec(spec)
    # macd ema'ya bagimli — path ekle
    sys.path.insert(0, INDICATORS_DIR)
    spec.loader.exec_module(module)
    return module

def log(msg):
    print(f"[INDICATOR_WORKER] {msg}", file=sys.stderr, flush=True)

def main():
    log("Indicator worker hazir, komut bekleniyor...")

    # Tum indikatörleri onceden yukle
    modules = {}
    for name in SUPPORTED:
        try:
            modules[name] = load_indicator(name)
            log(f"  {name}.py yuklendi")
        except Exception as e:
            log(f"  {name}.py yuklenemedi: {e}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({'error': f'JSON parse hatasi: {e}'}), flush=True)
            continue

        action = cmd.get('cmd')

        try:
            if action == 'list':
                # Mevcut indikatörleri listele
                available = []
                for name in SUPPORTED:
                    fp = os.path.join(INDICATORS_DIR, f"{name}.py")
                    if os.path.exists(fp):
                        available.append(name)
                print(json.dumps({'indicators': available}), flush=True)

            elif action == 'calculate':
                name    = cmd.get('indicator')
                closes  = cmd.get('closes', [])
                candles = cmd.get('candles', [])
                params  = cmd.get('params', {})

                if name not in modules:
                    print(json.dumps({'error': f'Bilinmeyen indikatör: {name}'}), flush=True)
                    continue

                mod = modules[name]
                if name == 'atr':
                    result = mod.calculate(candles, **params)
                else:
                    result = mod.calculate(closes, **params)

                print(json.dumps({'result': result}), flush=True)

            elif action == 'calculate_arr':
                name    = cmd.get('indicator')
                closes  = cmd.get('closes', [])
                candles = cmd.get('candles', [])
                params  = cmd.get('params', {})

                if name not in modules:
                    print(json.dumps({'error': f'Bilinmeyen indikatör: {name}'}), flush=True)
                    continue

                mod = modules[name]
                if hasattr(mod, 'calculate_arr'):
                    if name == 'atr':
                        result = mod.calculate_arr(candles, **params)
                    else:
                        result = mod.calculate_arr(closes, **params)
                else:
                    result = []

                print(json.dumps({'result': result}), flush=True)

            elif action == 'calculate_all':
                # Tum aktif indikatörleri tek seferde hesapla (LWC için)
                closes     = cmd.get('closes', [])
                candles    = cmd.get('candles', [])
                times      = cmd.get('times', [])
                indicators = cmd.get('indicators', {})
                result     = {}

                if indicators.get('ema'):
                    p = indicators['ema'].get('params', {})
                    period9  = p.get('period9', 9)
                    period21 = p.get('period21', 21)
                    e9  = modules['ema'].calculate_arr(closes, period9)
                    e21 = modules['ema'].calculate_arr(closes, period21)
                    result['ema9']  = [{'time': times[i], 'value': v} for i, v in enumerate(e9)  if v is not None]
                    result['ema21'] = [{'time': times[i], 'value': v} for i, v in enumerate(e21) if v is not None]

                if indicators.get('bb'):
                    p   = indicators['bb'].get('params', {})
                    arr = modules['bb'].calculate_arr(closes, p.get('period', 20), p.get('std', 2))
                    result['bb_upper'] = [{'time': times[i], 'value': v['upper']} for i, v in enumerate(arr) if v]
                    result['bb_mid']   = [{'time': times[i], 'value': v['mid']}   for i, v in enumerate(arr) if v]
                    result['bb_lower'] = [{'time': times[i], 'value': v['lower']} for i, v in enumerate(arr) if v]

                if indicators.get('rsi'):
                    p   = indicators['rsi'].get('params', {})
                    arr = modules['rsi'].calculate_arr(closes, p.get('period', 14))
                    result['rsi'] = [{'time': times[i], 'value': v} for i, v in enumerate(arr) if v is not None]

                if indicators.get('macd'):
                    arr = modules['macd'].calculate_arr(closes)
                    result['macd_line']      = [{'time': times[i], 'value': v['line']}      for i, v in enumerate(arr) if v]
                    result['macd_signal']    = [{'time': times[i], 'value': v['signal']}    for i, v in enumerate(arr) if v and v['signal'] is not None]
                    result['macd_histogram'] = [{'time': times[i], 'value': v['histogram']} for i, v in enumerate(arr) if v]

                print(json.dumps({'result': result}), flush=True)

            elif action == 'ping':
                print(json.dumps({'pong': True}), flush=True)

            else:
                print(json.dumps({'error': f'Bilinmeyen komut: {action}'}), flush=True)

        except Exception as e:
            log(f"Hata: {traceback.format_exc()}")
            print(json.dumps({'error': str(e)}), flush=True)

if __name__ == '__main__':
    main()
