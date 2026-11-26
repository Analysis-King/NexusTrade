#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..", "..");
const DAY = 86_400_000;

function parseArgs(argv) {
  const args = {
    minutes: 15,
    symbols: 10,
    capital: 1000,
    makerFeeBps: 2,
    quoteUsd: 25,
    maxInventoryUsd: 100,
    minSpreadBps: 8,
    minExpectedEdgeBps: 1,
    minQuoteVolume: 5_000_000,
    toxicityWindow: 30,
    toxicityCooldownMs: 60_000,
    refreshMs: 2_000,
    output: path.join("data", "orderbook_market_maker_forward.jsonl"),
    summary: path.join("data", "orderbook_market_maker_forward_summary.json"),
  };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const option = raw.slice(2);
    const separator = option.indexOf("=");
    const key = separator >= 0 ? option.slice(0, separator) : option;
    const value = separator >= 0 ? option.slice(separator + 1) : "true";
    if (!(key in args)) continue;
    args[key] = ["output", "summary"].includes(key) || key === "symbols" ? value : Number(value);
  }
  return args;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTopSymbols(value, args) {
  if (typeof value === "string" && value.includes(",")) {
    return value.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
  }
  const limit = Math.max(1, Number(value) || 10);
  const [tickerResponse, bookResponse] = await Promise.all([
    fetch("https://fapi.binance.com/fapi/v1/ticker/24hr"),
    fetch("https://fapi.binance.com/fapi/v1/ticker/bookTicker"),
  ]);
  if (!tickerResponse.ok) throw new Error(`Binance futures ticker ${tickerResponse.status}: ${await tickerResponse.text()}`);
  if (!bookResponse.ok) throw new Error(`Binance futures book ${bookResponse.status}: ${await bookResponse.text()}`);
  const rows = await tickerResponse.json();
  const books = new Map((await bookResponse.json()).map((row) => [row.symbol, row]));
  return rows
    .map((row) => {
      const book = books.get(row.symbol);
      const bid = Number(book?.bidPrice || 0);
      const ask = Number(book?.askPrice || 0);
      return { ...row, spreadBps: bid > 0 && ask > bid ? (ask / bid - 1) * 10_000 : 0 };
    })
    .filter((row) => /^[A-Z0-9]+USDT$/.test(String(row.symbol || ""))
      && Number(row.quoteVolume || 0) >= args.minQuoteVolume
      && row.spreadBps >= args.minSpreadBps)
    .sort((a, b) => b.spreadBps - a.spreadBps || Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, limit)
    .map((row) => row.symbol);
}

function createState(symbol) {
  return {
    symbol,
    bid: 0,
    ask: 0,
    bidQty: 0,
    askQty: 0,
    mid: 0,
    quoteBid: null,
    quoteAsk: null,
    inventoryQty: 0,
    cashPnl: 0,
    fees: 0,
    fills: 0,
    buyFills: 0,
    sellFills: 0,
    quotedMs: 0,
    lastBookAt: 0,
    lastQuoteAt: 0,
    lastMarkAt: Date.now(),
    realizedSpreadUsd: 0,
    adverseSelectionUsd: 0,
    adverseObservations: [],
    coolingUntil: 0,
    toxicityStops: 0,
    pendingMarks: [],
  };
}

function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function quoteOrder(state, side, args, now) {
  const price = side === "buy" ? state.bid : state.ask;
  const topQty = side === "buy" ? state.bidQty : state.askQty;
  if (!(price > 0) || !(topQty >= 0)) return null;
  const inventoryUsd = state.inventoryQty * state.mid;
  if (side === "buy" && inventoryUsd >= args.maxInventoryUsd) return null;
  if (side === "sell" && inventoryUsd <= -args.maxInventoryUsd) return null;
  if (side === "buy" && inventoryUsd > args.quoteUsd * 0.25) return null;
  if (side === "sell" && inventoryUsd < -args.quoteUsd * 0.25) return null;
  const qty = args.quoteUsd / price;
  return {
    side,
    price,
    qty,
    queueAhead: topQty,
    placedAt: now,
  };
}

function refreshQuotes(state, args, now, force = false) {
  if (!(state.bid > 0) || !(state.ask > state.bid)) return;
  const spreadBps = (state.ask / state.bid - 1) * 10_000;
  const recent = state.adverseObservations.slice(-args.toxicityWindow);
  const averageAdverseBps = recent.length
    ? recent.reduce((sum, value) => sum + value, 0) / recent.length
    : 0;
  const expectedEdgeBps = spreadBps / 2 - args.makerFeeBps + averageAdverseBps;
  if (spreadBps < args.minSpreadBps || expectedEdgeBps < args.minExpectedEdgeBps || now < state.coolingUntil) {
    state.quoteBid = null;
    state.quoteAsk = null;
    return;
  }
  const bidMoved = state.quoteBid?.price !== state.bid;
  const askMoved = state.quoteAsk?.price !== state.ask;
  if (!force && !bidMoved && !askMoved) return;
  state.quoteBid = quoteOrder(state, "buy", args, now);
  state.quoteAsk = quoteOrder(state, "sell", args, now);
  state.lastQuoteAt = now;
}

function markPending(state, now) {
  const stillPending = [];
  for (const mark of state.pendingMarks) {
    if (now < mark.at) {
      stillPending.push(mark);
      continue;
    }
    const direction = mark.side === "buy" ? 1 : -1;
    const adverseUsd = direction * (state.mid - mark.price) * mark.qty;
    const adverseBps = adverseUsd / (mark.price * mark.qty) * 10_000;
    state.adverseSelectionUsd += adverseUsd;
    state.adverseObservations.push(adverseBps);
    if (state.adverseObservations.length > args.toxicityWindow * 3) {
      state.adverseObservations.splice(0, state.adverseObservations.length - args.toxicityWindow * 3);
    }
    const recent = state.adverseObservations.slice(-args.toxicityWindow);
    if (recent.length >= Math.min(10, args.toxicityWindow)) {
      const averageAdverseBps = recent.reduce((sum, value) => sum + value, 0) / recent.length;
      const spreadBps = state.bid > 0 ? (state.ask / state.bid - 1) * 10_000 : 0;
      const expectedEdgeBps = spreadBps / 2 - args.makerFeeBps + averageAdverseBps;
      if (expectedEdgeBps < args.minExpectedEdgeBps) {
        state.coolingUntil = now + args.toxicityCooldownMs;
        state.toxicityStops += 1;
        state.quoteBid = null;
        state.quoteAsk = null;
      }
    }
  }
  state.pendingMarks = stillPending;
}

function fillOrder(state, order, args, now) {
  const direction = order.side === "buy" ? 1 : -1;
  const notional = order.price * order.qty;
  const fee = notional * args.makerFeeBps / 10_000;
  state.inventoryQty += direction * order.qty;
  state.cashPnl -= direction * notional;
  state.cashPnl -= fee;
  state.fees += fee;
  state.fills += 1;
  if (order.side === "buy") state.buyFills += 1;
  else state.sellFills += 1;
  state.pendingMarks.push({ at: now + 5_000, side: order.side, price: order.price, qty: order.qty });

  const opposite = order.side === "buy" ? state.quoteAsk : state.quoteBid;
  if (opposite) {
    const grossSpread = direction * (opposite.price - order.price) * order.qty;
    if (grossSpread > 0) state.realizedSpreadUsd += grossSpread;
  }
}

function processTrade(state, trade, args, now) {
  const price = Number(trade.p);
  const qty = Number(trade.q);
  const tradeTime = Number(trade.T);
  const sellerAggressor = Boolean(trade.m);
  const order = sellerAggressor ? state.quoteBid : state.quoteAsk;
  if (!order || !(qty > 0) || !(price > 0)) return;
  if (Number.isFinite(tradeTime) && tradeTime < order.placedAt) return;
  const crossed = order.side === "buy" ? price <= order.price : price >= order.price;
  if (!crossed) return;
  const tradedThrough = order.side === "buy" ? price < order.price : price > order.price;
  order.queueAhead = tradedThrough ? 0 : order.queueAhead - qty;
  if (order.queueAhead > 0) return;
  fillOrder(state, order, args, now);
  if (order.side === "buy") state.quoteBid = null;
  else state.quoteAsk = null;
  refreshQuotes(state, args, now, true);
}

function processBook(state, bid, bidQty, ask, askQty, args, now) {
  state.bid = bid;
  state.bidQty = bidQty;
  state.ask = ask;
  state.askQty = askQty;
  state.mid = (bid + ask) / 2;
  state.lastBookAt = now;
  refreshQuotes(state, args, now);
  markPending(state, now);
}

function stateSummary(state, args, now) {
  markPending(state, now);
  const inventoryUsd = state.inventoryQty * state.mid;
  const equityPnl = state.cashPnl + inventoryUsd;
  const elapsedDays = Math.max(1 / 1440, (now - state.lastMarkAt) / DAY);
  const recent = state.adverseObservations.slice(-args.toxicityWindow);
  const averageAdverseBps = recent.length
    ? recent.reduce((sum, value) => sum + value, 0) / recent.length
    : 0;
  const spreadBps = state.bid > 0 ? (state.ask / state.bid - 1) * 10_000 : null;
  return {
    symbol: state.symbol,
    mid: round(state.mid),
    spreadBps: round(spreadBps, 4),
    expectedEdgeBps: spreadBps === null ? null : round(spreadBps / 2 - args.makerFeeBps + averageAdverseBps, 4),
    averageAdverseBps: round(averageAdverseBps, 4),
    cooling: now < state.coolingUntil,
    toxicityStops: state.toxicityStops,
    fills: state.fills,
    buyFills: state.buyFills,
    sellFills: state.sellFills,
    inventoryQty: round(state.inventoryQty, 8),
    inventoryUsd: round(inventoryUsd, 4),
    cashPnlUsd: round(state.cashPnl, 4),
    equityPnlUsd: round(equityPnl, 4),
    returnPct: round(equityPnl / args.capital * 100, 4),
    simpleDailyPct: round(equityPnl / args.capital * 100 / elapsedDays, 4),
    feesUsd: round(state.fees, 4),
    estimatedGrossSpreadUsd: round(state.realizedSpreadUsd, 4),
    adverseSelection5sUsd: round(state.adverseSelectionUsd, 4),
  };
}

function totalSummary(states, args, startedAt, now) {
  const rows = [...states.values()].map((state) => stateSummary(state, args, now));
  const equityPnlUsd = rows.reduce((sum, row) => sum + row.equityPnlUsd, 0);
  const elapsedDays = Math.max(1 / 1440, (now - startedAt) / DAY);
  return {
    generatedAt: new Date(now).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    elapsedMinutes: round((now - startedAt) / 60_000, 2),
    assumptions: {
      paperOnly: true,
      makerFeeBps: args.makerFeeBps,
      quoteUsd: args.quoteUsd,
      maxInventoryUsd: args.maxInventoryUsd,
      minSpreadBps: args.minSpreadBps,
      minExpectedEdgeBps: args.minExpectedEdgeBps,
      fillModel: "Top-of-book queue ahead must be consumed by aggressor trades; book moves never imply a fill.",
    },
    symbols: rows.length,
    fills: rows.reduce((sum, row) => sum + row.fills, 0),
    equityPnlUsd: round(equityPnlUsd, 4),
    returnPct: round(equityPnlUsd / args.capital * 100, 4),
    simpleDailyPct: round(equityPnlUsd / args.capital * 100 / elapsedDays, 4),
    feesUsd: round(rows.reduce((sum, row) => sum + row.feesUsd, 0), 4),
    adverseSelection5sUsd: round(rows.reduce((sum, row) => sum + row.adverseSelection5sUsd, 0), 4),
    rows: rows.sort((a, b) => b.equityPnlUsd - a.equityPnlUsd),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = await fetchTopSymbols(args.symbols, args);
  if (!symbols.length) throw new Error("Spread ve hacim kapisini gecen sembol bulunamadi.");
  const states = new Map(symbols.map((symbol) => [symbol, createState(symbol)]));
  const streams = symbols.flatMap((symbol) => {
    const lower = symbol.toLowerCase();
    return [`${lower}@depth20@100ms`, `${lower}@aggTrade`];
  });
  const wsUrl = `wss://fstream.binance.com/stream?streams=${streams.join("/")}`;
  const output = path.resolve(ROOT, args.output);
  const summaryFile = path.resolve(ROOT, args.summary);
  const startedAt = Date.now();
  const stopAt = startedAt + Math.max(1, args.minutes) * 60_000;
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const ws = new WebSocket(wsUrl, { handshakeTimeout: 20_000 });
  let lastSnapshot = 0;
  let resolveClose;
  let rejectClose;
  const closed = new Promise((resolve, reject) => {
    resolveClose = resolve;
    rejectClose = reject;
  });

  ws.on("open", () => {
    console.error(`Market-maker paper forward started: ${symbols.join(", ")} for ${args.minutes} minutes`);
  });
  ws.on("message", (raw) => {
    const now = Date.now();
    const message = JSON.parse(raw.toString());
    const stream = String(message.stream || "");
    const symbol = String(message.data?.s || "").toUpperCase();
    const state = states.get(symbol);
    if (!state) return;
    if (stream.endsWith("@depth20@100ms")) {
      const bid = message.data.b?.[0];
      const ask = message.data.a?.[0];
      if (!bid || !ask) return;
      processBook(state, Number(bid[0]), Number(bid[1]), Number(ask[0]), Number(ask[1]), args, now);
    } else if (stream.endsWith("@aggTrade")) {
      processTrade(state, message.data, args, now);
    }

    if (now - lastSnapshot >= 60_000) {
      const snapshot = totalSummary(states, args, startedAt, now);
      appendJsonLine(output, snapshot);
      fs.writeFileSync(summaryFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.error(`minute ${snapshot.elapsedMinutes}: fills=${snapshot.fills} pnl=${snapshot.equityPnlUsd} daily=${snapshot.simpleDailyPct}%`);
      lastSnapshot = now;
    }
    if (now >= stopAt) ws.close(1000, "completed");
  });
  ws.on("error", rejectClose);
  ws.on("close", resolveClose);

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now >= stopAt && ws.readyState === WebSocket.OPEN) ws.close(1000, "completed");
  }, 1_000);
  await closed;
  clearInterval(watchdog);
  await sleep(100);
  const summary = totalSummary(states, args, startedAt, Date.now());
  appendJsonLine(output, summary);
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
