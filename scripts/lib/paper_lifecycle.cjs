'use strict';

// Paper portfoy script'lerinin ortak yasam dongusu.
//
//   running    planlanan bitise kadar yeni islem acar
//   closing    planlanan bitis gecti: yeni islem yok, acik pozisyonlar SL/TP ile kapanana kadar izlenir
//   completed  bitis gecti ve acik pozisyon kalmadi
//   stopped    elle durduruldu: acik pozisyonlar son fiyattan kapatildi, bir daha islem acilmaz
//
// state.status sadece 'running' ya da 'stopped' olarak saklanir; closing/completed tarihten turetilir.

const DAY = 86_400_000;

function acceptingEntries(state, now = Date.now()) {
  return state.status === 'running' && now < Number(state.stopAt);
}

function lifecycleStatus(state, now = Date.now()) {
  if (state.status === 'stopped') return 'stopped';
  if (now < Number(state.stopAt)) return state.status;
  return Object.keys(state.positions || {}).length ? 'closing' : 'completed';
}

// Raporlardaki "gecen gun" ve gunluk getiri bu ana kadar hesaplanir; bitmis bir test
// beklerken gunluk getirisi kendiliginden erimesin.
function reportEndTime(state, now = Date.now()) {
  const status = lifecycleStatus(state, now);
  if (status === 'stopped') return Math.min(now, Number(state.stoppedAt) || now);
  if (status === 'completed') {
    const lastExit = Number(state.trades?.at(-1)?.exitTime) || 0;
    return Math.min(now, Math.max(Number(state.stopAt), lastExit));
  }
  return now;
}

function remainingMs(state, now = Date.now()) {
  if (state.status === 'stopped') return 0;
  return Math.max(0, Number(state.stopAt) - now);
}

function extendStopAt(state, days, now = Date.now()) {
  if (state.status === 'stopped') throw new Error('Durdurulmus paper testi uzatilamaz.');
  const value = Number(days);
  if (!(value > 0) || value > 365) throw new Error('--extend-days 0 ile 365 arasinda olmali.');
  state.stopAt = Math.max(now, Number(state.stopAt)) + value * DAY;
  state.stopAtIso = new Date(state.stopAt).toISOString();
  state.status = 'running';
}

// Yeni islem acilmazken sadece acik pozisyonlarin mumlarini cekip SL/TP kontrol eder.
async function manageOpenPositions(state, deps) {
  const { now, candleLimit, positionInterval, fetchCandles, processPositionCandles } = deps;
  const failures = [];
  for (const [key, position] of Object.entries(state.positions)) {
    const interval = positionInterval(position);
    try {
      const candles = await fetchCandles(position.symbol, interval, candleLimit);
      const closed = candles.filter((candle) => candle.closeTime < now);
      if (!closed.length) continue;
      processPositionCandles(state, key, closed);
      state.lastMarks[key] = closed.at(-1).c;
    } catch (error) {
      failures.push({ symbol: position.symbol, interval, stage: 'manage', error: error.message });
    }
  }
  return failures;
}

// Elle durdurma. Once tum fiyatlar cekilir; biri alinamazsa durum hic degismez.
// Kapanmis mumlarda SL/TP'ye degen pozisyon normal kurala gore kapanir, kalanlar
// son fiyattan (henuz kapanmamis mumun son fiyati) 'manual_stop' ile kapatilir.
async function stopAndCloseAll(state, deps) {
  const { now, candleLimit, positionInterval, fetchCandles, processPositionCandles, closePosition } = deps;
  if (state.status === 'stopped') return;
  const datasets = new Map();
  for (const [key, position] of Object.entries(state.positions)) {
    const candles = await fetchCandles(position.symbol, positionInterval(position), candleLimit);
    if (!candles.length) throw new Error(`${position.symbol} icin fiyat alinamadi.`);
    datasets.set(key, candles);
  }
  for (const [key, candles] of datasets) {
    processPositionCandles(state, key, candles.filter((candle) => candle.closeTime < now));
    const position = state.positions[key];
    if (!position) continue;
    const last = candles.at(-1);
    state.lastMarks[key] = last.c;
    closePosition(state, position, last.c, now, 'manual_stop');
  }
  state.status = 'stopped';
  state.stoppedAt = now;
  state.stoppedAtIso = new Date(now).toISOString();
}

module.exports = {
  acceptingEntries,
  lifecycleStatus,
  reportEndTime,
  remainingMs,
  extendStopAt,
  manageOpenPositions,
  stopAndCloseAll,
};
