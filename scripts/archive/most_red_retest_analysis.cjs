const fs = require('node:fs');
const path = require('node:path');

const DAY = 86_400_000;
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_JSON = path.join(ROOT, 'data', 'most_red_retest_50_symbols_1h_90d_20260613.json');
const OUT_MD = path.join(ROOT, 'data', 'most_red_retest_50_symbols_1h_90d_20260613.md');
const INTERVAL = '1h';
const ANALYSIS_DAYS = 90;
const WARMUP_DAYS = 180;
const MA_PERIOD = 5;
const MOST_PERCENT = 2;
const CONCURRENCY = 5;

const SYMBOLS = [
  'ZECUSDT', 'ALLOUSDT', 'PEPEUSDT', 'ENAUSDT', 'STGUSDT', 'HOMEUSDT', 'HMSTRUSDT',
  'PYTHUSDT', 'OPNUSDT', 'TRUMPUSDT', 'LTCUSDT', 'DOGEUSDT', 'BTCUSDT', 'BNBUSDT',
  'DEXEUSDT', 'TRXUSDT', 'SUIUSDT', 'LINKUSDT', 'UTKUSDT', 'ETHUSDT', 'XLMUSDT',
  'UNIUSDT', 'AAVEUSDT', 'BCHUSDT', 'ADAUSDT', 'IDUSDT', 'EPICUSDT', 'ONDOUSDT',
  'SXTUSDT', 'XRPUSDT', 'TAOUSDT', 'XPLUSDT', 'HOLOUSDT', 'INJUSDT', 'CHZUSDT',
  'ASTERUSDT', 'LUMIAUSDT', 'HBARUSDT', 'SOLUSDT', 'AVAXUSDT', 'TONUSDT', 'FIDAUSDT',
  'WLDUSDT', 'FETUSDT', 'ZROUSDT', 'CRVUSDT', 'ATOMUSDT', 'NEARUSDT', 'SAHARAUSDT',
  'BABYUSDT',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, tries = 5) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchCandles(symbol, startMs, endMs) {
  const candles = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', INTERVAL);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endMs));
    url.searchParams.set('limit', '1000');
    const raw = await fetchJson(url);
    if (!Array.isArray(raw) || !raw.length) break;
    for (const row of raw) {
      candles.push({
        t: Number(row[0]),
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
      });
    }
    const next = Number(raw.at(-1)[6]) + 1;
    if (next <= cursor || raw.length < 1000) break;
    cursor = next;
    await sleep(20);
  }
  return [...new Map(candles.map((candle) => [candle.t, candle])).values()]
    .sort((a, b) => a.t - b.t);
}

function mostSeries(candles) {
  const percent = MOST_PERCENT / 100;
  const alpha = 2 / (MA_PERIOD + 1);
  const ma = [];
  const longStop = [];
  const shortStop = [];
  const direction = [];
  const most = [];

  for (let index = 0; index < candles.length; index += 1) {
    const close = candles[index].c;
    const maValue = index === 0 ? close : close * alpha + ma[index - 1] * (1 - alpha);
    const baseLong = maValue * (1 - percent);
    const baseShort = maValue * (1 + percent);
    let longValue = baseLong;
    let shortValue = baseShort;
    let dirValue = close >= maValue ? 1 : -1;

    if (index > 0) {
      const previousLong = longStop[index - 1];
      const previousShort = shortStop[index - 1];
      const previousDirection = direction[index - 1];
      longValue = maValue > previousLong ? Math.max(baseLong, previousLong) : baseLong;
      shortValue = maValue < previousShort ? Math.min(baseShort, previousShort) : baseShort;
      if (previousDirection === -1 && maValue > previousShort) dirValue = 1;
      else if (previousDirection === 1 && maValue < previousLong) dirValue = -1;
      else dirValue = previousDirection;
    }

    ma.push(maValue);
    longStop.push(longValue);
    shortStop.push(shortValue);
    direction.push(dirValue);
    most.push(dirValue === 1 ? longValue : shortValue);
  }
  return { ma, direction, most };
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function median(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function pct(count, total) {
  return total ? count / total * 100 : 0;
}

function analyze(symbol, candles, analysisStartMs) {
  const series = mostSeries(candles);
  const regimes = [];

  for (let flipIndex = 1; flipIndex < candles.length; flipIndex += 1) {
    if (!(series.direction[flipIndex - 1] > 0 && series.direction[flipIndex] < 0)) continue;
    if (candles[flipIndex].t < analysisStartMs) continue;

    let endIndex = candles.length - 1;
    for (let index = flipIndex + 1; index < candles.length; index += 1) {
      if (series.direction[index] > 0) {
        endIndex = index - 1;
        break;
      }
    }

    let firstTouch = null;
    let touchBars = 0;
    let rejectionBars = 0;
    let closeReclaims = 0;
    let closestDistancePct = Number.POSITIVE_INFINITY;

    for (let index = flipIndex + 1; index <= endIndex; index += 1) {
      const candle = candles[index];
      const line = series.most[index];
      const belowBeforeTouch = candle.o < line;
      const touchedFromBelow = belowBeforeTouch && candle.h >= line;
      const distancePct = line > 0 ? Math.max(0, line - candle.h) / line * 100 : null;
      if (Number.isFinite(distancePct)) closestDistancePct = Math.min(closestDistancePct, distancePct);

      if (touchedFromBelow) {
        touchBars += 1;
        if (firstTouch === null) firstTouch = index;
        if (candle.c < line) rejectionBars += 1;
        if (candle.c >= line) closeReclaims += 1;
      }
    }

    const durationBars = Math.max(0, endIndex - flipIndex);
    const firstTouchBars = firstTouch === null ? null : firstTouch - flipIndex;
    regimes.push({
      symbol,
      flipTime: candles[flipIndex].t,
      durationBars,
      touched: firstTouch !== null,
      firstTouchBars,
      touchBars,
      rejectionBars,
      closeReclaims,
      closestDistancePct: round(closestDistancePct, 4),
    });
  }

  const touched = regimes.filter((regime) => regime.touched);
  return {
    symbol,
    redRegimes: regimes.length,
    touchedRegimes: touched.length,
    touchRatePct: round(pct(touched.length, regimes.length)),
    touchWithin3Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 3).length, regimes.length)),
    touchWithin6Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 6).length, regimes.length)),
    touchWithin12Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 12).length, regimes.length)),
    touchWithin24Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 24).length, regimes.length)),
    medianFirstTouchBars: round(median(touched.map((regime) => regime.firstTouchBars)), 1),
    avgFirstTouchBars: round(mean(touched.map((regime) => regime.firstTouchBars)), 1),
    touchedBars: regimes.reduce((sum, regime) => sum + regime.touchBars, 0),
    rejectionBars: regimes.reduce((sum, regime) => sum + regime.rejectionBars, 0),
    closeReclaims: regimes.reduce((sum, regime) => sum + regime.closeReclaims, 0),
    rejectionRatePct: round(pct(
      regimes.reduce((sum, regime) => sum + regime.rejectionBars, 0),
      regimes.reduce((sum, regime) => sum + regime.touchBars, 0),
    )),
    regimes,
  };
}

function aggregate(rows) {
  const regimes = rows.flatMap((row) => row.regimes);
  const touched = regimes.filter((regime) => regime.touched);
  const touchBars = regimes.reduce((sum, regime) => sum + regime.touchBars, 0);
  const rejectionBars = regimes.reduce((sum, regime) => sum + regime.rejectionBars, 0);
  return {
    symbols: rows.length,
    redRegimes: regimes.length,
    touchedRegimes: touched.length,
    touchRatePct: round(pct(touched.length, regimes.length)),
    touchWithin3Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 3).length, regimes.length)),
    touchWithin6Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 6).length, regimes.length)),
    touchWithin12Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 12).length, regimes.length)),
    touchWithin24Pct: round(pct(touched.filter((regime) => regime.firstTouchBars <= 24).length, regimes.length)),
    medianFirstTouchBars: round(median(touched.map((regime) => regime.firstTouchBars)), 1),
    avgFirstTouchBars: round(mean(touched.map((regime) => regime.firstTouchBars)), 1),
    touchBars,
    rejectionBars,
    closeReclaims: regimes.reduce((sum, regime) => sum + regime.closeReclaims, 0),
    rejectionRatePct: round(pct(rejectionBars, touchBars)),
  };
}

function markdown(report) {
  const lines = [];
  lines.push('# MOST Kirmizi Donem Asagidan Retest Analizi');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Kosullar: ${INTERVAL}, son ${ANALYSIS_DAYS} gun, ${WARMUP_DAYS} gun warmup, MOST ${MA_PERIOD}/${MOST_PERCENT}.`);
  lines.push('');
  lines.push('Temas tanimi: MOST kirmiziya dondukten sonraki mumlarda, mum acilisinin MOST altinda olmasi ve mum tepesinin MOST cizgisine ulasmasi.');
  lines.push('');
  lines.push('## Genel Sonuc');
  lines.push('');
  lines.push(`- Kirmizi donem: ${report.aggregate.redRegimes}`);
  lines.push(`- En az bir kez asagidan temas: ${report.aggregate.touchedRegimes} (%${report.aggregate.touchRatePct})`);
  lines.push(`- 3 mum icinde temas: %${report.aggregate.touchWithin3Pct}`);
  lines.push(`- 6 mum icinde temas: %${report.aggregate.touchWithin6Pct}`);
  lines.push(`- 12 mum icinde temas: %${report.aggregate.touchWithin12Pct}`);
  lines.push(`- 24 mum icinde temas: %${report.aggregate.touchWithin24Pct}`);
  lines.push(`- Ilk temasa medyan sure: ${report.aggregate.medianFirstTouchBars} mum`);
  lines.push(`- Temas sonrasi MOST altinda kapanis: %${report.aggregate.rejectionRatePct}`);
  lines.push('');
  lines.push('## Sembol Bazinda');
  lines.push('');
  lines.push('| Sembol | Kirmizi Donem | Temas | Temas % | 6 Mum % | 12 Mum % | Medyan Mum | Red Altinda Kapanis % |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of report.symbols) {
    lines.push(`| ${row.symbol} | ${row.redRegimes} | ${row.touchedRegimes} | ${row.touchRatePct} | ${row.touchWithin6Pct} | ${row.touchWithin12Pct} | ${row.medianFirstTouchBars ?? '-'} | ${row.rejectionRatePct} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function worker(queue, rows, endMs, analysisStartMs, fetchStartMs) {
  while (queue.length) {
    const symbol = queue.shift();
    const candles = await fetchCandles(symbol, fetchStartMs, endMs);
    const row = analyze(symbol, candles, analysisStartMs);
    rows.push(row);
    console.log(`[${rows.length}/${SYMBOLS.length}] ${symbol} red=${row.redRegimes} touch=${row.touchRatePct}% median=${row.medianFirstTouchBars}`);
  }
}

async function main() {
  const endMs = Date.now();
  const analysisStartMs = endMs - ANALYSIS_DAYS * DAY;
  const fetchStartMs = analysisStartMs - WARMUP_DAYS * DAY;
  const queue = [...SYMBOLS];
  const rows = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue, rows, endMs, analysisStartMs, fetchStartMs)));
  rows.sort((a, b) => b.touchRatePct - a.touchRatePct);
  const report = {
    generatedAt: new Date().toISOString(),
    definition: 'After a green-to-red MOST flip, a later candle opens below MOST and its high reaches MOST before the next green flip.',
    conditions: {
      interval: INTERVAL,
      analysisDays: ANALYSIS_DAYS,
      warmupDays: WARMUP_DAYS,
      maPeriod: MA_PERIOD,
      mostPercent: MOST_PERCENT,
    },
    aggregate: aggregate(rows),
    symbols: rows,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(OUT_MD, markdown(report));
  console.log(JSON.stringify(report.aggregate, null, 2));
  console.log(`JSON: ${OUT_JSON}`);
  console.log(`MD: ${OUT_MD}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
