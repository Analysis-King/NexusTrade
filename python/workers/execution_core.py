"""
Tek yurutme cekirdegi (F1-1).

Giris, SL/TP, gap, ayni mumda SL+TP ve maliyet kurallari burada, tek yerde. Backtest
(pool_worker `backtest`) mumlari sirayla bu cekirdege verir; paper (`paper_step`) her
kapanan mumda ayni cekirdegi bir adim calistirir ve durumu JSON olarak geri alir.
Iki yol ayni sirayla ayni metotlari cagirdigi icin ayni mumlarda ayni islemleri uretir
(bkz. tests/executionParity.test.ts).

Bir mumdaki sira:
  1. open_bar(candle)   onceki mumun sinyali bu mumun acilisinda uygulanir, sonra mum ici SL/TP
  2. portfolio()        stratejiye verilecek hesap durumu
  3. (strateji on_candle calisir)
  4. close_bar(candle, signal_data)   acik pozisyonun SL/TP guncellemesi, yeni sinyal bir sonraki
                                      mumun acilisina kuyruklanir
"""

STATE_VERSION = 1

# Sinyal sozlugunden kuyruga alinan alanlar. Giris ve risk guncellemesi sadece bunlari okur.
_SIGNAL_KEYS = ('signal', 'sl_pct', 'tp_pct', 'sl_price', 'tp_price', 'meta')


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


class ExecutionCore:
    """Bir sembolde tek pozisyonluk hesabin yurutme durumu ve kurallari."""

    def __init__(
        self,
        params=None,
        initial_capital=1000.0,
        fee_bps=0.0,
        slippage_bps=0.0,
        fill_model='pessimistic_ohlc',
        start_time=0,
    ):
        params = params if isinstance(params, dict) else {}
        self.initial = float(initial_capital)
        self.fee_rate = float(fee_bps) / 10000.0
        self.slip_rate = float(slippage_bps) / 10000.0
        self.fill_model = fill_model or 'pessimistic_ohlc'
        self.start_time = int(start_time or 0)

        self.max_position = _float_param(params, 'max_position_usd', None)
        self.max_position_pct = _float_param(params, 'max_position_pct', None)
        self.leverage = max(1.0, _float_param(params, 'leverage', 1.0) or 1.0)
        self.default_sl = _float_param(params, 'stop_loss_pct', None)
        self.default_tp = _float_param(params, 'take_profit_pct', None)
        self.stop_loss_mode = str(params.get('stop_loss_mode') or 'strategy')
        self.stop_loss_target_ratio = _float_param(params, 'stop_loss_target_ratio', 1.0) or 1.0
        self.same_candle_mode = str(params.get('same_candle_tp_sl') or 'stop_first')
        stop_trigger_mode = str(params.get('stop_trigger_mode') or 'touch').strip().lower()
        self.stop_trigger_mode = stop_trigger_mode if stop_trigger_mode in ('touch', 'close') else 'touch'
        self.exit_on_opposite_signal = _bool_param(params, 'exit_on_opposite_signal', False)
        self.min_reward_risk = max(0.0, _float_param(params, 'min_reward_risk', 0.0) or 0.0)

        self.equity = self.initial
        self.realized_pnl = 0.0
        self.position = None
        self.pending_signal = None
        self.pending_exit = None
        self.trade_count = 0
        # Bu nesnenin omrunde kapanan islemler ve acilan pozisyonlar (paper adiminda: bu adimdakiler).
        self.trades = []
        self.opened = []

    @classmethod
    def from_request(cls, params, req):
        """Backtest ve paper isteklerindeki yurutme ayarlarini ayni sekilde okur."""
        return cls(
            params,
            initial_capital=float(req.get('initial_capital') or 1000),
            fee_bps=float(req.get('fee_bps') or 0),
            slippage_bps=float(req.get('slippage_bps') or 0),
            fill_model=req.get('fill_model') or 'pessimistic_ohlc',
            start_time=int(req.get('start_time') or 0),
        )

    # --- Kalici durum (paper her adimda bunu saklar) ---

    def to_state(self):
        return {
            'v': STATE_VERSION,
            'equity': self.equity,
            'realized_pnl': self.realized_pnl,
            'position': self.position,
            'pending_signal': self.pending_signal,
            'pending_exit': self.pending_exit,
            'trade_count': self.trade_count,
        }

    def load_state(self, state):
        if not state:
            return self
        if int(state.get('v') or 0) != STATE_VERSION:
            raise ValueError(f"Desteklenmeyen cekirdek durumu surumu: {state.get('v')}")
        self.equity = float(state['equity'])
        self.realized_pnl = float(state['realized_pnl'])
        self.position = state.get('position')
        self.pending_signal = state.get('pending_signal')
        self.pending_exit = state.get('pending_exit')
        self.trade_count = int(state.get('trade_count') or 0)
        return self

    # --- Mum adimlari ---

    def open_bar(self, candle):
        """Bekleyen cikis ve sinyali mumun acilisinda uygular, sonra mum ici SL/TP'yi kontrol eder."""
        open_price = candle.get('o', candle['c'])
        if self.pending_exit is not None and self.position is not None:
            self._close(open_price, candle['t'], self.pending_exit)
        self.pending_exit = None

        pending = self.pending_signal
        self.pending_signal = None
        if pending is not None:
            self._apply_pending_signal(pending, candle, open_price)

        if self.position is not None:
            exit_price, reason = _stop_or_target_price(
                self.position,
                candle,
                self.fill_model,
                self.same_candle_mode,
                self.stop_trigger_mode,
            )
            if exit_price is not None and self.fill_model == 'pessimistic_ohlc':
                self._close(exit_price, candle['t'], reason)
            elif exit_price is not None:
                self.pending_exit = reason

    def portfolio(self):
        portfolio = {
            'usdt': self.equity,
            'has_position': self.position is not None,
            'pnl': self.realized_pnl,
        }
        if self.position is not None:
            portfolio['side'] = 'BUY' if self.position['side'] == 'long' else 'SELL'
        return portfolio

    def close_bar(self, candle, signal_data, has_next_bar=True):
        """Strateji calistiktan sonra: SL/TP guncellemesi ve sinyalin sonraki muma kuyruklanmasi."""
        if self.position is not None:
            _apply_risk_update(
                self.position,
                signal_data,
                candle['c'],
                self.stop_loss_mode,
                self.stop_loss_target_ratio,
                self.min_reward_risk,
                self.fee_rate,
                self.slip_rate,
            )
        signal = signal_data.get('signal') or 'hold'
        can_trade_now = self.start_time <= 0 or int(candle.get('t') or 0) >= self.start_time
        if can_trade_now and signal in ('buy', 'sell', 'close') and has_next_bar:
            self.pending_signal = {key: signal_data.get(key) for key in _SIGNAL_KEYS}

    def mark(self, price):
        return self.equity + (_unrealized_pnl(self.position, price) if self.position is not None else 0.0)

    def close_open_position(self, candle, reason='end_of_test'):
        if self.position is not None:
            self._close(candle['c'], candle['t'], reason)

    # --- Ic kurallar ---

    def _apply_pending_signal(self, pending, candle, open_price):
        signal = pending.get('signal') or 'hold'
        if signal == 'close':
            if self.position is not None:
                self._close(open_price, candle['t'], 'signal')
            return

        wanted_side = 'long' if signal == 'buy' else 'short'
        if self.position is not None and self.position['side'] != wanted_side:
            if not self.exit_on_opposite_signal:
                return
            self._close(open_price, candle['t'], 'signal')

        if self.position is None:
            if self.max_position_pct is not None and self.max_position_pct > 0:
                allocation_pct = min(100.0, self.max_position_pct)
                position_cap = self.equity * allocation_pct / 100.0 * self.leverage
            else:
                position_cap = self.initial * self.leverage
            if self.max_position is not None and self.max_position > 0:
                position_cap = min(position_cap, self.max_position)
            position = _open_position(
                wanted_side,
                candle,
                self.equity,
                position_cap,
                self.fee_rate,
                self.slip_rate,
                pending.get('sl_pct') if pending.get('sl_pct') is not None else self.default_sl,
                pending.get('tp_pct') if pending.get('tp_pct') is not None else self.default_tp,
                pending.get('sl_price'),
                pending.get('tp_price'),
                self.stop_loss_mode,
                self.stop_loss_target_ratio,
                self.min_reward_risk,
                pending.get('meta'),
                price_key='o',
            )
            if position is not None:
                self.equity -= position['entry_fee']
                self.position = position
                self.opened.append(dict(position))
        elif self.position['side'] == wanted_side:
            _apply_risk_update(
                self.position,
                pending,
                open_price,
                self.stop_loss_mode,
                self.stop_loss_target_ratio,
                self.min_reward_risk,
                self.fee_rate,
                self.slip_rate,
            )

    def _close(self, raw_exit_price, exit_time, reason):
        self.equity, self.realized_pnl, trade = _close_position(
            self.position,
            raw_exit_price,
            exit_time,
            reason,
            self.fee_rate,
            self.slip_rate,
            self.equity,
            self.realized_pnl,
            self.trade_count + 1,
        )
        self.trade_count += 1
        self.trades.append(trade)
        self.position = None
        return trade


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


def _stop_or_target_price(
    position,
    candle,
    fill_model='pessimistic_ohlc',
    same_candle_mode='stop_first',
    stop_trigger_mode='touch',
):
    side = position['side']
    sl = position.get('sl')
    tp = position.get('tp')
    open_price = float(candle.get('o', candle['c']))
    close_price = float(candle['c'])

    if fill_model == 'close_next_open':
        if side == 'long':
            if sl is not None and close_price <= sl:
                return sl, 'sl'
            if tp is not None and close_price >= tp:
                return tp, 'tp'
        else:
            if sl is not None and close_price >= sl:
                return sl, 'sl'
            if tp is not None and close_price <= tp:
                return tp, 'tp'
        return None, None

    if side == 'long':
        if stop_trigger_mode == 'touch' and sl is not None and open_price <= sl:
            return open_price, 'sl'
        if tp is not None and open_price >= tp:
            return open_price, 'tp'
        hit_sl = sl is not None and (
            close_price <= sl if stop_trigger_mode == 'close' else candle['l'] <= sl
        )
        hit_tp = tp is not None and candle['h'] >= tp
    else:
        if stop_trigger_mode == 'touch' and sl is not None and open_price >= sl:
            return open_price, 'sl'
        if tp is not None and open_price <= tp:
            return open_price, 'tp'
        hit_sl = sl is not None and (
            close_price >= sl if stop_trigger_mode == 'close' else candle['h'] >= sl
        )
        hit_tp = tp is not None and candle['l'] <= tp
    if hit_sl and hit_tp:
        if same_candle_mode == 'take_profit_first':
            return tp, 'tp'
        return (close_price if stop_trigger_mode == 'close' else sl), 'sl'
    if hit_sl:
        return (close_price if stop_trigger_mode == 'close' else sl), 'sl'
    if hit_tp:
        return tp, 'tp'
    return None, None


def _close_position(position, raw_exit_price, exit_time, reason, fee_rate, slip_rate, equity, realized_pnl, trade_number):
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
    trade = {
        'id': f"tr_{trade_number}",
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
    }
    return equity, realized_pnl, trade


def _unrealized_pnl(position, price):
    if position is None:
        return 0.0
    side = position['side']
    entry = position['entry_price']
    qty = position['qty']
    return (price - entry) * qty if side == 'long' else (entry - price) * qty
