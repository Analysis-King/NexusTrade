"""
NexusTrade Python Pool Worker (V2 - test/arastirma dali)
==============================
pool_worker.py'nin ayri kopyasi. Uretimdeki dosyaya dokunmadan asagidaki
duzeltmeleri icerir:
  1) Pozisyon boyutu varsayilani artik sabit initial_capital degil, mevcut
     equity'ye gore olcekleniyor (max_position_pct/usd verilmezse equity*leverage).
  2) Basit izole-marj likidasyon yaklasimi: leverage>1 iken entry*(1-1/leverage)
     (long) / entry*(1+1/leverage) (short) seviyesine ulasilirsa pozisyon
     'liquidation' nedeniyle kapatilir (stratejinin kendi SL'i daha gevsekse).
  3) Max drawdown/equity egrisi artik acik pozisyonun o an kapatilirsa
     alinacak cikis komisyonu+slippage'ini de dusuyor (daha az iyimser).

Tek bir Python process'i birden fazla bot/strateji instance'i icin calisir.
Node tarafi (workerPool.ts) tarafindan spawn edilir.

Protokol — Newline Delimited JSON (NDJSON), stdin/stdout:

Request (Node -> Worker):
    {"id": "<req-id>", "cmd": "load",     "instance": "bot-uuid", "strategy_file": "...", "params": {...}}
    {"id": "<req-id>", "cmd": "tick",     "instance": "bot-uuid", "candle": {...}, "candles": [...], "portfolio": {...}}
    {"id": "<req-id>", "cmd": "backtest", "instance": "bot-uuid", "candles": [...], "params": {...}}
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
import types
import inspect

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
    def __init__(self, closes, candles, footprints=None, footprint=None):
        self._closes = closes
        self._candles = candles
        self._footprints = footprints or []
        self._footprint = footprint

    def candles(self):          return self._candles
    def footprint(self):        return self._footprint
    def footprints(self):       return self._footprints
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
        self.side = data.get('side')


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
        if cmd == 'load_code':
            return self._load_code(req)
        if cmd == 'validate_code':
            return self._validate_code(req)
        if cmd == 'drop':
            return self._drop(req)
        if cmd == 'tick':
            return self._tick(req)
        if cmd == 'draw':
            return self._draw(req)
        if cmd == 'backtest':
            return self._backtest(req)
        if cmd == 'optimize_harmonic':
            return self._optimize_harmonic(req)
        raise ValueError(f"Bilinmeyen komut: {cmd}")

    def _load(self, req):
        instance_id = req['instance']
        strategy_file = req['strategy_file']

        filepath = os.path.join(STRATEGIES_DIR, strategy_file)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Strateji dosyasi yok: {strategy_file}")

        module = self._module_from_file(instance_id, strategy_file, filepath)

        config = dict(req.get('params') or {})
        if hasattr(module, 'initialize'):
            defaults = module.initialize() or {}
            config = {**defaults, **config}
        config = _resolve_module_config(module, config)

        self.instances[instance_id] = {
            'module': module,
            'config': config,
            'file': strategy_file,
        }
        return {
            'config': config,
            'file': strategy_file,
            'capabilities': {
                'footprint': bool(getattr(module, 'REQUIRES_FOOTPRINT', False)),
            },
        }

    def _load_code(self, req):
        instance_id = req['instance']
        strategy_file = req.get('strategy_file') or 'inline_strategy.py'
        source_code = req['source_code']

        module = self._module_from_code(instance_id, strategy_file, source_code)
        config = dict(req.get('params') or {})
        if hasattr(module, 'initialize'):
            defaults = module.initialize() or {}
            config = {**defaults, **config}
        config = _resolve_module_config(module, config)

        self.instances[instance_id] = {
            'module': module,
            'config': config,
            'file': strategy_file,
        }
        return {
            'config': config,
            'file': strategy_file,
            'capabilities': {
                'footprint': bool(getattr(module, 'REQUIRES_FOOTPRINT', False)),
            },
        }

    def _validate_code(self, req):
        strategy_file = req.get('strategy_file') or 'inline_strategy.py'
        source_code = req['source_code']
        errors = []
        warnings = []
        capabilities = {
            'initialize': False,
            'on_candle': False,
            'draw': False,
        }

        try:
            module = self._module_from_code('validate', strategy_file, source_code)
        except Exception as exc:
            return {
                'ok': False,
                'errors': [str(exc)],
                'warnings': warnings,
                'capabilities': capabilities,
            }

        for name in capabilities:
            capabilities[name] = hasattr(module, name)

        if hasattr(module, 'initialize'):
            try:
                cfg = module.initialize()
                if cfg is not None and not isinstance(cfg, dict):
                    warnings.append('initialize() dict dondurmeli; farkli tipler yok sayilabilir.')
            except Exception as exc:
                errors.append(f'initialize() hata verdi: {exc}')

        if not hasattr(module, 'on_candle'):
            errors.append('Universal backtest ve bot akisi icin on_candle(candle, portfolio, config) gerekli.')
        else:
            try:
                sig = inspect.signature(module.on_candle)
                positional = [
                    p for p in sig.parameters.values()
                    if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
                    and p.default is p.empty
                ]
                has_varargs = any(p.kind == p.VAR_POSITIONAL for p in sig.parameters.values())
                if not has_varargs and len(positional) > 3:
                    warnings.append('on_candle en fazla candle, portfolio, config beklemeli.')
            except Exception as exc:
                warnings.append(f'on_candle imzasi okunamadi: {exc}')

        return {
            'ok': len(errors) == 0,
            'errors': errors,
            'warnings': warnings,
            'capabilities': capabilities,
        }

    def _drop(self, req):
        instance_id = req['instance']
        self.instances.pop(instance_id, None)
        return {'dropped': True}

    def _tick(self, req):
        instance_id = req['instance']
        inst = self.instances.get(instance_id)
        if inst is None:
            raise RuntimeError(f"Instance yuklu degil: {instance_id} — once 'load' gonderin")

        return self._run_on_candle(
            inst['module'],
            inst['config'],
            req['candle'],
            req['candles'],
            req.get('portfolio', {}),
            include_drawings=bool(req.get('include_drawings', True)),
            footprints_data=req.get('footprints') or [],
            footprint_data=req.get('footprint'),
        )

    def _draw(self, req):
        instance_id = req['instance']
        inst = self.instances.get(instance_id)
        if inst is None:
            raise RuntimeError(f"Instance yuklu degil: {instance_id}")

        return self._run_draw(
            inst['module'],
            inst['config'],
            req.get('candles') or [],
        )

    def _backtest(self, req):
        instance_id = req['instance']
        inst = self.instances.get(instance_id)
        if inst is None:
            raise RuntimeError(f"Instance yuklu degil: {instance_id}")

        return self._run_universal_backtest(inst['module'], inst['config'], req)

    def _optimize_harmonic(self, req):
        strategy_file = req.get('strategy_file') or 'pine_harmonic_patterns.py'
        filepath = os.path.join(STRATEGIES_DIR, strategy_file)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Strateji dosyasi yok: {strategy_file}")
        module = self._module_from_file('harmonic_optimizer', strategy_file, filepath)
        if not hasattr(module, 'scan_historical_patterns'):
            raise RuntimeError('Strateji scan_historical_patterns(candles, config) desteklemiyor.')

        candles = req.get('candles') or []
        params = dict(req.get('params') or {})
        config = module.initialize() if hasattr(module, 'initialize') else {}
        if config is None:
            config = {}
        config = {**config, **params}
        if hasattr(module, '_cfg'):
            config = module._cfg(config)

        patterns = module.scan_historical_patterns(candles, config)
        buckets = {}
        for pattern in patterns:
            scored = _score_harmonic_pattern(module, pattern, candles, config)
            if scored is None:
                continue
            bucket_key = (
                pattern.get('name'),
                pattern.get('zigzag_length'),
                pattern.get('direction'),
            )
            bucket = buckets.setdefault(bucket_key, {
                'pattern': pattern.get('name'),
                'zigzag_length': pattern.get('zigzag_length'),
                'direction': pattern.get('direction'),
                'count': 0,
                'wins': 0,
                'losses': 0,
                'sum_r': 0.0,
                'avg_quality': 0.0,
            })
            bucket['count'] += 1
            bucket['wins'] += 1 if scored['won'] else 0
            bucket['losses'] += 0 if scored['won'] else 1
            bucket['sum_r'] += scored['r']
            bucket['avg_quality'] += float(pattern.get('quality') or 0.0)

        min_samples = max(1, int(req.get('min_samples') or 3))
        min_win_rate = float(req.get('min_win_rate') or 0.0)
        min_expectancy_r = float(req.get('min_expectancy_r') or 0.0)
        scored_buckets = []
        for bucket in buckets.values():
            count = max(1, bucket['count'])
            bucket['win_rate'] = bucket['wins'] * 100.0 / count
            bucket['expectancy_r'] = bucket['sum_r'] / count
            bucket['avg_quality'] = bucket['avg_quality'] / count
            bucket['score'] = bucket['expectancy_r'] * min(count, 12)
            if (
                bucket['count'] >= min_samples
                and bucket['win_rate'] >= min_win_rate
                and bucket['expectancy_r'] >= min_expectancy_r
            ):
                scored_buckets.append(bucket)

        scored_buckets.sort(key=lambda item: (
            item.get('score', 0.0),
            item.get('expectancy_r', 0.0),
            item.get('win_rate', 0.0),
            item.get('count', 0),
        ), reverse=True)
        top_n = max(1, int(req.get('top_n') or 6))
        selected = [
            {
                'pattern': item['pattern'],
                'zigzag_length': item['zigzag_length'],
                'direction': item['direction'],
            }
            for item in scored_buckets[:top_n]
        ]
        return {
            'selected': selected,
            'buckets': scored_buckets,
            'observed_patterns': len(patterns),
        }

# Sentinel — 'attribute mevcut degildi' demek icin
    def _module_from_file(self, instance_id, strategy_file, filepath):
        mod_name = f"strategy_{instance_id.replace('-', '_')}"
        spec = importlib.util.spec_from_file_location(mod_name, filepath)
        if spec is None or spec.loader is None:
            raise ImportError(f"Strateji yuklenemedi: {strategy_file}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _module_from_code(self, instance_id, strategy_file, source_code):
        mod_name = f"strategy_{instance_id.replace('-', '_')}"
        module = types.ModuleType(mod_name)
        module.__file__ = strategy_file
        code = compile(source_code, strategy_file, 'exec')
        exec(code, module.__dict__)
        return module

    def _run_on_candle(
        self,
        module,
        config,
        candle_data,
        candles_data,
        portfolio_data,
        include_drawings=False,
        footprints_data=None,
        footprint_data=None,
    ):
        if not hasattr(module, 'on_candle'):
            raise RuntimeError('Strateji on_candle(candle, portfolio, config) fonksiyonu icermiyor')

        closes = [c['c'] for c in candles_data]
        result = {
            'signal': 'hold',
            'sl_pct': None,
            'tp_pct': None,
            'sl_price': None,
            'tp_price': None,
            'meta': {},
            'observations': [],
            'drawings': [],
        }

        def _buy():    result['signal'] = 'buy'
        def _sell():   result['signal'] = 'sell'
        def _close():  result['signal'] = 'close'
        def _hold():   result['signal'] = 'hold'
        def _set_sl(pct=None, price=None):
            if pct is not None: result['sl_pct'] = pct
            if price is not None: result['sl_price'] = price
        def _set_tp(pct=None, price=None):
            if pct is not None: result['tp_pct'] = pct
            if price is not None: result['tp_price'] = price
        def _set_meta(**meta):
            for key, value in (meta or {}).items():
                result['meta'][str(key)] = value
        def _observe(name, side=None, **meta):
            label = str(name or '').strip()
            if not label:
                return
            norm_side = _normalize_side(side)
            result['observations'].append({
                'name': label,
                'side': norm_side,
                'meta': meta or {},
            })
        def _plot(series, title='', color='#D1D4DC', linewidth=1, style='line', trackprice=False,
                  histbase=None, offset=0, join=True, editable=True, show_last=None, display='all',
                  format=None, precision=None, force_overlay=True, linestyle=None, group=None, role=None):
            points = _drawing_series_points(series, candles_data, offset, show_last)
            if not points:
                return
            result['drawings'].append({
                'type': 'plot',
                'title': str(title or ''),
                'points': points,
                'color': str(color or '#D1D4DC'),
                'linewidth': int(float(linewidth or 1)),
                'style': str(style or 'line'),
                'trackprice': bool(trackprice),
                'histbase': histbase,
                'join': bool(join),
                'editable': bool(editable),
                'display': str(display or 'all'),
                'format': format,
                'precision': precision,
                'force_overlay': bool(force_overlay),
                'linestyle': linestyle,
                'group': group,
                'role': role,
            })
        def _line_new(first_point, second_point, xloc='bar_time', extend='none', color='#D1D4DC',
                      style='solid', width=1, force_overlay=True, group=None, role=None):
            p1 = _drawing_point(first_point, candles_data, xloc)
            p2 = _drawing_point(second_point, candles_data, xloc)
            if p1 is None or p2 is None:
                return
            result['drawings'].append({
                'type': 'line',
                'first': p1,
                'second': p2,
                'xloc': str(xloc or 'bar_time'),
                'extend': str(extend or 'none'),
                'color': str(color or '#D1D4DC'),
                'style': str(style or 'solid'),
                'width': int(float(width or 1)),
                'force_overlay': bool(force_overlay),
                'group': group,
                'role': role,
            })
        def _label_new(point, text='', color='#D1D4DC', textcolor='#131722', style='label_up',
                       size='normal', force_overlay=True, group=None, role=None):
            p = _drawing_point(point, candles_data, 'bar_time')
            if p is None:
                return
            result['drawings'].append({
                'type': 'label',
                'point': p,
                'text': str(text or ''),
                'color': str(color or '#D1D4DC'),
                'textcolor': str(textcolor or '#131722'),
                'style': str(style or 'label_up'),
                'size': str(size or 'normal'),
                'force_overlay': bool(force_overlay),
                'group': group,
                'role': role,
            })

        injected = {
            'buy': _buy, 'sell': _sell, 'close': _close, 'hold': _hold,
            'set_sl': _set_sl, 'set_tp': _set_tp,
            'set_meta': _set_meta,
            'observe': _observe,
            'plot': _plot,
            'line': _DrawingFactory(_line_new),
            'label': _DrawingFactory(_label_new),
            'indicators': _Indicators(closes, candles_data, footprints_data, footprint_data),
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
            for name, orig in original.items():
                if orig is _UNSET:
                    try: delattr(_builtins, name)
                    except AttributeError: pass
                else:
                    setattr(_builtins, name, orig)

        drawings = result.get('drawings') or []
        if include_drawings and hasattr(module, 'draw'):
            try:
                ind_data = {
                    'rsiArr': calc_rsi_arr(closes),
                    'emaArr9': calc_ema_arr(closes, 9),
                    'emaArr21': calc_ema_arr(closes, 21),
                }
                draw_params = list(inspect.signature(module.draw).parameters.values())
                accepts_config = (
                    len(draw_params) >= 4 or
                    any(p.kind == p.VAR_POSITIONAL for p in draw_params)
                )
                d = (
                    module.draw(candles_data, ind_data, [], config)
                    if accepts_config
                    else module.draw(candles_data, ind_data, [])
                )
                if d:
                    legacy_drawings = d if isinstance(d, list) else [d]
                    drawings.extend(legacy_drawings)
            except Exception as e:
                _log('warn', f'draw() hata: {e}')

        return {
            'signal': result['signal'],
            'sl_pct': result.get('sl_pct'),
            'tp_pct': result.get('tp_pct'),
            'sl_price': result.get('sl_price'),
            'tp_price': result.get('tp_price'),
            'meta': result.get('meta') or {},
            'observations': result.get('observations') or [],
            'drawings': drawings,
        }

    def _run_draw(self, module, config, candles_data):
        if not hasattr(module, 'draw'):
            return {'drawings': []}

        closes = [c['c'] for c in candles_data]
        try:
            ind_data = {
                'rsiArr': calc_rsi_arr(closes),
                'emaArr9': calc_ema_arr(closes, 9),
                'emaArr21': calc_ema_arr(closes, 21),
            }
            draw_params = list(inspect.signature(module.draw).parameters.values())
            accepts_config = (
                len(draw_params) >= 4 or
                any(p.kind == p.VAR_POSITIONAL for p in draw_params)
            )
            drawings = (
                module.draw(candles_data, ind_data, [], config)
                if accepts_config
                else module.draw(candles_data, ind_data, [])
            )
            if not drawings:
                return {'drawings': []}
            return {'drawings': drawings if isinstance(drawings, list) else [drawings]}
        except Exception as e:
            _log('warn', f'draw() hata: {e}')
            return {'drawings': []}

    def _run_universal_backtest(self, module, config, req):
        candles = req.get('candles') or []
        if len(candles) < 2:
            return _empty_backtest(req, candles)

        initial = float(req.get('initial_capital') or 1000)
        fee_bps = float(req.get('fee_bps') or 0)
        slippage_bps = float(req.get('slippage_bps') or 0)
        fill_model = req.get('fill_model') or 'pessimistic_ohlc'
        params = {**(config if isinstance(config, dict) else {}), **(req.get('params') or {})}
        params = _resolve_module_config(module, params)
        start_time = int(req.get('start_time') or 0)
        fee_rate = fee_bps / 10000.0
        slip_rate = slippage_bps / 10000.0
        max_position = _float_param(params, 'max_position_usd', None)
        max_position_pct = _float_param(params, 'max_position_pct', None)
        leverage = max(1.0, _float_param(params, 'leverage', 1.0) or 1.0)
        default_sl = _float_param(params, 'stop_loss_pct', None)
        default_tp = _float_param(params, 'take_profit_pct', None)
        stop_loss_mode = str(params.get('stop_loss_mode') or 'strategy')
        stop_loss_target_ratio = _float_param(params, 'stop_loss_target_ratio', 1.0) or 1.0
        same_candle_mode = str(params.get('same_candle_tp_sl') or 'stop_first')
        stop_trigger_mode = str(params.get('stop_trigger_mode') or 'touch').strip().lower()
        if stop_trigger_mode not in ('touch', 'close'):
            stop_trigger_mode = 'touch'
        exit_on_opposite_signal = _bool_param(params, 'exit_on_opposite_signal', False)
        observation_horizon = max(1, int(_float_param(params, 'observation_horizon_bars', 10) or 10))
        observation_sl = _float_param(params, 'observation_stop_loss_pct', default_sl)
        observation_tp = _float_param(params, 'observation_take_profit_pct', default_tp)
        report_period_days = _float_param(params, 'report_period_days', None)
        min_reward_risk = max(0.0, _float_param(params, 'min_reward_risk', 0.0) or 0.0)

        equity = initial
        realized_pnl = 0.0
        position = None
        pending_signal = None
        pending_exit = None
        trades = []
        observations = []
        equity_curve = []
        peak = initial
        max_dd = 0.0
        history = []
        footprints_by_t = {}
        for footprint in req.get('footprints') or []:
            try:
                footprints_by_t[int(footprint.get('t'))] = footprint
            except (AttributeError, TypeError, ValueError):
                continue
        footprint_history = []

        for i, candle in enumerate(candles):
            history.append(candle)
            current_footprint = footprints_by_t.get(int(candle.get('t') or 0))
            if current_footprint is not None:
                footprint_history.append(current_footprint)
            if pending_exit is not None and position is not None:
                equity, realized_pnl = _close_position(
                    position, candle.get('o', candle['c']), candle['t'], pending_exit,
                    fee_rate, slip_rate, equity, realized_pnl, trades
                )
                position = None
            pending_exit = None

            if pending_signal is not None:
                signal = pending_signal.get('signal') or 'hold'
                if signal == 'close':
                    if position is not None:
                        equity, realized_pnl = _close_position(
                            position, candle.get('o', candle['c']), candle['t'], 'signal',
                            fee_rate, slip_rate, equity, realized_pnl, trades
                        )
                        position = None
                    pending_signal = None
                else:
                    wanted_side = 'long' if signal == 'buy' else 'short'
                    if position is not None and position['side'] != wanted_side:
                        if exit_on_opposite_signal:
                            equity, realized_pnl = _close_position(
                                position, candle.get('o', candle['c']), candle['t'], 'signal',
                                fee_rate, slip_rate, equity, realized_pnl, trades
                            )
                            position = None
                        else:
                            pending_signal = None
                    if pending_signal is not None and position is None:
                        if max_position_pct is not None and max_position_pct > 0:
                            allocation_pct = min(100.0, max_position_pct)
                            position_cap = equity * allocation_pct / 100.0 * leverage
                        else:
                            # V2: varsayilan artik sabit initial_capital degil, mevcut equity'ye
                            # gore olcekleniyor (equity eriyince yeni pozisyonlar da kuculuyor).
                            position_cap = max(0.0, equity) * leverage
                        if max_position is not None and max_position > 0:
                            position_cap = min(position_cap, max_position)
                        position = _open_position(
                            wanted_side,
                            candle,
                            equity,
                            position_cap,
                            fee_rate,
                            slip_rate,
                            pending_signal.get('sl_pct') if pending_signal.get('sl_pct') is not None else default_sl,
                            pending_signal.get('tp_pct') if pending_signal.get('tp_pct') is not None else default_tp,
                            pending_signal.get('sl_price'),
                            pending_signal.get('tp_price'),
                            stop_loss_mode,
                            stop_loss_target_ratio,
                            min_reward_risk,
                            pending_signal.get('meta'),
                            price_key='o',
                        )
                        if position is not None:
                            equity -= position['entry_fee']
                    elif pending_signal is not None and position is not None and position['side'] == wanted_side:
                        _apply_risk_update(
                            position,
                            pending_signal,
                            candle.get('o', candle['c']),
                            stop_loss_mode,
                            stop_loss_target_ratio,
                            min_reward_risk,
                            fee_rate,
                            slip_rate,
                        )
            pending_signal = None

            if position is not None:
                exit_price, reason = _stop_or_target_price(
                    position,
                    candle,
                    fill_model,
                    same_candle_mode,
                    stop_trigger_mode,
                    leverage,
                )
                if exit_price is not None and fill_model == 'pessimistic_ohlc':
                    equity, realized_pnl = _close_position(
                        position, exit_price, candle['t'], reason, fee_rate, slip_rate,
                        equity, realized_pnl, trades
                    )
                    position = None
                elif exit_price is not None:
                    pending_exit = reason

            portfolio = {
                'usdt': equity,
                'has_position': position is not None,
                'pnl': realized_pnl,
            }
            if position is not None:
                portfolio['side'] = 'BUY' if position['side'] == 'long' else 'SELL'

            signal_data = self._run_on_candle(
                module,
                config,
                candle,
                history,
                portfolio,
                footprints_data=footprint_history,
                footprint_data=current_footprint,
            )
            signal = signal_data.get('signal') or 'hold'
            for observation in signal_data.get('observations') or []:
                evaluated = _evaluate_observation(
                    observation,
                    candles,
                    i,
                    observation_horizon,
                    observation_sl,
                    observation_tp,
                    fill_model,
                    same_candle_mode,
                    slip_rate,
                )
                if evaluated is not None:
                    observations.append(evaluated)

            if position is not None:
                _apply_risk_update(position, signal_data, candle['c'], stop_loss_mode, stop_loss_target_ratio, min_reward_risk, fee_rate, slip_rate)

            can_trade_now = start_time <= 0 or int(candle.get('t') or 0) >= start_time
            if can_trade_now and signal in ('buy', 'sell', 'close') and i < len(candles) - 1:
                pending_signal = signal_data

            mark = equity + (
                _unrealized_mark_pnl(position, candle['c'], fee_rate, slip_rate) if position is not None else 0.0
            )
            peak = max(peak, mark)
            dd = 0.0 if peak <= 0 else (peak - mark) / peak * 100.0
            max_dd = max(max_dd, dd)
            equity_curve.append({'t': candle['t'], 'value': round(mark, 2)})

        if position is not None:
            last = candles[-1]
            equity, realized_pnl = _close_position(
                position, last['c'], last['t'], 'end_of_test', fee_rate, slip_rate,
                equity, realized_pnl, trades
            )
            if equity_curve and equity_curve[-1]['t'] == last['t']:
                equity_curve[-1]['value'] = round(equity, 2)
            else:
                equity_curve.append({'t': last['t'], 'value': round(equity, 2)})

        return {
            'engine': 'universal_on_candle',
            'execution': {
                'signal_fill': 'next_open',
                'fill_model': fill_model,
                'same_candle_tp_sl': same_candle_mode,
                'stop_trigger_mode': stop_trigger_mode,
                'exit_on_opposite_signal': exit_on_opposite_signal,
                'report_period_days': report_period_days,
                'max_position_pct': max_position_pct,
                'leverage': leverage,
                'start_time': start_time or None,
            },
            'summary': _summary(initial, equity, trades, max_dd),
            'trades': trades,
            'equity': equity_curve,
            'patterns': _side_stats(trades, initial),
            'observations': observations,
            'observationStats': _observation_stats(observations),
            'periodReports': _period_reports(equity_curve, trades, report_period_days),
        }


class _Unset:
    pass
_UNSET = _Unset()


# ── stderr loglama ───────────────────────────────────────────
class _DrawingFactory:
    def __init__(self, new_fn):
        self.new = new_fn


def _resolve_module_config(module, config):
    resolver = getattr(module, 'resolve_config', None)
    if not callable(resolver):
        return config
    resolved = resolver(dict(config or {}))
    if resolved is None:
        return config
    if not isinstance(resolved, dict):
        raise TypeError('resolve_config(config) dict dondurmeli')
    return resolved


def _float_param(params, key, fallback):
    value = params.get(key) if isinstance(params, dict) else None
    if value in (None, ''):
        return fallback
    try:
        return float(value)
    except Exception:
        return fallback


def _bool_param(params, key, fallback=False):
    value = params.get(key) if isinstance(params, dict) else None
    if value in (None, ''):
        return fallback
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ('1', 'true', 'yes', 'evet', 'acik', 'on')
    return bool(value)


def _drawing_point(raw, candles, xloc='bar_time'):
    if raw is None:
        return None
    x_value = None
    price = None
    if isinstance(raw, dict):
        x_value = raw.get('time', raw.get('t', raw.get('x', raw.get('bar_index'))))
        price = raw.get('price', raw.get('y', raw.get('value')))
    elif isinstance(raw, (list, tuple)) and len(raw) >= 2:
        x_value = raw[0]
        price = raw[1]
    if x_value is None or price is None:
        return None
    try:
        y = float(price)
    except Exception:
        return None
    t = _drawing_time(x_value, candles, xloc)
    if t is None:
        return None
    return {'time': int(t), 'price': y}


def _drawing_time(value, candles, xloc='bar_time'):
    try:
        n = float(value)
    except Exception:
        return None
    if str(xloc or '').lower() in ('bar_index', 'index'):
        idx = int(n)
        return candles[idx]['t'] if 0 <= idx < len(candles) else None
    if n < 10_000_000 and float(n).is_integer():
        idx = int(n)
        if 0 <= idx < len(candles):
            return candles[idx]['t']
    return int(n)


def _drawing_series_points(series, candles, offset=0, show_last=None):
    if series is None or not candles:
        return []
    if isinstance(series, (int, float)):
        values = [series]
    elif isinstance(series, (list, tuple)):
        values = list(series)
    else:
        return []
    try:
        off = int(offset or 0)
    except Exception:
        off = 0
    if show_last is not None:
        try:
            limit = max(0, int(show_last))
            values = values[-limit:] if limit else []
        except Exception:
            pass
    start = max(0, len(candles) - len(values) + off)
    points = []
    for idx, value in enumerate(values):
        candle_idx = start + idx
        if not (0 <= candle_idx < len(candles)):
            continue
        if value is None:
            continue
        try:
            y = float(value)
        except Exception:
            continue
        points.append({'time': int(candles[candle_idx]['t']), 'value': y})
    return points


def _normalize_side(side):
    value = str(side or 'long').strip().lower()
    if value in ('buy', 'long', 'bull', 'bullish', 'alis', 'al'):
        return 'long'
    if value in ('sell', 'short', 'bear', 'bearish', 'satis', 'sat'):
        return 'short'
    return 'long'


def _evaluate_observation(
    observation,
    candles,
    signal_index,
    horizon_bars,
    sl_pct,
    tp_pct,
    fill_model,
    same_candle_mode,
    slip_rate,
):
    if signal_index >= len(candles) - 1:
        return None
    if not isinstance(observation, dict):
        return None

    name = str(observation.get('name') or '').strip()
    if not name:
        return None

    side = _normalize_side(observation.get('side'))
    entry_index = signal_index + 1
    entry_candle = candles[entry_index]
    raw_entry = float(entry_candle.get('o', entry_candle['c']))
    entry_price = raw_entry * (1 + slip_rate if side == 'long' else 1 - slip_rate)
    position = {
        'side': side,
        'entry_time': entry_candle['t'],
        'entry_price': entry_price,
        'qty': 1.0,
        'notional': entry_price,
        'entry_fee': 0.0,
        'sl': None,
        'tp': None,
    }
    _apply_risk_update(position, {'sl_pct': sl_pct, 'tp_pct': tp_pct}, entry_price, 'percent', 1.0)

    last_index = min(len(candles) - 1, entry_index + max(1, int(horizon_bars)) - 1)
    exit_price = None
    exit_time = None
    reason = None
    for idx in range(entry_index, last_index + 1):
        candidate, hit_reason = _stop_or_target_price(position, candles[idx], fill_model, same_candle_mode)
        if candidate is not None:
            exit_price = float(candidate) * (1 - slip_rate if side == 'long' else 1 + slip_rate)
            exit_time = candles[idx]['t']
            reason = hit_reason
            break

    if exit_price is None:
        last_candle = candles[last_index]
        exit_price = float(last_candle['c']) * (1 - slip_rate if side == 'long' else 1 + slip_rate)
        exit_time = last_candle['t']
        reason = 'horizon' if last_index < len(candles) - 1 else 'end_of_data'

    return_pct = (exit_price - entry_price) / entry_price * 100.0 if side == 'long' else (entry_price - exit_price) / entry_price * 100.0
    success = reason == 'tp' or (reason not in ('sl',) and return_pct > 0)
    return {
        'id': f"obs_{signal_index + 1}_{name}_{len(str(observation.get('meta') or ''))}",
        'name': name,
        'side': side,
        'signalTime': candles[signal_index]['t'],
        'entryTime': entry_candle['t'],
        'entryPrice': round(entry_price, 8),
        'exitTime': exit_time,
        'exitPrice': round(exit_price, 8),
        'returnPct': round(return_pct, 4),
        'success': bool(success),
        'reason': reason,
        'horizonBars': int(horizon_bars),
        'meta': observation.get('meta') or {},
    }


def _empty_backtest(req, candles):
    initial = float(req.get('initial_capital') or 1000)
    t = candles[0]['t'] if candles else 0
    return {
        'engine': 'universal_on_candle',
        'summary': {
            'initialCapital': round(initial, 2),
            'finalCapital': round(initial, 2),
            'totalReturnPct': 0,
            'maxDrawdownPct': 0,
            'winRatePct': 0,
            'profitFactor': None,
            'sharpe': None,
            'totalTrades': 0,
            'avgTradePct': None,
            'bestTradePct': None,
            'worstTradePct': None,
        },
        'trades': [],
        'equity': [{'t': t, 'value': round(initial, 2)}] if t else [],
        'patterns': [],
        'observations': [],
        'observationStats': [],
        'periodReports': [],
    }


def _score_harmonic_pattern(module, pattern, candles, config):
    if not candles:
        return None
    try:
        if hasattr(module, '_entry_trade_levels'):
            sl_price, tp_price = module._entry_trade_levels(pattern, config)
        elif hasattr(module, '_trade_levels'):
            sl_price, tp_price = module._trade_levels(pattern, config)
        else:
            return None
    except Exception:
        return None

    direction = pattern.get('direction')
    signal_i = int(pattern.get('signal_i') or pattern.get('D', {}).get('i') or 0)
    entry_i = signal_i + 1
    if entry_i >= len(candles):
        return None

    try:
        entry = float(candles[entry_i].get('o', candles[entry_i].get('c')))
        sl_price = float(sl_price)
        tp_price = float(tp_price)
    except (TypeError, ValueError):
        return None

    if entry <= 0 or sl_price <= 0 or tp_price <= 0:
        return None
    if direction == 'bullish' and not (sl_price < entry < tp_price):
        return None
    if direction == 'bearish' and not (tp_price < entry < sl_price):
        return None
    if direction not in ('bullish', 'bearish'):
        return None

    risk = abs(entry - sl_price)
    reward = abs(tp_price - entry)
    if risk <= 0 or reward <= 0:
        return None

    horizon = max(1, int(config.get('learning_horizon_bars') or 96))
    last_i = min(len(candles) - 1, entry_i + horizon)
    for idx in range(entry_i, last_i + 1):
        candle = candles[idx]
        high = float(candle.get('h', candle.get('high', 0.0)))
        low = float(candle.get('l', candle.get('low', 0.0)))
        if direction == 'bullish':
            hit_sl = low <= sl_price
            hit_tp = high >= tp_price
        else:
            hit_sl = high >= sl_price
            hit_tp = low <= tp_price
        if hit_sl and hit_tp:
            return {'won': False, 'r': -1.0}
        if hit_sl:
            return {'won': False, 'r': -1.0}
        if hit_tp:
            return {'won': True, 'r': reward / risk}

    close = float(candles[last_i].get('c', candles[last_i].get('close', entry)))
    if direction == 'bullish':
        pnl = close - entry
    else:
        pnl = entry - close
    return {'won': pnl > 0, 'r': pnl / risk}


def _open_position(
    side,
    candle,
    equity,
    max_position,
    fee_rate,
    slip_rate,
    sl_pct,
    tp_pct,
    sl_price=None,
    tp_price=None,
    stop_loss_mode='strategy',
    stop_loss_target_ratio=1.0,
    min_reward_risk=0.0,
    meta=None,
    price_key='c',
):
    notional = max(0.0, float(max_position or equity))
    if notional <= 0:
        return None
    tp_requested = tp_pct is not None or tp_price is not None
    raw_price = float(candle.get(price_key, candle['c']))
    entry_price = raw_price * (1 + slip_rate if side == 'long' else 1 - slip_rate)
    qty = 0.0 if entry_price <= 0 else notional / entry_price
    entry_fee = notional * fee_rate
    pos = {
        'side': side,
        'entry_time': candle['t'],
        'entry_price': entry_price,
        'qty': qty,
        'notional': notional,
        'entry_fee': entry_fee,
        'sl': None,
        'tp': None,
        'meta': meta if isinstance(meta, dict) else {},
    }
    _apply_risk_update(
        pos,
        {
            'sl_pct': sl_pct,
            'tp_pct': tp_pct,
            'sl_price': sl_price,
            'tp_price': tp_price,
        },
        entry_price,
        stop_loss_mode,
        stop_loss_target_ratio,
        min_reward_risk,
        fee_rate,
        slip_rate,
    )
    if tp_requested and pos.get('tp') is None:
        return None
    if not _tp_covers_entry_costs(pos, fee_rate, slip_rate):
        return None
    if not _reward_risk_ok(pos, min_reward_risk):
        return None
    return pos


def _tp_covers_entry_costs(position, fee_rate, slip_rate):
    return _tp_price_covers_costs(position, position.get('tp'), fee_rate, slip_rate)


def _reward_risk_ok(position, minimum):
    minimum = float(minimum or 0.0)
    if minimum <= 0:
        return True
    entry = float(position.get('entry_price') or 0.0)
    sl = position.get('sl')
    tp = position.get('tp')
    if entry <= 0 or sl is None or tp is None:
        return True
    risk = abs(entry - float(sl))
    reward = abs(float(tp) - entry)
    if risk <= 0 or reward <= 0:
        return False
    return reward / risk >= minimum


def _tp_price_covers_costs(position, tp, fee_rate, slip_rate):
    if tp is None:
        return True

    side = position['side']
    qty = float(position.get('qty') or 0.0)
    entry = float(position.get('entry_price') or 0.0)
    if qty <= 0 or entry <= 0:
        return False

    raw_exit = float(tp)
    exit_price = raw_exit * (1 - slip_rate if side == 'long' else 1 + slip_rate)
    gross = (exit_price - entry) * qty if side == 'long' else (entry - exit_price) * qty
    exit_fee = abs(exit_price * qty) * fee_rate
    net_pnl = gross - float(position.get('entry_fee') or 0.0) - exit_fee
    return net_pnl > 0


def _apply_risk_update(position, signal_data, reference_price, stop_loss_mode='strategy', stop_loss_target_ratio=1.0, min_reward_risk=0.0, fee_rate=0.0, slip_rate=0.0):
    if position is None or not isinstance(signal_data, dict):
        return
    side = position['side']
    ref = float(reference_price)
    entry = float(position.get('entry_price') or ref)

    sl_price = signal_data.get('sl_price')
    tp_price = signal_data.get('tp_price')

    if tp_price is None and signal_data.get('tp_pct') is not None:
        pct = float(signal_data['tp_pct']) / 100.0
        tp_price = ref * (1 + pct if side == 'long' else 1 - pct)

    mode = str(stop_loss_mode or 'strategy').lower()
    if mode == 'target_ratio' and tp_price is not None:
        distance = abs(float(tp_price) - entry)
        ratio = max(0.1, float(stop_loss_target_ratio or 1.0))
        if distance > 0:
            sl_price = entry - distance * ratio if side == 'long' else entry + distance * ratio
    elif mode == 'strategy':
        if sl_price is None and signal_data.get('sl_pct') is not None:
            pct = float(signal_data['sl_pct']) / 100.0
            sl_price = ref * (1 - pct if side == 'long' else 1 + pct)
    else:
        if signal_data.get('sl_pct') is not None:
            pct = float(signal_data['sl_pct']) / 100.0
            sl_price = ref * (1 - pct if side == 'long' else 1 + pct)

    next_sl = position.get('sl')
    next_tp = position.get('tp')
    changed = False
    tp_valid = False
    if tp_price is not None:
        tp = float(tp_price)
        tp_valid = (
            ((side == 'long' and tp > entry) or (side == 'short' and tp < entry))
            and _tp_price_covers_costs(position, tp, fee_rate, slip_rate)
        )
        if tp_valid:
            next_tp = tp
            changed = True

    if sl_price is not None and (tp_price is None or tp_valid):
        sl = float(sl_price)
        if (side == 'long' and sl < ref) or (side == 'short' and sl > ref):
            next_sl = sl
            changed = True

    if not changed:
        return

    candidate = {**position, 'sl': next_sl, 'tp': next_tp}
    if not _reward_risk_ok(candidate, min_reward_risk):
        return

    position['sl'] = next_sl
    position['tp'] = next_tp


def _liquidation_price(entry_price, side, leverage):
    """Basit izole-marj yaklasimi: marj = notional/leverage kaybedilince likidasyon.
    leverage<=1 durumunda fiili olarak devre disi (None) - 1x'te likidasyon riski yok."""
    lev = float(leverage or 1.0)
    if lev <= 1.0 or entry_price is None:
        return None
    frac = 1.0 / lev
    entry = float(entry_price)
    return entry * (1.0 - frac) if side == 'long' else entry * (1.0 + frac)


def _effective_stop(position, leverage):
    """Stratejinin kendi SL'i ile likidasyon seviyesinden hangisi giris fiyatina
    daha yakinsa (once tetiklenecekse) onu ve dogru 'reason' etiketini dondurur."""
    strategy_sl = position.get('sl')
    liq_price = _liquidation_price(position.get('entry_price'), position['side'], leverage)
    if liq_price is None:
        return strategy_sl, 'sl'
    if strategy_sl is None:
        return liq_price, 'liquidation'
    if position['side'] == 'long':
        return (liq_price, 'liquidation') if liq_price >= strategy_sl else (strategy_sl, 'sl')
    return (liq_price, 'liquidation') if liq_price <= strategy_sl else (strategy_sl, 'sl')


def _stop_or_target_price(
    position,
    candle,
    fill_model='pessimistic_ohlc',
    same_candle_mode='stop_first',
    stop_trigger_mode='touch',
    leverage=1.0,
):
    side = position['side']
    sl, sl_reason = _effective_stop(position, leverage)
    tp = position.get('tp')
    open_price = float(candle.get('o', candle['c']))
    close_price = float(candle['c'])

    if fill_model == 'close_next_open':
        if side == 'long':
            if sl is not None and close_price <= sl:
                return sl, sl_reason
            if tp is not None and close_price >= tp:
                return tp, 'tp'
        else:
            if sl is not None and close_price >= sl:
                return sl, sl_reason
            if tp is not None and close_price <= tp:
                return tp, 'tp'
        return None, None

    if side == 'long':
        if stop_trigger_mode == 'touch' and sl is not None and open_price <= sl:
            return open_price, sl_reason
        if tp is not None and open_price >= tp:
            return open_price, 'tp'
        hit_sl = sl is not None and (
            close_price <= sl if stop_trigger_mode == 'close' else candle['l'] <= sl
        )
        hit_tp = tp is not None and candle['h'] >= tp
    else:
        if stop_trigger_mode == 'touch' and sl is not None and open_price >= sl:
            return open_price, sl_reason
        if tp is not None and open_price <= tp:
            return open_price, 'tp'
        hit_sl = sl is not None and (
            close_price >= sl if stop_trigger_mode == 'close' else candle['h'] >= sl
        )
        hit_tp = tp is not None and candle['l'] <= tp
    if hit_sl and hit_tp:
        if same_candle_mode == 'take_profit_first' and sl_reason != 'liquidation':
            return tp, 'tp'
        return (close_price if stop_trigger_mode == 'close' else sl), sl_reason
    if hit_sl:
        return (close_price if stop_trigger_mode == 'close' else sl), sl_reason
    if hit_tp:
        return tp, 'tp'
    return None, None


def _close_position(position, raw_exit_price, exit_time, reason, fee_rate, slip_rate, equity, realized_pnl, trades):
    equity_before = equity
    side = position['side']
    exit_price = float(raw_exit_price) * (1 - slip_rate if side == 'long' else 1 + slip_rate)
    qty = position['qty']
    entry = position['entry_price']
    gross = (exit_price - entry) * qty if side == 'long' else (entry - exit_price) * qty
    exit_fee = abs(exit_price * qty) * fee_rate
    fee_paid = position['entry_fee'] + exit_fee
    net_after_exit_fee = gross - exit_fee
    net_pnl = net_after_exit_fee - position['entry_fee']
    equity += net_after_exit_fee
    realized_pnl += net_pnl
    pnl_pct = 0.0 if position['notional'] <= 0 else net_pnl / position['notional'] * 100.0
    account_return_pct = 0.0 if equity_before <= 0 else net_pnl / equity_before * 100.0
    trades.append({
        'id': f"tr_{len(trades) + 1}",
        'side': side,
        'entryTime': position['entry_time'],
        'entryPrice': round(entry, 8),
        'slPrice': round(position['sl'], 8) if position.get('sl') is not None else None,
        'tpPrice': round(position['tp'], 8) if position.get('tp') is not None else None,
        'exitTime': exit_time,
        'exitPrice': round(exit_price, 8),
        'qty': round(qty, 8),
        'notional': round(position['notional'], 4),
        'grossPnl': round(gross, 4),
        'netPnl': round(net_pnl, 4),
        'pnlPct': round(pnl_pct, 4),
        'accountReturnPct': round(account_return_pct, 4),
        'feePaid': round(fee_paid, 4),
        'reason': reason,
        'meta': position.get('meta') or {},
    })
    return equity, realized_pnl


def _unrealized_pnl(position, price):
    if position is None:
        return 0.0
    side = position['side']
    entry = position['entry_price']
    qty = position['qty']
    return (price - entry) * qty if side == 'long' else (entry - price) * qty


def _unrealized_mark_pnl(position, price, fee_rate, slip_rate):
    """V2: acik pozisyon o an (slippage+komisyon dahil) kapatilsaydi elde edilecek
    net deger. Equity curve/max drawdown bunu kullanir, entry_fee equity'den zaten
    dusuldugu icin tekrar dahil edilmez."""
    if position is None:
        return 0.0
    side = position['side']
    entry = position['entry_price']
    qty = position['qty']
    exit_price = float(price) * (1 - slip_rate if side == 'long' else 1 + slip_rate)
    gross = (exit_price - entry) * qty if side == 'long' else (entry - exit_price) * qty
    exit_fee = abs(exit_price * qty) * fee_rate
    return gross - exit_fee


def _summary(initial, final_equity, trades, max_dd):
    pnls = [t['netPnl'] for t in trades]
    returns = [t['pnlPct'] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    total = len(trades)
    profit_factor = None
    if gross_loss > 0:
        profit_factor = round(gross_profit / gross_loss, 2)
    elif gross_profit > 0:
        profit_factor = 99
    return {
        'initialCapital': round(initial, 2),
        'finalCapital': round(final_equity, 2),
        'totalReturnPct': round((final_equity - initial) / initial * 100.0, 2) if initial else 0,
        'maxDrawdownPct': round(max_dd, 2),
        'winRatePct': round(len(wins) / total * 100.0, 2) if total else 0,
        'profitFactor': profit_factor,
        'sharpe': _sharpe(returns),
        'totalTrades': total,
        'avgTradePct': round(sum(returns) / total, 2) if total else None,
        'bestTradePct': round(max(returns), 2) if returns else None,
        'worstTradePct': round(min(returns), 2) if returns else None,
    }


def _side_stats(trades, initial):
    out = []
    for side in ('long', 'short'):
        rows = [t for t in trades if t['side'] == side]
        if not rows:
            continue
        pnls = [t['netPnl'] for t in rows]
        returns = [t['pnlPct'] for t in rows]
        wins = [p for p in pnls if p > 0]
        gross_profit = sum(p for p in pnls if p > 0)
        gross_loss = abs(sum(p for p in pnls if p < 0))
        pf = round(gross_profit / gross_loss, 2) if gross_loss > 0 else (99 if gross_profit > 0 else None)
        out.append({
            'pattern': 'Long' if side == 'long' else 'Short',
            'trades': len(rows),
            'winRatePct': round(len(wins) / len(rows) * 100.0, 2),
            'profitFactor': pf,
            'totalReturnPct': round(sum(pnls) / initial * 100.0, 2) if initial else round(sum(returns), 2),
            'maxDrawdownPct': None,
        })
    return out


def _period_reports(equity_curve, trades, period_days):
    if period_days is None:
        return []
    try:
        days = float(period_days)
    except Exception:
        return []
    if days <= 0 or not equity_curve:
        return []

    period_ms = max(1, int(days * 24 * 60 * 60 * 1000))
    points = [
        {'t': int(point.get('t') or 0), 'value': float(point.get('value') or 0)}
        for point in equity_curve
        if isinstance(point, dict) and point.get('t') is not None
    ]
    points = [point for point in points if point['t'] > 0]
    points.sort(key=lambda point: point['t'])
    if not points:
        return []

    out = []
    cursor = 0
    period_no = 1
    period_start = points[0]['t']
    last_time = points[-1]['t']
    start_equity = points[0]['value']

    while period_start <= last_time and cursor < len(points):
        period_end = min(period_start + period_ms - 1, last_time)
        period_points = []
        while cursor < len(points) and points[cursor]['t'] <= period_end:
            period_points.append(points[cursor])
            cursor += 1

        if not period_points:
            period_start = period_end + 1
            continue

        end_equity = period_points[-1]['value']
        period_trades = [
            trade for trade in trades
            if isinstance(trade, dict)
            and period_start <= int(trade.get('exitTime') or 0) <= period_end
        ]
        gross_profit = sum(float(trade.get('netPnl') or 0) for trade in period_trades if float(trade.get('netPnl') or 0) > 0)
        gross_loss = abs(sum(float(trade.get('netPnl') or 0) for trade in period_trades if float(trade.get('netPnl') or 0) < 0))
        wins = len([trade for trade in period_trades if float(trade.get('netPnl') or 0) > 0])
        losses = len([trade for trade in period_trades if float(trade.get('netPnl') or 0) < 0])
        realized_pnl = sum(float(trade.get('netPnl') or 0) for trade in period_trades)
        fee_paid = sum(float(trade.get('feePaid') or 0) for trade in period_trades)
        tp_trades = len([trade for trade in period_trades if trade.get('reason') == 'tp'])
        sl_trades = len([trade for trade in period_trades if trade.get('reason') == 'sl'])
        end_trades = len([trade for trade in period_trades if trade.get('reason') == 'end_of_test'])
        signal_trades = len([trade for trade in period_trades if trade.get('reason') == 'signal'])
        profit_factor = None
        if gross_loss > 0:
            profit_factor = round(gross_profit / gross_loss, 2)
        elif gross_profit > 0:
            profit_factor = 99

        pnl = end_equity - start_equity
        open_pnl = pnl - realized_pnl
        out.append({
            'period': period_no,
            'startTime': period_start,
            'endTime': period_points[-1]['t'],
            'startEquity': round(start_equity, 2),
            'endEquity': round(end_equity, 2),
            'pnl': round(pnl, 2),
            'returnPct': round((pnl / start_equity * 100.0) if start_equity else 0, 4),
            'realizedPnl': round(realized_pnl, 2),
            'realizedReturnPct': round((realized_pnl / start_equity * 100.0) if start_equity else 0, 4),
            'openPnl': round(open_pnl, 2),
            'openReturnPct': round((open_pnl / start_equity * 100.0) if start_equity else 0, 4),
            'feePaid': round(fee_paid, 2),
            'trades': len(period_trades),
            'tpTrades': tp_trades,
            'slTrades': sl_trades,
            'signalTrades': signal_trades,
            'endTrades': end_trades,
            'wins': wins,
            'losses': losses,
            'winRatePct': round((wins / len(period_trades) * 100.0) if period_trades else 0, 2),
            'profitFactor': profit_factor,
            'maxDrawdownPct': round(_period_max_drawdown(start_equity, period_points), 4),
        })
        start_equity = end_equity
        period_start = period_end + 1
        period_no += 1

    return out


def _period_max_drawdown(start_equity, points):
    peak = float(start_equity or 0)
    max_dd = 0.0
    for point in points:
        value = float(point.get('value') or 0)
        peak = max(peak, value)
        if peak > 0:
            max_dd = max(max_dd, (peak - value) / peak * 100.0)
    return max_dd


def _observation_stats(observations):
    groups = {}
    for obs in observations:
        if not isinstance(obs, dict):
            continue
        key = (obs.get('name'), obs.get('side'))
        groups.setdefault(key, []).append(obs)

    out = []
    for (name, side), rows in sorted(groups.items(), key=lambda item: (str(item[0][0]), str(item[0][1]))):
        returns = [float(row.get('returnPct') or 0) for row in rows]
        wins = [row for row in rows if row.get('success')]
        tp_first = [row for row in rows if row.get('reason') == 'tp']
        sl_first = [row for row in rows if row.get('reason') == 'sl']
        horizon = [row for row in rows if row.get('reason') in ('horizon', 'end_of_data')]
        out.append({
            'name': name,
            'side': side,
            'count': len(rows),
            'wins': len(wins),
            'losses': len(rows) - len(wins),
            'winRatePct': round(len(wins) / len(rows) * 100.0, 2) if rows else 0,
            'avgReturnPct': round(sum(returns) / len(returns), 4) if returns else 0,
            'bestReturnPct': round(max(returns), 4) if returns else None,
            'worstReturnPct': round(min(returns), 4) if returns else None,
            'tpFirst': len(tp_first),
            'slFirst': len(sl_first),
            'horizon': len(horizon),
        })
    return out


def _sharpe(values):
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    sd = variance ** 0.5
    return None if sd == 0 else round(mean / sd, 2)


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
