// Birdeye adapter for ASTY Token Fight. No API keys are stored in source control.
// Single-token endpoints work without assuming a paid batch-price subscription.
const API = "https://public-api.birdeye.so";
export const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function request(env, path, fetcher = fetch) {
  if (!env?.BIRDEYE_API_KEY) throw new Error("BIRDEYE_API_KEY fehlt in Cloudflare Secrets.");
  const res = await fetcher(API + path, {
    headers: { "X-API-KEY": env.BIRDEYE_API_KEY, "x-chain": "solana", "accept": "application/json" },
    signal: AbortSignal.timeout(9000)
  });
  if (!res.ok) throw new Error(`Birdeye: HTTP ${res.status}${res.status === 429 ? " (Rate limit)" : ""}`);
  const body = await res.json();
  if (body?.success === false) throw new Error("Birdeye meldet einen API-Fehler.");
  return body?.data ?? null;
}
export async function birdeyeTokenInfo(env, mint, fetcher = fetch) {
  const item = await request(env, `/defi/token_overview?address=${encodeURIComponent(mint)}`, fetcher);
  if (!item || (item.address && item.address !== mint)) throw new Error("Tokenadresse wurde bei Birdeye nicht gefunden.");
  return {
    mint,
    name: String(item.name || mint.slice(0, 8)),
    symbol: String(item.symbol || "?"),
    logo_url: typeof item.logoURI === "string" ? item.logoURI : null
  };
}
export async function birdeyePrice(env, mint, fetcher = fetch) {
  const item = await request(env, `/defi/price?address=${encodeURIComponent(mint)}`, fetcher);
  // Treat missing/zero prices as unavailable. Never fabricate a result.
  const n = item?.value == null ? NaN : Number(item.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export async function birdeyePairPrices(env, a, b, fetcher = fetch, sleeper = pause) {
  const first = await birdeyePrice(env, a, fetcher);
  // Free Birdeye API allows 1 request/second. This spaces calls within one fight.
  // Concurrent fights still need account-level throttling before a large public launch.
  await sleeper(1200);
  const second = await birdeyePrice(env, b, fetcher);
  return [first, second];
}
