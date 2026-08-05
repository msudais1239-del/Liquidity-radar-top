import React, { useState, useEffect, useRef, useCallback } from "react";

const SYMBOL = "BTCUSDT";
const BASE = "https://fapi.binance.com/fapi/v1";

function fmtUSD(n, digits = 0) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtCompact(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function fmtPct(n, digits = 2) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return sign + n.toFixed(digits) + "%";
}

// Cluster order-book levels into price buckets and return the biggest cluster + a directional target
function analyzeDepth(bids, asks, midPrice) {
  const bucketSize = Math.max(10, Math.round(midPrice * 0.0008 / 10) * 10); // ~0.08% wide buckets
  const buckets = {};

  const add = (levels, side) => {
    for (const [priceStr, qtyStr] of levels) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      const usd = price * qty;
      const bucketKey = Math.round(price / bucketSize) * bucketSize;
      if (!buckets[bucketKey]) buckets[bucketKey] = { price: bucketKey, usd: 0, side };
      buckets[bucketKey].usd += usd;
      buckets[bucketKey].side = bucketKey > midPrice ? "ask" : "bid";
    }
  };
  add(bids, "bid");
  add(asks, "ask");

  const list = Object.values(buckets).sort((a, b) => b.usd - a.usd);
  if (list.length === 0) return { magnet: null, target: null };

  const magnet = list[0];

  // Likely target: strongest cluster on the opposite side of price from the magnet,
  // scored by size and proximity (closer + bigger = higher score)
  const maxUsd = list[0].usd;
  const scored = list
    .filter((b) => b.price !== magnet.price)
    .map((b) => {
      const dist = Math.abs(b.price - midPrice) / midPrice;
      const sizeScore = b.usd / maxUsd;
      const distPenalty = Math.min(dist * 40, 1);
      const score = Math.round((sizeScore * 0.7 + (1 - distPenalty) * 0.3) * 100);
      return { ...b, score, dist };
    })
    .sort((a, b) => b.score - a.score);

  const target = scored[0] || magnet;
  return { magnet, target, bucketSize };
}

function analyzeTrades(trades) {
  let buyUsd = 0;
  let sellUsd = 0;
  for (const t of trades) {
    const usd = parseFloat(t.price) * parseFloat(t.qty);
    // isBuyerMaker true => trade was matched against a resting buy order => taker sold => sell pressure
    if (t.isBuyerMaker) sellUsd += usd;
    else buyUsd += usd;
  }
  const total = buyUsd + sellUsd || 1;
  const buyPct = (buyUsd / total) * 100;
  const sellPct = 100 - buyPct;
  return { buyPct, sellPct, buyUsd, sellUsd };
}

function useInterval(callback, delay) {
  const savedRef = useRef(callback);
  useEffect(() => {
    savedRef.current = callback;
  }, [callback]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => savedRef.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

function Gauge({ value, label }) {
  const clamped = Math.max(0, Math.min(100, value));
  const angle = (clamped / 100) * 270 - 135; // -135 to +135 deg sweep
  const r = 54;
  const cx = 64;
  const cy = 64;
  const startAngle = -135;
  const endAngle = -135 + (clamped / 100) * 270;
  const polarToXY = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [sx, sy] = polarToXY(-135);
  const [ex, ey] = polarToXY(endAngle);
  const largeArc = clamped / 100 > 0.5 / 0.75 ? 1 : 0;
  const color = clamped >= 60 ? "#22c55e" : clamped >= 40 ? "#f5b301" : "#ef4444";

  return (
    <svg width="128" height="88" viewBox="0 0 128 88">
      <path
        d={`M ${cx + r * Math.cos((-135 * Math.PI) / 180)} ${cy + r * Math.sin((-135 * Math.PI) / 180)} A ${r} ${r} 0 1 1 ${cx + r * Math.cos((135 * Math.PI) / 180)} ${cy + r * Math.sin((135 * Math.PI) / 180)}`}
        fill="none"
        stroke="#1f2733"
        strokeWidth="10"
        strokeLinecap="round"
      />
      <path
        d={`M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
      />
      <text x="64" y="60" textAnchor="middle" fontSize="26" fontWeight="800" fill={color}>
        {Math.round(clamped)}
      </text>
    </svg>
  );
}

export default function LiquidityRadar() {
  const [ticker, setTicker] = useState(null);
  const [premium, setPremium] = useState(null);
  const [openInterest, setOpenInterest] = useState(null);
  const [depth, setDepth] = useState(null);
  const [trades, setTrades] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const [tRes, pRes, oiRes, dRes, trRes] = await Promise.all([
        fetch(`${BASE}/ticker/24hr?symbol=${SYMBOL}`),
        fetch(`${BASE}/premiumIndex?symbol=${SYMBOL}`),
        fetch(`${BASE}/openInterest?symbol=${SYMBOL}`),
        fetch(`${BASE}/depth?symbol=${SYMBOL}&limit=500`),
        fetch(`${BASE}/trades?symbol=${SYMBOL}&limit=500`),
      ]);
      if (!tRes.ok || !pRes.ok || !oiRes.ok || !dRes.ok || !trRes.ok) {
        throw new Error("One or more Binance endpoints returned an error");
      }
      const [t, p, oi, d, tr] = await Promise.all([
        tRes.json(),
        pRes.json(),
        oiRes.json(),
        dRes.json(),
        trRes.json(),
      ]);
      setTicker(t);
      setPremium(p);
      setOpenInterest(oi);
      setDepth(d);
      setTrades(tr);
      setError(null);
      setLastUpdate(new Date());
    } catch (e) {
      setError(e.message || "Failed to reach Binance Futures API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useInterval(fetchAll, 4000);

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

  const { magnet, target } = depth && price ? analyzeDepth(depth.bids, depth.asks, price) : {};
  const bias = trades ? analyzeTrades(trades) : null;

  const biasLabel = bias ? (bias.buyPct >= 50 ? "BULLISH" : "BEARISH") : null;
  const biasScore = bias ? Math.round(bias.buyPct * 10) / 10 : null;

  const confidence = bias && target
    ? Math.round(Math.min(99, Math.max(1, Math.abs(bias.buyPct - 50) * 1.4 + (target.score || 0) * 0.3)))
    : null;

  const marketStrength = bias && fundingRate !== null
    ? Math.round(Math.min(100, Math.max(0, bias.buyPct + fundingRate * 200)))
    : null;

  const magnetDist = magnet && price ? (Math.abs(magnet.price - price) / price) * 100 : null;
  const targetType =
    target && price
      ? target.price > price
        ? target.score > 80
          ? "Stop Hunt Zone ▲"
          : "Resistance ▲"
        : target.score > 80
        ? "Support Sweep ▼"
        : "Support ▼"
      : null;

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
          <div style={styles.subtitle}>BTCUSDT PERP &nbsp;·&nbsp; BINANCE FUTURES</div>
        </div>
        <div style={styles.livePill}>
          <span style={styles.liveDot} /> LIVE
        </div>
      </div>
      <div style={styles.hr} />

      {error && (
        <div style={styles.errorBox}>
          Couldn't reach Binance: {error}. Retrying every 4s…
        </div>
      )}

      <div style={styles.statsRow}>
        <Stat label="OI" value={openInterest ? fmtCompact(parseFloat(openInterest.openInterest) * price) : "—"} />
        <Stat
          label="FR"
          value={fundingRate !== null ? fmtPct(fundingRate, 4) : "—"}
          color={fundingRate >= 0 ? "#22c55e" : "#ef4444"}
        />
        <Stat label="Spread" value={spread !== null ? fmtUSD(spread, 1) : "—"} />
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
          <span>
            24h H: <b style={{ color: "#fff" }}>{high ? fmtUSD(high) : "—"}</b>
          </span>
          <span>
            24h L: <b style={{ color: "#fff" }}>{low ? fmtUSD(low) : "—"}</b>
          </span>
          <span>
            Vol: <b style={{ color: "#fff" }}>{vol ? fmtCompact(vol) : "—"}</b>
          </span>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardLabel}>MARKET BIAS</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ color: biasLabel === "BULLISH" ? "#22c55e" : "#ec4899", fontWeight: 800, fontSize: 20 }}>
            {biasLabel ?? "—"}
          </div>
          <div style={{ color: "#94a3b8" }}>{biasScore !== null ? `${biasScore}/100` : "—"}</div>
        </div>
        <div style={styles.barTrack}>
          <div style={{ ...styles.barFill, width: `${bias ? bias.buyPct : 0}%` }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span style={{ color: "#22c55e", fontWeight: 700 }}>
            {bias ? bias.buyPct.toFixed(1) : "—"}% BUY
          </span>
          <span style={{ color: "#ec4899", fontWeight: 700 }}>
            {bias ? bias.sellPct.toFixed(1) : "—"}% SELL
          </span>
        </div>
      </div>

      <div style={styles.twoCol}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>LIQUIDITY MAGNET</div>
          <div style={{ color: "#38bdf8", fontSize: 24, fontWeight: 800, marginTop: 4 }}>
            {magnet ? fmtUSD(magnet.price) : "—"}
          </div>
          <div style={styles.cardHint}>Largest resting order-book cluster.</div>
          <Row label="Distance" value={magnetDist !== null ? `${magnetDist.toFixed(2)}%` : "—"} valueColor="#22c55e" />
          <Row label="Cluster $" value={magnet ? fmtCompact(magnet.usd) : "—"} />
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>LIKELY TARGET</div>
          <div style={{ color: "#f5b301", fontSize: 24, fontWeight: 800, marginTop: 4 }}>
            {target ? fmtUSD(target.price) : "—"}
          </div>
          <div style={styles.cardHint}>Book density + trade-flow weighted.</div>
          <Row label="Score" value={target ? `${target.score}/100` : "—"} valueColor="#f5b301" />
          <Row label="Type" value={targetType ?? "—"} valueColor="#f5b301" />
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardLabel}>MARKET STRENGTH</div>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Gauge value={marketStrength ?? 50} />
        </div>
      </div>

      <div style={styles.footer}>
        {loading ? "Connecting to Binance Futures…" : lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : ""}
        <div style={{ marginTop: 4, opacity: 0.6 }}>
          Heuristic model for illustration — not financial advice.
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
  app: {
    background: "#05070a",
    minHeight: "100vh",
    color: "#e2e8f0",
    fontFamily: "'Inter', -apple-system, sans-serif",
    padding: "20px 16px 40px",
    maxWidth: 480,
    margin: "0 auto",
    boxSizing: "border-box",
  },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  logoutPill: {
    border: "1px solid #2a3240",
    borderRadius: 999,
    padding: "8px 16px",
    fontSize: 13,
    color: "#cbd5e1",
  },
  bell: {
    background: "#f5b301",
    borderRadius: "50%",
    width: 40,
    height: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 16,
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  title: { fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 34, color: "#fff", lineHeight: 1.05 },
  titleAccent: { color: "#f5b301", fontStyle: "italic" },
  subtitle: { fontSize: 11, letterSpacing: 2, color: "#64748b", marginTop: 6 },
  livePill: {
    border: "1px solid #134e3a",
    color: "#22c55e",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: "fit-content",
  },
  liveDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block" },
  hr: { height: 2, background: "linear-gradient(90deg,#f5b301,transparent)", marginTop: 16, marginBottom: 20 },
  errorBox: {
    background: "#2a1215",
    border: "1px solid #7f1d1d",
    color: "#fca5a5",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13,
    marginBottom: 16,
  },
  statsRow: {
    display: "flex",
    justifyContent: "space-between",
    background: "#0d1117",
    border: "1px solid #1a2130",
    borderRadius: 16,
    padding: "14px 10px",
    marginBottom: 16,
  },
  statCell: { textAlign: "center", flex: 1 },
  statLabel: { fontSize: 11, color: "#64748b", marginBottom: 4 },
  priceCard: {
    border: "1px solid #16532f",
    background: "#0a1410",
    borderRadius: 18,
    padding: 20,
    marginBottom: 16,
  },
  priceText: { fontSize: 36, fontWeight: 800, color: "#fff" },
  smallLabel: { fontSize: 11, color: "#64748b", letterSpacing: 1 },
  priceSubRow: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 14,
    fontSize: 13,
    color: "#94a3b8",
  },
  card: {
    background: "#0d1117",
    border: "1px solid #1a2130",
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  cardLabel: { fontSize: 11, letterSpacing: 1.5, color: "#64748b", fontWeight: 700 },
  barTrack: { height: 8, background: "#1a2130", borderRadius: 999, marginTop: 10, overflow: "hidden" },
  barFill: { height: "100%", background: "#22c55e", borderRadius: 999, transition: "width 0.4s ease" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  cardHint: { fontSize: 12, color: "#64748b", marginTop: 4, lineHeight: 1.4 },
  footer: { textAlign: "center", fontSize: 12, color: "#475569", marginTop: 24 },
};
