import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ComposedChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";

const BASE = "https://fapi.binance.com/fapi/v1";

const SYMBOLS = [
  { symbol: "BTCUSDT", label: "BTC" },
  { symbol: "ETHUSDT", label: "ETH" },
  { symbol: "SOLUSDT", label: "SOL" },
  { symbol: "BNBUSDT", label: "BNB" },
  { symbol: "XRPUSDT", label: "XRP" },
  { symbol: "DOGEUSDT", label: "DOGE" },
  { symbol: "XAUUSDT", label: "XAU" },
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

  const profile = {};
  let priceStep = null;
  for (const k of klines) {
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const vol = parseFloat(k[5]);
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
      // non-fatal
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
    const id = setInterval(fetchCore, 1000);
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

// ---------- Custom Chart Components ----------
const WickShape = (props) => {
  const { x, y, width, height, payload } = props;
  const fill = payload.isUp ? "#22c55e" : "#ef4444";
  return <rect x={x + width / 2 - 1} y={y} width={2} height={height} fill={fill} />;
};

const CandleBodyShape = (props) => {
  const { x, y, width, height, payload } = props;
  const fill = payload.isUp ? "#22c55e" : "#ef4444";
  return <rect x={x} y={y} width={width} height={Math.max(height, 1)} fill={fill} rx={1} />;
};

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, padding: "10px 14px", fontSize: 12, color: "#cbd5e1", boxShadow: "0 10px 25px rgba(0,0,0,0.5)" }}>
        <div style={{ marginBottom: 6, color: "#94a3b8", fontWeight: 600 }}>{new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>O: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtUSD(data.open, 2)}</span></div>
          <div>H: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtUSD(data.high, 2)}</span></div>
          <div>L: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtUSD(data.low, 2)}</span></div>
          <div>C: <span style={{ color: data.isUp ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{fmtUSD(data.close, 2)}</span></div>
        </div>
      </div>
    );
  }
  return null;
};


// ---------- small UI atoms ----------
function Card({ children, style }) {
  return <div style={{ ...styles.card, ...style }}>{children}</div>;
}
function CardLabel({ children, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
      <div style={styles.cardLabel}>{children}</div>
      {right && <div style={styles.cardLabelRight}>{right}</div>}
    </div>
  );
}
function BarGauge({ pct, color }) {
  return (
    <div style={styles.barTrack}>
      <div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );
}
function Gauge({ value, label, sub }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = clamped >= 60 ? "#22c55e" : clamped >= 40 ? "#f5b301" : "#ef4444";
  const r = 34, circ = 2 * Math.PI * r;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width="88" height="88" viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={r} fill="none" stroke="#1e293b" strokeWidth="8" />
        <circle
          cx="44" cy="44" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={circ} strokeDashoffset={circ - (clamped / 100) * circ}
          strokeLinecap="round" transform="rotate(-90 44 44)"
        />
        <text x="44" y="40" textAnchor="middle" fontSize="22" fontWeight="800" fill={color}>{Math.round(clamped)}</text>
        <text x="44" y="58" textAnchor="middle" fontSize="9" fontWeight="700" fill={color} letterSpacing="1">{label}</text>
      </svg>
      <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}

export default function LiquidityRadar() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setIntervalStr] = useState("5m");
  const data = useRadarData(symbol, interval);
  const { ticker, premium, openInterest, depth, klines, chartKlines, events, error, loading, lastUpdate, oiChangePct } = data;

  useEffect(() => {
    // Fix white sides by forcing body color globally
    document.body.style.backgroundColor = "#02040a";
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    document.documentElement.style.backgroundColor = "#02040a";
  }, []);

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
  const strengthSub = marketStrength >= 65 ? "Trend has conviction." : marketStrength >= 40 ? "Mixed signals — monitor closely." : "Fading momentum.";

  const shortSqueeze = fundingRate !== null ? Math.round(Math.min(100, Math.max(0, -fundingRate * 400 + (kAnalysis ? kAnalysis.buyPct - 50 : 0) * 1.5))) : 0;
  const longSqueeze = fundingRate !== null ? Math.round(Math.min(100, Math.max(0, fundingRate * 400 + (kAnalysis ? 50 - kAnalysis.buyPct : 0) * 1.5))) : 0;
  const bullTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bearish" ? kAnalysis.sweep.confidence : 0;
  const bearTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bullish" ? kAnalysis.sweep.confidence : 0;

  const recentEvents = events.filter((e) => Date.now() - e.time < 120000);
  const cancels = recentEvents.filter((e) => e.type === "CANCEL");
  const appears = recentEvents.filter((e) => e.type === "APPEAR");
  const spoofScore = recentEvents.length ? Math.round(Math.min(100, (cancels.length / Math.max(1, appears.length + cancels.length)) * 130)) : 0;
  const biggestCancel = cancels.sort((a, b) => b.usd - a.usd)[0];
  const nextSweepPct = target ? Math.min(99, Math.round(target.score * 0.9 + Math.random() * 3)) : null;

  const chartData = useMemo(() => {
    if (!chartKlines) return [];
    return chartKlines.map((k) => {
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      return {
        time: k[0], open, high, low, close,
        candle: [open, close].sort((a, b) => a - b),
        wick: [low, high],
        isUp: close >= open
      };
    });
  }, [chartKlines]);

  return (
    <div style={styles.pageWrapper}>
      <div style={styles.app}>
        <div style={styles.topBar}>
          <div style={styles.logoutPill}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginRight: 6}}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
            Log out
          </div>
          <div style={styles.bell}>
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#05070a" strokeWidth="2.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
          </div>
        </div>

        <div style={styles.header}>
          <div>
            <div style={styles.title}>
              Liquidity <span style={styles.titleAccent}>Radar.</span>
            </div>
            <div style={styles.subtitle}>{symbol} PERP &nbsp;·&nbsp; BINANCE FUTURES</div>
          </div>
          <div style={styles.livePill}>
            <span style={styles.liveDot} /> LIVE
          </div>
        </div>
        
        <div style={styles.hr} />

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

        {error && <div style={styles.errorBox}>Connection error: {error}. Retrying…</div>}

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
              <div style={styles.priceChangeWrapper}>
                <span style={{ color: changePct >= 0 ? "#22c55e" : "#ef4444", fontWeight: 700 }}>
                  {changePct !== null ? fmtPct(changePct) : ""}
                </span>
              </div>
            </div>
            <div style={{ textAlign: "right", marginTop: 4 }}>
              <div style={{ color: "#38bdf8", fontSize: 38, fontWeight: 800, lineHeight: 1 }}>{confidence ?? "—"}</div>
              <div style={styles.smallLabel}>CONFIDENCE</div>
            </div>
          </div>
          <div style={styles.priceSubRow}>
            <span>24h H: <b style={{ color: "#fff" }}>{high ? fmtUSD(high) : "—"}</b></span>
            <span>24h L: <b style={{ color: "#fff" }}>{low ? fmtUSD(low) : "—"}</b></span>
            <span>Vol: <b style={{ color: "#fff" }}>{vol ? fmtCompact(vol) : "—"}</b></span>
          </div>
        </Card>

        {/* Candlestick Chart */}
        <Card style={{ padding: "20px 16px" }}>
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
          <div style={{ height: 180, marginTop: 12, marginLeft: -12 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="time" tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} stroke="#64748b" fontSize={10} minTickGap={30} tickLine={false} axisLine={false} dy={10} />
                <YAxis domain={["auto", "auto"]} stroke="#64748b" fontSize={10} width={54} tickFormatter={(v) => fmtCompact(v)} tickLine={false} axisLine={false} />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#334155', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Bar dataKey="wick" shape={<WickShape />} isAnimationActive={false} />
                <Bar dataKey="candle" shape={<CandleBodyShape />} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardLabel>MARKET BIAS</CardLabel>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: -4 }}>
            <div style={{ color: biasLabel === "BULLISH" ? "#22c55e" : "#ec4899", fontWeight: 800, fontSize: 22 }}>{biasLabel ?? "—"}</div>
            <div style={{ color: "#94a3b8", fontWeight: 600 }}>{kAnalysis ? `${kAnalysis.buyPct.toFixed(1)}/100` : "—"}</div>
          </div>
          <BarGauge pct={kAnalysis ? kAnalysis.buyPct : 0} color={biasLabel === "BULLISH" ? "#22c55e" : "#ec4899"} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 13 }}>
            <span style={{ color: "#22c55e", fontWeight: 700 }}>{kAnalysis ? kAnalysis.buyPct.toFixed(1) : "—"}% BUY</span>
            <span style={{ color: "#ec4899", fontWeight: 700 }}>{kAnalysis ? kAnalysis.sellPct.toFixed(1) : "—"}% SELL</span>
          </div>
        </Card>

        <div style={styles.twoCol}>
          <Card style={{ padding: "16px 14px" }}>
            <CardLabel>MAGNET</CardLabel>
            <div style={{ color: "#38bdf8", fontSize: 24, fontWeight: 800, marginTop: 4 }}>{magnet ? fmtUSD(magnet.price, magnet.price < 100 ? 3 : 0) : "—"}</div>
            <div style={styles.cardHint}>Largest resting cluster</div>
            <Row label="Dist" value={magnet && price ? `${(Math.abs(magnet.price - price) / price * 100).toFixed(2)}%` : "—"} valueColor="#22c55e" />
            <Row label="Size" value={magnet ? fmtCompact(magnet.usd) : "—"} />
          </Card>
          <Card style={{ padding: "16px 14px" }}>
            <CardLabel>TARGET</CardLabel>
            <div style={{ color: "#f5b301", fontSize: 24, fontWeight: 800, marginTop: 4 }}>{target ? fmtUSD(target.price, target.price < 100 ? 3 : 0) : "—"}</div>
            <div style={styles.cardHint}>OB density + CVD</div>
            <Row label="Score" value={target ? `${target.score}/100` : "—"} valueColor="#f5b301" />
            <Row label="Type" value={target && price ? (target.price > price ? "Resistance" : "Support") : "—"} valueColor="#f5b301" />
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
              <div style={{ ...styles.sweepBadge, color: kAnalysis.sweep.type === "bullish" ? "#22c55e" : "#ec4899", background: kAnalysis.sweep.type === "bullish" ? "rgba(34,197,94,0.1)" : "rgba(236,72,153,0.1)" }}>
                {kAnalysis.sweep.label}
              </div>
              <div style={styles.cardHint}>Price swept {fmtUSD(kAnalysis.sweep.price)}, reclaimed range.</div>
              <div style={{ display: "flex", gap: 24, marginTop: 14 }}>
                <MiniStat label="At Price" value={fmtUSD(kAnalysis.sweep.price)} />
                <MiniStat label="Confidence" value={`${kAnalysis.sweep.confidence}/100`} color="#f5b301" />
              </div>
            </>
          ) : (
            <div style={{...styles.cardHint, marginTop: 0}}>No recent sweep detected in the last 12 candles.</div>
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
          <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
            <div style={{ color: "#ec4899", fontSize: 32, fontWeight: 800 }}>{spoofScore}/100</div>
            <div style={{ fontSize: 13, color: "#94a3b8", lineHeight: 1.4 }}>
              {biggestCancel
                ? `${fmtCompact(biggestCancel.usd)} ${biggestCancel.side === "BUY" ? "bid" : "ask"} wall at ${fmtUSD(biggestCancel.price, biggestCancel.price < 100 ? 3 : 0)} pulled`
                : "No large walls pulled recently."}
            </div>
          </div>
          <div style={styles.spoofBars}>
            {recentEvents.slice(0, 20).map((e, i) => (
              <div key={e.id || i} style={{ ...styles.spoofBar, background: e.type === "CANCEL" ? "#ec4899" : e.type === "APPEAR" ? "#f5b301" : "#1e293b" }} />
            ))}
          </div>
          <div style={styles.warnText}>⚠ Probability estimate only. Never confirmed — do not trade on this alone.</div>
        </Card>

        <Card>
          <CardLabel right={<span style={{ fontSize: 11, color: "#64748b" }}>AMBER = WALL</span>}>ORDER BOOK HEATMAP</CardLabel>
          <div style={{ marginTop: 8 }}>
            {(zones || [])
              .slice()
              .sort((a, b) => b.price - a.price)
              .map((z, i) => {
                const maxUsd = Math.max(...(zones || []).map((x) => x.usd), 1);
                const isWall = z.usd === maxUsd;
                return (
                  <div key={i} style={styles.heatRow}>
                    <span style={{ width: 80, fontSize: 13, color: price && Math.abs(z.price - price) < (depthAnalysis.bucketSize || 1) ? "#38bdf8" : "#94a3b8", fontWeight: 600 }}>
                      {fmtUSD(z.price, z.price < 100 ? 3 : 0)}
                    </span>
                    <div style={{ ...styles.heatBar, width: `${(z.usd / maxUsd) * 100}%`, background: isWall ? "#f5b301" : z.side === "ask" ? "rgba(236,72,153,0.3)" : "rgba(34,197,94,0.3)" }}>
                      {isWall && <span style={{ fontSize: 11, color: "#02040a", fontWeight: 800, padding: "0 8px" }}>{fmtCompact(z.usd)} WALL</span>}
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>

        <Card>
          <CardLabel right={<span style={{ fontSize: 11, color: "#64748b" }}>★ = Point of Control</span>}>VOLUME PROFILE — SESSION</CardLabel>
          {kAnalysis && kAnalysis.poc && (
            <div style={{ marginTop: 8 }}>
              {kAnalysis.profileList.slice(0, 6).map((p, i) => {
                const maxVol = kAnalysis.profileList[0].vol;
                return (
                  <div key={i} style={styles.heatRow}>
                    <span style={{ width: 90, fontSize: 13, fontWeight: p.price === kAnalysis.poc.price ? 700 : 600, color: p.price === kAnalysis.poc.price ? "#f5b301" : "#94a3b8" }}>
                      {p.price === kAnalysis.poc.price ? "★ " : ""}
                      {fmtUSD(p.price, p.price < 100 ? 3 : 0)}
                    </span>
                    <div style={{ ...styles.heatBar, width: `${(p.vol / maxVol) * 100}%`, background: "rgba(245,179,1,0.25)" }} />
                    <span style={{ fontSize: 12, color: "#cbd5e1", marginLeft: 8 }}>{fmtQty(p.vol)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardLabel right={<span style={{ fontSize: 11, color: "#64748b" }}>{events.length} tracking</span>}>LARGE ORDER EVENTS</CardLabel>
          <div style={{ marginTop: 6, maxHeight: 280, overflowY: "auto", paddingRight: 4 }}>
            {events.length === 0 && <div style={styles.cardHint}>Watching the book for large orders…</div>}
            {events.slice(0, 20).map((e) => (
              <div key={e.id} style={styles.eventRow}>
                <span style={{ width: 66, fontSize: 12, color: "#64748b", fontWeight: 600 }}>{e.type}</span>
                <span style={{ width: 44, fontSize: 12, color: e.side === "BUY" ? "#22c55e" : "#ec4899", fontWeight: 800 }}>{e.side}</span>
                <span style={{ flex: 1, fontSize: 14, color: "#f8fafc", fontWeight: 600 }}>{fmtUSD(e.price, e.price < 100 ? 3 : 0)}</span>
                <span style={{ fontSize: 13, color: "#cbd5e1", fontWeight: 500 }}>{fmtCompact(e.usd)}</span>
                <span style={{ width: 56, fontSize: 11, color: "#64748b", textAlign: "right" }}>{timeAgo(e.time)}</span>
              </div>
            ))}
          </div>
        </Card>

        <div style={styles.footer}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
             <span style={{width: 8, height: 8, borderRadius: '50%', background: loading ? '#f5b301' : '#22c55e'}} />
             {loading ? "Connecting to Binance..." : lastUpdate ? `Live Data — Updated ${lastUpdate.toLocaleTimeString()}` : ""}
          </div>
          <div style={{ opacity: 0.5, lineHeight: 1.5 }}>
            Spoofing, trap/squeeze, and sweep scores are heuristic models built from public order-book &amp; kline data — not internal exchange events. Not financial advice.
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={styles.statCell}>
      <div style={styles.statLabel}>{label}</div>
      <div style={{ fontWeight: 800, color: color || "#f8fafc", fontSize: 15 }}>{value}</div>
    </div>
  );
}
function MiniStat({ label, value, color }) {
  return (
    <div style={{ textAlign: "center", flex: 1 }}>
      <div style={{ fontWeight: 800, color: color || "#f8fafc", fontSize: 16 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#64748b", marginTop: 4, fontWeight: 600 }}>{label}</div>
    </div>
  );
}
function Row({ label, value, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 14 }}>
      <span style={{ color: "#94a3b8", fontWeight: 500 }}>{label}</span>
      <span style={{ color: valueColor || "#fff", fontWeight: 700 }}>{value}</span>
    </div>
  );
}
function TrapRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
      <span style={{ width: 100, fontSize: 13, color: "#94a3b8", fontWeight: 600 }}>{label}</span>
      <div style={{ flex: 1 }}>
        <BarGauge pct={value} color={color || "#ec4899"} />
      </div>
      <span style={{ width: 32, textAlign: "right", fontSize: 14, color: "#f8fafc", fontWeight: 700 }}>{value}</span>
    </div>
  );
}

const styles = {
  pageWrapper: { background: "#02040a", minHeight: "100vh", width: "100%" },
  app: { background: "#02040a", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, sans-serif", padding: "20px 16px 40px", maxWidth: 480, margin: "0 auto", boxSizing: "border-box" },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  logoutPill: { border: "1px solid #1e293b", borderRadius: 999, padding: "8px 16px", fontSize: 13, color: "#cbd5e1", display: 'flex', alignItems: 'center', fontWeight: 600, cursor: 'pointer' },
  bell: { background: "#f5b301", borderRadius: "50%", width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: 'pointer', boxShadow: '0 4px 12px rgba(245, 179, 1, 0.3)' },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  title: { fontFamily: "'Inter', -apple-system, sans-serif", fontSize: 32, fontWeight: 800, color: "#fff", lineHeight: 1.1, letterSpacing: "-0.02em" },
  titleAccent: { color: "#f5b301" },
  subtitle: { fontSize: 11, letterSpacing: 1.5, color: "#64748b", marginTop: 8, fontWeight: 600, textTransform: 'uppercase' },
  livePill: { border: "1px solid rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.1)", color: "#22c55e", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", gap: 6, height: "fit-content" },
  liveDot: { width: 8, height: 8, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: '0 0 8px #22c55e' },
  hr: { height: 1, background: "linear-gradient(90deg, #1e293b, transparent)", marginTop: 20, marginBottom: 18 },
  tabRow: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 16, marginBottom: 6, msOverflowStyle: 'none', scrollbarWidth: 'none' },
  tab: { flexShrink: 0, padding: "8px 18px", borderRadius: 999, border: "1px solid #1e293b", color: "#94a3b8", fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s' },
  tabActive: { background: "#f5b301", color: "#02040a", borderColor: "#f5b301", boxShadow: '0 4px 12px rgba(245, 179, 1, 0.2)' },
  errorBox: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#fca5a5", borderRadius: 12, padding: "12px 16px", fontSize: 13, marginBottom: 20, fontWeight: 600 },
  statsRow: { display: "flex", justifyContent: "space-between", background: "#0a0e17", border: "1px solid #1e293b", borderRadius: 20, padding: "18px 12px", marginBottom: 20, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  statCell: { textAlign: "center", flex: 1 },
  statLabel: { fontSize: 11, color: "#64748b", marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' },
  priceCard: { border: "1px solid rgba(34,197,94,0.3)", background: "linear-gradient(180deg, #0a1410 0%, #050a08 100%)", boxShadow: '0 8px 32px rgba(34,197,94,0.05)' },
  priceText: { fontSize: 38, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" },
  priceChangeWrapper: { marginTop: 6, fontSize: 15 },
  smallLabel: { fontSize: 11, color: "#64748b", letterSpacing: 1, fontWeight: 700, marginTop: 4 },
  priceSubRow: { display: "flex", justifyContent: "space-between", marginTop: 20, fontSize: 13, color: "#94a3b8" },
  card: { background: "#0a0e17", border: "1px solid #1e293b", borderRadius: 24, padding: "20px", marginBottom: 20, boxShadow: '0 4px 20px rgba(0,0,0,0.2)' },
  cardLabel: { fontSize: 11, letterSpacing: 1.5, color: "#64748b", fontWeight: 800, textTransform: 'uppercase' },
  cardLabelRight: { fontSize: 11, fontWeight: 600 },
  barTrack: { height: 10, background: "#1e293b", borderRadius: 999, marginTop: 12, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999, transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 },
  cardHint: { fontSize: 13, color: "#64748b", marginTop: 6, lineHeight: 1.5, fontWeight: 500 },
  sweepBadge: { display: "inline-block", borderRadius: 999, padding: "6px 14px", fontSize: 12, fontWeight: 800, marginTop: 4 },
  spoofBars: { display: "flex", gap: 4, alignItems: "flex-end", height: 36, marginTop: 16 },
  spoofBar: { flex: 1, height: 36, borderRadius: 3 },
  warnText: { fontSize: 11, color: "#64748b", fontStyle: "italic", marginTop: 14 },
  heatRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  heatBar: { height: 26, borderRadius: 6, display: "flex", alignItems: "center", minWidth: 6, transition: "width 0.3s ease" },
  eventRow: { display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: "1px solid #1e293b" },
  ivPill: { fontSize: 11, color: "#64748b", padding: "4px 10px", borderRadius: 8, border: "1px solid #1e293b", fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' },
  ivPillActive: { color: "#02040a", background: "#f5b301", borderColor: "#f5b301", fontWeight: 800 },
  footer: { textAlign: "center", fontSize: 12, color: "#475569", marginTop: 32 },
};
