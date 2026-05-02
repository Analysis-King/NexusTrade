# name: Harmonik Formasyon
# desc: 13 harmonik formasyon: Gartley, Yarasa, Kelebek, Yengec, Cypher, Shark ve diger 7
# author: NexusTrade
# version: 1.0

"""
Harmonik Formasyon Stratejisi
==============================
Bu dosya hem bot editöründe strateji olarak kullanılır
hem de doğrudan Python scripti olarak çalıştırılabilir.

Doğrudan çalıştırma:
    python harmonik_formasyon.py --symbol BTCUSDT --interval 4h --days 90

Bot editöründe:
    Dosyayı yükle → Deploy Bot → Paper/Live modda çalıştır
"""

# ════════════════════════════════════════════════════════════
#  YAPILANDIRMA
# ════════════════════════════════════════════════════════════

TOLERANCE  = 0.05   # Fibonacci oran toleransı ±%5
LEFT_BARS  = 3      # Pivot tespiti sol pencere
RIGHT_BARS = 3      # Pivot tespiti sağ pencere
LOOKBACK   = 30     # Kaç swing noktasına bakılacak


# ════════════════════════════════════════════════════════════
#  FİBONACCİ YARDIMCI FONKSİYONLARI
# ════════════════════════════════════════════════════════════

def in_range(val, lo, hi):
    """Değerin tolerans dahilinde [lo, hi] aralığında olup olmadığını kontrol et."""
    return lo * (1 - TOLERANCE) <= val <= hi * (1 + TOLERANCE)


def in_target(val, target):
    """Değerin tolerans dahilinde hedef değere eşit olup olmadığını kontrol et."""
    return in_range(val, target, target)


def calc_ratios(X, A, B, C, D):
    """XABCD noktalarından Fibonacci oranlarını hesapla."""
    XA = abs(A['c'] - X['c'])
    AB = abs(B['c'] - A['c'])
    BC = abs(C['c'] - B['c'])
    CD = abs(D['c'] - C['c'])
    XD = abs(D['c'] - X['c'])
    return {
        'AB_XA': AB / XA if XA > 0 else 0,
        'BC_AB': BC / AB if AB > 0 else 0,
        'CD_BC': CD / BC if BC > 0 else 0,
        'XD_XA': XD / XA if XA > 0 else 0,
    }


def quality_score(ratios, targets):
    """Fibonacci oranlarının hedefe yakınlığını puanla (0-100)."""
    scores = []
    for key, (lo, hi) in targets.items():
        if key not in ratios:
            continue
        val  = ratios[key]
        mid  = (lo + hi) / 2
        span = (hi - lo) / 2 + 0.001
        scores.append(max(0, 100 - abs(val - mid) / span * 100))
    return round(sum(scores) / len(scores)) if scores else 0


def calc_targets(X, A, D, direction):
    """PRZ, Stop-Loss ve Take-Profit seviyelerini hesapla."""
    prz      = D['c']
    xa_range = abs(A['c'] - X['c'])
    if direction == 'bullish':
        sl  = D['c'] - xa_range * 0.10
        tp1 = D['c'] + (A['c'] - D['c']) * 0.382
        tp2 = D['c'] + (A['c'] - D['c']) * 0.618
        tp3 = A['c']
    else:
        sl  = D['c'] + xa_range * 0.10
        tp1 = D['c'] - (D['c'] - A['c']) * 0.382
        tp2 = D['c'] - (D['c'] - A['c']) * 0.618
        tp3 = A['c']
    return {'prz': prz, 'sl': sl, 'tp1': tp1, 'tp2': tp2, 'tp3': tp3}


# ════════════════════════════════════════════════════════════
#  13 HARMONİK FORMASYON
# ════════════════════════════════════════════════════════════

PATTERNS = [
    {
        'name': 'Gartley',
        'check': lambda r: (in_target(r['AB_XA'], 0.618) and in_target(r['XD_XA'], 0.786) and
                            in_range(r['BC_AB'], 0.382, 0.886) and in_range(r['CD_BC'], 1.272, 1.618)),
        'targets': {'AB_XA': (0.618, 0.618), 'XD_XA': (0.786, 0.786),
                    'BC_AB': (0.382, 0.886), 'CD_BC': (1.272, 1.618)},
    },
    {
        'name': 'Yengec',
        'check': lambda r: (in_range(r['AB_XA'], 0.382, 0.618) and in_target(r['XD_XA'], 1.618) and
                            in_range(r['BC_AB'], 0.382, 0.886) and in_range(r['CD_BC'], 2.618, 3.618)),
        'targets': {'AB_XA': (0.382, 0.618), 'XD_XA': (1.618, 1.618),
                    'BC_AB': (0.382, 0.886), 'CD_BC': (2.618, 3.618)},
    },
    {
        'name': 'Derin Yengec',
        'check': lambda r: (in_target(r['AB_XA'], 0.886) and in_target(r['XD_XA'], 1.618) and
                            in_range(r['BC_AB'], 0.382, 0.886) and in_range(r['CD_BC'], 2.0, 3.618)),
        'targets': {'AB_XA': (0.886, 0.886), 'XD_XA': (1.618, 1.618),
                    'BC_AB': (0.382, 0.886), 'CD_BC': (2.0, 3.618)},
    },
    {
        'name': 'Yarasa',
        'check': lambda r: (in_range(r['AB_XA'], 0.382, 0.500) and in_target(r['XD_XA'], 0.886) and
                            in_range(r['BC_AB'], 0.382, 0.886) and in_range(r['CD_BC'], 1.618, 2.618)),
        'targets': {'AB_XA': (0.382, 0.500), 'XD_XA': (0.886, 0.886),
                    'BC_AB': (0.382, 0.886), 'CD_BC': (1.618, 2.618)},
    },
    {
        'name': 'Alt Yarasa',
        'check': lambda r: (in_target(r['AB_XA'], 0.382) and in_target(r['XD_XA'], 1.13) and
                            in_range(r['BC_AB'], 0.382, 0.886) and in_range(r['CD_BC'], 2.0, 3.618)),
        'targets': {'AB_XA': (0.382, 0.382), 'XD_XA': (1.13, 1.13),
                    'BC_AB': (0.382, 0.886), 'CD_BC': (2.0, 3.618)},
    },
    {
        'name': 'Kelebek',
        'check': lambda r: (in_target(r['AB_XA'], 0.786) and in_range(r['XD_XA'], 1.27, 1.618) and
                            in_range(r['BC_AB'], 0.382, 0.886) and in_range(r['CD_BC'], 1.618, 2.618)),
        'targets': {'AB_XA': (0.786, 0.786), 'XD_XA': (1.27, 1.618),
                    'BC_AB': (0.382, 0.886), 'CD_BC': (1.618, 2.618)},
    },
    {
        'name': 'Shark',
        'check': lambda r: (in_range(r['AB_XA'], 1.13, 1.618) and in_range(r['BC_AB'], 1.618, 2.24) and
                            in_range(r['XD_XA'], 0.886, 1.13)),
        'targets': {'AB_XA': (1.13, 1.618), 'BC_AB': (1.618, 2.24), 'XD_XA': (0.886, 1.13)},
    },
    {
        'name': 'Cypher',
        'check': lambda r: (in_range(r['AB_XA'], 0.382, 0.618) and in_range(r['BC_AB'], 1.13, 1.414) and
                            in_target(r['XD_XA'], 0.786)),
        'targets': {'AB_XA': (0.382, 0.618), 'BC_AB': (1.13, 1.414), 'XD_XA': (0.786, 0.786)},
    },
    {
        'name': 'Nenstar',
        'check': lambda r: (in_target(r['AB_XA'], 0.618) and in_range(r['BC_AB'], 1.272, 2.0) and
                            in_range(r['XD_XA'], 1.272, 2.0)),
        'targets': {'AB_XA': (0.618, 0.618), 'BC_AB': (1.272, 2.0), 'XD_XA': (1.272, 2.0)},
    },
    {
        'name': 'Black Swan',
        'check': lambda r: (in_range(r['AB_XA'], 1.382, 2.618) and in_range(r['BC_AB'], 0.382, 0.618) and
                            in_range(r['XD_XA'], 1.382, 2.618)),
        'targets': {'AB_XA': (1.382, 2.618), 'BC_AB': (0.382, 0.618), 'XD_XA': (1.382, 2.618)},
    },
    {
        'name': 'White Swan',
        'check': lambda r: (in_range(r['AB_XA'], 0.382, 0.618) and in_range(r['BC_AB'], 1.382, 2.618) and
                            in_range(r['XD_XA'], 0.382, 0.618)),
        'targets': {'AB_XA': (0.382, 0.618), 'BC_AB': (1.382, 2.618), 'XD_XA': (0.382, 0.618)},
    },
    {
        'name': '3 Basamak',
        'check': lambda r: (in_range(r['AB_XA'], 0.618, 0.786) and in_range(r['BC_AB'], 1.27, 1.618) and
                            in_range(r['CD_BC'], 0.618, 0.786)),
        'targets': {'AB_XA': (0.618, 0.786), 'BC_AB': (1.27, 1.618), 'CD_BC': (0.618, 0.786)},
    },
    {
        'name': '5-0',
        'check': lambda r: (in_range(r['AB_XA'], 1.13, 1.618) and in_range(r['BC_AB'], 1.618, 2.24) and
                            in_target(r['CD_BC'], 0.50)),
        'targets': {'AB_XA': (1.13, 1.618), 'BC_AB': (1.618, 2.24), 'CD_BC': (0.50, 0.50)},
    },
]


# ════════════════════════════════════════════════════════════
#  SWING NOKTA TESPİTİ (ZigZag)
# ════════════════════════════════════════════════════════════

def find_swing_points(candles, left_bars=LEFT_BARS, right_bars=RIGHT_BARS, min_pct=0.005):
    """Pivot high/low noktalarını bul ve temizle."""
    n      = len(candles)
    swings = []

    for i in range(left_bars, n - right_bars):
        window = candles[i - left_bars: i + right_bars + 1]
        max_h  = max(c['h'] for c in window)
        min_l  = min(c['l'] for c in window)
        if candles[i]['h'] == max_h:
            swings.append({'i': i, 't': candles[i]['t'], 'c': candles[i]['h'], 'type': 'H'})
        if candles[i]['l'] == min_l:
            swings.append({'i': i, 't': candles[i]['t'], 'c': candles[i]['l'], 'type': 'L'})

    swings.sort(key=lambda s: s['i'])

    # Ardışık aynı tipteki noktaları temizle
    cleaned = []
    for s in swings:
        if not cleaned:
            cleaned.append(s)
            continue
        last = cleaned[-1]
        if s['type'] == last['type']:
            if s['type'] == 'H' and s['c'] > last['c']:
                cleaned[-1] = s
            elif s['type'] == 'L' and s['c'] < last['c']:
                cleaned[-1] = s
        else:
            if abs(s['c'] - last['c']) / last['c'] >= min_pct:
                cleaned.append(s)

    return cleaned


# ════════════════════════════════════════════════════════════
#  FORMASYON TARAMA
# ════════════════════════════════════════════════════════════

def scan_patterns(candles, min_quality=60):
    """Tüm mumları tarayarak harmonik formasyonları tespit et."""
    swings = find_swing_points(candles)
    if len(swings) < 5:
        return []

    results = []
    seen    = set()

    for di in range(4, len(swings)):
        window = swings[max(0, di - LOOKBACK + 1): di + 1]
        if len(window) < 5:
            continue

        for i in range(len(window) - 4):
            X, A, B, C, D = window[i], window[i+1], window[i+2], window[i+3], window[i+4]
            key = (X['i'], A['i'], B['i'], C['i'], D['i'])
            if key in seen:
                continue

            direction = 'bullish' if A['c'] > X['c'] else 'bearish'
            ratios    = calc_ratios(X, A, B, C, D)
            XA        = abs(A['c'] - X['c'])
            AB        = abs(B['c'] - A['c'])

            if AB > XA * 2.5 or AB < XA * 0.1:
                continue

            for pc in PATTERNS:
                if not pc['check'](ratios):
                    continue
                q = quality_score(ratios, pc['targets'])
                if q < min_quality:
                    continue
                seen.add(key)
                t = calc_targets(X, A, D, direction)
                results.append({
                    'name': pc['name'], 'direction': direction, 'quality': q,
                    'X': X, 'A': A, 'B': B, 'C': C, 'D': D,
                    'ratios': ratios, **t,
                })
                break

    return sorted(results, key=lambda p: p['quality'], reverse=True)


# ════════════════════════════════════════════════════════════
#  BACKTEST MOTORU
# ════════════════════════════════════════════════════════════

def run_backtest(candles, min_quality=40, tp_mode='TP2'):
    """Geçmiş veriler üzerinde harmonik strateji backtesti."""
    swings = find_swing_points(candles)
    if len(swings) < 5:
        return {}

    all_trades = []
    seen       = set()

    for di in range(4, len(swings)):
        window = swings[max(0, di - LOOKBACK + 1): di + 1]
        if len(window) < 5:
            continue

        for i in range(len(window) - 4):
            X, A, B, C, D = window[i], window[i+1], window[i+2], window[i+3], window[i+4]
            key = (X['i'], A['i'], B['i'], C['i'], D['i'])
            if key in seen:
                continue

            direction = 'bullish' if A['c'] > X['c'] else 'bearish'
            ratios    = calc_ratios(X, A, B, C, D)
            XA        = abs(A['c'] - X['c'])
            AB        = abs(B['c'] - A['c'])
            if AB > XA * 2.5 or AB < XA * 0.1:
                continue

            for pc in PATTERNS:
                if not pc['check'](ratios):
                    continue
                q = quality_score(ratios, pc['targets'])
                if q < min_quality:
                    continue
                seen.add(key)

                t      = calc_targets(X, A, D, direction)
                target = {'TP1': t['tp1'], 'TP2': t['tp2'], 'TP3': t['tp3']}.get(tp_mode, t['tp2'])
                future = candles[D['i'] + 1: D['i'] + 101]

                exit_price  = None
                exit_reason = 'TIMEOUT'
                for bar in future:
                    if direction == 'bullish':
                        if bar['l'] <= t['sl']:
                            exit_price = t['sl']; exit_reason = 'SL'; break
                        if bar['h'] >= target:
                            exit_price = target; exit_reason = tp_mode; break
                    else:
                        if bar['h'] >= t['sl']:
                            exit_price = t['sl']; exit_reason = 'SL'; break
                        if bar['l'] <= target:
                            exit_price = target; exit_reason = tp_mode; break

                if exit_price is None:
                    exit_price = future[-1]['c'] if future else t['prz']

                pnl = ((exit_price - t['prz']) / t['prz'] * 100 if direction == 'bullish'
                       else (t['prz'] - exit_price) / t['prz'] * 100)
                risk = abs(t['prz'] - t['sl'])
                rr   = abs(exit_price - t['prz']) / risk if risk > 0 else 0

                all_trades.append({
                    'pattern': pc['name'], 'direction': direction, 'quality': q,
                    'entry': t['prz'], 'exit': exit_price,
                    'sl': t['sl'], 'tp2': t['tp2'],
                    'reason': exit_reason,
                    'pnl': round(pnl, 4), 'rr': round(rr, 2),
                })
                break

    # İstatistik hesapla
    by_pattern = {}
    for tr in all_trades:
        by_pattern.setdefault(tr['pattern'], []).append(tr)

    stats = {}
    for name, trades in by_pattern.items():
        wins   = [t for t in trades if t['pnl'] > 0]
        losses = [t for t in trades if t['pnl'] <= 0]
        gp     = sum(t['pnl'] for t in wins)
        gl     = abs(sum(t['pnl'] for t in losses))
        peak = cum = max_dd = 0.0
        for tr in trades:
            cum += tr['pnl']
            if cum > peak: peak = cum
            dd = peak - cum
            if dd > max_dd: max_dd = dd
        stats[name] = {
            'pattern': name, 'trades': len(trades),
            'wins': len(wins), 'losses': len(losses),
            'win_rate': round(len(wins) / len(trades) * 100, 1),
            'profit_factor': round(gp / gl, 2) if gl > 0 else 99.0,
            'total_pnl': round(sum(t['pnl'] for t in trades), 2),
            'max_drawdown': round(max_dd, 2),
        }
    return stats


# ════════════════════════════════════════════════════════════
#  BOT EDİTÖRÜ ARAYÜZÜ
# ════════════════════════════════════════════════════════════

def initialize():
    config = {
        'min_quality': 60,   # Minimum formasyon kalitesi (0-100)
        'tp_mode':    'TP2', # Take-profit hedefi: TP1, TP2 veya TP3
        'sl_ratio':   0.10,  # Stop-loss: XA mesafesinin yüzdesi
    }
    return config


def draw(candles, indicators, patterns):
    """
    Grafik üzerine çizilecek katmanları döndür.
    Bu fonksiyon her kapanan mumda otomatik çağrılır.

    Döndürülen format:
        [
            {
                'type': 'harmonic',
                'patterns': [...]   # scan_patterns() çıktısı
            }
        ]
    """
    # Tespit edilen harmonik formasyonları grafik üzerine çiz
    found = scan_patterns(candles, min_quality=60)
    if not found:
        return []

    return [
        {
            'type':     'harmonic',
            'patterns': found[:5],  # En iyi 5 formasyon
        }
    ]


def on_candle(candle, portfolio, config):
    """
    Her kapanan mumda çalışır.
    Harmonik motor otomatik olarak formasyon tarar.
    D noktası tespit edildiğinde giriş yapar.
    """
    # Mevcut pozisyon varsa RSI ile çıkış kontrol et
    if portfolio.has_position:
        rsi = indicators.rsi(14)
        if rsi > 75:
            sell()
        else:
            hold()
        return

    # Harmonik tarama — motor otomatik çalışır
    hold()


# ════════════════════════════════════════════════════════════
#  DOĞRUDAN ÇALIŞTIRMA (python harmonik_formasyon.py)
# ════════════════════════════════════════════════════════════

if __name__ == '__main__':
    import urllib.request, urllib.parse, json, time, argparse

    parser = argparse.ArgumentParser(description='Harmonik Formasyon Stratejisi')
    parser.add_argument('--symbol',   default='BTCUSDT')
    parser.add_argument('--interval', default='4h')
    parser.add_argument('--days',     type=int, default=90)
    parser.add_argument('--quality',  type=int, default=40)
    parser.add_argument('--tp',       default='TP2')
    args = parser.parse_args()

    print(f"\n{'='*50}")
    print(f"Harmonik Formasyon Stratejisi")
    print(f"Sembol: {args.symbol} | TF: {args.interval} | {args.days} gün")
    print(f"{'='*50}\n")

    # Binance'den veri çek
    total_ms = args.days * 24 * 60 * 60 * 1000
    since    = int(time.time() * 1000) - total_ms
    candles  = []

    print("Binance verisi çekiliyor...")
    while True:
        params = urllib.parse.urlencode({'symbol': args.symbol, 'interval': args.interval,
                                         'startTime': since, 'limit': 1000})
        with urllib.request.urlopen(f"https://api.binance.com/api/v3/klines?{params}", timeout=15) as r:
            raw = json.loads(r.read())
        if not raw: break
        candles.extend([{'t':k[0],'o':float(k[1]),'h':float(k[2]),
                          'l':float(k[3]),'c':float(k[4]),'v':float(k[5])} for k in raw])
        since = raw[-1][0] + 1
        if len(raw) < 1000: break
        time.sleep(0.3)

    print(f"{len(candles)} mum yüklendi.\n")

    # Canlı tarama
    patterns = scan_patterns(candles, args.quality)
    print(f"Tespit edilen formasyon: {len(patterns)}")
    for p in patterns[:5]:
        arrow = '▲' if p['direction'] == 'bullish' else '▼'
        print(f"  {arrow} {p['name']} ({p['direction']}) | Kalite: {p['quality']}/100 | "
              f"PRZ: {p['prz']:.2f} | SL: {p['sl']:.2f} | TP2: {p['tp2']:.2f}")

    # Backtest
    print(f"\nBacktest çalışıyor...")
    stats = run_backtest(candles, args.quality, args.tp)
    if stats:
        print(f"\n{'FORMASYON':<16} {'İŞLEM':>6} {'WIN%':>7} {'PF':>6} {'PnL%':>8} {'MaxDD%':>7}")
        print('-' * 55)
        for s in sorted(stats.values(), key=lambda x: x['total_pnl'], reverse=True):
            pf = f"{s['profit_factor']:.2f}" if s['profit_factor'] < 99 else "99+"
            print(f"{s['pattern']:<16} {s['trades']:>6} {s['win_rate']:>6.1f}% "
                  f"{pf:>6} {s['total_pnl']:>+8.2f}% {s['max_drawdown']:>6.2f}%")
    else:
        print("Yeterli işlem bulunamadı. --quality değerini düşürün.")
