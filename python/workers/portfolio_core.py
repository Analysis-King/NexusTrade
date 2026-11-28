"""
Cok sembollu portfoy cekirdegi (F1-7).

Ayni sermayeyi paylasan birden cok anahtar ("SEMBOL|periyot"). Giris, SL/TP, gap, ayni mumda
SL+TP ve maliyet kurallari execution_core'daki yardimcilarla ayni; kural parametreleri de
ExecutionCore ile ayni sekilde okunur. Burada sadece portfoy katmani var:

  - ortak sermaye; en fazla `max_positions` acik pozisyon
  - pozisyon buyuklugu: sermaye / max_positions x kaldirac (sinyalin kabul edildigi an)
  - ayni anda gelen giris sinyalleri puana gore siralanir, bos yer kadari kabul edilir
  - ayni formasyona (ayni D noktasi) tek islem
  - istege bagli ust periyot onayi: giris sinyali, ust periyotta ayni yonde yakin zamanli bir
    sinyal varsa kabul edilir

Backtest (pool_worker `portfolio_backtest`) ve paper (`portfolio_run`) ayni `run` metodunu
kullanir. Paper her calismada durumu geri yukler ve kaldigi mumdan devam eder; kapali kalinan
surede kapanan mumlar sirayla islenir. Iki yolun ayni islemleri urettigi
tests/portfolioParity.test.ts'te dogrulaniyor.

Bir zaman adiminda (ayni anda kapanan mumlar) sira:
  1. her anahtar: kabul edilmis giris bu mumun acilisinda acilir, sonra mum ici SL/TP
  2. her anahtar (once ust periyotlar): strateji; acik pozisyonun SL/TP guncellemesi; yeni
     giris adaylari
  3. adaylar puana gore siralanir, bos yer kadari kabul edilir (bir sonraki mumun acilisinda)

Strateji modulu her paper calismasinda yeniden yuklenir; modulun kendi ic durumu calismalar
arasinda tasinmaz. Kararini sadece mum penceresinden ve portfoy durumundan veren stratejiler
(kilitli ayarlariyla harmonik stratejiler gibi) backtest ile ayni sonucu verir.
"""

import math

from execution_core import (
    _SIGNAL_KEYS,
    ExecutionCore,
    _apply_risk_update,
    _close_position,
    _open_position,
    _stop_or_target_price,
    _unrealized_pnl,
)

PORTFOLIO_STATE_VERSION = 1
SCORE_MODES = ('target_distance', 'quality', 'quality_target')
SEEN_SIGNAL_LIMIT = 10000
_INTERVAL_UNIT_MS = {'m': 60_000, 'h': 3_600_000, 'd': 86_400_000, 'w': 604_800_000}
_COUNTERS = (
    'entries',
    'rejected_signals',
    'rejected_htf',
    'rejected_at_entry',
    'duplicate_signals',
    'short_window_bars',
    'late_bars',
)


def interval_ms(interval):
    text = str(interval or '').strip()
    if len(text) < 2 or text[-1] not in _INTERVAL_UNIT_MS or not text[:-1].isdigit():
        raise ValueError(f'Gecersiz periyot: {interval}')
    return int(text[:-1]) * _INTERVAL_UNIT_MS[text[-1]]


def split_key(key):
    symbol, _, interval = str(key).partition('|')
    if not symbol or not interval:
        raise ValueError(f'Gecersiz portfoy anahtari: {key} (SEMBOL|periyot olmali)')
    return symbol, interval


class PortfolioCore:
    """Ortak sermayeli, cok anahtarli paper/backtest portfoyu."""

    def __init__(self, params=None, options=None):
        options = options if isinstance(options, dict) else {}
        # Islem kurallari (maliyet, SL/TP modu, ayni mumda SL+TP, stop tetigi) tek cekirdekle ayni.
        self.rules = ExecutionCore.from_request(params, options)
        if self.rules.fill_model != 'pessimistic_ohlc':
            raise ValueError('Portfoy sadece pessimistic_ohlc dolum modelini destekler')

        self.initial = self.rules.initial
        self.max_positions = max(1, int(options.get('max_positions') or 1))
        self.leverage = float(options.get('leverage') or 1.0)
        if not self.leverage > 0:
            raise ValueError('leverage 0dan buyuk olmali')
        self.score_mode = str(options.get('score_mode') or 'target_distance')
        if self.score_mode not in SCORE_MODES:
            raise ValueError(f'Bilinmeyen score_mode: {self.score_mode}')
        # Bos = tum periyotlarda giris.
        self.entry_intervals = [str(item) for item in (options.get('entry_intervals') or [])]
        self.confirm_intervals = sorted(
            {str(item) for item in (options.get('confirm_intervals') or [])},
            key=interval_ms,
        )
        self.confirm_bars = max(1, int(options.get('confirm_bars') or 3))
        history = options.get('max_history_bars')
        self.max_history_bars = 500 if history is None else max(0, int(history))
        self.start_time = int(options.get('start_time') or 0)
        self.accept_entries = options.get('accept_entries') is not False
        # Paper: penceresi dolmamis mumda strateji calismaz (backtest'te ilk mumlar kisa pencereyle
        # calisir). SL/TP her mumda islenir.
        self.require_full_window = bool(options.get('require_full_window'))

        self.equity = self.initial
        self.realized_pnl = 0.0
        self.trade_count = 0
        self.position_seq = 0
        self.positions = {}
        self.pending = {}
        self.last_t = {}
        self.last_marks = {}
        self.clock = 0
        self.seen_signal_keys = []
        self._seen = set()
        self.htf_signals = {}
        self.counters = {name: 0 for name in _COUNTERS}
        self.peak_equity = self.initial
        self.max_drawdown_pct = 0.0
        self.mark_equity = self.initial
        self.mark_peak_equity = self.initial
        self.mark_max_drawdown_pct = 0.0

        # Bu nesnenin omrunde (paper: bu calismada) olanlar.
        self.trades = []
        self.opened = []
        self.equity_curve = []

    # --- Kalici durum ---

    def to_state(self):
        return {
            'v': PORTFOLIO_STATE_VERSION,
            'equity': self.equity,
            'realized_pnl': self.realized_pnl,
            'trade_count': self.trade_count,
            'position_seq': self.position_seq,
            'positions': self.positions,
            'pending': self.pending,
            'last_t': self.last_t,
            'last_marks': self.last_marks,
            'clock': self.clock,
            'seen_signal_keys': self.seen_signal_keys,
            'htf_signals': self.htf_signals,
            'counters': self.counters,
            'peak_equity': self.peak_equity,
            'max_drawdown_pct': self.max_drawdown_pct,
            'mark_equity': self.mark_equity,
            'mark_peak_equity': self.mark_peak_equity,
            'mark_max_drawdown_pct': self.mark_max_drawdown_pct,
        }

    def load_state(self, state):
        if not state:
            return self
        if int(state.get('v') or 0) != PORTFOLIO_STATE_VERSION:
            raise ValueError(f"Desteklenmeyen portfoy durumu surumu: {state.get('v')}")
        self.equity = float(state['equity'])
        self.realized_pnl = float(state['realized_pnl'])
        self.trade_count = int(state.get('trade_count') or 0)
        self.position_seq = int(state.get('position_seq') or 0)
        self.positions = dict(state.get('positions') or {})
        self.pending = dict(state.get('pending') or {})
        self.last_t = {key: int(value) for key, value in (state.get('last_t') or {}).items()}
        self.last_marks = {key: float(value) for key, value in (state.get('last_marks') or {}).items()}
        self.clock = int(state.get('clock') or 0)
        self.seen_signal_keys = list(state.get('seen_signal_keys') or [])
        self._seen = set(self.seen_signal_keys)
        self.htf_signals = dict(state.get('htf_signals') or {})
        self.counters = {name: int((state.get('counters') or {}).get(name) or 0) for name in _COUNTERS}
        self.peak_equity = float(state.get('peak_equity') or self.equity)
        self.max_drawdown_pct = float(state.get('max_drawdown_pct') or 0.0)
        self.mark_equity = float(state.get('mark_equity') or self.equity)
        self.mark_peak_equity = float(state.get('mark_peak_equity') or self.mark_equity)
        self.mark_max_drawdown_pct = float(state.get('mark_max_drawdown_pct') or 0.0)
        return self

    # --- Calistirma ---

    def run(self, datasets, strategy):
        """
        datasets: {anahtar: [kapanmis mumlar, zamana gore sirali]}
        strategy(anahtar, mum, pencere, portfoy) -> sinyal sozlugu (pool_worker._run_on_candle)

        Her anahtarda last_t'den sonraki ve start_time'dan sonra kapanan mumlar, kapanis
        zamanina gore sirayla islenir.
        """
        info = {}
        steps = {}
        for key, candles in datasets.items():
            symbol, interval = split_key(key)
            step = interval_ms(interval)
            info[key] = (symbol, interval, step)
            last = self.last_t.get(key)
            for index, candle in enumerate(candles):
                t = int(candle['t'])
                if last is not None and t <= last:
                    continue
                if t + step <= self.start_time:
                    continue
                steps.setdefault(t + step, []).append((key, index))
        for close_time in sorted(steps):
            items = sorted(steps[close_time], key=lambda item: (-info[item[0]][2], item[0]))
            self._step(close_time, items, datasets, info, strategy)

    def close_all(self, prices, exit_time, reason='manual_stop'):
        """Elle durdurma: bekleyen girisler atilir, acik pozisyonlar verilen fiyattan kapatilir."""
        self.pending = {}
        for key in sorted(self.positions):
            price = (prices or {}).get(key)
            if price is None:
                price = self.last_marks.get(key)
            if price is None:
                raise ValueError(f'{key} icin kapanis fiyati yok')
            self.last_marks[key] = float(price)
            self._close(key, float(price), int(exit_time), reason)
        self._mark(int(exit_time))

    def close_at_end(self, datasets, reason='end_of_test'):
        """Backtest sonu: acik pozisyonlar kendi son mumunun kapanisindan kapatilir."""
        for key in sorted(self.positions):
            candles = datasets.get(key) or []
            if not candles:
                continue
            last = candles[-1]
            self._close(key, float(last['c']), int(last['t']), reason)
        self.pending = {}

    # --- Ic adimlar ---

    def _step(self, close_time, items, datasets, info, strategy):
        late = close_time <= self.clock
        for key, index in items:
            candle = datasets[key][index]
            self._open_bar(key, info[key], candle)
            self.last_t[key] = int(candle['t'])
            self.last_marks[key] = float(candle['c'])
        if late:
            # Bir anahtarin verisi onceki calismada alinamadiysa mumlari gecmiste kalir: SL/TP
            # islenir ama strateji calismaz (diger anahtarlar zaten ilerledi).
            self.counters['late_bars'] += len(items)
            return

        candidates = []
        for key, index in items:
            candles = datasets[key]
            candle = candles[index]
            start = 0 if not self.max_history_bars else max(0, index - self.max_history_bars + 1)
            if self.require_full_window and self.max_history_bars and index - start + 1 < self.max_history_bars:
                self.counters['short_window_bars'] += 1
                continue
            signal_data = strategy(key, candle, candles[start:index + 1], self._portfolio_view(key))
            self._after_strategy(key, info[key], candle, signal_data or {}, candidates)
        self._select(candidates)
        self.clock = close_time
        self._mark(close_time)

    def _open_bar(self, key, key_info, candle):
        rules = self.rules
        open_price = float(candle.get('o', candle['c']))
        pending = self.pending.pop(key, None)
        position = self.positions.get(key)
        if pending is not None:
            signal = pending.get('signal')
            if position is not None and signal == 'close':
                self._close(key, open_price, int(candle['t']), 'signal')
            elif position is not None and (signal == 'buy') == (position['side'] == 'long'):
                _apply_risk_update(
                    position,
                    pending,
                    open_price,
                    rules.stop_loss_mode,
                    rules.stop_loss_target_ratio,
                    rules.min_reward_risk,
                    rules.fee_rate,
                    rules.slip_rate,
                )
            elif position is not None and pending.get('reverse'):
                # Ters sinyal (exit_on_opposite_signal): acilista kapat, ayni yerde ters yone gir.
                # Buyukluk tek cekirdekteki gibi kapanistan sonraki sermayeyle.
                self._close(key, open_price, int(candle['t']), 'signal')
                position = None
            entry = pending if pending.get('entry') else pending.get('entry_after')
            if self.positions.get(key) is None and entry:
                if entry.get('notional') is None:
                    entry = {**entry, 'notional': self._position_notional()}
                self._enter(key, key_info, entry, candle)

        position = self.positions.get(key)
        if position is not None:
            exit_price, reason = _stop_or_target_price(
                position,
                candle,
                rules.fill_model,
                rules.same_candle_mode,
                rules.stop_trigger_mode,
            )
            if exit_price is not None:
                self._close(key, exit_price, int(candle['t']), reason)

    def _enter(self, key, key_info, pending, candle):
        rules = self.rules
        side = 'long' if pending.get('signal') == 'buy' else 'short'
        notional = float(pending.get('notional') or 0.0)
        position = None
        if notional > 0:
            position = _open_position(
                side,
                candle,
                self.equity,
                notional,
                rules.fee_rate,
                rules.slip_rate,
                pending.get('sl_pct') if pending.get('sl_pct') is not None else rules.default_sl,
                pending.get('tp_pct') if pending.get('tp_pct') is not None else rules.default_tp,
                pending.get('sl_price'),
                pending.get('tp_price'),
                rules.stop_loss_mode,
                rules.stop_loss_target_ratio,
                rules.min_reward_risk,
                pending.get('meta'),
                price_key='o',
            )
        if position is None:
            # Gerceklesen giris fiyatinda hedef gecersiz ya da maliyeti karsilamiyor.
            self.counters['rejected_at_entry'] += 1
            return
        symbol, interval, _ = key_info
        self.position_seq += 1
        self.equity -= position['entry_fee']
        position.update({
            'id': f'pp_{self.position_seq}',
            'key': key,
            'symbol': symbol,
            'interval': interval,
            'signal_time': pending.get('signal_time'),
            'signal_key': pending.get('signal_key'),
            'score': pending.get('score'),
            'target_pct': pending.get('target_pct'),
        })
        self.positions[key] = position
        self.opened.append(dict(position))
        self.counters['entries'] += 1
        signal_key = pending.get('signal_key')
        if signal_key:
            self.seen_signal_keys.append(signal_key)
            self._seen.add(signal_key)
            if len(self.seen_signal_keys) > SEEN_SIGNAL_LIMIT:
                del self.seen_signal_keys[:len(self.seen_signal_keys) - SEEN_SIGNAL_LIMIT]
                self._seen = set(self.seen_signal_keys)

    def _close(self, key, raw_exit_price, exit_time, reason):
        rules = self.rules
        position = self.positions.pop(key)
        self.equity, self.realized_pnl, trade = _close_position(
            position,
            raw_exit_price,
            exit_time,
            reason,
            rules.fee_rate,
            rules.slip_rate,
            self.equity,
            self.realized_pnl,
            self.trade_count + 1,
        )
        self.trade_count += 1
        trade.update({
            'positionId': position.get('id'),
            'key': key,
            'symbol': position.get('symbol'),
            'interval': position.get('interval'),
            'signalTime': position.get('signal_time'),
            'targetPct': position.get('target_pct'),
            'score': position.get('score'),
        })
        self.trades.append(trade)
        self.peak_equity = max(self.peak_equity, self.equity)
        if self.peak_equity > 0:
            drawdown = (self.peak_equity - self.equity) / self.peak_equity * 100.0
            self.max_drawdown_pct = max(self.max_drawdown_pct, drawdown)
        return trade

    def _portfolio_view(self, key):
        position = self.positions.get(key)
        view = {'usdt': self.equity, 'has_position': position is not None, 'pnl': self.realized_pnl}
        if position is not None:
            view['side'] = 'BUY' if position['side'] == 'long' else 'SELL'
        return view

    def _after_strategy(self, key, key_info, candle, signal_data, candidates):
        rules = self.rules
        symbol, interval, step = key_info
        signal = signal_data.get('signal') or 'hold'
        if interval in self.confirm_intervals:
            self._remember_htf(key, step, signal_data, candle)

        position = self.positions.get(key)
        if position is not None:
            # Tek cekirdekteki close_bar ile ayni: SL/TP guncellemesi, sinyal sonraki acilisa.
            _apply_risk_update(
                position,
                signal_data,
                candle['c'],
                rules.stop_loss_mode,
                rules.stop_loss_target_ratio,
                rules.min_reward_risk,
                rules.fee_rate,
                rules.slip_rate,
            )
            if signal not in ('buy', 'sell', 'close'):
                return
            queued = {name: signal_data.get(name) for name in _SIGNAL_KEYS}
            opposite = signal != 'close' and (signal == 'buy') != (position['side'] == 'long')
            if opposite and rules.exit_on_opposite_signal:
                queued['reverse'] = True
                queued['entry_after'] = self._entry_candidate(key, key_info, candle, signal_data)
            self.pending[key] = queued
            return

        if signal not in ('buy', 'sell'):
            return
        entry = self._entry_candidate(key, key_info, candle, signal_data)
        if entry is not None:
            candidates.append((key, entry))

    def _entry_candidate(self, key, key_info, candle, signal_data):
        """Giris kurallari (periyot, ust periyot onayi, ayni formasyon); gecerse bekleyen giris."""
        symbol, interval, step = key_info
        if not self.accept_entries:
            return None
        if self.entry_intervals and interval not in self.entry_intervals:
            return None
        side = 'long' if signal_data.get('signal') == 'buy' else 'short'
        meta = signal_data.get('meta') if isinstance(signal_data.get('meta'), dict) else {}

        confirmation = None
        if self.confirm_intervals:
            confirmation = self._htf_confirmation(symbol, step, side)
            if confirmation is None:
                self.counters['rejected_htf'] += 1
                return None

        signal_key = _signal_key(key, meta)
        if signal_key and signal_key in self._seen:
            self.counters['duplicate_signals'] += 1
            return None

        target_pct = _target_pct(signal_data, float(candle['c']))
        entry = {name: signal_data.get(name) for name in _SIGNAL_KEYS}
        if confirmation is not None:
            entry['meta'] = {
                **meta,
                'htf_confirmed': True,
                'htf_interval': confirmation['interval'],
                'htf_pattern': confirmation.get('pattern'),
                'htf_direction': confirmation.get('direction'),
                'htf_signal_time': confirmation.get('signal_time'),
                'htf_quality': confirmation.get('quality'),
            }
        entry.update({
            'entry': True,
            'signal_time': int(candle['t']),
            'signal_key': signal_key,
            'target_pct': target_pct,
            'score': _score(self.score_mode, meta.get('quality'), target_pct),
        })
        return entry

    def _position_notional(self):
        return self.equity / self.max_positions * self.leverage

    def _select(self, candidates):
        if not candidates:
            return
        reserved = len(self.positions) + sum(1 for item in self.pending.values() if item.get('entry'))
        slots = max(0, self.max_positions - reserved)
        notional = self._position_notional()
        if not notional > 0:
            slots = 0
        # Python siralamasi kararli: esit puanda once ust periyot, sonra anahtar adi.
        candidates.sort(key=lambda item: item[1]['score'], reverse=True)
        for key, entry in candidates[:slots]:
            entry['notional'] = notional
            self.pending[key] = entry
        self.counters['rejected_signals'] += max(0, len(candidates) - slots)

    def _remember_htf(self, key, step, signal_data, candle):
        signal = signal_data.get('signal')
        if signal not in ('buy', 'sell'):
            return
        meta = signal_data.get('meta') if isinstance(signal_data.get('meta'), dict) else {}
        signal_time = _positive_int(meta.get('d_time')) or _positive_int(meta.get('signal_time')) or int(candle['t'])
        self.htf_signals[key] = {
            'signal': signal,
            'pattern': meta.get('pattern'),
            'direction': meta.get('direction'),
            'quality': meta.get('quality'),
            'signal_time': signal_time,
            'expires_at': signal_time + step * self.confirm_bars,
        }

    def _htf_confirmation(self, symbol, step, side):
        expected = 'buy' if side == 'long' else 'sell'
        for interval in self.confirm_intervals:
            if interval_ms(interval) <= step:
                continue
            key = f'{symbol}|{interval}'
            item = self.htf_signals.get(key)
            if item is None or item.get('signal') != expected:
                continue
            # Ust periyot sinyali, o periyodun son kapanan mumu itibariyla hala gecerli mi.
            if int(item.get('expires_at') or 0) < int(self.last_t.get(key, 0)):
                continue
            return {'interval': interval, **item}
        return None

    def _mark(self, time):
        mark = self.equity
        for key, position in self.positions.items():
            mark += _unrealized_pnl(position, self.last_marks.get(key, position['entry_price']))
        self.mark_equity = mark
        self.mark_peak_equity = max(self.mark_peak_equity, mark)
        if self.mark_peak_equity > 0:
            drawdown = (self.mark_peak_equity - mark) / self.mark_peak_equity * 100.0
            self.mark_max_drawdown_pct = max(self.mark_max_drawdown_pct, drawdown)
        self.equity_curve.append({'t': time, 'value': round(mark, 2)})


def _signal_key(key, meta):
    """Ayni formasyona tek islem: strateji signal_key verirse o, yoksa harmonik D noktasi."""
    custom = meta.get('signal_key')
    if custom not in (None, ''):
        return f'{key}|{custom}'
    d_time = _positive_int(meta.get('d_time'))
    if d_time is None:
        return None
    return '|'.join(str(part) for part in (
        key,
        meta.get('pattern'),
        meta.get('zigzag_length'),
        meta.get('direction'),
        d_time,
    ))


def _target_pct(signal_data, reference):
    tp_price = signal_data.get('tp_price')
    if tp_price is not None and reference > 0:
        return abs(float(tp_price) - reference) / reference * 100.0
    tp_pct = signal_data.get('tp_pct')
    if tp_pct is not None:
        return abs(float(tp_pct))
    return 0.0


def _score(mode, quality, target_pct):
    try:
        quality = max(0.0, float(quality or 0.0))
    except (TypeError, ValueError):
        quality = 0.0
    if mode == 'quality':
        score = quality
    elif mode == 'quality_target':
        score = quality * math.sqrt(max(0.0, target_pct))
    else:
        score = target_pct
    return score if math.isfinite(score) else 0.0


def _positive_int(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None
