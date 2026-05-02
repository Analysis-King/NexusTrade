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

import { useEffect, useRef } from 'react';
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
import { marketApi } from '@/api/endpoints';
import { ws } from '@/api/ws';
import { useAppStore } from '@/store/app';
import { closesOf, computeEMA, computeRSI } from '@/lib/indicators';
import type { Candle } from '@/types/api';

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

export function Chart(): JSX.Element {
  const symbol = useAppStore((s) => s.symbol);
  const interval = useAppStore((s) => s.interval);

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
        vertLine: { color: C.muted, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.surface },
        horzLine: { color: C.muted, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.surface },
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
    });
    subChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) mainChart.timeScale().setVisibleLogicalRange(range);
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
    });
    resizeObserver.observe(main);
    resizeObserver.observe(sub);

    mainChartRef.current = mainChart;
    subChartRef.current = subChart;
    candleSeriesRef.current = candle;
    volumeSeriesRef.current = volume;
    emaSeriesRef.current = ema;
    rsiSeriesRef.current = rsi;

    return () => {
      resizeObserver.disconnect();
      mainChart.remove();
      subChart.remove();
      mainChartRef.current = null;
      subChartRef.current = null;
    };
  }, []);

  /* ─── Tarihsel veri yükleme ──────────────────────────── */
  const { data: candles } = useQuery({
    queryKey: ['klines', symbol, interval],
    queryFn: () => marketApi.klines(symbol, interval, 500),
    staleTime: 30_000,
  });

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
    });

    return unsub;
  }, [symbol, interval]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Üst: mum + volume + EMA */}
      <div className="flex-1 min-h-0 relative">
        <ChartLabel symbol={symbol} interval={interval} />
        <div ref={mainContainerRef} className="absolute inset-0" />
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
