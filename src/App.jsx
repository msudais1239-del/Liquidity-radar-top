import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ComposedChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";

const BASE = "https://fapi.binance.com/fapi/v1";

// ---------- top ~50 Binance USDT-M futures symbols ----------
const SYMBOLS = [
  { symbol: "BTCUSDT", label: "BTC" },
  { symbol: "ETHUSDT", label: "ETH" },
  { symbol: "BNBUSDT", label: "BNB" },
  { symbol: "SOLUSDT", label: "SOL" },
  { symbol: "XRPUSDT", label: "XRP" },
  { symbol: "DOGEUSDT", label: "DOGE" },
  { symbol: "XAUUSDT", label: "XAU" },
  { symbol: "ADAUSDT", label: "ADA" },
  { symbol: "TRXUSDT", label: "TRX" },
  { symbol: "LINKUSDT", label: "LINK" },
  { symbol: "AVAXUSDT", label: "AVAX" },
  { symbol: "DOTUSDT", label: "DOT" },
  { symbol: "LTCUSDT", label: "LTC" },
  { symbol: "BCHUSDT", label: "BCH" },
  { symbol: "ATOMUSDT", label: "ATOM" },
  { symbol: "UNIUSDT", label: "UNI" },
  { symbol: "NEARUSDT", label: "NEAR" },
  { symbol: "APTUSDT", label: "APT" },
  { symbol: "ARBUSDT", label: "ARB" },
  { symbol: "OPUSDT", label: "OP" },
  { symbol: "FILUSDT", label: "FIL" },
  { symbol: "ICPUSDT", label: "ICP" },
  { symbol: "ETCUSDT", label: "ETC" },
  { symbol: "INJUSDT", label: "INJ" },
  { symbol: "SUIUSDT", label: "SUI" },
  { symbol: "RENDERUSDT", label: "RENDER" },
  { symbol: "TIAUSDT", label: "TIA" },
  { symbol: "SEIUSDT", label: "SEI" },
  { symbol: "SANDUSDT", label: "SAND" },
  { symbol: "AAVEUSDT", label: "AAVE" },
  { symbol: "MKRUSDT", label: "MKR" },
  { symbol: "RUNEUSDT", label: "RUNE" },
  { symbol: "GALAUSDT", label: "GALA" },
  { symbol: "ALGOUSDT", label: "ALGO" },
  { symbol: "VETUSDT", label: "VET" },
  { symbol: "HBARUSDT", label: "HBAR" },
  { symbol: "XLMUSDT", label: "XLM" },
  { symbol: "EGLDUSDT", label: "EGLD" },
  { symbol: "THETAUSDT", label: "THETA" },
  { symbol: "FLOWUSDT", label: "FLOW" },
  { symbol: "XTZUSDT", label: "XTZ" },
  { symbol: "ZECUSDT", label: "ZEC" },
  { symbol: "COMPUSDT", label: "COMP" },
  { symbol: "SNXUSDT", label: "SNX" },
  { symbol: "CRVUSDT", label: "CRV" },
  { symbol: "GRTUSDT", label: "GRT" },
  { symbol: "DYDXUSDT", label: "DYDX" },
  { symbol: "LDOUSDT", label: "LDO" },
  { symbol: "PEPEUSDT", label: "PEPE" },
  { symbol: "WIFUSDT", label: "WIF" },
];

const SYMBOL_LIST = SYMBOLS.map((s) => s.symbol);

const INTERVALS = ["1m", "5m", "15m", "1h"];

// polling cadence — core data (price/depth/signal inputs) refreshes every 2.5s,
// chart candles every 15s. Slower than 1s on purpose: it kills the tick-to-tick
// noise that was making the signal box flicker.
const CORE_POLL_MS = 2500;
const CHART_POLL_MS = 15000;
const SCANNER_POLL_MS = 2500;
const SCANNER_BATCH_SIZE = 3;

// ---------- formatters ----------
function smartDigits(price) {
  if (price === null || price === undefined || isNaN(price)) return 2;
  const p = Math.abs(price);
  if (p === 0) return 2;
  if (p < 0.001) return 8;
  if (p < 0.01) return 6;
  if (p < 1) return 4;
  if (p < 100) return 2;
  return 0;
}
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
// Bias/profile are computed from CLOSED candles only — the still-forming last
// candle changes every tick and was the single biggest source of signal jitter.
// The breakout-sweep check still looks at the live candle since that's meant
// to react immediately.
function analyzeKlines(klines) {
  if (!klines || klines.length < 2) return null;
  const closed = klines.slice(0, -1);

  let buyVol = 0,
    sellVol = 0;
  const bars = closed.map((k) => {
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
  for (const k of closed) {
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    if (!priceStep) priceStep = Math.max((high - low) / 4, high * 0.0005) || high * 0.0005;
  }
  for (const k of closed) {
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

// ---------- SIGNAL SCORING (pure, no thresholding) ----------
// Returns raw buy/sell scores that sum to 100. `target` (order-book target
// level) is optional — when it's not available (e.g. the lightweight
// top-50 screener, which skips full depth to stay cheap on API calls) its
// weight is simply redistributed across the other factors.
function computeRawScores(kAnalysis, target, price, fundingRate, marketStrength) {
  if (!kAnalysis || price === null || price === undefined || isNaN(price)) return null;

  let buyScore = 0;
  let sellScore = 0;

  // 1. Market bias from taker buy/sell volume (0-30 pts)
  if (kAnalysis.buyPct >= 60) {
    buyScore += 30;
  } else if (kAnalysis.buyPct <= 40) {
    sellScore += 30;
  } else {
    buyScore += (kAnalysis.buyPct - 40) * 1.5;
    sellScore += (60 - kAnalysis.buyPct) * 1.5;
  }

  // 2. Order-book target level (0-25 pts) — only when depth data is present
  if (target) {
    if (target.price > price) {
      buyScore += target.score * 0.25;
    } else {
      sellScore += target.score * 0.25;
    }
  }

  // 3. Funding rate (0-20 pts)
  if (fundingRate !== null && fundingRate !== undefined) {
    if (fundingRate > 0.01) {
      sellScore += Math.min(20, fundingRate * 1000);
    } else if (fundingRate < -0.01) {
      buyScore += Math.min(20, Math.abs(fundingRate) * 1000);
    }
  }

  // 4. Volume profile POC (0-15 pts)
  if (kAnalysis.poc) {
    const pocDist = Math.abs(kAnalysis.poc.price - price) / price;
    if (pocDist < 0.01 && kAnalysis.poc.price < price) {
      buyScore += 15;
    } else if (pocDist < 0.01 && kAnalysis.poc.price > price) {
      sellScore += 15;
    }
  }

  // 5. Market strength (0-10 pts)
  if (marketStrength !== null && marketStrength !== undefined) {
    if (marketStrength >= 70) buyScore += 10;
    else if (marketStrength <= 30) sellScore += 10;
  }

  const total = buyScore + sellScore || 1;
  return { buyScore: (buyScore / total) * 100, sellScore: (sellScore / total) * 100 };
}

// EMA smoothing — call with a plain object ref + key so callers (main view,
// screener) can each keep their own independent history.
function emaUpdate(store, key, raw, alpha = 0.3) {
  if (raw === null || raw === undefined || isNaN(raw)) return store[key];
  store[key] = store[key] === undefined ? raw : store[key] * (1 - alpha) + raw * alpha;
  return store[key];
}

// Hysteresis so the signal box doesn't pop in/out or flip direction on a
// single noisy reading. Must clear the `enter` bar to switch on, and must
// drop below `exit` before it's allowed to switch off or flip.
function updateSignalState(state, buyScore, enter = 68, exit = 55) {
  if (buyScore === null || buyScore === undefined || isNaN(buyScore)) {
    if (!state.active) return null;
    const score = Math.round(state.lastScore);
    return { type: state.type, score, strength: score > 85 ? "STRONG" : score > 72 ? "MODERATE" : "WEAK" };
  }
  const sellScore = 100 - buyScore;
  if (!state.active) {
    if (buyScore >= enter) {
      state.active = true;
      state.type = "BUY";
    } else if (sellScore >= enter) {
      state.active = true;
      state.type = "SELL";
    }
  } else {
    const current = state.type === "BUY" ? buyScore : sellScore;
    const opposite = state.type === "BUY" ? sellScore : buyScore;
    if (current < exit) {
      if (opposite >= enter) {
        state.type = state.type === "BUY" ? "SELL" : "BUY";
      } else {
        state.active = false;
        state.type = null;
      }
    }
  }
  if (!state.active) return null;
  state.lastScore = state.type === "BUY" ? buyScore : sellScore;
  const score = Math.round(state.lastScore);
  return { type: state.type, score, strength: score > 85 ? "STRONG" : score > 72 ? "MODERATE" : "WEAK" };
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

// ---------- data hook (selected symbol, full detail) ----------
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
    const id = setInterval(fetchCore, CORE_POLL_MS);
    return () => clearInterval(id);
  }, [fetchCore]);

  useEffect(() => {
    const id = setInterval(fetchChart, CHART_POLL_MS);
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

// ---------- top-50 screener hook ----------
// Cycles through the whole symbol list a few at a time (lightweight calls
// only — ticker + funding + 1m klines, no full depth) so it stays cheap on
// API weight, and surfaces only the names whose smoothed, hysteresis-gated
// confidence is 95 or higher.
function useTopSignalScanner(symbols) {
  const [signals, setSignals] = useState([]);
  const stateRef = useRef({});
  const cursorRef = useRef(0);

  const scanBatch = useCallback(async () => {
    const batch = [];
    for (let i = 0; i < SCANNER_BATCH_SIZE; i++) {
      batch.push(symbols[cursorRef.current % symbols.length]);
      cursorRef.current += 1;
    }

    await Promise.all(
      batch.map(async (sym) => {
        try {
          const [tRes, pRes, kRes] = await Promise.all([
            fetch(`${BASE}/ticker/24hr?symbol=${sym}`),
            fetch(`${BASE}/premiumIndex?symbol=${sym}`),
            fetch(`${BASE}/klines?symbol=${sym}&interval=1m&limit=30`),
          ]);
          if (!tRes.ok || !pRes.ok || !kRes.ok) return;
          const [t, p, k] = await Promise.all([tRes.json(), pRes.json(), kRes.json()]);

          const price = parseFloat(t.lastPrice);
          const changePct = parseFloat(t.priceChangePercent);
          const fundingRate = parseFloat(p.lastFundingRate) * 100;
          const kA = analyzeKlines(k);
          if (!kA || !price || isNaN(price)) return;

          if (!stateRef.current[sym]) {
            stateRef.current[sym] = { smooth: {}, hysteresis: { active: false, type: null } };
          }
          const st = stateRef.current[sym];

          const smoothedBuyPct = emaUpdate(st.smooth, "buyPct", kA.buyPct, 0.35);
          const marketStrength = Math.min(100, Math.max(0, smoothedBuyPct + fundingRate * 150));
          const raw = computeRawScores({ ...kA, buyPct: smoothedBuyPct }, null, price, fundingRate, marketStrength);
          const smoothedBuyScore = emaUpdate(st.smooth, "buyScore", raw ? raw.buyScore : null, 0.4);
          const sig = updateSignalState(st.hysteresis, smoothedBuyScore, 70, 55);

          st.price = price;
          st.changePct = changePct;
          st.updatedAt = Date.now();
          st.signal = sig;
        } catch (e) {
          // symbol may not exist on futures, or a transient network hiccup — skip it
        }
      })
    );

    const list = [];
    for (const sym of symbols) {
      const st = stateRef.current[sym];
      if (st && st.signal && st.signal.score >= 95) {
        list.push({ symbol: sym, type: st.signal.type, score: st.signal.score, price: st.price, changePct: st.changePct, updatedAt: st.updatedAt });
      }
    }
    list.sort((a, b) => b.score - a.score);
    setSignals(list);
  }, [symbols]);

  useEffect(() => {
    scanBatch();
    const id = setInterval(scanBatch, SCANNER_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return signals;
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
    const d = smartDigits(data.close);
    return (
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, padding: "10px 14px", fontSize: 12, color: "#cbd5e1", boxShadow: "0 10px 25px rgba(0,0,0,0.5)" }}>
        <div style={{ marginBottom: 6, color: "#94a3b8", fontWeight: 600 }}>{new Date(label).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div>O: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtUSD(data.open, d)}</span></div>
          <div>H: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtUSD(data.high, d)}</span></div>
          <div>L: <span style={{ color: "#fff", fontWeight: 700 }}>{fmtUSD(data.low, d)}</span></div>
          <div>C: <span style={{ color: data.isUp ? "#22c55e" : "#ef4444", fontWeight: 700 }}>{fmtUSD(data.close, d)}</span></div>
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

// ---------- SIGNAL COMPONENT ----------
function SignalDisplay({ signal }) {
  if (!signal) return null;

  const isBuy = signal.type === "BUY";
  const bgColor = isBuy ? "#0a2e1a" : "#2e0a0a";
  const borderColor = isBuy ? "#22c55e" : "#ef4444";
  const textColor = isBuy ? "#22c55e" : "#ef4444";

  return (
    <div style={{
      ...styles.signalBox,
      background: bgColor,
      borderColor: borderColor,
      boxShadow: `0 0 40px ${isBuy ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
      animation: 'pulse 2s infinite'
    }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 40px ${isBuy ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}; }
          50% { box-shadow: 0 0 60px ${isBuy ? 'rgba(34, 197, 94, 0.8)' : 'rgba(239, 68, 68, 0.8)'}; }
        }
        @keyframes bounce {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        .signal-arrow { animation: bounce 1s infinite; }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <div style={{ fontSize: 60, fontWeight: 900, color: textColor, lineHeight: 1 }}>
          <span className="signal-arrow">{isBuy ? "↑" : "↓"}</span>
        </div>
        <div>
          <div style={{ fontSize: 44, fontWeight: 900, color: textColor, lineHeight: 1 }}>
            {signal.type}
          </div>
          <div style={{ fontSize: 14, color: textColor, fontWeight: 700, letterSpacing: 1, marginTop: 4 }}>
            {signal.strength} SIGNAL
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <div style={{ fontSize: 48, fontWeight: 800, color: textColor }}>
          {signal.score}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ height: 8, background: "#1e293b", borderRadius: 999, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${signal.score}%`,
              background: textColor,
              borderRadius: 999
            }} />
          </div>
          <div style={{ fontSize: 11, color: textColor, marginTop: 4, fontWeight: 600 }}>Confidence Score</div>
        </div>
      </div>
    </div>
  );
}

// ---------- HIGH-CONFIDENCE SCREENER (95%+) ----------
function ScreenerRow({ entry }) {
  const isBuy = entry.type === "BUY";
  const color = isBuy ? "#22c55e" : "#ef4444";
  const label = SYMBOLS.find((s) => s.symbol === entry.symbol)?.label || entry.symbol.replace("USDT", "");
  return (
    <div style={styles.screenerRow}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ ...styles.screenerBadge, background: isBuy ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)", color }}>
          {isBuy ? "↑ BUY" : "↓ SELL"}
        </span>
        <span style={{ fontWeight: 800, fontSize: 15, color: "#f8fafc" }}>{label}</span>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontWeight: 800, fontSize: 15, color }}>{entry.score}</div>
        <div style={{ fontSize: 11, color: "#64748b" }}>{fmtUSD(entry.price, smartDigits(entry.price))} · {timeAgo(entry.updatedAt)}</div>
      </div>
    </div>
  );
}

function TopSignalsCard({ signals }) {
  return (
    <Card>
      <CardLabel right={<span style={{ fontSize: 11, color: "#64748b" }}>SCANNING {SYMBOLS.length} COINS</span>}>
        HIGH CONFIDENCE (95+)
      </CardLabel>
      {signals.length === 0 ? (
        <div style={{ fontSize: 13, color: "#64748b", padding: "8px 0", lineHeight: 1.6 }}>
          No coin is showing 95%+ confidence right now. This box only lists signals that clear a very high bar, so it may sit empty for a while — that's expected.
        </div>
      ) : (
        <div>
          {signals.slice(0, 10).map((entry) => (
            <ScreenerRow key={entry.symbol} entry={entry} />
          ))}
        </div>
      )}
    </Card>
  );
}

export default function LiquidityRadar() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setIntervalStr] = useState("5m");
  const data = useRadarData(symbol, interval);
  const { ticker, premium, openInterest, depth, klines, chartKlines, events, error, loading, lastUpdate, oiChangePct } = data;
  const topSignals = useTopSignalScanner(SYMBOL_LIST);

  useEffect(() => {
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

  // --- smoothing (resets whenever the selected symbol changes) ---
  const smootherRef = useRef({ key: symbol, vals: {} });
  if (smootherRef.current.key !== symbol) smootherRef.current = { key: symbol, vals: {} };
  const smoothedBuyPct = kAnalysis ? emaUpdate(smootherRef.current.vals, "buyPct", kAnalysis.buyPct, 0.3) : smootherRef.current.vals.buyPct;
  const smoothedTargetScore = target ? emaUpdate(smootherRef.current.vals, "targetScore", target.score, 0.3) : smootherRef.current.vals.targetScore;

  const biasLabel = smoothedBuyPct != null ? (smoothedBuyPct >= 50 ? "BULLISH" : "BEARISH") : null;
  const confidence = smoothedBuyPct != null && smoothedTargetScore != null
    ? Math.round(Math.min(99, Math.max(1, Math.abs(smoothedBuyPct - 50) * 1.4 + smoothedTargetScore * 0.3)))
    : null;

  const marketStrength = smoothedBuyPct != null && fundingRate !== null ? Math.round(Math.min(100, Math.max(0, smoothedBuyPct + fundingRate * 150))) : null;
  const strengthLabel = marketStrength >= 65 ? "STRONG" : marketStrength >= 40 ? "MODERATE" : "WEAK";
  const strengthSub = marketStrength >= 65 ? "Trend has conviction." : marketStrength >= 40 ? "Mixed signals — monitor closely." : "Fading momentum.";

  const shortSqueeze = fundingRate !== null ? Math.round(Math.min(100, Math.max(0, -fundingRate * 400 + (smoothedBuyPct != null ? smoothedBuyPct - 50 : 0) * 1.5))) : 0;
  const longSqueeze = fundingRate !== null ? Math.round(Math.min(100, Math.max(0, fundingRate * 400 + (smoothedBuyPct != null ? 50 - smoothedBuyPct : 0) * 1.5))) : 0;
  const bullTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bearish" ? kAnalysis.sweep.confidence : 0;
  const bearTrap = kAnalysis && kAnalysis.sweep && kAnalysis.sweep.type === "bullish" ? kAnalysis.sweep.confidence : 0;

  const recentEvents = events.filter((e) => Date.now() - e.time < 120000);
  const cancels = recentEvents.filter((e) => e.type === "CANCEL");
  const appears = recentEvents.filter((e) => e.type === "APPEAR");
  const spoofScore = recentEvents.length ? Math.round(Math.min(100, (cancels.length / Math.max(1, appears.length + cancels.length)) * 130)) : 0;
  const biggestCancel = cancels.sort((a, b) => b.usd - a.usd)[0];

  // --- signal: raw scores -> smoothing -> hysteresis, so it holds steady between polls ---
  const rawScores = useMemo(() => {
    if (!kAnalysis || !price) return null;
    const kA = { ...kAnalysis, buyPct: smoothedBuyPct ?? kAnalysis.buyPct };
    const t = target ? { ...target, score: smoothedTargetScore ?? target.score } : null;
    return computeRawScores(kA, t, price, fundingRate, marketStrength);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kAnalysis, price, target, fundingRate, marketStrength, smoothedBuyPct, smoothedTargetScore]);

  const smoothedBuyScore = rawScores ? emaUpdate(smootherRef.current.vals, "buyScore", rawScores.buyScore, 0.35) : smootherRef.current.vals.buyScore;

  const hysteresisRef = useRef({ key: symbol, state: { active: false, type: null } });
  if (hysteresisRef.current.key !== symbol) hysteresisRef.current = { key: symbol, state: { active: false, type: null } };
  const signal = updateSignalState(hysteresisRef.current.state, smoothedBuyScore, 68, 55);

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

  const priceDigits = smartDigits(price);

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

        {/* BIG SIGNAL DISPLAY */}
        {signal && (
          <div style={{ marginBottom: 20 }}>
            <SignalDisplay signal={signal} />
          </div>
        )}

        <div style={styles.statsRow}>
          <Stat label="OI" value={oiUsd ? fmtCompact(oiUsd) : "—"} />
          <Stat label="FR" value={fundingRate !== null ? fmtPct(fundingRate, 4) : "—"} color={fundingRate >= 0 ? "#22c55e" : "#ef4444"} />
          <Stat label="Spread" value={spread !== null ? fmtUSD(spread, smartDigits(spread)) : "—"} />
          <Stat label="Trades" value={tradeCount ? tradeCount.toLocaleString() : "—"} color="#38bdf8" />
        </div>

        <Card style={styles.priceCard}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={styles.priceText}>{price ? fmtUSD(price, priceDigits) : "Loading…"}</div>
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
            <span>24h H: <b style={{ color: "#fff" }}>{high ? fmtUSD(high, smartDigits(high)) : "—"}</b></span>
            <span>24h L: <b style={{ color: "#fff" }}>{low ? fmtUSD(low, smartDigits(low)) : "—"}</b></span>
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
            <div style={{ color: "#94a3b8", fontWeight: 600 }}>{smoothedBuyPct != null ? `${smoothedBuyPct.toFixed(1)}/100` : "—"}</div>
          </div>
          <BarGauge pct={smoothedBuyPct ?? 0} color={biasLabel === "BULLISH" ? "#22c55e" : "#ec4899"} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 13 }}>
            <span style={{ color: "#22c55e", fontWeight: 700 }}>{smoothedBuyPct != null ? smoothedBuyPct.toFixed(1) : "—"}% BUY</span>
            <span style={{ color: "#ec4899", fontWeight: 700 }}>{smoothedBuyPct != null ? (100 - smoothedBuyPct).toFixed(1) : "—"}% SELL</span>
          </div>
        </Card>

        <div style={styles.twoCol}>
          <Card style={{ padding: "16px 14px" }}>
            <CardLabel>MAGNET</CardLabel>
            <div style={{ color: "#38bdf8", fontSize: 24, fontWeight: 800, marginTop: 4 }}>{magnet ? fmtUSD(magnet.price, smartDigits(magnet.price)) : "—"}</div>
            <div style={styles.cardHint}>Largest resting cluster</div>
            <Row label="Dist" value={magnet && price ? `${(Math.abs(magnet.price - price) / price * 100).toFixed(2)}%` : "—"} valueColor="#22c55e" />
            <Row label="Size" value={magnet ? fmtCompact(magnet.usd) : "—"} />
          </Card>
          <Card style={{ padding: "16px 14px" }}>
            <CardLabel>TARGET</CardLabel>
            <div style={{ color: "#f5b301", fontSize: 24, fontWeight: 800, marginTop: 4 }}>{target ? fmtUSD(target.price, smartDigits(target.price)) : "—"}</div>
            <div style={styles.cardHint}>OB density + CVD</div>
            <Row label="Score" value={smoothedTargetScore != null ? `${Math.round(smoothedTargetScore)}/100` : "—"} valueColor="#f5b301" />
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
                ? `${fmtCompact(biggestCancel.usd)} ${biggestCancel.side === "BUY" ? "bid" : "ask"} wall at ${fmtUSD(biggestCancel.price, smartDigits(biggestCancel.price))} pulled`
                : "No large walls pulled recently."}
            </div>
          </div>
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
                      {fmtUSD(z.price, smartDigits(z.price))}
                    </span>
                    <div style={{ ...styles.heatBar, width: `${(z.usd / maxUsd) * 100}%`, background: isWall ? "#f5b301" : z.side === "ask" ? "rgba(236,72,153,0.3)" : "rgba(34,197,94,0.3)" }}>
                      {isWall && <span style={{ fontSize: 11, color: "#02040a", fontWeight: 800, padding: "0 8px" }}>{fmtCompact(z.usd)} WALL</span>}
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>

        {/* HIGH CONFIDENCE SCREENER — 95%+ ONLY, across all 50 tracked coins */}
        <TopSignalsCard signals={topSignals} />

        <div style={styles.footer}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8 }}>
             <span style={{width: 8, height: 8, borderRadius: '50%', background: loading ? '#f5b301' : '#22c55e'}} />
             {loading ? "Connecting to Binance..." : lastUpdate ? `Live Data — Updated ${lastUpdate.toLocaleTimeString()}` : ""}
          </div>
          <div style={{ opacity: 0.5, lineHeight: 1.5 }}>
            Signals generated from market bias, liquidity, and order flow analysis — not financial advice.
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
  heatRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  heatBar: { height: 26, borderRadius: 6, display: "flex", alignItems: "center", minWidth: 6, transition: "width 0.3s ease" },
  eventRow: { display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: "1px solid #1e293b" },
  ivPill: { fontSize: 11, color: "#64748b", padding: "4px 10px", borderRadius: 8, border: "1px solid #1e293b", fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s' },
  ivPillActive: { color: "#02040a", background: "#f5b301", borderColor: "#f5b301", fontWeight: 800 },
  signalBox: {
    border: "2px solid",
    borderRadius: 24,
    padding: "24px",
    marginBottom: 20,
    background: "#0a0e17",
  },
  screenerRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #1e293b" },
  screenerBadge: { fontSize: 11, fontWeight: 800, padding: "4px 8px", borderRadius: 8, letterSpacing: 0.5 },
  footer: { textAlign: "center", fontSize: 12, color: "#475569", marginTop: 32 },
};
