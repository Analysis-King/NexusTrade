"""
NexusTrade Python Pool Worker
==============================
Tek bir Python process'i birden fazla bot/strateji instance'i icin calisir.
Node tarafi (workerPool.ts) tarafindan spawn edilir.

Protokol — Newline Delimited JSON (NDJSON), stdin/stdout:

Request (Node -> Worker):
    {"id": "<req-id>", "cmd": "load",     "instance": "bot-uuid", "strategy_file": "rsi_mean_reversion.py"}
    {"id": "<req-id>", "cmd": "tick",     "instance": "bot-uuid", "candle": {...}, "candles": [...], "portfolio": {...}}
    {"id": "<req-id>", "cmd": "backtest", "instance": "bot-uuid", "candles": [...], "min_quality": 40, "tp_mode": "TP2"}
    {"id": "<req-id>", "cmd": "drop",     "instance": "bot-uuid"}
    {"id": "<req-id>", "cmd": "ping"}

Response (Worker -> Node):
    {"id": "<req-id>", "ok": true,  "data": {...}}
    {"id": "<req-id>", "ok": false, "error": "...", "trace": "..."}

Worker bagimsizdir — Node yeniden spawn ederse instance'lari kaybeder, Node
'load' komutuyla onlari geri yukler. State Node'da, hesaplama Python'da.

Stderr log icin rezerve: {"level": "info|warn|error", "msg": "..."}
"""

import sys
import os
import json
import importlib.util
import importlib
import traceback
import builtins as _builtins

# ── Indicator import ─────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_PYROOT = os.path.abspath(os.path.join(_HERE, '..'))
if _PYROOT not in sys.path:
    sys.path.insert(0, _PYROOT)

from indicators.indicators import (  # noqa: E402
    calc_sma, calc_ema_arr, calc_ema,
    calc_rsi, calc_rsi_arr, calc_bb, calc_bb_arr,
    calc_macd, calc_atr,
)

STRATEGIES_DIR = os.path.join(_PYROOT, 'strategies')


# ── Yardimci tipler — strateji koduna verilen API ───────────
class _Indicators:
    """Strateji icinde `indicators` global'i olarak gorunur."""
    def __init__(self, closes, candles):
        self._closes = closes
        self._candles = candles

    def rsi(self, period=14):    return calc_rsi(self._closes, period)
    def ema(self, period=20):    return calc_ema(self._closes, period)
    def sma(self, period=20):    return calc_sma(self._closes, period)
    def bb(self, period=20, std=2):
        return calc_bb(self._closes, period, std)
    def macd(self, fast=12, slow=26, signal=9):
        return calc_macd(self._closes, fast, slow, signal)
    def atr(self, period=14):    return calc_atr(self._candles, period)


class _Portfolio:
    def __init__(self, data):
        self.usdt = data.get('usdt', 1000)
        self.has_position = data.get('has_position', False)
        self.pnl = data.get('pnl', 0)


class _Candle:
    __slots__ = ('open', 'high', 'low', 'close', 'volume', 'time')

    def __init__(self, data):
        self.open = data['o']
        self.high = data['h']
        self.low = data['l']
        self.close = data['c']
        self.volume = data['v']
        self.time = data['t']


# ── Worker ────────────────────────────────────────────────────
class PoolWorker:
    def __init__(self):
        # instance_id -> {"module": <mod>, "config": {...}, "file": "..."}
        self.instances = {}

    # --- Komut dispatcher ---
    def handle(self, req):
        cmd = req.get('cmd')
        if cmd == 'ping':
            return {'pong': True}
        if cmd == 'load':
            return self._load(req)
        if cmd == 'drop':
            return self._drop(req)
        if cmd == 'tick':
            return self._tick(req)
        if cmd == 'backtest':
            return self._backtest(req)
        raise ValueError(f"Bilinmeyen komut: {cmd}")

    def _load(self, req):
        instance_id = req['instance']
        strategy_file = req['strategy_file']

        filepath = os.path.join(STRATEGIES_DIR, strategy_file)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Strateji dosyasi yok: {strategy_file}")

        # Her instance icin tekil module ismi (cache karismasin)
        mod_name = f"strategy_{instance_id.replace('-', '_')}"
        spec = importlib.util.spec_from_file_location(mod_name, filepath)
        if spec is None or spec.loader is None:
            raise ImportError(f"Strateji yuklenemedi: {strategy_file}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        config = {}
        if hasattr(module, 'initialize'):
            config = module.initialize() or {}

        self.instances[instance_id] = {
            'module': module,
            'config': config,
            'file': strategy_file,
        }
        return {'config': config, 'file': strategy_file}

    def _drop(self, req):
        instance_id = req['instance']
        self.instances.pop(instance_id, None)
        return {'dropped': True}

    def _tick(self, req):
        instance_id = req['instance']
        inst = self.instances.get(instance_id)
        if inst is None:
            raise RuntimeError(f"Instance yuklu degil: {instance_id} — once 'load' gonderin")

        module = inst['module']
        config = inst['config']

        if not hasattr(module, 'on_candle'):
            return {'signal': 'hold', 'sl_pct': None, 'tp_pct': None, 'drawings': []}

        candle_data = req['candle']
        candles_data = req['candles']
        portfolio_data = req.get('portfolio', {})

        closes = [c['c'] for c in candles_data]

        # Sinyal yakalama buffer'i
        result = {'signal': 'hold', 'sl_pct': None, 'tp_pct': None}

        def _buy():    result['signal'] = 'buy'
        def _sell():   result['signal'] = 'sell'
        def _hold():   result['signal'] = 'hold'
        def _set_sl(pct=None, price=None):
            if pct is not None: result['sl_pct'] = pct
        def _set_tp(pct=None, price=None):
            if pct is not None: result['tp_pct'] = pct

        # Strateji koduna `indicators`, `portfolio`, `buy`, `sell` global'larini sun.
        # Builtins'e ekle, sonra geri al.
        injected = {
            'buy': _buy, 'sell': _sell, 'hold': _hold,
            'set_sl': _set_sl, 'set_tp': _set_tp,
            'indicators': _Indicators(closes, candles_data),
            'portfolio': _Portfolio(portfolio_data),
        }
        original = {}
        for name, val in injected.items():
            original[name] = getattr(_builtins, name, _UNSET)
            setattr(_builtins, name, val)

        try:
            module.on_candle(
                _Candle(candle_data),
                _Portfolio(portfolio_data),
                config
            )
        finally:
            # Geri al — her durumda
            for name, orig in original.items():
                if orig is _UNSET:
                    try: delattr(_builtins, name)
                    except AttributeError: pass
                else:
                    setattr(_builtins, name, orig)

        # Cizimleri al (varsa)
        drawings = []
        if hasattr(module, 'draw'):
            try:
                ind_data = {
                    'rsiArr': calc_rsi_arr(closes),
                    'emaArr9': calc_ema_arr(closes, 9),
                    'emaArr21': calc_ema_arr(closes, 21),
                }
                d = module.draw(candles_data, ind_data, [])
                if d:
                    drawings = d if isinstance(d, list) else [d]
            except Exception as e:
                _log('warn', f'draw() hata: {e}')

        return {
            'signal': result['signal'],
            'sl_pct': result.get('sl_pct'),
            'tp_pct': result.get('tp_pct'),
            'drawings': drawings,
        }

    def _backtest(self, req):
        instance_id = req['instance']
        inst = self.instances.get(instance_id)
        if inst is None:
            raise RuntimeError(f"Instance yuklu degil: {instance_id}")

        module = inst['module']
        if not hasattr(module, 'run_backtest'):
            return {'error': 'Strateji backtest desteklemiyor'}

        candles = req['candles']
        min_quality = req.get('min_quality', 40)
        tp_mode = req.get('tp_mode', 'TP2')

        return module.run_backtest(candles, min_quality, tp_mode)


# Sentinel — 'attribute mevcut degildi' demek icin
class _Unset:
    pass
_UNSET = _Unset()


# ── stderr loglama ───────────────────────────────────────────
def _log(level, msg):
    try:
        sys.stderr.write(json.dumps({'level': level, 'msg': msg}) + '\n')
        sys.stderr.flush()
    except Exception:
        pass


# ── Ana dongu — NDJSON loop ──────────────────────────────────
def main():
    worker = PoolWorker()
    _log('info', f'pool_worker basladi (pid={os.getpid()})')

    # stdout'u line-buffered yap
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _log('error', f'JSON parse: {e}')
            continue

        req_id = req.get('id')
        try:
            data = worker.handle(req)
            sys.stdout.write(json.dumps({
                'id': req_id, 'ok': True, 'data': data
            }) + '\n')
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({
                'id': req_id,
                'ok': False,
                'error': str(e),
                'trace': traceback.format_exc(),
            }) + '\n')
            sys.stdout.flush()


if __name__ == '__main__':
    main()
