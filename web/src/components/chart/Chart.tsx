/**
 * Mum grafiği — Lightweight Charts.
 *
 * Yapı:
 *   - Üst (ana) panel: candle + volume histogram + EMA(20) overlay
 *   - Alt panel:       RSI(14) line
 *
 * Chart, sembol/interval değişince yeniden veri çeker. Canlı kline akışı için
 * useKlineStream hook'una abone olur — her closed candle geldiğinde son mumu
 * günceller (veya yeni bir tane ekler).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { indicatorsApi, marketApi } from '@/api/endpoints';
import { ws } from '@/api/ws';
import { useAppStore, type DrawingMode } from '@/store/app';
import { useBot } from '@/hooks/useBots';
import { closesOf, computeEMA, computeRSI } from '@/lib/indicators';
import type { Candle, DrawingPoint, StrategyDrawing } from '@/types/api';

/** Tema renkleri — globals.css değerleriyle senkron tutulmalı. */
const C = {
  bg: '#131722',
  surface: '#1E222D',
  border: '#343A47',
  text: '#D1D4DC',
  muted: '#7F8AA0',
  bull: '#26A69A',
  bear: '#EF5350',
  ema: '#FFB74D',     // Sarı-turuncu — TradingView default EMA tonu
  rsi: '#A78BFA',     // Mor — TradingView default RSI tonu
  rsiBand: '#7F8AA0', // 30/70 bantları
};

/** Backend Candle → Lightweight Charts CandlestickData (saniye cinsinden time). */
function toCandleData(c: Candle): CandlestickData {
  return {
    time: (c.openTime / 1000) as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

function toVolumeData(c: Candle): HistogramData {
  const isUp = c.close >= c.open;
  return {
    time: (c.openTime / 1000) as UTCTimestamp,
    value: c.volume,
    color: isUp ? `${C.bull}66` : `${C.bear}66`, // %40 alpha
  };
}

type OverlayElement =
  | {
      kind: 'polyline';
      id: string;
      points: string;
      color: string;
      width: number;
      dash?: string;
    }
  | {
      kind: 'line';
      id: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      width: number;
      dash?: string;
    }
  | {
      kind: 'label';
      id: string;
      x: number;
      y: number;
      text: string;
      color: string;
      textColor: string;
      isUp: boolean;
      stackIndex: number;
    };

function toChartTime(raw: number): UTCTimestamp {
  return Math.floor(raw > 1_000_000_000_000 ? raw / 1000 : raw) as UTCTimestamp;
}

function pointValue(point: DrawingPoint): number | null {
  const raw = point.price ?? point.value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function clampOverlayX(x: number, width: number): number {
  if (!Number.isFinite(x) || width <= 0) return x;
  return Math.max(8, Math.min(width - 72, x));
}

function widthOf(raw: unknown, fallback = 1): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(6, Math.round(n)));
}

function dashOf(style?: string): string | undefined {
  const value = String(style ?? '').toLowerCase();
  if (value.includes('dot')) return '2 4';
  if (value.includes('dash')) return '7 5';
  return undefined;
}

export function Chart(): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);
  const interval = useAppStore((s) => s.interval);
  const selectedBotId = useAppStore((s) => s.selectedBotId);
  const drawingMode = useAppStore((s) => s.drawingMode);
  const activeIndicatorIds = useAppStore((s) => s.activeIndicatorIds);
  const setDrawingMode = useAppStore((s) => s.setDrawingMode);
  const { data: selectedBot } = useBot(selectedBotId);
  const selectedDrawings =
    selectedBot?.config.symbol === symbol && selectedBot.config.interval === interval
      ? selectedBot.state.drawings
      : undefined;
  const { data: candles } = useQuery({
    queryKey: ['klines', symbol, interval],
    queryFn: () => marketApi.klines(symbol, interval, 500),
    staleTime: 30_000,
  });
  const activeIndicatorKey = activeIndicatorIds.join('|');
  const indicatorDrawings = useQuery({
    queryKey: ['indicator-drawings', symbol, interval, activeIndicatorKey, candles?.at(-1)?.openTime],
    queryFn: async () => {
      if (!candles?.length) return [];
      const results = await Promise.all(
        activeIndicatorIds.map((id) =>
          indicatorsApi
            .draw(`${id}.py`, { candles })
            .then((result) => result.drawings)
            .catch(() => [])
        )
      );
      return results.flat() as StrategyDrawing[];
    },
    enabled: Boolean(candles?.length && activeIndicatorIds.length > 0),
    staleTime: 10_000,
  });
  const visibleDrawings = useMemo(() => {
    if (drawingMode === 'hidden') return [];
    const botDrawings = selectedDrawings ?? [];
    const activeIndicatorDrawings = activeIndicatorIds.length ? indicatorDrawings.data ?? [] : [];
    if (drawingMode === 'all') return [...activeIndicatorDrawings, ...botDrawings];
    const firstGrouped = botDrawings.find((drawing) => typeof drawing.group === 'string' && drawing.group);
    if (firstGrouped?.group) {
      return [
        ...activeIndicatorDrawings,
        ...botDrawings.filter((drawing) => drawing.group === firstGrouped.group),
      ];
    }
    return [...activeIndicatorDrawings, ...botDrawings.slice(-10)];
  }, [activeIndicatorIds.length, drawingMode, indicatorDrawings.data, selectedDrawings]);
  const [overlayElements, setOverlayElements] = useState<OverlayElement[]>([]);

  // İki ayrı container — main (mum/volume/ema) ve sub (RSI)
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const subContainerRef = useRef<HTMLDivElement>(null);

  // Chart referansları (cleanup için lazım)
  const mainChartRef = useRef<IChartApi | null>(null);
  const subChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Candle buffer — canlı update için lokal kopya tutuyoruz
  const candlesRef = useRef<Candle[]>([]);
  const drawingsRef = useRef<StrategyDrawing[]>([]);
  const renderOverlayRef = useRef<() => void>(() => undefined);
  const overlayFrameRef = useRef<number | null>(null);
  const scheduleOverlayRenderRef = useRef<() => void>(() => undefined);

  renderOverlayRef.current = () => {
    const chart = mainChartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) {
      setOverlayElements([]);
      return;
    }

    const timeScale = chart.timeScale() as {
      timeToCoordinate: (time: UTCTimestamp) => number | null;
    };
    const timeToX = (rawTime: number): number | null => {
      const chartTime = toChartTime(rawTime);
      const direct = timeScale.timeToCoordinate(chartTime);
      const width = mainContainerRef.current?.clientWidth ?? 0;
      if (direct !== null) return clampOverlayX(Number(direct), width);

      const candles = candlesRef.current;
      if (candles.length < 2 || width <= 0) return null;

      const pointSec = Number(chartTime);
      const first = candles[0]!;
      const second = candles[1]!;
      const prev = candles[candles.length - 2]!;
      const last = candles[candles.length - 1]!;
      const firstSec = Number(toChartTime(first.openTime));
      const secondSec = Number(toChartTime(second.openTime));
      const prevSec = Number(toChartTime(prev.openTime));
      const lastSec = Number(toChartTime(last.openTime));

      const afterLast = pointSec > lastSec;
      const beforeFirst = pointSec < firstSec;
      if (!afterLast && !beforeFirst) return null;

      const anchorTime = afterLast ? lastSec : firstSec;
      const neighborTime = afterLast ? prevSec : secondSec;
      const anchorX = timeScale.timeToCoordinate((afterLast ? lastSec : firstSec) as UTCTimestamp);
      const neighborX = timeScale.timeToCoordinate((afterLast ? prevSec : secondSec) as UTCTimestamp);
      if (anchorX === null || neighborX === null || anchorTime === neighborTime) return null;

      const pxPerSecond = (Number(anchorX) - Number(neighborX)) / (anchorTime - neighborTime);
      if (!Number.isFinite(pxPerSecond) || pxPerSecond === 0) return null;

      const extrapolated = Number(anchorX) + (pointSec - anchorTime) * pxPerSecond;
      return clampOverlayX(extrapolated, width);
    };
    const toCoord = (point: DrawingPoint): { x: number; y: number } | null => {
      const value = pointValue(point);
      if (value === null || typeof point.time !== 'number') return null;
      const x = timeToX(point.time);
      const y = series.priceToCoordinate(value);
      if (x === null || y === null) return null;
      return { x: Number(x), y: Number(y) };
    };

    const next: OverlayElement[] = [];
    drawingsRef.current.forEach((drawing, drawingIndex) => {
      if (!drawing || typeof drawing !== 'object') return;
      if (drawing.type === 'plot') {
        const coords = (Array.isArray(drawing.points) ? drawing.points : [])
          .map(toCoord)
          .filter((p): p is { x: number; y: number } => Boolean(p));
        if (coords.length < 2) return;
        next.push({
          kind: 'polyline',
          id: `plot-${drawingIndex}`,
          points: coords.map((p) => `${p.x},${p.y}`).join(' '),
          color: drawing.color ?? C.text,
          width: widthOf(drawing.linewidth, 1),
          dash: dashOf(drawing.linestyle ?? drawing.style),
        });
        return;
      }

      if (drawing.type === 'line') {
        const first = toCoord(drawing.first);
        const second = toCoord(drawing.second);
        if (!first || !second) return;
        next.push({
          kind: 'line',
          id: `line-${drawingIndex}`,
          x1: first.x,
          y1: first.y,
          x2: second.x,
          y2: second.y,
          color: drawing.color ?? C.text,
          width: widthOf(drawing.width, 1),
          dash: dashOf(drawing.style),
        });
        return;
      }

      if (drawing.type === 'label') {
        const point = toCoord(drawing.point);
        if (!point) return;
        const stackIndex = next.filter((el) =>
          el.kind === 'label' &&
          Math.abs(el.x - point.x) < 90 &&
          Math.abs(el.y - point.y) < 32 &&
          el.isUp === !String(drawing.style ?? '').toLowerCase().includes('down')
        ).length;
        next.push({
          kind: 'label',
          id: `label-${drawingIndex}`,
          x: point.x,
          y: point.y,
          text: drawing.text ?? '',
          color: drawing.color ?? C.text,
          textColor: drawing.textcolor ?? C.bg,
          isUp: !String(drawing.style ?? '').toLowerCase().includes('down'),
          stackIndex,
        });
      }
    });
    setOverlayElements(next);
  };

  scheduleOverlayRenderRef.current = () => {
    if (overlayFrameRef.current !== null) return;
    overlayFrameRef.current = window.requestAnimationFrame(() => {
      overlayFrameRef.current = null;
      renderOverlayRef.current();
    });
  };

  useEffect(() => {
    drawingsRef.current = visibleDrawings;
    renderOverlayRef.current();
  }, [visibleDrawings, symbol, interval]);

  /* ─── Chart oluşturma — ilk render ────────────────────── */
  useEffect(() => {
    const main = mainContainerRef.current;
    const sub = subContainerRef.current;
    if (!main || !sub) return;

    const commonOpts = {
      layout: {
        background: { type: ColorType.Solid, color: C.bg },
        textColor: C.text,
        fontFamily: 'Inter, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: C.surface },
        horzLines: { color: C.surface },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: C.muted, width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: C.surface },
        horzLine: { color: C.muted, width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: C.surface },
      },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false },
    };

    // ── Ana chart (mum + volume + ema)
    const mainChart = createChart(main, {
      ...commonOpts,
      width: main.clientWidth,
      height: main.clientHeight,
    });
    const candle = mainChart.addCandlestickSeries({
      upColor: C.bull,
      downColor: C.bear,
      borderVisible: false,
      wickUpColor: C.bull,
      wickDownColor: C.bear,
    });
    const volume = mainChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '', // overlay
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    const ema = mainChart.addLineSeries({
      color: C.ema,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // ── Alt chart (RSI)
    const subChart = createChart(sub, {
      ...commonOpts,
      width: sub.clientWidth,
      height: sub.clientHeight,
      timeScale: { ...commonOpts.timeScale, visible: false }, // ana ile sync olacak, üst panelde zaman var
    });
    const rsi = subChart.addLineSeries({
      color: C.rsi,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    // 30/70 bant çizgileri
    rsi.createPriceLine({
      price: 70,
      color: C.rsiBand,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '70',
    });
    rsi.createPriceLine({
      price: 30,
      color: C.rsiBand,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '30',
    });

    // Time scale senkronu — ana chart'ı kaydırınca alt da kaysın
    mainChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) subChart.timeScale().setVisibleLogicalRange(range);
      scheduleOverlayRenderRef.current();
    });
    subChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) mainChart.timeScale().setVisibleLogicalRange(range);
      scheduleOverlayRenderRef.current();
    });

    const scheduleOverlayRender = (): void => {
      scheduleOverlayRenderRef.current();
    };
    const overlaySyncEvents: Array<keyof HTMLElementEventMap> = [
      'wheel',
      'pointerdown',
      'pointermove',
      'pointerup',
      'pointercancel',
      'pointerleave',
      'mousemove',
      'touchmove',
      'touchend',
      'dblclick',
    ];
    const overlaySyncOptions: AddEventListenerOptions = { passive: true };
    overlaySyncEvents.forEach((eventName) => {
      main.addEventListener(eventName, scheduleOverlayRender, overlaySyncOptions);
    });

    // Resize observer — pencere boyutu değişince
    const resizeObserver = new ResizeObserver(() => {
      if (mainContainerRef.current) {
        mainChart.applyOptions({
          width: mainContainerRef.current.clientWidth,
          height: mainContainerRef.current.clientHeight,
        });
      }
      if (subContainerRef.current) {
        subChart.applyOptions({
          width: subContainerRef.current.clientWidth,
          height: subContainerRef.current.clientHeight,
        });
      }
      scheduleOverlayRenderRef.current();
    });
    resizeObserver.observe(main);
    resizeObserver.observe(sub);

    mainChartRef.current = mainChart;
    subChartRef.current = subChart;
    candleSeriesRef.current = candle;
    volumeSeriesRef.current = volume;
    emaSeriesRef.current = ema;
    rsiSeriesRef.current = rsi;
    renderOverlayRef.current();

    return () => {
      overlaySyncEvents.forEach((eventName) => {
        main.removeEventListener(eventName, scheduleOverlayRender, overlaySyncOptions);
      });
      if (overlayFrameRef.current !== null) {
        window.cancelAnimationFrame(overlayFrameRef.current);
        overlayFrameRef.current = null;
      }
      resizeObserver.disconnect();
      mainChart.remove();
      subChart.remove();
      mainChartRef.current = null;
      subChartRef.current = null;
    };
  }, []);

  /* ─── Tarihsel veri yükleme ──────────────────────────── */
  // Veriyi chart'a aktar
  useEffect(() => {
    if (!candles || !candleSeriesRef.current || !volumeSeriesRef.current ||
        !emaSeriesRef.current || !rsiSeriesRef.current) return;

    candlesRef.current = [...candles];

    candleSeriesRef.current.setData(candles.map(toCandleData));
    volumeSeriesRef.current.setData(candles.map(toVolumeData));

    // EMA(20)
    const closes = closesOf(candles);
    const emaArr = computeEMA(closes, 20);
    const emaData: LineData[] = [];
    for (let i = 0; i < candles.length; i++) {
      const v = emaArr[i];
      if (v !== null && v !== undefined) {
        emaData.push({
          time: (candles[i]!.openTime / 1000) as UTCTimestamp,
          value: v,
        });
      }
    }
    emaSeriesRef.current.setData(emaData);

    // RSI(14)
    const rsiArr = computeRSI(closes, 14);
    const rsiData: LineData[] = [];
    for (let i = 0; i < candles.length; i++) {
      const v = rsiArr[i];
      if (v !== null && v !== undefined) {
        rsiData.push({
          time: (candles[i]!.openTime / 1000) as UTCTimestamp,
          value: v,
        });
      }
    }
    rsiSeriesRef.current.setData(rsiData);

// Sembol/interval değişince son mumlara odaklan
    if (candles.length > 0 && mainChartRef.current) {
      const ts = mainChartRef.current.timeScale();
      ts.fitContent();
      ts.scrollToRealTime();
    }
    renderOverlayRef.current();
  }, [candles]);

  /* ─── Canlı kline akışı ──────────────────────────────── */
  useEffect(() => {
    if (!symbol || !interval) return;

    const unsub = ws.subscribeKline(symbol, interval, (data) => {
      const k = data as { e: string; k?: any };
      if (k.e !== 'kline' || !k.k) return;
      const kk = k.k;

      const candle: Candle = {
        openTime: kk.t,
        open: Number(kk.o),
        high: Number(kk.h),
        low: Number(kk.l),
        close: Number(kk.c),
        volume: Number(kk.v),
        closeTime: kk.T,
      };

      // Buffer'ı güncelle
      const buf = candlesRef.current;
      const last = buf[buf.length - 1];
      if (last && last.openTime === candle.openTime) {
        buf[buf.length - 1] = candle;
      } else {
        buf.push(candle);
        if (buf.length > 600) buf.shift();
      }

      // Chart serileri — Lightweight Charts'ın update() metodu hem yeni bar
      // hem güncel bar için aynı şekilde çalışır.
      candleSeriesRef.current?.update(toCandleData(candle));
      volumeSeriesRef.current?.update(toVolumeData(candle));

      // EMA & RSI'yi son N mum üzerinden hızlıca yeniden hesapla
      const closes = closesOf(buf);
      const emaArr = computeEMA(closes, 20);
      const lastEma = emaArr[emaArr.length - 1];
      if (lastEma !== null && lastEma !== undefined) {
        emaSeriesRef.current?.update({
          time: (candle.openTime / 1000) as UTCTimestamp,
          value: lastEma,
        });
      }

      const rsiArr = computeRSI(closes, 14);
      const lastRsi = rsiArr[rsiArr.length - 1];
      if (lastRsi !== null && lastRsi !== undefined) {
        rsiSeriesRef.current?.update({
          time: (candle.openTime / 1000) as UTCTimestamp,
          value: lastRsi,
        });
      }
      renderOverlayRef.current();
    });

    return unsub;
  }, [symbol, interval]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Üst: mum + volume + EMA */}
      <div className="flex-1 min-h-0 relative">
        <ChartLabel symbol={symbol} interval={interval} />
        <DrawingModeControl mode={drawingMode} onChange={setDrawingMode} />
        <div ref={mainContainerRef} className="absolute inset-0" />
        <svg className="absolute inset-0 z-[5] pointer-events-none" width="100%" height="100%">
          {overlayElements.map((el) => {
            if (el.kind === 'polyline') {
              return (
                <polyline
                  key={el.id}
                  points={el.points}
                  fill="none"
                  stroke={el.color}
                  strokeWidth={el.width}
                  strokeDasharray={el.dash}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            }
            if (el.kind === 'line') {
              return (
                <line
                  key={el.id}
                  x1={el.x1}
                  y1={el.y1}
                  x2={el.x2}
                  y2={el.y2}
                  stroke={el.color}
                  strokeWidth={el.width}
                  strokeDasharray={el.dash}
                  strokeLinecap="round"
                />
              );
            }
            const labelWidth = Math.max(56, Math.min(220, el.text.length * 7 + 18));
            const labelHeight = 22;
            const labelX = el.x - labelWidth / 2;
            const stackOffset = el.stackIndex * (labelHeight + 4);
            const labelY = el.isUp
              ? el.y - labelHeight - 8 - stackOffset
              : el.y + 8 + stackOffset;
            return (
              <g key={el.id}>
                <rect
                  x={labelX}
                  y={labelY}
                  width={labelWidth}
                  height={labelHeight}
                  rx={4}
                  fill={el.color}
                />
                <text
                  x={el.x}
                  y={labelY + 15}
                  fill={el.textColor}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                >
                  {el.text}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Alt: RSI */}
      <div className="h-32 border-t border-border relative flex-shrink-0">
        <div className="absolute top-1 left-2 text-2xs text-muted z-10 select-none pointer-events-none">
          RSI 14
        </div>
        <div ref={subContainerRef} className="absolute inset-0" />
      </div>
    </div>
  );
}

/** Sol üstte sembol + interval + EMA badge. */
function DrawingModeControl({
  mode,
  onChange,
}: {
  mode: DrawingMode;
  onChange: (mode: DrawingMode) => void;
}): JSX.Element {
  const options: Array<{ value: DrawingMode; label: string }> = [
    { value: 'hidden', label: 'Gizle' },
    { value: 'latest', label: 'Son' },
    { value: 'all', label: 'Hepsi' },
  ];

  return (
    <div className="absolute top-2 right-2 z-10 flex overflow-hidden rounded border border-border bg-bg/80 text-2xs shadow">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`px-2 py-1 transition-colors ${
            mode === option.value
              ? 'bg-accent text-white'
              : 'text-muted hover:bg-surface-2 hover:text-text'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ChartLabel({ symbol, interval }: { symbol: string; interval: string }): JSX.Element {
  return (
    <div className="absolute top-2 left-2 z-10 flex items-center gap-2 text-xs text-muted select-none pointer-events-none">
      <span className="font-semibold text-text">{symbol}</span>
      <span>·</span>
      <span>{interval}</span>
      <span className="ml-2 inline-flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: C.ema }} />
        EMA 20
      </span>
    </div>
  );
}
