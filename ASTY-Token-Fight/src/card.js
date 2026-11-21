import { Resvg } from '@cf-wasm/resvg';

function xml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])); }
function short(s,n=15){return String(s||'?').slice(0,n)}
function b64(bytes){
  let out=''; const step=16384;
  for(let i=0;i<bytes.length;i+=step) out+=String.fromCharCode(...bytes.slice(i,i+step));
  return btoa(out);
}
async function embedLogo(url){
  if(!url) return null;
  try {
    const u=new URL(url);
    if(u.protocol!=='https:') return null;
    // Never let third-party metadata point the Worker at local/private services.
    if(!['static.jup.ag','cdn.dexscreener.com','assets.coingecko.com','ipfs.io','arweave.net','raw.githubusercontent.com','gateway.pinata.cloud'].includes(u.hostname)) return null;
    const res=await fetch(u.toString(),{signal:AbortSignal.timeout(3500)});
    if(!res.ok) return null;
    const type=(res.headers.get('content-type')||'').split(';')[0];
    if(!['image/png','image/jpeg','image/webp'].includes(type)) return null;
    const bytes=new Uint8Array(await res.arrayBuffer());
    if(bytes.length>450000 || bytes.length===0) return null;
    return `data:${type};base64,${b64(bytes)}`;
  }catch{return null;}
}
function imageNode(data,x,y){
  return data ? `<image href="${data}" x="${x}" y="${y}" width="176" height="176" preserveAspectRatio="xMidYMid slice" clip-path="url(#logo${x})"/>` : `<circle cx="${x+88}" cy="${y+88}" r="84" fill="#241744"/><path d="M${x+42} ${y+88}h92 M${x+88} ${y+42}v92" stroke="#cbb0ff" stroke-width="7" stroke-linecap="round"/>`;
}
function svgCard(a,b,lA,lB,astyLogo){
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="520" viewBox="0 0 960 520">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#070614"/><stop offset="0.55" stop-color="#1a0d3e"/><stop offset="1" stop-color="#090714"/></linearGradient>
    <linearGradient id="beam" x1="0" x2="1"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
    <clipPath id="logo154"><circle cx="242" cy="270" r="84"/></clipPath>
    <clipPath id="logo630"><circle cx="718" cy="270" r="84"/></clipPath>
  </defs>
  <rect width="960" height="520" fill="url(#bg)"/>
  <g stroke="#6b32c8" stroke-width="2" opacity=".45"><path d="M0 80L960 440 M0 400L960 30 M0 510L960 190"/><path d="M0 180H960 M0 470H960"/></g>
  <rect x="24" y="24" width="912" height="472" rx="30" fill="none" stroke="#ae78ff" stroke-width="3" opacity=".7"/>
  <circle cx="242" cy="270" r="104" fill="#33165f" stroke="#9f70f8" stroke-width="12"/>
  <circle cx="718" cy="270" r="104" fill="#251a49" stroke="#9f70f8" stroke-width="12"/>
  ${imageNode(lA,154,182)}${imageNode(lB,630,182)}
  <path d="M408 220L461 325L484 325L535 220L508 220L473 293L436 220Z" fill="#ede4ff"/>
  <path d="M555 242Q526 218 507 240Q498 257 521 269L544 282Q554 297 532 303Q520 305 509 294L491 310Q510 334 539 326Q571 318 570 291Q568 274 547 264L529 254Q519 245 532 244Q546 243 552 251Z" fill="#ede4ff"/>
  <g fill="#f3eaff" font-family="sans-serif" text-anchor="middle"><text x="480" y="105" font-size="42" font-weight="bold">ASTY TOKEN FIGHT</text><text x="242" y="421" font-size="34" font-weight="bold">${xml(short(a.symbol))}</text><text x="718" y="421" font-size="34" font-weight="bold">${xml(short(b.symbol))}</text><text x="480" y="471" font-size="20">24H · 50% VOTES · 50% PRICE</text></g>
  ${astyLogo ? `<image href="${astyLogo}" x="54" y="434" width="52" height="52" preserveAspectRatio="xMidYMid meet"/>` : ``}
  </svg>`;
}
// Render once per fight (not every 10 minutes). Telegram stores the uploaded PNG itself.
export async function fightImage(a,b) {
  const [la,lb,astyLogo]=await Promise.all([
    embedLogo(a.logo_url), embedLogo(b.logo_url),
    embedLogo('https://raw.githubusercontent.com/ArbStrategy-ASTY/ArbStrategy-ASTY/main/assets/logo.png')
  ]);
  const renderer=new Resvg(svgCard(a,b,la,lb,astyLogo));
  return renderer.render().asPng();
}
