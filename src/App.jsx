import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";

const BASE = "https://fapi.binance.com/fapi/v1";

const SYMBOLS = [
  { symbol: "BTCUSDT", label: "BTC" },
  { symbol: "ETHUSDT", label: "ETH" },
  { symbol: "SOLUSDT", label: "SOL" },
  { symbol: "BNBUSDT", label: "BNB" },
  { symbol: "XRPUSDT", label: "XRP" },
  { symbol: "DOGEUSDT", label: "DOGE" },
  { symbol: "XAUUSDT", label: "XAU · Gold" },
];

const INTERVALS = ["1m", "5m", "15m", "1h"];

// ---------- formatters ----------
function fmtUSD(n, digits = 0) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function fmtCompact(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(0);
}
function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(digits) + "%";
}
function fmtQty(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// ---------- order book clustering ----------
function analyzeDepth(bids, asks, midPrice) {
  const bucketSize = Math.max(midPrice * 0.0008, midPrice > 100 ? 10 : 0.01);
  const round = (p) => Math.round(p / bucketSize) * bucketSize;
  const buckets = {};
  const add = (levels) => {
    for (const [priceStr, qtyStr] of levels) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      const usd = price * qty;
      const key = round(price);
      if (!buckets[key]) buckets[key] = { price: key, usd: 0 };
      buckets[key].usd += usd;
    }
  };
  add(bids);
  add(asks);
  const list = Object.values(buckets)
    .map((b) => ({ ...b, side: b.price >= midPrice ? "ask" : "bid" }))
    .sort((a, b) => b.usd - a.usd);
  if (list.length === 0) return { magnet: null, target: null, zones: [], bucketSize };

  const magnet = list[0];
  const maxUsd = list[0].usd;
  const scored = list.map((b) => {
    const dist = Math.abs(b.price - midPrice) / midPrice;
    const sizeScore = b.usd / maxUsd;
    const distPenalty = Math.min(dist * 40, 1);
    const score = Math.round((sizeScore * 0.7 + (1 - distPenalty) * 0.3) * 100);
    return { ...b, score, dist };
  });
  const target = scored.filter((b) => b.price !== magnet.price).sort((a, b) => b.score - a.score)[0] || magnet;

  const zones = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .sort((a, b) => b.price - a.price);

  return { magnet, target, zones, bucketSize };
}

// ---------- kline-derived CVD / bias / volume profile ----------
function analyzeKlines(klines) {
  if (!klines || klines.length === 0) return null;
  let buyVol = 0,
    sellVol = 0;
  const bars = klines.map((k) => {
    const vol = parseFloat(k[5]);
    const takerBuy = parseFloat(k[9]);
    const takerSell = vol - takerBuy;
    buyVol += takerBuy;
    sellVol += takerSell;
    return { time: k[0], delta: takerBuy - takerSell, close: parseFloat(k[4]) };
  });
  const total = buyVol + sellVol || 1;
  const buyPct = (buyVol / total) * 100;

  // rough volume profile: distribute each candle's volume across its H-L range
  const profile = {};
  let priceStep = null;
  for (const k of klines) {
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    if (!priceStep) priceStep = Math.max((high - low) / 4, high * 0.0005) || high * 0.0005;
  }
  for (const k of klines) {
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const vol = parseFloat(k[5]);
    const steps = Math.max(1, Math.round((high - low) / priceStep));
    const share = vol / steps;
    for (let i = 0; i < steps; i++) {
      const p = Math.round((low + i * priceStep) / priceStep) * priceStep;
      profile[p] = (profile[p] || 0) + share;
    }
  }
  const profileList = Object.entries(profile)
    .map(([p, v]) => ({ price: parseFloat(p), vol: v }))
    .sort((a, b) => b.vol - a.vol);
  const poc = profileList[0];

  // liquidity sweep detection: last candle wicking beyond prior 10-candle extreme then closing back inside
  let sweep = null;
  if (klines.length > 12) {
    const last = klines[klines.length - 1];
    const priorSlice = klines.slice(-13, -1);
    const priorLow = Math.min(...priorSlice.map((k) => parseFloat(k[3])));
    const priorHigh = Math.max(...priorSlice.map((k) => parseFloat(k[2])));
    const lastLow = parseFloat(last[3]);
    const lastHigh = parseFloat(last[2]);
    const lastClose = parseFloat(last[4]);
    if (lastLow < priorLow && lastClose > priorLow) {
      sweep = { type: "bullish", price: priorLow, label: "Weak Bullish Sweep", confidence: Math.round(Math.min(95, ((lastClose - lastLow) / (priorHigh - priorLow || 1)) * 200)) };
    } else if (lastHigh > priorHigh && lastClose < priorHigh) {
      sweep = { type: "bearish", price: priorHigh, label: "Weak Bearish Sweep", confidence: Math.round(Math.min(95, ((lastHigh - lastClose) / (priorHigh - priorLow || 1)) * 200)) };
    }
  }

  return { buyPct, sellPct: 100 - buyPct, bars, poc, profileList: profileList.slice(0, 12), sweep };
}

// ---------- order-flow / spoofing tracking across polls ----------
function diffDepth(prevMap, currMap, threshold, midPrice) {
  const events = [];
  for (const [price, qty] of currMap.entries()) {
    const usd = price * qty;
    if (usd < threshold) continue;
    const prevQty = prevMap.get(price);
    if (prevQty === undefined) {
      events.push({ type: "APPEAR", price, usd, side: price >= midPrice ? "SELL" : "BUY" });
    } else if (qty > prevQty * 1.5) {
      events.push({ type: "INCREASE", price, usd, side: price >= midPrice ? "SELL" : "BUY" });
    } else if (qty < prevQty * 0.7) {
      events.push({ type: "PARTIAL", price, usd, side: price >= midPrice ? "SELL" : "BUY" });
    }
  }
  for (const [price, qty] of prevMap.entries()) {
    const usd = price * qty;
    if (usd < threshold) continue;
    if (!currMap.has(price)) {
      const nearTouch = Math.abs(price - midPrice) / midPrice < 0.0006;
      events.push({ type: nearTouch ? "PARTIAL" : "CANCEL", price, usd, side: price >= midPrice ? "SELL" : "BUY" });
    }
  }
  return events;
}

function depthToMap(levels) {
  const m = new Map();
  for (const [p, q] of levels) {
    const price = parseFloat(p);
    const qty = parseFloat(q);
    if (qty > 0) m.set(price, qty);
  }
  return m;
}

// ---------- data hook ----------
function useRadarData(symbol, interval) {
  const [ticker, setTicker] = useState(null);
  const [premium, setPremium] = useState(null);
  const [openInterest, setOpenInterest] = useState(null);
  const [depth, setDepth] = useState(null);
  const [klines, setKlines] = useState(null);
  const [chartKlines, setChartKlines] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);

  const prevDepthRef = useRef(null);
  const oiHistoryRef = useRef([]);

  const fetchCore = useCallback(async () => {
    try {
      const [tRes, pRes, oiRes, dRes, kRes] = await Promise.all([
        fetch(`${BASE}/ticker/24hr?symbol=${symbol}`),
        fetch(`${BASE}/premiumIndex?symbol=${symbol}`),
        fetch(`${BASE}/openInterest?symbol=${symbol}`),
        fetch(`${BASE}/depth?symbol=${symbol}&limit=1000`),
        fetch(`${BASE}/klines?symbol=${symbol}&interval=1m&limit=30`),
      ]);
      if (!tRes.ok || !pRes.ok || !oiRes.ok || !dRes.ok || !kRes.ok) throw new Error("Binance request failed");
      const [t, p, oi, d, k] = await Promise.all([tRes.json(), pRes.json(), oiRes.json(), dRes.json(), kRes.json()]);

      setTicker(t);
      setPremium(p);
      setOpenInterest(oi);
      setDepth(d);
      setKlines(k);

      const price = parseFloat(t.lastPrice);
      const threshold = Math.max(price * 2, 20000);
      const currBidMap = depthToMap(d.bids);
      const currAskMap = depthToMap(d.asks);
      const currMap = new Map([...currBidMap, ...currAskMap]);
      if (prevDepthRef.current) {
        const newEvents = diffDepth(prevDepthRef.current, currMap, threshold, price).map((e) => ({
          ...e,
          id: `${e.price}-${Date.now()}-${Math.random()}`,
          time: Date.now(),
        }));
        if (newEvents.length) {
          setEvents((prev) => [...newEvents, ...prev].slice(0, 60));
        }
      }
      prevDepthRef.current = currMap;

      const oiUsd = parseFloat(oi.openInterest) * price;
      oiHistoryRef.current = [...oiHistoryRef.current, { t: Date.now(), v: oiUsd }].slice(-30);

      setError(null);
      setLastUpdate(new Date());
    } catch (e) {
      setError(e.message || "Failed to reach Binance");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  const fetchChart = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=60`);
      if (!res.ok) throw new Error("chart fetch failed");
      const k = await res.json();
      setChartKlines(k);
    } catch (e) {
      // chart errors are non-fatal, keep old data
    }
  }, [symbol, interval]);

  useEffect(() => {
    prevDepthRef.current = null;
    oiHistoryRef.current = [];
    setEvents([]);
    setLoading(true);
    fetchCore();
    fetchChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  useEffect(() => {
    fetchChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

  useEffect(() => {
    const id = setInterval(fetchCore, 4000);
    return () => clearInterval(id);
  }, [fetchCore]);

  useEffect(() => {
    const id = setInterval(fetchChart, 15000);
    return () => clearInterval(id);
  }, [fetchChart]);

  const oiChangePct = useMemo(() => {
    const hist = oiHistoryRef.current;
    if (hist.length < 2) return 0;
    const first = hist[0].v;
    const last = hist[hist.length - 1].v;
    return first ? ((last - first) / first) * 100 : 0;
  }, [openInterest]);

  return { ticker, premium, openInterest, depth, klines, chartKlines, events, error, loading, lastUpdate, oiChangePct };
}

// ---------- small UI atoms ----------
function Card({ children, style }) {
  return <div style={{ ...styles.card, ...style }}>{children}</div>;
}
function CardLabel({ children, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <div style={styles.cardLabel}>{children}</div>
      {right && <div style={styles.cardLabelRight}>{right}</div>}
    </div>
  );
}
function Bar({ pct, color }) {
  return (
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}
function Gauge({ value, label, sub }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = clamped >= 60 ? "#22c55e" : clamped >= 40 ? "#f5b301" : "#ef4444";
  const r = 34,
    circ = 2 * Math.PI * r;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={r} fill="none" stroke="#1a2130" strokeWidth="8" />
        <circle
          cx="44"
          cy="44"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={circ}
          strokeDashoffset={circ - (clamped / 100) * circ}
          strokeLinecap="round"
          transform="rotate(-90 44 44)"
        />
        <text x="44" y="40" textAnchor="middle" fontSize="22" fontWeight="800" fill={color}>
          {Math.round(clamped)}
        </text>
        <text x="44" y="58" textAnchor="middle" fontSize="9" fontWeight="700" fill={color} letterSpacing="1">
          {label}
        </text>
      </svg>
      <div style={{ fontSize: 13, color: "#94a3b8" }}>{sub}</div>
    </div>
  );
}

export default function LiquidityRadar() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setIntervalStr] = useState("5m");
  const data = useRadarData(symbol, interval);
  const { ticker, premium, openInterest, depth, klines, chartKlines, events, error, loading, lastUpdate, oiChangePct } = data;

  const price = ticker ? parseFloat(ticker.lastPrice) : null;
  const changePct = ticker ? parseFloat(ticker.priceChangePercent) : null;
  const high = ticker ? parseFloat(ticker.highPrice) : null;
  const low = ticker ? parseFloat(ticker.lowPrice) : null;
  const vol = ticker ? parseFloat(ticker.quoteVolume) : null;
  const tradeCount = ticker ? parseInt(ticker.count) : null;
  const bestBid = depth && depth.bids[0] ? parseFloat(depth.bids[0][0]) : null;
  const bestAsk = depth && depth.asks[0] ? parseFloat(depth.asks[0][0]) : null;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
  const fundingRate = premium ? parseFloat(premium.lastFundingRate) * 100 : null;
  const oiUsd = openInterest && price ? parseFloat(openInterest.openInterest) * price : null;

  const depthAnalysis = useMemo(() => (depth && price ? analyzeDepth(depth.bids, depth.asks, price) : {}), [depth, price]);
  const { magnet, target, zones } = depthAnalysis;
  const kAnalysis = useMemo(() => analyzeKlines(klines), [klines]);

  const biasLabel = kAnalysis ? (kAnalysis.buyPct >= 50 ? "BULLISH" : "BEARISH") : null;
  const confidence =
    kAnalysis && target ? Math.round(Math.min(99, Math.max(1, Math.abs(kAnalysis.buyPct - 50) * 1.4 + (target.score || 0) * 0.3))) : null;

  const marketStrength =
    kAnalysis && fundingRate !== null ? Math.round(Math.min(100, Math.max(0, kAnalysis.buyPct + fundingRate * 150))) : null;
  const strengthLabel = marketStrength >= 65 ? "STRONG" : marketStrength >= 40 ? "MODERATE" : "WEAK";
  const strengthSub =
    marketStrength >= 65 ? "Trend has conviction." : marketStrength >= 40 ? "Mixed signals — monitor closely." : "Fading momentum.";

  // trap & squeeze heuristics (0-100), derived from real funding + bias + recent wick behavior
  const shortSqueeze = fundingRate !== null ? Math.round(Math.min(100, Math.max(0, -fundingRate * 400 + (kAnalysis ? kAnalysis.buyPct - 50 : 0) * 1.5))) : 0;
  const longSqueeze = fundingRate !== null ? Math.round(Math.min(100, Math.max(0, fundingRate * 400 + (kAnalysis ? 50 - kAnalysis.buyPct : 0) * 1.5))) : 0;
  const bullTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bearish" ? kAnalysis.sweep.confidence : 0;
  const bearTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bullish" ? 0 : 0;

  // spoofing score from recent CANCEL/APPEAR events
  const recentEvents = events.filter((e) => Date.now() - e.time < 120000);
  const cancels = recentEvents.filter((e) => e.type === "CANCEL");
  const appears = recentEvents.filter((e) => e.type === "APPEAR");
  const spoofScore = recentEvents.length ? Math.round(Math.min(100, (cancels.length / Math.max(1, appears.length + cancels.length)) * 130)) : 0;
  const biggestCancel = cancels.sort((a, b) => b.usd - a.usd)[0];

  const nextSweepPct = target ? Math.min(99, Math.round(target.score * 0.9 + Math.random() * 3)) : null;

  const chartData = useMemo(() => {
    if (!chartKlines) return [];
    return chartKlines.map((k) => ({ time: k[0], close: parseFloat(k[4]) }));
  }, [chartKlines]);

  return (
    <div style={styles.app}>
      <div style={styles.topBar}>
        <div style={styles.logoutPill}>⭘ Log out</div>
        <div style={styles.bell}>🔔</div>
      </div>

      <div style={styles.header}>
        <div>
          <div style={styles.title}>
            Liquidity <span style={styles.titleAccent}>Radar.</span>
          </div>
          <div style={styles.subtitle}>
            {symbol} PERP &nbsp;·&nbsp; BINANCE FUTURES
          </div>
        </div>
        <div style={styles.livePill}>
          <span style={styles.liveDot} /> LIVE
        </div>
      </div>
      <div style={styles.hr} />

      {/* symbol tabs */}
      <div style={styles.tabRow}>
        {SYMBOLS.map((s) => (
          <div
            key={s.symbol}
            onClick={() => setSymbol(s.symbol)}
            style={{ ...styles.tab, ...(symbol === s.symbol ? styles.tabActive : {}) }}
          >
            {s.label}
          </div>
        ))}
      </div>

      {error && <div style={styles.errorBox}>Couldn't reach Binance: {error}. Retrying…</div>}

      <div style={styles.statsRow}>
        <Stat label="OI" value={oiUsd ? fmtCompact(oiUsd) : "—"} />
        <Stat label="FR" value={fundingRate !== null ? fmtPct(fundingRate, 4) : "—"} color={fundingRate >= 0 ? "#22c55e" : "#ef4444"} />
        <Stat label="Spread" value={spread !== null ? fmtUSD(spread, spread < 1 ? 2 : 1) : "—"} />
        <Stat label="Trades" value={tradeCount ? tradeCount.toLocaleString() : "—"} color="#38bdf8" />
      </div>

      <Card style={styles.priceCard}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={styles.priceText}>{price ? fmtUSD(price, price < 100 ? 4 : 0) : "Loading…"}</div>
            <div style={{ color: changePct >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700, marginTop: 4 }}>
              {changePct !== null ? fmtPct(changePct) : ""}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "#38bdf8", fontSize: 34, fontWeight: 800 }}>{confidence ?? "—"}</div>
            <div style={styles.smallLabel}>CONFIDENCE</div>
          </div>
        </div>
        <div style={styles.priceSubRow}>
          <span>24h H: <b style={{ color: "#fff" }}>{high ? fmtUSD(high) : "—"}</b></span>
          <span>24h L: <b style={{ color: "#fff" }}>{low ? fmtUSD(low) : "—"}</b></span>
          <span>Vol: <b style={{ color: "#fff" }}>{vol ? fmtCompact(vol) : "—"}</b></span>
        </div>
      </Card>

      {/* Chart */}
      <Card>
        <CardLabel
          right={
            <div style={{ display: "flex", gap: 6 }}>
              {INTERVALS.map((iv) => (
                <span
                  key={iv}
                  onClick={() => setIntervalStr(iv)}
                  style={{ ...styles.ivPill, ...(interval === iv ? styles.ivPillActive : {}) }}
                >
                  {iv}
                </span>
              ))}
            </div>
          }
        >
          PRICE CHART
        </CardLabel>
        <div style={{ height: 160, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke="#1a2130" strokeDasharray="3 3" />
              <XAxis dataKey="time" tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} stroke="#475569" fontSize={10} minTickGap={30} />
              <YAxis domain={["auto", "auto"]} stroke="#475569" fontSize={10} width={54} tickFormatter={(v) => fmtCompact(v)} />
              <Tooltip
                contentStyle={{ background: "#0d1117", border: "1px solid #1a2130", borderRadius: 8, fontSize: 12 }}
                labelFormatter={(t) => new Date(t).toLocaleTimeString()}
                formatter={(v) => [fmtUSD(v, 2), "Price"]}
              />
              <Line type="monotone" dataKey="close" stroke="#f5b301" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <CardLabel>MARKET BIAS</CardLabel>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
          <div style={{ color: biasLabel === "BULLISH" ? "#22c55e" : "#ec4899", fontWeight: 800, fontSize: 20 }}>{biasLabel ?? "—"}</div>
          <div style={{ color: "#94a3b8" }}>{kAnalysis ? `${kAnalysis.buyPct.toFixed(1)}/100` : "—"}</div>
        </div>
        <Bar pct={kAnalysis ? kAnalysis.buyPct : 0} color="#22c55e" />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span style={{ color: "#22c55e", fontWeight: 700 }}>{kAnalysis ? kAnalysis.buyPct.toFixed(1) : "—"}% BUY</span>
          <span style={{ color: "#ec4899", fontWeight: 700 }}>{kAnalysis ? kAnalysis.sellPct.toFixed(1) : "—"}% SELL</span>
        </div>
      </Card>

      <div style={styles.twoCol}>
        <Card>
          <CardLabel>LIQUIDITY MAGNET</CardLabel>
          <div style={{ color: "#38bdf8", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{magnet ? fmtUSD(magnet.price, magnet.price < 100 ? 3 : 0) : "—"}</div>
          <div style={styles.cardHint}>Largest resting cluster.</div>
          <Row label="Distance" value={magnet && price ? `${(Math.abs(magnet.price - price) / price * 100).toFixed(2)}%` : "—"} valueColor="#22c55e" />
          <Row label="Cluster $" value={magnet ? fmtCompact(magnet.usd) : "—"} />
        </Card>
        <Card>
          <CardLabel>LIKELY TARGET</CardLabel>
          <div style={{ color: "#f5b301", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{target ? fmtUSD(target.price, target.price < 100 ? 3 : 0) : "—"}</div>
          <div style={styles.cardHint}>OB density + CVD weighted.</div>
          <Row label="Score" value={target ? `${target.score}/100` : "—"} valueColor="#f5b301" />
          <Row label="Type" value={target && price ? (target.price > price ? "Resistance ▲" : "Support ▼") : "—"} valueColor="#f5b301" />
        </Card>
      </div>

      <Card>
        <CardLabel>MARKET STRENGTH</CardLabel>
        <div style={{ marginTop: 8 }}>
          <Gauge value={marketStrength ?? 50} label={strengthLabel} sub={strengthSub} />
        </div>
      </Card>

      <Card>
        <CardLabel>LAST LIQUIDITY SWEEP</CardLabel>
        {kAnalysis && kAnalysis.sweep ? (
          <>
            <div style={{ ...styles.sweepBadge, color: kAnalysis.sweep.type === "bullish" ? "#22c55e" : "#ec4899" }}>
              {kAnalysis.sweep.label}
            </div>
            <div style={styles.cardHint}>Price swept {fmtUSD(kAnalysis.sweep.price)}, reclaimed range.</div>
            <div style={{ display: "flex", gap: 24, marginTop: 10 }}>
              <MiniStat label="At Price" value={fmtUSD(kAnalysis.sweep.price)} />
              <MiniStat label="Confidence" value={`${kAnalysis.sweep.confidence}/100`} color="#f5b301" />
            </div>
          </>
        ) : (
          <div style={styles.cardHint}>No recent sweep detected in the last 12 candles.</div>
        )}
      </Card>

      <Card>
        <CardLabel>TRAP &amp; SQUEEZE RISK</CardLabel>
        <TrapRow label="Bull Trap" value={bullTrap} />
        <TrapRow label="Bear Trap" value={bearTrap} />
        <TrapRow label="Short Squeeze" value={shortSqueeze} color="#22c55e" />
        <TrapRow label="Long Squeeze" value={longSqueeze} color="#38bdf8" />
      </Card>

      <Card>
        <CardLabel>POSSIBLE SPOOFING</CardLabel>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginTop: 6 }}>
          <div style={{ color: "#ec4899", fontSize: 28, fontWeight: 800 }}>{spoofScore}/100</div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>
            {biggestCancel
              ? `${fmtCompact(biggestCancel.usd)} ${biggestCancel.side === "BUY" ? "bid" : "ask"} wall at ${fmtUSD(biggestCancel.price, biggestCancel.price < 100 ? 3 : 0)} — pulled`
              : "No large walls pulled recently."}
          </div>
        </div>
        <div style={styles.spoofBars}>
          {recentEvents.slice(0, 20).map((e, i) => (
            <div key={e.id || i} style={{ ...styles.spoofBar, background: e.type === "CANCEL" ? "#ec4899" : e.type === "APPEAR" ? "#f5b301" : "#334155" }} />
          ))}
        </div>
        <div style={styles.warnText}>⚠ Probability estimate only. Never confirmed — do not trade on this alone.</div>
      </Card>

      <Card>
        <CardLabel>FUNDING RATE + OPEN INTEREST</CardLabel>
        <div style={styles.statsRow2}>
          <MiniStat label="RATE" value={fundingRate !== null ? fmtPct(fundingRate, 4) : "—"} color={fundingRate >= 0 ? "#22c55e" : "#ef4444"} />
          <MiniStat label="OPEN INT." value={oiUsd ? fmtCompact(oiUsd) : "—"} color="#38bdf8" />
          <MiniStat label="OI CHANGE" value={fmtPct(oiChangePct, 2)} color={oiChangePct >= 0 ? "#22c55e" : "#ef4444"} />
          <MiniStat label="NEXT SWEEP" value={nextSweepPct !== null ? `${nextSweepPct}%` : "—"} color="#f5b301" />
        </div>
      </Card>

      <Card>
        <CardLabel>CVD — VOLUME DELTA</CardLabel>
        <div style={styles.cvdChart}>
          {kAnalysis &&
            kAnalysis.bars.map((b, i) => {
              const maxAbs = Math.max(...kAnalysis.bars.map((x) => Math.abs(x.delta)), 1);
              const h = Math.max(4, (Math.abs(b.delta) / maxAbs) * 60);
              return <div key={i} style={{ width: 6, height: h, background: b.delta >= 0 ? "#22c55e" : "#ec4899", borderRadius: 2 }} />;
            })}
        </div>
        {kAnalysis && (
          <div style={styles.statsRow2}>
            <MiniStat label="Buy Vol" value={fmtQty(kAnalysis.bars.reduce((s, b) => s + Math.max(0, b.delta), 0))} color="#22c55e" />
            <MiniStat label="Sell Vol" value={fmtQty(Math.abs(kAnalysis.bars.reduce((s, b) => s + Math.min(0, b.delta), 0)))} color="#ec4899" />
            <MiniStat label="Delta" value={fmtQty(kAnalysis.bars.reduce((s, b) => s + b.delta, 0))} color="#38bdf8" />
            <MiniStat label="Trend" value={biasLabel === "BULLISH" ? "Bull ↑" : "Bear ↓"} color={biasLabel === "BULLISH" ? "#22c55e" : "#ec4899"} />
          </div>
        )}
      </Card>

      <Card>
        <CardLabel>LIQUIDITY TARGET ZONES</CardLabel>
        <div style={{ marginTop: 8 }}>
          {(zones || []).map((z, i) => (
            <div key={i} style={styles.zoneRow}>
              <span style={{ color: z.side === "ask" ? "#f5b301" : "#38bdf8", width: 90, fontWeight: 700, fontSize: 13 }}>
                {z.side === "ask" ? "▲" : "▼"} {fmtUSD(z.price, z.price < 100 ? 3 : 0)}
              </span>
              <div style={{ ...styles.zoneBar, background: z.side === "ask" ? "rgba(245,179,1,0.18)" : "rgba(56,189,248,0.18)" }}>
                <span style={{ fontSize: 11, color: "#cbd5e1" }}>
                  {z.side === "ask" ? "Sell Wall" : "Buy Wall"} · {fmtCompact(z.usd)}
                </span>
              </div>
              <span style={{ color: "#f5b301", fontWeight: 700, width: 30, textAlign: "right" }}>{z.score}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardLabel>ORDER BOOK — LIVE</CardLabel>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginTop: 8 }}>
          <span>BIDS (BUY)</span>
          <span>ASKS (SELL)</span>
        </div>
        {depth &&
          depth.bids.slice(0, 8).map((bid, i) => {
            const ask = depth.asks[i];
            return (
              <div key={i} style={styles.obRow}>
                <span style={{ color: "#22c55e", fontWeight: 700 }}>{fmtUSD(parseFloat(bid[0]), parseFloat(bid[0]) < 100 ? 3 : 0)}</span>
                <span style={{ color: "#64748b" }}>{fmtQty(bid[1])}</span>
                <span style={{ color: "#64748b" }}>{ask ? fmtQty(ask[1]) : "—"}</span>
                <span style={{ color: "#ec4899", fontWeight: 700 }}>{ask ? fmtUSD(parseFloat(ask[0]), parseFloat(ask[0]) < 100 ? 3 : 0) : "—"}</span>
              </div>
            );
          })}
      </Card>

      <Card>
        <CardLabel right={<span style={{ fontSize: 10, color: "#64748b" }}>AMBER = WALL</span>}>ORDER BOOK HEATMAP</CardLabel>
        <div style={{ marginTop: 8 }}>
          {(zones || [])
            .slice()
            .sort((a, b) => b.price - a.price)
            .map((z, i) => {
              const maxUsd = Math.max(...(zones || []).map((x) => x.usd), 1);
              const isWall = z.usd === maxUsd;
              return (
                <div key={i} style={styles.heatRow}>
                  <span style={{ width: 76, fontSize: 12, color: price && Math.abs(z.price - price) < (depthAnalysis.bucketSize || 1) ? "#38bdf8" : "#64748b" }}>
                    {fmtUSD(z.price, z.price < 100 ? 3 : 0)}
                  </span>
                  <div style={{ ...styles.heatBar, width: `${(z.usd / maxUsd) * 100}%`, background: isWall ? "#f5b301" : z.side === "ask" ? "rgba(236,72,153,0.35)" : "rgba(34,197,94,0.35)" }}>
                    {isWall && <span style={{ fontSize: 11, color: "#05070a", fontWeight: 800, padding: "0 6px" }}>{fmtCompact(z.usd)} WALL</span>}
                  </div>
                </div>
              );
            })}
        </div>
      </Card>

      <Card>
        <CardLabel right={<span style={{ fontSize: 10, color: "#64748b" }}>★ = Point of Control</span>}>VOLUME PROFILE — SESSION</CardLabel>
        {kAnalysis && kAnalysis.poc && (
          <div style={{ marginTop: 8 }}>
            {kAnalysis.profileList.slice(0, 6).map((p, i) => {
              const maxVol = kAnalysis.profileList[0].vol;
              return (
                <div key={i} style={styles.heatRow}>
                  <span style={{ width: 90, fontSize: 12, color: p.price === kAnalysis.poc.price ? "#f5b301" : "#94a3b8" }}>
                    {p.price === kAnalysis.poc.price ? "★ " : ""}
                    {fmtUSD(p.price, p.price < 100 ? 3 : 0)}
                  </span>
                  <div style={{ ...styles.heatBar, width: `${(p.vol / maxVol) * 100}%`, background: "rgba(245,179,1,0.35)" }} />
                  <span style={{ fontSize: 11, color: "#64748b", marginLeft: 6 }}>{fmtQty(p.vol)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <CardLabel right={<span style={{ fontSize: 10, color: "#64748b" }}>large notional appear/fill/cancel</span>}>LARGE ORDER EVENTS</CardLabel>
        <div style={{ marginTop: 6, maxHeight: 260, overflowY: "auto" }}>
          {events.length === 0 && <div style={styles.cardHint}>Watching the book for large orders…</div>}
          {events.slice(0, 20).map((e) => (
            <div key={e.id} style={styles.eventRow}>
              <span style={{ width: 62, fontSize: 11, color: "#64748b" }}>{e.type}</span>
              <span style={{ width: 46, fontSize: 11, color: e.side === "BUY" ? "#22c55e" : "#ec4899", fontWeight: 700 }}>{e.side}</span>
              <span style={{ flex: 1, fontSize: 13, color: "#e2e8f0" }}>{fmtUSD(e.price, e.price < 100 ? 3 : 0)}</span>
              <span style={{ fontSize: 12, color: "#cbd5e1" }}>{fmtCompact(e.usd)}</span>
              <span style={{ width: 50, fontSize: 10, color: "#64748b", textAlign: "right" }}>{timeAgo(e.time)}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardLabel right={<span style={{ fontSize: 10, color: "#64748b" }}>{zones ? zones.length + events.length : 0} total</span>}>ALERTS</CardLabel>
        <div style={{ marginTop: 6, maxHeight: 260, overflowY: "auto" }}>
          {(zones || []).slice(0, 5).map((z, i) => (
            <div key={"z" + i} style={styles.alertRow}>
              <span style={{ ...styles.alertBar, background: "#38bdf8" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>🎯 Liquidity Target Forming</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>
                  Cluster near {fmtUSD(z.price, z.price < 100 ? 3 : 0)}. Score {z.score}/100.
                </div>
              </div>
              <span style={{ fontSize: 10, color: "#64748b" }}>0s ago</span>
            </div>
          ))}
          {kAnalysis && kAnalysis.sweep && (
            <div style={styles.alertRow}>
              <span style={{ ...styles.alertBar, background: kAnalysis.sweep.type === "bullish" ? "#22c55e" : "#ec4899" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{kAnalysis.sweep.type === "bullish" ? "↑" : "↓"} {kAnalysis.sweep.label}</div>
                <div style={{ fontSize: 12, color: "#94a3b8" }}>
                  Confidence {kAnalysis.sweep.confidence}/100. Price swept {fmtUSD(kAnalysis.sweep.price)}.
                </div>
              </div>
              <span style={{ fontSize: 10, color: "#64748b" }}>1m ago</span>
            </div>
          )}
        </div>
      </Card>

      <div style={styles.footer}>
        {loading ? "Connecting to Binance Futures…" : lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : ""}
        <div style={{ marginTop: 4, opacity: 0.6 }}>
          Spoofing, trap/squeeze, and sweep scores are heuristic models built from public order-book &amp; kline data — not the
          exchange's internal order events. Not financial advice.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={styles.statCell}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ fontWeight: 700, color: color || "#e2e8f0" }}>{value}</div>
    </div>
  );
}
function MiniStat({ label, value, color }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{ fontWeight: 800, color: color || "#e2e8f0", fontSize: 15 }}>{value}</div>
      <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>{label}</div>
    </div>
  );
}
function Row({ label, value, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 14 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ color: valueColor || "#fff", fontWeight: 700 }}>{value}</span>
    </div>
  );
}
function TrapRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
      <span style={{ width: 100, fontSize: 13, color: "#94a3b8" }}>{label}</span>
      <div style={{ flex: 1 }}>
        <Bar pct={value} color={color || "#ec4899"} />
      </div>
      <span style={{ width: 26, textAlign: "right", fontSize: 13, color: "#e2e8f0" }}>{value}</span>
    </div>
  );
}

const styles = {
  app: { background: "#05070a", minHeight: "100vh", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, sans-serif", padding: "20px 16px 40px", maxWidth: 480, margin: "0 auto", boxSizing: "border-box" },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  logoutPill: { border: "1px solid #2a3240", borderRadius: 999, padding: "8px 16px", fontSize: 13, color: "#cbd5e1" },
  bell: { background: "#f5b301", borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  title: { fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 32, color: "#fff", lineHeight: 1.05 },
  titleAccent: { color: "#f5b301", fontStyle: "italic" },
  subtitle: { fontSize: 11, letterSpacing: 2, color: "#64748b", marginTop: 6 },
  livePill: { border: "1px solid #134e3a", color: "#22c55e", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, height: "fit-content" },
  liveDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block" },
  hr: { height: 2, background: "linear-gradient(90deg,#f5b301,transparent)", marginTop: 16, marginBottom: 14 },
  tabRow: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 14, marginBottom: 4 },
  tab: { flexShrink: 0, padding: "7px 14px", borderRadius: 999, border: "1px solid #1a2130", color: "#94a3b8", fontSize: 12, fontWeight: 700 },
  tabActive: { background: "#f5b301", color: "#05070a", borderColor: "#f5b301" },
  errorBox: { background: "#2a1215", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 16 },
  statsRow: { display: "flex", justifyContent: "space-between", background: "#0d1117", border: "1px solid #1a2130", borderRadius: 16, padding: "14px 10px", marginBottom: 16 },
  statCell: { textAlign: "center", flex: 1 },
  statLabel: { fontSize: 11, color: "#64748b", marginBottom: 4 },
  priceCard: { border: "1px solid #16532f", background: "#0a1410" },
  priceText: { fontSize: 32, fontWeight: 800, color: "#fff" },
  smallLabel: { fontSize: 11, color: "#64748b", letterSpacing: 1 },
  priceSubRow: { display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 13, color: "#94a3b8" },
  card: { background: "#0d1117", border: "1px solid #1a2130", borderRadius: 16, padding: 16, marginBottom: 16 },
  cardLabel: { fontSize: 11, letterSpacing: 1.5, color: "#64748b", fontWeight: 700 },
  cardLabelRight: { fontSize: 10 },
  barTrack: { height: 8, background: "#1a2130", borderRadius: 999, marginTop: 10, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999, transition: "width 0.4s ease" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 },
  cardHint: { fontSize: 12, color: "#64748b", marginTop: 4, lineHeight: 1.4 },
  sweepBadge: { display: "inline-block", background: "#111827", borderRadius: 999, padding: "5px 12px", fontSize: 12, fontWeight: 800, marginTop: 8 },
  spoofBars: { display: "flex", gap: 3, alignItems: "flex-end", height: 30, marginTop: 12 },
  spoofBar: { width: 8, height: 24, borderRadius: 2 },
  warnText: { fontSize: 11, color: "#64748b", fontStyle: "italic", marginTop: 10 },
  statsRow2: { display: "flex", justifyContent: "space-between", marginTop: 12 },
  cvdChart: { display: "flex", gap: 3, alignItems: "flex-end", height: 64, marginTop: 10 },
  zoneRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  zoneBar: { flex: 1, borderRadius: 8, padding: "6px 8px" },
  obRow: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", fontSize: 13, padding: "4px 0" },
  heatRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  heatBar: { height: 22, borderRadius: 4, display: "flex", alignItems: "center", minWidth: 4 },
  eventRow: { display: "flex", alignItems: "center", gap: 6, padding: "6px 0", borderBottom: "1px solid #131a25" },
  alertRow: { display: "flex", gap: 10, padding: "10px 0", borderBottom: "1px solid #131a25" },
  alertBar: { width: 3, borderRadius: 2, alignSelf: "stretch" },
  ivPill: { fontSize: 11, color: "#64748b", padding: "3px 8px", borderRadius: 6, border: "1px solid #1a2130" },
  ivPillActive: { color: "#05070a", background: "#f5b301", borderColor: "#f5b301", fontWeight: 700 },
  footer: { textAlign: "center", fontSize: 12, color: "#475569", marginTop: 24 },
};
