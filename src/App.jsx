import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";

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

function analyzeKlines(klines) {
  if (!klines || klines.length === 0) return null;
  let buyVol = 0, sellVol = 0;
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

  return { buyPct, sellPct: 100 - buyPct, bars, sweep };
}

function klinesToCandleData(klines) {
  if (!klines) return [];
  return klines.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

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
    } catch (e) {}
  }, [symbol, interval]);

  useEffect(() => {
    prevDepthRef.current = null;
    oiHistoryRef.current = [];
    setEvents([]);
    setLoading(true);
    fetchCore();
    fetchChart();
  }, [symbol]);

  useEffect(() => {
    fetchChart();
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

function CandleStick({ x, y, width, height, payload }) {
  if (!payload) return null;
  const { open, high, low, close } = payload;
  if (!open || !high || !low || !close) return null;

  const yScale = height / (Math.max(...[open, high, low, close]) - Math.min(...[open, high, low, close]) + 1);
  const minY = Math.min(...[open, high, low, close]);

  const yPos = (val) => y + height - (val - minY) * yScale;
  const wickX = x + width / 2;
  const bodyWidth = Math.max(width * 0.6, 2);

  const isGreen = close >= open;
  const color = isGreen ? "#22c55e" : "#ef4444";
  const bodyTop = yPos(Math.max(open, close));
  const bodyHeight = Math.abs(yPos(Math.min(open, close)) - bodyTop) || 1;

  return (
    <g>
      <line x1={wickX} y1={yPos(high)} x2={wickX} y2={yPos(low)} stroke={color} strokeWidth="1" />
      <rect x={x + (width - bodyWidth) / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} stroke={color} strokeWidth="0.5" />
    </g>
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
  const confidence = kAnalysis && target ? Math.round(Math.min(99, Math.max(1, Math.abs(kAnalysis.buyPct - 50) * 1.4 + (target.score || 0) * 0.3))) : null;

  const marketStrength = kAnalysis && fundingRate !== null ? Math.round(Math.min(100, Math.max(0, kAnalysis.buyPct + fundingRate * 150))) : null;
  const strengthLabel = marketStrength >= 65 ? "STRONG" : marketStrength >= 40 ? "MODERATE" : "WEAK";

  const bullTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bearish" ? kAnalysis.sweep.confidence : 0;
  const bearTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bullish" ? kAnalysis.sweep.confidence : 0;

  const recentEvents = events.filter((e) => Date.now() - e.time < 120000);
  const cancels = recentEvents.filter((e) => e.type === "CANCEL");
  const appears = recentEvents.filter((e) => e.type === "APPEAR");
  const spoofScore = recentEvents.length ? Math.round(Math.min(100, (cancels.length / Math.max(1, appears.length + cancels.length)) * 130)) : 0;

  const candleData = useMemo(() => klinesToCandleData(chartKlines), [chartKlines]);

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
          <div style={styles.subtitle}>{symbol} PERP · BINANCE FUTURES</div>
        </div>
        <div style={styles.livePill}>
          <span style={styles.liveDot} /> LIVE
        </div>
      </div>
      <div style={styles.hr} />

      <div style={styles.tabRow}>
        {SYMBOLS.map((s) => (
          <div key={s.symbol} onClick={() => setSymbol(s.symbol)} style={{ ...styles.tab, ...(symbol === s.symbol ? styles.tabActive : {}) }}>
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

      <div style={styles.priceCard}>
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
      </div>

      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
          <div style={styles.cardLabel}>CANDLESTICK CHART</div>
          <div style={{ display: "flex", gap: 6 }}>
            {INTERVALS.map((iv) => (
              <span key={iv} onClick={() => setIntervalStr(iv)} style={{ ...styles.ivPill, ...(interval === iv ? styles.ivPillActive : {}) }}>
                {iv}
              </span>
            ))}
          </div>
        </div>
        <div style={{ height: 200, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={candleData}>
              <CartesianGrid stroke="#1a2130" strokeDasharray="3 3" />
              <XAxis dataKey="time" tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} stroke="#475569" fontSize={10} minTickGap={30} />
              <YAxis domain={["auto", "auto"]} stroke="#475569" fontSize={10} width={54} tickFormatter={(v) => fmtCompact(v)} />
              <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #1a2130", borderRadius: 8, fontSize: 12 }} formatter={(v) => fmtUSD(v, 2)} />
              <Bar dataKey="close" shape={<CandleStick />} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardLabel}>MARKET BIAS</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
          <div style={{ color: biasLabel === "BULLISH" ? "#22c55e" : "#ec4899", fontWeight: 800, fontSize: 20 }}>{biasLabel ?? "—"}</div>
          <div style={{ color: "#94a3b8" }}>{kAnalysis ? `${kAnalysis.buyPct.toFixed(1)}/100` : "—"}</div>
        </div>
        <div style={styles.barTrack}>
          <div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, kAnalysis ? kAnalysis.buyPct : 0))}%` }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span style={{ color: "#22c55e", fontWeight: 700 }}>{kAnalysis ? kAnalysis.buyPct.toFixed(1) : "—"}% BUY</span>
          <span style={{ color: "#ec4899", fontWeight: 700 }}>{kAnalysis ? kAnalysis.sellPct.toFixed(1) : "—"}% SELL</span>
        </div>
      </div>

      <div style={styles.twoCol}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>LIQUIDITY MAGNET</div>
          <div style={{ color: "#38bdf8", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{magnet ? fmtUSD(magnet.price, magnet.price < 100 ? 3 : 0) : "—"}</div>
          <div style={styles.cardHint}>Largest resting cluster.</div>
          <Row label="Distance" value={magnet && price ? `${(Math.abs(magnet.price - price) / price * 100).toFixed(2)}%` : "—"} valueColor="#22c55e" />
          <Row label="Cluster $" value={magnet ? fmtCompact(magnet.usd) : "—"} />
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>LIKELY TARGET</div>
          <div style={{ color: "#f5b301", fontSize: 22, fontWeight: 800, marginTop: 4 }}>{target ? fmtUSD(target.price, target.price < 100 ? 3 : 0) : "—"}</div>
          <div style={styles.cardHint}>OB density + CVD weighted.</div>
          <Row label="Score" value={target ? `${target.score}/100` : "—"} valueColor="#f5b301" />
          <Row label="Type" value={target && price ? (target.price > price ? "Resistance ▲" : "Support ▼") : "—"} valueColor="#f5b301" />
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardLabel}>MARKET STRENGTH</div>
        <div style={{ marginTop: 8, fontSize: 18, fontWeight: 800, color: marketStrength >= 65 ? "#22c55e" : marketStrength >= 40 ? "#f5b301" : "#ef4444" }}>
          {strengthLabel}
        </div>
        <div style={{ marginTop: 4, color: "#94a3b8", fontSize: 12 }}>
          {marketStrength >= 65 ? "Trend has conviction." : marketStrength >= 40 ? "Mixed signals — monitor closely." : "Fading momentum."}
        </div>
      </div>

      <div style={styles.footer}>
        {loading ? "Connecting to Binance Futures…" : lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : ""}
        <div style={{ marginTop: 4, opacity: 0.6, fontSize: 11 }}>
          Real-time data from Binance Futures. Not financial advice.
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

function Row({ label, value, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 14 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ color: valueColor || "#fff", fontWeight: 700 }}>{value}</span>
    </div>
  );
}

const styles = {
  app: { background: "#05070a", minHeight: "100vh", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, sans-serif", padding: "0px" },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 20, paddingTop: 20, paddingLeft: 16, paddingRight: 16 },
  logoutPill: { border: "1px solid #2a3240", borderRadius: 999, padding: "8px 16px", fontSize: 13, color: "#cbd5e1" },
  bell: { background: "#f5b301", borderRadius: "50%", width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", paddingLeft: 16, paddingRight: 16 },
  title: { fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 36, color: "#fff", lineHeight: 1.05, fontWeight: 700 },
  titleAccent: { color: "#f5b301", fontStyle: "italic" },
  subtitle: { fontSize: 11, letterSpacing: 2, color: "#64748b", marginTop: 6 },
  livePill: { border: "1px solid #134e3a", color: "#22c55e", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 6, height: "fit-content" },
  liveDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block" },
  hr: { height: 2, background: "linear-gradient(90deg,#f5b301,transparent)", marginTop: 16, marginBottom: 14, width: "100%" },
  tabRow: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 14, marginBottom: 4, paddingLeft: 16, paddingRight: 16 },
  tab: { flexShrink: 0, padding: "7px 14px", borderRadius: 999, border: "1px solid #1a2130", color: "#94a3b8", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  tabActive: { background: "#f5b301", color: "#05070a", borderColor: "#f5b301" },
  errorBox: { background: "#2a1215", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 10, padding: "10px 12px", fontSize: 13, marginBottom: 16, marginLeft: 16, marginRight: 16 },
  statsRow: { display: "flex", justifyContent: "space-between", background: "#0d1117", border: "1px solid #1a2130", borderRadius: 16, padding: "14px 10px", marginBottom: 16, marginLeft: 16, marginRight: 16 },
  statCell: { textAlign: "center", flex: 1 },
  statLabel: { fontSize: 11, color: "#64748b", marginBottom: 4 },
  priceCard: { border: "1px solid #16532f", background: "#0a1410", borderRadius: 16, padding: 20, marginBottom: 16, marginLeft: 16, marginRight: 16 },
  priceText: { fontSize: 36, fontWeight: 800, color: "#fff" },
  smallLabel: { fontSize: 11, color: "#64748b", letterSpacing: 1 },
  priceSubRow: { display: "flex", justifyContent: "space-between", marginTop: 14, fontSize: 13, color: "#94a3b8" },
  card: { background: "#0d1117", border: "1px solid #1a2130", borderRadius: 16, padding: 16, marginBottom: 16, marginLeft: 16, marginRight: 16 },
  cardLabel: { fontSize: 11, letterSpacing: 1.5, color: "#64748b", fontWeight: 700 },
  barTrack: { height: 8, background: "#1a2130", borderRadius: 999, marginTop: 10, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999, transition: "width 0.4s ease", background: "#22c55e" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16, marginLeft: 16, marginRight: 16 },
  cardHint: { fontSize: 12, color: "#64748b", marginTop: 4, lineHeight: 1.4 },
  ivPill: { fontSize: 11, color: "#64748b", padding: "3px 8px", borderRadius: 6, border: "1px solid #1a2130", cursor: "pointer" },
  ivPillActive: { color: "#05070a", background: "#f5b301", borderColor: "#f5b301", fontWeight: 700 },
  footer: { textAlign: "center", fontSize: 12, color: "#475569", marginTop: 24, paddingBottom: 40, paddingLeft: 16, paddingRight: 16 },
};
