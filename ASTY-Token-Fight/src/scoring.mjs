// Battle rules v0.7: 50% vote share + 50% capped relative price advantage.
// Every 0.1 percentage POINT of relative 24h price performance = 1 point in
// the price category. E.g., +5% vs +3% => 70:30 price points.
// Price category is capped in [0,100]. No liquidity threshold.
export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
export function priceChange(start, end) {
  if (!(Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > 0)) return null;
  return ((end / start) - 1) * 100;
}
export function calculateScore(votesA, votesB, priceAStart, priceAEnd, priceBStart, priceBEnd) {
  const ra = priceChange(priceAStart, priceAEnd);
  const rb = priceChange(priceBStart, priceBEnd);
  if (ra === null || rb === null) return null;
  const total = votesA + votesB;
  const voteShareA = total ? (100 * votesA) / total : 50;
  const priceShareA = clamp(50 + 10 * (ra - rb), 0, 100);
  const scoreA = (voteShareA + priceShareA) / 2;
  return {
    returnA: ra, returnB: rb,
    voteShareA, voteShareB: 100 - voteShareA,
    priceShareA, priceShareB: 100 - priceShareA,
    scoreA, scoreB: 100 - scoreA,
    winner: Math.abs(scoreA - 50) < 1e-9 ? 'draw' : scoreA > 50 ? 'a' : 'b',
  };
}
