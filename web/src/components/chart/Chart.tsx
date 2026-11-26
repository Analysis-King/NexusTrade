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
import { indicatorsApi, marketApi, paperPortfoliosApi, strategiesApi } from '@/api/endpoints';
import { ws } from '@/api/ws';
import { useAppStore, type DrawingMode } from '@/store/app';
import { useBot } from '@/hooks/useBots';
import { closesOf, computeEMA, computeRSI } from '@/lib/indicators';
import type { Candle, DrawingPoint, Position, StrategyDrawing } from '@/types/api';

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

const CHART_CANDLE_LIMIT = 5000;

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
      xOffset: number;
      /** Etiketin sag kenari bu x'i gecmez; fiyat eksenindeki etiketleri ortmesin. */
      maxRight: number;
    };

/**
 * Fiyat ekseni ondalik hassasiyeti: ~5 anlamli basamak (en az 2, en fazla 8).
 * Kutuphane varsayilani 2 ondalik oldugundan ADA gibi dusuk fiyatli coinlerde
 * eksen, SL/TP ve giris etiketleri "0.14" gibi ayni degere yuvarlaniyordu.
 *   60000 -> 2 · 150 -> 2 · 1.5 -> 4 · 0.1445 -> 5 · 0.00001234 -> 8
 */
function pricePrecisionFor(price: number | undefined): number {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return 2;
  const digitsBeforePoint = Math.floor(Math.log10(price)) + 1;
  return Math.max(2, Math.min(8, 5 - digitsBeforePoint));
}

function toChartTime(raw: number): UTCTimestamp {
  return Math.floor(raw > 1_000_000_000_000 ? raw / 1000 : raw) as UTCTimestamp;
}

function pointValue(point: DrawingPoint): number | null {
  const raw = point.price ?? point.value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** x'i cizim alanina (fiyat ekseni haric) sigdirir; plotWidth = timeScale().width(). */
function clampOverlayX(x: number, plotWidth: number): number {
  if (!Number.isFinite(x) || plotWidth <= 0) return x;
  return Math.max(8, Math.min(plotWidth - 8, x));
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

// Strateji cizimlerindeki tahmini seviyeler: pattern'in kendi SL/TP rehberi,
// hedefleri ve teyit bolgesi. Acik pozisyon yokken "bu setup'a girilse seviyeler
// ne olurdu" bilgisini verir. Pozisyon acikken ise pozisyonun gercek
// Giris/SL/TP setiyle ayni isimlerde ikinci bir set olusturup hangisinin gercek
// oldugunu belirsizlestirir; o durumda yalnizca pozisyonun seviyeleri cizilir.
const PATTERN_LEVEL_ROLES = new Set([
  'confirmation',
  'entry_guide',
  'stop_guide',
  'take_profit_guide',
  'target_1',
  'target_2',
]);

function withoutPatternLevels(drawings: StrategyDrawing[]): StrategyDrawing[] {
  return drawings.filter((drawing) => !PATTERN_LEVEL_ROLES.has(drawing.role ?? ''));
}

// Gecmis setup'larin kendi TP/SL seviyeleri ayni fiyat skalasinda ust uste
// yigilir. Pozisyonun gecerli seviyeleri mum serisine fiyat cizgisi olarak tek
// bir set halinde cizilir; burada yalnizca tarihsel risk cizimlerini ayikliyoruz.
const HISTORICAL_RISK_LEVEL_ROLES = new Set([
  'strategy_stop',
  'strategy_target',
]);

function withoutHistoricalRiskLevels(drawings: StrategyDrawing[]): StrategyDrawing[] {
  return drawings.filter((drawing) => !HISTORICAL_RISK_LEVEL_ROLES.has(drawing.role ?? ''));
}

/**
 * Pozisyonu acan pattern'in cizim grubunu bulur. Pozisyon meta'sindaki
 * pattern/direction/zigzag_length etiketiyle eslesen gruplardan D zamani en
 * yakin olani secilir. Eslesme yoksa bos doner.
 */
function selectPositionPatternDrawings(
  drawings: StrategyDrawing[],
  position: { meta?: Record<string, unknown> } | null | undefined
): StrategyDrawing[] {
  if (!position || drawings.length === 0) return [];
  const meta = position.meta ?? {};
  const pattern = typeof meta.pattern === 'string' ? meta.pattern : '';
  const direction = typeof meta.direction === 'string' ? meta.direction : '';
  const length = Number(meta.zigzag_length);
  const dTime = Number(meta.d_time);
  if (!pattern || !direction || !Number.isFinite(length)) return [];

  const labelText = `${direction} ${pattern} L${length}`;
  const labels = drawings.filter((drawing): drawing is Extract<StrategyDrawing, { type: 'label' }> =>
    drawing.type === 'label' && drawing.text === labelText && typeof drawing.group === 'string'
  );
  if (labels.length === 0) return [];

  const selected = [...labels].sort((a, b) => {
    if (!Number.isFinite(dTime)) return 0;
    return Math.abs(Number(a.point.time) - dTime) - Math.abs(Number(b.point.time) - dTime);
  })[0];
  return selected?.group ? drawings.filter((drawing) => drawing.group === selected.group) : [];
}

export function Chart(): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);
  const interval = useAppStore((s) => s.interval);
  const selectedBotId = useAppStore((s) => s.selectedBotId);
  const selectedPaperPosition = useAppStore((s) => s.selectedPaperPosition);
  const drawingMode = useAppStore((s) => s.drawingMode);
  const activeIndicatorIds = useAppStore((s) => s.activeIndicatorIds);
  const setDrawingMode = useAppStore((s) => s.setDrawingMode);
  const { data: selectedBot } = useBot(selectedBotId);
  const paperReports = useQuery({
    queryKey: ['paper-portfolios'],
    queryFn: () => paperPortfoliosApi.list(),
    enabled: selectedPaperPosition !== null,
    refetchInterval: selectedPaperPosition ? 15_000 : false,
  });
  const selectedPaperReport = paperReports.data?.find(
    (report) => report.sourceFile === selectedPaperPosition?.sourceFile
  );
  const selectedPaperRaw = selectedPaperReport?.openPositions.find(
    (position) => position.id === selectedPaperPosition?.positionId
  );
  const selectedPaperAsPosition = useMemo<Position | null>(() => {
    if (
      !selectedPaperRaw ||
      selectedPaperRaw.symbol !== symbol ||
      selectedPaperReport?.config.interval !== interval
    ) {
      return null;
    }
    return {
      botId: `paper:${selectedPaperReport.sourceFile}`,
      symbol: selectedPaperRaw.symbol,
      side: selectedPaperRaw.side === 'long' ? 'BUY' : 'SELL',
      quantity: selectedPaperRaw.qty ?? 0,
      entryPrice: selectedPaperRaw.entry,
      stopLossPrice: selectedPaperRaw.sl,
      takeProfitPrice: selectedPaperRaw.tp,
      meta: selectedPaperRaw.meta,
      openedAt: selectedPaperRaw.entryTime ?? Date.parse(selectedPaperRaw.openedAtIso),
    };
  }, [interval, selectedPaperRaw, selectedPaperReport?.config.interval, selectedPaperReport?.sourceFile, symbol]);
  const selectedDrawings =
    selectedBot?.config.symbol === symbol && selectedBot.config.interval === interval
      ? selectedBot.state.drawings
      : undefined;
  const { data: candles } = useQuery({
    queryKey: ['klines', symbol, interval],
    queryFn: () => marketApi.klines(symbol, interval, CHART_CANDLE_LIMIT),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
  const activeIndicatorKey = activeIndicatorIds.join('|');
  const paperStrategyFilename = selectedPaperReport?.config.strategyFile;
  const paperStrategyDrawings = useQuery({
    queryKey: [
      'paper-strategy-drawings',
      selectedPaperReport?.sourceFile,
      paperStrategyFilename,
      symbol,
      interval,
      candles?.at(-1)?.openTime,
    ],
    queryFn: () => strategiesApi
      .draw(paperStrategyFilename!, { candles: candles ?? [] })
      .then((result) => result.drawings),
    enabled: Boolean(selectedPaperRaw && paperStrategyFilename && candles?.length),
    staleTime: 30_000,
  });
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
  const selectedPaperDrawings = useMemo(
    () => selectPositionPatternDrawings(paperStrategyDrawings.data ?? [], selectedPaperRaw),
    [paperStrategyDrawings.data, selectedPaperRaw]
  );
  // Baska bir sembole gecildiyse botun pozisyon seviyeleri bu grafige ait degildir.
  const selectedBotPosition =
    selectedBot?.config.symbol === symbol ? selectedBot.state.position ?? null : null;
  const activePosition = selectedPaperAsPosition ?? selectedBotPosition;
  const visibleDrawings = useMemo(() => {
    if (drawingMode === 'hidden') return [];
    const botDrawings = selectedDrawings ?? [];
    const paperDrawings = selectedPaperRaw ? selectedPaperDrawings : [];
    const activeIndicatorDrawings = activeIndicatorIds.length ? indicatorDrawings.data ?? [] : [];
    // Acik pozisyon varken grafikteki tek Giris/SL/TP seti pozisyonun kendisidir
    // (asagidaki fiyat cizgisi efekti); stratejinin tahmini seviyeleri gizlenir.
    const hasOpenPosition = Boolean(activePosition || selectedPaperRaw);
    const strategyView = (drawings: StrategyDrawing[]): StrategyDrawing[] => {
      const cleaned = withoutHistoricalRiskLevels(drawings);
      return hasOpenPosition ? withoutPatternLevels(cleaned) : cleaned;
    };
    if (drawingMode === 'all') {
      return [
        ...activeIndicatorDrawings,
        ...strategyView(botDrawings),
        ...strategyView(paperDrawings),
      ];
    }
    // "Son" modunda pozisyonu acan pattern gosterilir; bulunamazsa en son pattern.
    const botPositionDrawings = selectedBotPosition
      ? selectPositionPatternDrawings(botDrawings, selectedBotPosition)
      : [];
    const strategyDrawings = paperDrawings.length
      ? paperDrawings
      : botPositionDrawings.length
        ? botPositionDrawings
        : botDrawings;
    const firstGrouped = strategyDrawings.find((drawing) => typeof drawing.group === 'string' && drawing.group);
    if (firstGrouped?.group) {
      return [
        ...activeIndicatorDrawings,
        ...strategyView(strategyDrawings.filter((drawing) => drawing.group === firstGrouped.group)),
      ];
    }
    return [
      ...activeIndicatorDrawings,
      ...strategyView(strategyDrawings.slice(-10)),
    ];
  }, [activeIndicatorIds.length, activePosition, drawingMode, indicatorDrawings.data, selectedBotPosition, selectedDrawings, selectedPaperDrawings, selectedPaperRaw]);
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
  const lastAutoFitKeyRef = useRef<string | null>(null);

  renderOverlayRef.current = () => {
    const chart = mainChartRef.current;
    const series = candleSeriesRef.current;
    if (!chart || !series) {
      setOverlayElements([]);
      return;
    }

    // Sagdaki fiyat ekseni haric cizim alani genisligi.
    const plotWidth = chart.timeScale().width();
    // Acik pozisyonda Giris/SL/TP basliklari cizim alaninin sag kenarina yazilir;
    // pattern etiketleri onlarin ustune binmesin diye o seridi bos birak.
    const labelRightEdge = plotWidth - (activePosition ? 64 : 4);
    const timeScale = chart.timeScale() as {
      timeToCoordinate: (time: UTCTimestamp) => number | null;
    };
    const timeToX = (rawTime: number): number | null => {
      const chartTime = toChartTime(rawTime);
      const direct = timeScale.timeToCoordinate(chartTime);
      const width = plotWidth;
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
        const isUp = !String(drawing.style ?? '').toLowerCase().includes('down');
        const stackIndex = next.filter((el) =>
          el.kind === 'label' &&
          Math.abs(el.x - point.x) < 90 &&
          Math.abs(el.y - point.y) < 32 &&
          el.isUp === isUp
        ).length;
        const labelHeight = 22;
        const candidateTop = isUp
          ? point.y - labelHeight - 8 - stackIndex * (labelHeight + 4)
          : point.y + 8 + stackIndex * (labelHeight + 4);
        const oppositeCollisions = next.filter((el) => {
          if (el.kind !== 'label' || el.isUp === isUp || Math.abs(el.x - point.x) >= 90) return false;
          const existingTop = el.isUp
            ? el.y - labelHeight - 8 - el.stackIndex * (labelHeight + 4)
            : el.y + 8 + el.stackIndex * (labelHeight + 4);
          return candidateTop < existingTop + labelHeight && candidateTop + labelHeight > existingTop;
        }).length;
        next.push({
          kind: 'label',
          id: `label-${drawingIndex}`,
          x: point.x,
          y: point.y,
          text: drawing.text ?? '',
          color: drawing.color ?? C.text,
          textColor: drawing.textcolor ?? C.bg,
          isUp,
          stackIndex,
          xOffset: oppositeCollisions === 0 ? 0 : (isUp ? -64 : 64) * oppositeCollisions,
          maxRight: labelRightEdge,
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

  /* ─── Açık pozisyonun Giriş / SL / TP seviyeleri ─────── */
  // Mum serisine fiyat çizgisi olarak çizilir: çizgi tam o fiyatta durur,
  // fiyatı sağdaki eksende, adı çizginin üstünde görünür. Overlay etiketleri
  // yakın seviyelerde üst üste kaydırıldığı için hangi etiketin hangi çizgiye
  // ait olduğu karışıyordu.
  const positionEntry = activePosition?.entryPrice;
  const positionTp = activePosition?.takeProfitPrice;
  const positionSl = activePosition?.stopLossPrice;
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || drawingMode === 'hidden') return;
    const levels = [
      { price: positionEntry, title: 'Giriş', color: '#cbd5e1', lineStyle: LineStyle.Dotted },
      { price: positionTp, title: 'TP', color: '#22c55e', lineStyle: LineStyle.Dashed },
      { price: positionSl, title: 'SL', color: '#ef4444', lineStyle: LineStyle.Dashed },
    ];
    const lines = levels.flatMap((level) =>
      typeof level.price === 'number' && Number.isFinite(level.price)
        ? [series.createPriceLine({
            price: level.price,
            color: level.color,
            lineWidth: 2,
            lineStyle: level.lineStyle,
            axisLabelVisible: true,
            title: level.title,
          })]
        : []
    );
    return () => {
      for (const line of lines) {
        try {
          series.removePriceLine(line);
        } catch {
          /* chart zaten kaldırıldı */
        }
      }
    };
  }, [drawingMode, positionEntry, positionSl, positionTp]);

  /* ─── Tarihsel veri yükleme ──────────────────────────── */
  // Veriyi chart'a aktar
  useEffect(() => {
    if (!candles || !candleSeriesRef.current || !volumeSeriesRef.current ||
        !emaSeriesRef.current || !rsiSeriesRef.current) return;

    candlesRef.current = [...candles];

    const precision = pricePrecisionFor(candles.at(-1)?.close);
    candleSeriesRef.current.applyOptions({
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
    });
    emaSeriesRef.current.applyOptions({
      priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
    });
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

    const autoFitKey = `${symbol}:${interval}`;
    if (candles.length > 0 && mainChartRef.current && lastAutoFitKeyRef.current !== autoFitKey) {
      lastAutoFitKeyRef.current = autoFitKey;
      const ts = mainChartRef.current.timeScale();
      ts.fitContent();
      ts.scrollToRealTime();
    }
    renderOverlayRef.current();
  }, [candles, interval, symbol]);

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
        if (buf.length > CHART_CANDLE_LIMIT) buf.shift();
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
            // Sag kenara yakin etiketler fiyat eksenine tasmasin diye sola kaydirilir.
            const labelX = Math.max(
              4,
              Math.min(el.x + el.xOffset - labelWidth / 2, el.maxRight - labelWidth)
            );
            const labelCenterX = labelX + labelWidth / 2;
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
                  x={labelCenterX}
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
