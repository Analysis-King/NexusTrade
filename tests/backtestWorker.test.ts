import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';

interface WorkerMessage {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

function startWorker(): {
  child: ChildProcessWithoutNullStreams;
  request: <T>(cmd: string, payload: Record<string, unknown>) => Promise<T>;
} {
  const child = spawn('python', ['-u', 'python/workers/pool_worker.py'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let buffer = '';
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      const msg = JSON.parse(line) as WorkerMessage;
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.data);
      else waiter.reject(new Error(msg.error ?? 'Worker error'));
    }
  });

  const request = <T>(cmd: string, payload: Record<string, unknown>): Promise<T> => {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker timeout: ${cmd}`));
      }, 10_000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
    });
  };

  return { child, request };
}

function candles(rows: Array<[number, number, number, number]>): Array<{
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}> {
  return rows.map(([o, h, l, c], index) => ({
    t: 1_700_000_000_000 + index * 60_000,
    o,
    h,
    l,
    c,
    v: 1000,
  }));
}

async function runBacktest(
  sourceCode: string,
  rows: Array<[number, number, number, number]>,
  params: Record<string, unknown> = {},
  options: {
    feeBps?: number;
    slippageBps?: number;
    footprints?: Array<Record<string, unknown>>;
  } = {}
) {
  const { child, request } = startWorker();
  const instance = `test_${randomUUID()}`;
  try {
    await request('load_code', {
      instance,
      strategy_file: 'inline_strategy.py',
      source_code: sourceCode,
      params: {},
    });
    return await request<Record<string, unknown>>('backtest', {
      instance,
      candles: candles(rows),
      footprints: options.footprints,
      initial_capital: 1000,
      fee_bps: options.feeBps ?? 0,
      slippage_bps: options.slippageBps ?? 0,
      fill_model: 'pessimistic_ohlc',
      params: { max_position_usd: 100, ...params },
    });
  } finally {
    child.kill();
  }
}

describe('universal Python backtest worker', () => {
  test('lets a strategy normalize and lock its universal execution config', async () => {
    const result = await runBacktest(
      `
done = False

def resolve_config(config):
    config["stop_loss_mode"] = "percent"
    config["stop_loss_pct"] = 1
    config["take_profit_pct"] = 1
    return config

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 100, 101],
        [101, 101, 101, 101],
      ],
      { stop_loss_pct: 10, take_profit_pct: 10 }
    );

    expect(result.summary).toMatchObject({
      finalCapital: 1001,
      totalReturnPct: 0.1,
      totalTrades: 1,
    });
    expect(result.trades).toMatchObject([{ reason: 'tp', tpPrice: 101 }]);
  });

  test('exposes supplied footprint data to universal strategies', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    footprint = indicators.footprint()
    if not done and footprint and footprint.get("delta", 0) > 0:
        done = True
        buy()
    else:
        hold()
`,
      [
        [100, 101, 99, 100],
        [110, 111, 109, 110],
        [121, 121, 121, 121],
      ],
      {},
      {
        footprints: [
          {
            t: 1_700_000_000_000,
            complete: true,
            trades: 10,
            buy_trades: 7,
            sell_trades: 3,
            buy_volume: 7,
            sell_volume: 3,
            delta: 4,
            total_volume: 10,
            buy_notional: 700,
            sell_notional: 300,
            delta_notional: 400,
            total_notional: 1000,
            poc_price: 100,
            levels: [],
          },
        ],
      }
    );

    expect(result.summary).toMatchObject({
      totalTrades: 1,
      finalCapital: 1010,
    });
  });

  test('fills strategy signals on the next candle open', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
    else:
        hold()
`,
      [
        [100, 101, 99, 100],
        [110, 111, 109, 110],
        [121, 121, 121, 121],
      ]
    );

    expect(result.summary).toMatchObject({
      finalCapital: 1010,
      totalReturnPct: 1,
      totalTrades: 1,
    });
    expect(result.patterns).toMatchObject([
      {
        pattern: 'Long',
        totalReturnPct: 1,
      },
    ]);
  });

  test('treats max_position_usd as the final hard notional cap after leverage', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 100, 100, 100],
        [110, 110, 110, 110],
      ],
      { leverage: 2, max_position_usd: 100 }
    );

    expect(result.summary).toMatchObject({
      finalCapital: 1010,
      totalReturnPct: 1,
      totalTrades: 1,
    });
    expect(result.trades).toMatchObject([
      {
        notional: 100,
        netPnl: 10,
      },
    ]);
  });

  test('applies leverage to percentage allocation before the hard notional cap', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 100, 100, 100],
        [110, 110, 110, 110],
      ],
      { leverage: 2, max_position_pct: 100, max_position_usd: 2500 }
    );

    expect(result.summary).toMatchObject({
      finalCapital: 1200,
      totalReturnPct: 20,
      totalTrades: 1,
    });
    expect(result.trades).toMatchObject([
      {
        notional: 2000,
        netPnl: 200,
      },
    ]);
  });

  test('uses stop-first pessimistic resolution when stop and target hit in one candle', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
        set_sl(pct=10)
        set_tp(pct=10)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 115, 85, 100],
        [100, 100, 100, 100],
      ]
    );

    expect(result.summary).toMatchObject({
      finalCapital: 990,
      totalReturnPct: -1,
      totalTrades: 1,
    });
    expect(result.trades).toMatchObject([
      {
        reason: 'sl',
        slPrice: 90,
        tpPrice: 110,
        notional: 100,
        netPnl: -10,
      },
    ]);
  });

  test('can require a candle close to trigger the stop while targets still use intrabar prices', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
        set_sl(price=98)
        set_tp(price=110)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 97, 99],
        [99, 110, 99, 110],
      ],
      { stop_trigger_mode: 'close' }
    );

    expect(result.summary).toMatchObject({
      finalCapital: 1010,
      totalReturnPct: 1,
      totalTrades: 1,
    });
    expect(result.trades).toMatchObject([
      {
        reason: 'tp',
        slPrice: 98,
        tpPrice: 110,
      },
    ]);
  });

  test('keeps an open position through opposite signals by default until target hits', async () => {
    const result = await runBacktest(
      `
def on_candle(candle, portfolio, config):
    if not portfolio.has_position:
        buy()
        set_sl(pct=2)
        set_tp(pct=4)
    else:
        sell()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 99, 100],
        [100, 101, 99, 100],
        [100, 104, 99, 104],
      ],
      { stop_loss_mode: 'percent' }
    );

    expect(result.summary).toMatchObject({
      finalCapital: 1004,
      totalReturnPct: 0.4,
      totalTrades: 1,
    });
    expect(result.trades).toMatchObject([
      {
        side: 'long',
        reason: 'tp',
        slPrice: 98,
        tpPrice: 104,
        pnlPct: 4,
      },
    ]);
  });

  test('keeps strategy stop values as the universal stop model by default', async () => {
    const result = await runBacktest(
      `
def on_candle(candle, portfolio, config):
    if not portfolio.has_position:
        buy()
        set_sl(pct=2)
        set_tp(pct=4)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 99, 100],
        [100, 104, 96, 104],
      ]
    );

    expect(result.trades).toMatchObject([
      {
        side: 'long',
        slPrice: 98,
        tpPrice: 104,
      },
    ]);
  });

  test('can use target distance ratio as an explicit universal stop model', async () => {
    const result = await runBacktest(
      `
def on_candle(candle, portfolio, config):
    if not portfolio.has_position:
        buy()
        set_sl(pct=2)
        set_tp(pct=4)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 99, 100],
        [100, 104, 96, 104],
      ],
      { stop_loss_mode: 'target_ratio' }
    );

    expect(result.trades).toMatchObject([
      {
        side: 'long',
        slPrice: 96,
        tpPrice: 104,
      },
    ]);
  });

  test('does not move an existing target to the wrong side of entry', async () => {
    const result = await runBacktest(
      `
step = 0

def on_candle(candle, portfolio, config):
    global step
    if step == 0:
        step = 1
        buy()
        set_sl(price=95)
        set_tp(price=110)
    elif portfolio.has_position:
        buy()
        set_tp(price=99)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 99, 100],
        [99, 100, 98, 99],
        [100, 110, 100, 110],
      ]
    );

    expect(result.trades).toMatchObject([
      {
        side: 'long',
        reason: 'tp',
        tpPrice: 110,
        pnlPct: 10,
      },
    ]);
  });

  test('does not accept risk updates that break minimum reward risk', async () => {
    const result = await runBacktest(
      `
step = 0

def on_candle(candle, portfolio, config):
    global step
    if step == 0:
        step = 1
        buy()
        set_sl(price=95)
        set_tp(price=110)
    elif portfolio.has_position:
        buy()
        set_sl(price=80)
        set_tp(price=110)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 99, 100],
        [100, 101, 99, 100],
        [100, 94, 94, 94],
      ],
      { min_reward_risk: 1 }
    );

    expect(result.trades).toMatchObject([
      {
        side: 'long',
        reason: 'sl',
        slPrice: 95,
      },
    ]);
  });

  test('allows an open position stop to trail into profit after price moves', async () => {
    const result = await runBacktest(
      `
step = 0

def on_candle(candle, portfolio, config):
    global step
    if step == 0:
        step = 1
        buy()
        set_sl(price=95)
        set_tp(price=115)
    elif portfolio.has_position:
        set_sl(price=104)
        hold()
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 111, 100, 110],
        [110, 111, 103, 104],
      ]
    );

    expect(result.trades).toMatchObject([
      {
        side: 'long',
        reason: 'sl',
        slPrice: 104,
        pnlPct: 4,
      },
    ]);
  });

  test('carries strategy metadata onto completed trades', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        set_meta(pattern='ABCD', direction='bullish', zigzag_length=5)
        buy()
        set_tp(pct=10)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 100, 100, 100],
        [100, 111, 100, 110],
      ]
    );

    expect(result.trades).toMatchObject([
      {
        side: 'long',
        reason: 'tp',
        meta: {
          pattern: 'ABCD',
          direction: 'bullish',
          zigzag_length: 5,
        },
      },
    ]);
  });

  test('skips entries when target profit cannot cover fees and slippage', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
        set_tp(pct=0.1)
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 100.5, 99.5, 100],
        [100, 101, 99, 100],
      ],
      {},
      { feeBps: 10, slippageBps: 2 }
    );

    expect(result.summary).toMatchObject({
      finalCapital: 1000,
      totalReturnPct: 0,
      totalTrades: 0,
    });
    expect(result.trades).toHaveLength(0);
  });

  test('can close and reverse on opposite signal when explicitly enabled', async () => {
    const result = await runBacktest(
      `
def on_candle(candle, portfolio, config):
    if not portfolio.has_position:
        buy()
        set_sl(pct=2)
        set_tp(pct=4)
    else:
        sell()
`,
      [
        [100, 100, 100, 100],
        [100, 101, 99, 100],
        [100, 101, 99, 100],
        [100, 104, 99, 104],
      ],
      { exit_on_opposite_signal: true }
    );

    expect(result.trades).toHaveLength(2);
    expect((result.trades as Array<Record<string, unknown>>)[0]).toMatchObject({
      side: 'long',
      reason: 'signal',
      pnlPct: 0,
    });
  });

  test('returns period reports using the requested report duration', async () => {
    const result = await runBacktest(
      `
done = False

def on_candle(candle, portfolio, config):
    global done
    if not done:
        done = True
        buy()
    else:
        hold()
`,
      [
        [100, 100, 100, 100],
        [100, 100, 100, 100],
        [110, 110, 110, 110],
        [120, 120, 120, 120],
      ],
      { report_period_days: 1 / 1440 }
    );

    const reports = result.periodReports as Array<Record<string, unknown>>;
    expect(reports).toHaveLength(4);
    expect(reports[2]).toMatchObject({
      startEquity: 1000,
      endEquity: 1010,
      returnPct: 1,
      openPnl: 10,
      tpTrades: 0,
      slTrades: 0,
    });
    expect(reports[3]).toMatchObject({
      endEquity: 1020,
      realizedPnl: 20,
      openPnl: -10,
      trades: 1,
      endTrades: 1,
    });
  });
});
