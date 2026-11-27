"""
Pencereden bagimsiz mum numarasi (F1-8).

Stratejiler bekleme suresini ve pozisyon tutma suresini "su anki mum - kayitli mum" farkiyla
olcer. Mum sirasi `len(candles) - 1` ile alinirsa, paper bot stratejiye son 500 mumu verdigi
icin pencere dolunca bu sayi 499'da sabit kalir: bekleme suresi hic dolmaz, bot ilk sinyalden
sonra yeni giris yapamaz. `bar_number` mumun zamanindan hesaplanir; ayni mum her pencerede ayni
numarayi alir ve iki mum arasindaki fark, araya giren mum sayisina esittir (borsada mum eksigi
yoksa tum gecmisle hesaplanan `len(candles) - 1` farkiyla birebir ayni).

Bu numarayi sadece kayitli mumlarla karsilastirmak icin kullan; dizi indeksi degildir.
"""


def bar_interval_ms(candles, lookback=50):
    """Son mumlardaki en kucuk pozitif zaman araligi (mum eksigi araligi buyutur, kucultmez)."""
    best = 0
    start = max(1, len(candles) - lookback)
    for i in range(start, len(candles)):
        diff = int(candles[i]['t']) - int(candles[i - 1]['t'])
        if diff > 0 and (best == 0 or diff < best):
            best = diff
    return best


def bar_number(candles):
    """Son mumun pencereden bagimsiz numarasi: mum zamani / mum araligi."""
    if not candles:
        return 0
    step = bar_interval_ms(candles)
    if step <= 0:
        return len(candles) - 1
    return int(candles[-1]['t']) // step
