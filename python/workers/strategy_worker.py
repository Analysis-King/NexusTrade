"""
NexusTrade Python Strateji Worker
==================================
server.js tarafindan spawn edilir.
stdin'den JSON komutlari alir, stdout'a JSON cevap yazar.

Protokol:
    server.js -> worker: {"cmd": "init", "strategy_file": "...", "config": {...}}
    worker -> server.js: {"ok": true, "config": {...}}

    server.js -> worker: {"cmd": "tick", "candle": {...}, "candles": [...], "portfolio": {...}, "indicators": {...}}
    worker -> server.js: {"signal": "buy"|"sell"|"hold", "sl_pct": 2.0, "tp_pct": 4.0, "drawings": [...]}

    server.js -> worker: {"cmd": "backtest", "candles": [...], "params": {...}}
    worker -> server.js: {"stats": {...}}
"""

import sys
import os
import json
import importlib.util
import traceback

# ── Indikatörler — indicators/indicators.py'den import ──────
import sys as _sys
import os as _os
_sys.path.insert(0, _os.path.dirname(__file__))
from indicators.indicators import (
    calc_sma, calc_ema_arr, calc_ema,
    calc_rsi, calc_rsi_arr, calc_bb, calc_bb_arr,
    calc_macd, calc_atr,
)


# ── Worker sinifi ────────────────────────────────────────────
class StrategyWorker:
    def __init__(self):
        self.module      = None
        self.config      = {}
        self.strategy_file = None

    def load_strategy(self, strategy_file):
        """Strateji dosyasini yukle."""
        strat_dir = os.path.join(os.path.dirname(__file__), 'strategies')
        filepath  = os.path.join(strat_dir, strategy_file)

        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Strateji dosyasi bulunamadi: {filepath}")

        spec   = importlib.util.spec_from_file_location("strategy", filepath)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.module = module
        self.strategy_file = strategy_file

        # initialize() varsa cagir
        if hasattr(module, 'initialize'):
            self.config = module.initialize() or {}
        else:
            self.config = {}

        return self.config

    def tick(self, candle, candles, portfolio_data, indicators_data):
        """
        on_candle() fonksiyonunu cagir, sinyali don.
        """
        if not self.module or not hasattr(self.module, 'on_candle'):
            return {'signal': 'hold', 'sl_pct': None, 'tp_pct': None, 'drawings': []}

        closes = [c['c'] for c in candles]

        # Indikatör nesnesi olustur
        class Indicators:
            def rsi(self, period=14):
                return calc_rsi(closes, period)
            def ema(self, period=20):
                return calc_ema(closes, period)
            def sma(self, period=20):
                return calc_sma(closes, period)
            def bb(self, period=20, std=2):
                return calc_bb(closes, period, std)
            def macd(self, fast=12, slow=26, signal=9):
                return calc_macd(closes, fast, slow, signal)
            def atr(self, period=14):
                return calc_atr(candles, period)

        class Portfolio:
            def __init__(self, data):
                self.usdt         = data.get('usdt', 1000)
                self.has_position = data.get('has_position', False)
                self.pnl          = data.get('pnl', 0)

        class Candle:
            def __init__(self, data):
                self.open   = data['o']
                self.high   = data['h']
                self.low    = data['l']
                self.close  = data['c']
                self.volume = data['v']
                self.time   = data['t']

        # Sinyal yakalayici
        result = {'signal': 'hold', 'sl_pct': None, 'tp_pct': None}

        def buy():
            result['signal'] = 'buy'

        def sell():
            result['signal'] = 'sell'

        def close():
            result['signal'] = 'close'

        def hold():
            result['signal'] = 'hold'

        def set_sl(pct=None, price=None):
            if pct is not None:
                result['sl_pct'] = pct

        def set_tp(pct=None, price=None):
            if pct is not None:
                result['tp_pct'] = pct

        # Global namespace'e inject et
        import builtins
        _orig = {}
        for name, fn in [('buy', buy), ('sell', sell), ('close', close), ('hold', hold),
                          ('set_sl', set_sl), ('set_tp', set_tp)]:
            _orig[name] = getattr(builtins, name, None)
            setattr(builtins, name, fn)

        _orig_ind  = getattr(builtins, 'indicators', None)
        _orig_port = getattr(builtins, 'portfolio',  None)
        builtins.indicators = Indicators()
        builtins.portfolio  = Portfolio(portfolio_data)

        try:
            self.module.on_candle(
                Candle(candle),
                Portfolio(portfolio_data),
                self.config
            )
        except Exception as e:
            result['error'] = str(e)
        finally:
            # Cleanup
            for name, fn in _orig.items():
                if fn is None:
                    try: delattr(builtins, name)
                    except: pass
                else:
                    setattr(builtins, name, fn)
            if _orig_ind is None:
                try: delattr(builtins, 'indicators')
                except: pass
            else:
                builtins.indicators = _orig_ind
            if _orig_port is None:
                try: delattr(builtins, 'portfolio')
                except: pass
            else:
                builtins.portfolio = _orig_port

        # draw() varsa cagir
        drawings = []
        if hasattr(self.module, 'draw'):
            try:
                ind_data = {
                    'rsiArr':  calc_rsi_arr(closes),
                    'emaArr9': calc_ema_arr(closes, 9),
                    'emaArr21': calc_ema_arr(closes, 21),
                }
                draw_result = self.module.draw(candles, ind_data, [])
                if draw_result:
                    drawings = draw_result if isinstance(draw_result, list) else [draw_result]
            except Exception:
                pass

        return {
            'signal':   result['signal'],
            'sl_pct':   result.get('sl_pct'),
            'tp_pct':   result.get('tp_pct'),
            'drawings': drawings,
        }

    def backtest(self, candles, params=None):
        """Legacy worker artik stratejiye ozel backtest metodu cagirmiyor."""
        return {
            'error': 'Universal backtest icin pool_worker kullanilmali.',
            'candles': len(candles or []),
        }


# ── Ana dongu ────────────────────────────────────────────────
def main():
    worker = StrategyWorker()

    # stderr'e log yaz (stdout JSON icin rezerve)
    def log(msg):
        print(f"[WORKER] {msg}", file=sys.stderr, flush=True)

    log("Python worker hazir, komut bekleniyor...")

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
            if action == 'init':
                config = worker.load_strategy(cmd['strategy_file'])
                log(f"Strateji yuklendi: {cmd['strategy_file']}")
                print(json.dumps({'ok': True, 'config': config}), flush=True)

            elif action == 'tick':
                result = worker.tick(
                    cmd['candle'],
                    cmd['candles'],
                    cmd.get('portfolio', {}),
                    cmd.get('indicators', {}),
                )
                print(json.dumps(result), flush=True)

            elif action == 'backtest':
                stats = worker.backtest(
                    cmd['candles'],
                    cmd.get('params', {}),
                )
                print(json.dumps({'stats': stats}), flush=True)

            elif action == 'indicators':
                c       = cmd.get('candles', [])
                inds    = cmd.get('indicators', {})
                closes  = [x['c'] for x in c]
                result  = {}
                if 'rsi'  in inds: result['rsi']  = calc_rsi(closes, inds['rsi'].get('period', 14))
                if 'sma'  in inds: result['sma']  = calc_sma(closes, inds['sma'].get('period', 20))
                if 'ema'  in inds: result['ema']  = calc_ema(closes, inds['ema'].get('period', 20))
                if 'bb'   in inds: result['bb']   = calc_bb(closes, inds['bb'].get('period', 20), inds['bb'].get('std', 2))
                if 'macd' in inds: result['macd'] = calc_macd(closes)
                if 'atr'  in inds: result['atr']  = calc_atr(c, inds['atr'].get('period', 14))
                print(json.dumps(result), flush=True)

            elif action == 'ping':
                print(json.dumps({'pong': True}), flush=True)

            else:
                print(json.dumps({'error': f'Bilinmeyen komut: {action}'}), flush=True)

        except Exception as e:
            log(f"Hata: {traceback.format_exc()}")
            print(json.dumps({'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
