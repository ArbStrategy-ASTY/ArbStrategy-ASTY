import test from 'node:test';
import assert from 'node:assert/strict';
import { birdeyeTokenInfo, birdeyePrice, birdeyePairPrices } from '../src/birdeye.mjs';

const env = { BIRDEYE_API_KEY: 'test-key' };
const mintA='So11111111111111111111111111111111111111112';
const mintB='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function mockFetch(handler) {
  return async (url, options) => {
    assert.equal(options.headers['X-API-KEY'], 'test-key');
    assert.equal(options.headers['x-chain'], 'solana');
    return handler(new URL(url));
  };
}
const okay=(data)=>({ok:true,json:async()=>({success:true,data})});

test('Token details use correct token mint and metadata fields',async()=>{
  const p=await birdeyeTokenInfo(env,mintA,mockFetch(url=>{
    assert.equal(url.pathname,'/defi/token_overview');
    assert.equal(url.searchParams.get('address'),mintA);
    return okay({address:mintA,name:'Wrapped SOL',symbol:'SOL',logoURI:'https://example.invalid/logo.png'});
  }));
  assert.equal(p.name,'Wrapped SOL');
  assert.equal(p.logo_url,'https://example.invalid/logo.png');
});
test('price is returned in data.value',async()=>{
  const p=await birdeyePrice(env,mintA,mockFetch(url=>{
    assert.equal(url.pathname,'/defi/price');
    return okay({value:1.234});
  }));
  assert.equal(p,1.234);
});
test('unknown price returns null instead of zero',async()=>{
  const p=await birdeyePrice(env,mintA,mockFetch(()=>okay({value:null})));
  assert.equal(p,null);
});
test('pair fetches in order, with spacing for limited API tiers',async()=>{
  const queried=[];let paused=0;
  const fetcher=mockFetch(url=>{queried.push(url.searchParams.get('address'));return okay({value:queried.length});});
  const p=await birdeyePairPrices(env,mintA,mintB,fetcher,async ms=>{paused=ms;});
  assert.deepEqual(p,[1,2]);
  assert.deepEqual(queried,[mintA,mintB]);
  assert.ok(paused>=1000);
});
test('missing key fails rather than leaking fallback data',async()=>{
  await assert.rejects(()=>birdeyePrice({},mintA,async()=>{}),/BIRDEYE_API_KEY/);
});
test('HTTP errors are surfaced',async()=>{
  await assert.rejects(()=>birdeyePrice(env,mintA,mockFetch(()=>({ok:false,status:429}))),/429/);
});
