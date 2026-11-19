import { readFile, mkdir, writeFile } from 'node:fs/promises';

const ASTY_MINT = 'ASTYqeaoK83Zs1pTFEXZUB6BM8cG8YLTsN852NUkt7ZR';
const BATCH_SIZE = 25;
const MIN_COVERAGE = 0.8;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const html = await readFile('Dashboard.html', 'utf8');
const poolBlock = html.match(/const POOLS\s*=\s*\[([\s\S]*?)\n\s*\];/);
if (!poolBlock) throw Error('Dashboard POOLS declaration not found');
const poolRows = [...poolBlock[1].matchAll(/\[\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*,\s*"([^"]+)"/g)];
const addresses = [...new Set(poolRows.map(m => m[1]))];
if (addresses.length < 50 || addresses.length !== poolRows.length) throw Error('Unexpected or duplicate dashboard pools: ' + poolRows.length + '/' + addresses.length);

const map = new Map();
const perProvider = {geckoterminal: 0, dexscreener: 0};
const warnings = [];
async function fetchJSON(provider, url) {
  try {
    const response = await fetch(url, {
      headers: provider === 'geckoterminal' ?
        {'accept': 'application/json;version=20230203'} : {'accept': 'application/json'},
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      warnings.push(provider + ' HTTP ' + response.status);
      return null;
    }
    return await response.json();
  } catch (error) {
    warnings.push(provider + ' ' + String(error?.message || error).slice(0,100));
    return null;
  }
}
function positiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
}
function addResult(address, liquidity, volume, provider, wanted) {
  if (!wanted.has(address) || map.has(address)) return;
  const l = positiveNumber(liquidity);
  const v = positiveNumber(volume);
  if (l === null || (l > 0 && v === null)) return;
  map.set(address, {usd24h: l > 0 ? v : 0, source: provider});
  perProvider[provider] += 1;
}
for (let start = 0; start < addresses.length; start += BATCH_SIZE) {
  const batch = addresses.slice(start, start + BATCH_SIZE);
  const expected = new Set(batch);
  const gecko = await fetchJSON('geckoterminal',
    'https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/' + batch.join(','));
  for (const pool of Array.isArray(gecko?.data) ? gecko.data : []) {
    const address = typeof pool?.attributes?.address === 'string' ? pool.attributes.address :
      String(pool?.id || '').replace(/^solana_/, '');
    addResult(address, pool?.attributes?.reserve_in_usd,
      pool?.attributes?.volume_usd?.h24, 'geckoterminal', expected);
  }
  const missing = batch.filter(a => !map.has(a));
  if (missing.length) {
    const dex = await fetchJSON('dexscreener',
      'https://api.dexscreener.com/latest/dex/pairs/solana/' + missing.join(','));
    for (const pool of Array.isArray(dex?.pairs) ? dex.pairs : []) {
      if (pool?.chainId !== 'solana') continue;
      if (pool?.baseToken?.address !== ASTY_MINT && pool?.quoteToken?.address !== ASTY_MINT) continue;
      addResult(String(pool?.pairAddress || ''), pool?.liquidity?.usd,
        pool?.volume?.h24, 'dexscreener', new Set(missing));
    }
  }
  console.log('ASTY batch ' + (Math.floor(start/BATCH_SIZE)+1) + ': ' +
    batch.filter(a=>map.has(a)).length + '/' + batch.length + ', total ' + map.size + '/' + addresses.length);
  await delay(1500);
}
const total = [...map.values()].reduce((sum, row) => sum + row.usd24h, 0);
const result = {
  schema: 'asty-pool-volume/v1',
  observedAt: new Date().toISOString(),
  poolNetworkVolume24hUsd: Number(total.toFixed(6)),
  configuredPools: addresses.length,
  coveredPools: map.size,
  coveragePercent: Number((100*map.size/addresses.length).toFixed(2)),
  sourceCounts: perProvider,
  partial: map.size !== addresses.length,
  pools: Object.fromEntries(map),
  missingPoolAddresses: addresses.filter(a=>!map.has(a)),
  warnings
};
console.log('ASTY_RESULT ' + JSON.stringify({
  observedAt:result.observedAt,volume24hUsd:result.poolNetworkVolume24hUsd,
  covered:result.coveredPools,configured:result.configuredPools,
  sourceCounts:result.sourceCounts,warnings:result.warnings
}));
if (map.size/addresses.length < MIN_COVERAGE) {
  throw Error('Below minimum pool coverage; refusing to publish incomplete total');
}
await mkdir('data', {recursive:true});
await writeFile('data/asty-pool-volume.json', JSON.stringify(result,null,2)+'\n');
