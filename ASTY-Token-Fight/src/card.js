import { Resvg } from '@cf-wasm/resvg';
import { vectorText } from './vector-font.mjs';

const IMAGE_HOSTS = new Set(['static.jup.ag','cdn.dexscreener.com','assets.coingecko.com','img.fotofolio.xyz','img.birdeye.so','static.birdeye.so','ipfs.io','arweave.net','raw.githubusercontent.com','gateway.pinata.cloud','ipfs.birdeye.so','cf-ipfs.com']);
const VALID_TYPES = new Set(['image/png','image/jpeg','image/webp']);


function base64(bytes){let out='';for(let i=0;i<bytes.length;i+=16384)out+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(out);}

function approvedImage(url){try{const u=new URL(url);return u.protocol==='https:'&&u.port===''&&!u.username&&!u.password&&IMAGE_HOSTS.has(u.hostname.toLowerCase())?u:null;}catch{return null;}}

async function embedLogo(url){
  const safe=approvedImage(url);
  if(!safe)return null;
  try{
    const res=await fetch(safe.toString(),{redirect:'error',signal:AbortSignal.timeout(5000),headers:{accept:'image/png,image/jpeg,image/webp'}});
    if(!res.ok)return null;
    const type=(res.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    const size=Number(res.headers.get('content-length')||'0');
    if(!VALID_TYPES.has(type)||size>600000)return null;
    const bytes=new Uint8Array(await res.arrayBuffer());
    if(!bytes.length||bytes.length>600000)return null;
    return `data:${type};base64,${base64(bytes)}`;
  }catch{return null;}
}

function portrait(center,logo,symbol,side){
  const accent=side==='left'?'#b476ff':'#3de3ff';
  const grad=side==='left'?'ringL':'ringR';
  const clip=side==='left'?'tokenA':'tokenB';
  const monogram=String(symbol??'?').replace(/^\$+/,'').slice(0,1).toUpperCase();
  return `<circle cx="${center}" cy="347" r="158" fill="${accent}" opacity=".06"/>
    <circle cx="${center}" cy="347" r="145" fill="none" stroke="${accent}" opacity=".13" stroke-width="8"/>
    <circle cx="${center}" cy="347" r="134" fill="none" stroke="${accent}" opacity=".35" stroke-width="2" stroke-dasharray="31 13 8 13"/>
    <circle cx="${center}" cy="347" r="125" fill="#080a1e" stroke="url(#${grad})" stroke-width="12"/>
    <circle cx="${center}" cy="347" r="112" fill="${side==='left'?'#241544':'#103447'}" />
    ${logo
      ? `<image href="${logo}" x="${center-112}" y="235" width="224" height="224" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>`
      : `<circle cx="${center}" cy="347" r="111" fill="${side==='left'?'#341952':'#12344a'}"/>${vectorText(monogram,center,298,{pixel:14,color:'#f8f4ff',align:'middle'})}`
    }
    <path d="M${center-155} 347h-34 M${center+155} 347h34 M${center} 197v-31 M${center} 497v31" stroke="${accent}" stroke-width="4" stroke-linecap="round" opacity=".75"/>
    <path d="M${center-80} 238A117 117 0 0 1 ${center+79} 238" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity=".38"/>`;
}

export function fightCardSvg(a,b,logoA=null,logoB=null){
  const left=String(a?.symbol??'TOKEN A').replace(/^\$+/,'').slice(0,15);
  const right=String(b?.symbol??'TOKEN B').replace(/^\$+/,'').slice(0,15);
  const stars=[[79,162,2],[132,412,2],[194,153,3],[444,233,2],[503,405,2],[698,230,2],[761,413,2],[1028,183,3],[1112,458,2],[1050,96,2],[345,125,2],[891,137,2],[1150,279,3],[74,530,2]]
    .map(([x,y,r])=>`<circle cx="${x}" cy="${y}" r="${r}" fill="#b3a2fa" opacity=".6"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="680" viewBox="0 0 1200 680">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#050719"/><stop offset=".49" stop-color="#170a35"/><stop offset="1" stop-color="#040a1a"/></linearGradient>
    <linearGradient id="ringL" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#f1d0ff"/><stop offset=".48" stop-color="#995aff"/><stop offset="1" stop-color="#4f24b4"/></linearGradient>
    <linearGradient id="ringR" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#c7ffff"/><stop offset=".48" stop-color="#53bfff"/><stop offset="1" stop-color="#2671da"/></linearGradient>
    <linearGradient id="bar" x1="0" x2="1"><stop stop-color="#9041ff"/><stop offset=".5" stop-color="#c97dff"/><stop offset="1" stop-color="#50cdff"/></linearGradient>
    <radialGradient id="glowL"><stop stop-color="#803bff" stop-opacity=".5"/><stop offset="1" stop-color="#803bff" stop-opacity="0"/></radialGradient>
    <radialGradient id="glowR"><stop stop-color="#1ac7e6" stop-opacity=".3"/><stop offset="1" stop-color="#1ac7e6" stop-opacity="0"/></radialGradient>
    <radialGradient id="centerGlow"><stop stop-color="#c061ff" stop-opacity=".3"/><stop offset="1" stop-color="#c061ff" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="#7857bb" stroke-width="1" opacity=".16"/></pattern>
    <clipPath id="tokenA"><circle cx="282" cy="347" r="111"/></clipPath>
    <clipPath id="tokenB"><circle cx="918" cy="347" r="111"/></clipPath>
  </defs>
  <rect width="1200" height="680" fill="url(#bg)"/>
  <path d="M0 0L700 0L450 680H0Z" fill="#5b21b6" opacity=".09"/>
  <path d="M1200 0L734 0L918 680H1200Z" fill="#00d5ff" opacity=".06"/>
  <rect width="1200" height="680" fill="url(#grid)"/>
  <ellipse cx="282" cy="347" rx="380" ry="340" fill="url(#glowL)"/>
  <ellipse cx="918" cy="347" rx="380" ry="340" fill="url(#glowR)"/>
  <ellipse cx="600" cy="347" rx="270" ry="315" fill="url(#centerGlow)"/>
  ${stars}
  <path d="M26 72V26H144 M1056 26H1174V72 M26 608V654H144 M1056 654H1174V608" stroke="#b896ff" fill="none" stroke-width="4" opacity=".83"/>
  <rect x="26" y="26" width="1148" height="628" rx="20" fill="none" stroke="#a979ff" stroke-width="1" opacity=".38"/>
  <path d="M360 36H840 M490 45H710" stroke="url(#bar)" stroke-width="5" stroke-linecap="round"/>
  ${vectorText('ASTY TOKEN FIGHT',600,72,{pixel:9,color:'#f6efff',tracking:3,align:'middle',maxWidth:1020})}
  ${vectorText('24H - COMMUNITY VS MARKET',600,154,{pixel:4,color:'#bfa7ee',tracking:3,align:'middle',maxWidth:820})}
  <path d="M65 201L390 201 M810 201L1135 201" stroke="url(#bar)" stroke-width="3" opacity=".45"/>
  ${vectorText('CHALLENGER',282,202,{pixel:4,color:'#c9a0ff',tracking:3,align:'middle'})}
  ${vectorText('OPPONENT',918,202,{pixel:4,color:'#92eaff',tracking:3,align:'middle'})}
  ${portrait(282,logoA,left,'left')}
  ${portrait(918,logoB,right,'right')}
  <path d="M570 230L630 230L661 265L661 415L630 449L570 449L539 415L539 265Z" fill="#07091b" stroke="#a65ffe" stroke-width="4" opacity=".9"/>
  <path d="M565 246L635 246L646 265L646 414L635 433L565 433L554 414L554 265Z" fill="none" stroke="#5c3a8e" stroke-width="2"/>
  ${vectorText('VS',600,309,{pixel:14,color:'#f4e3ff',tracking:7,align:'middle',maxWidth:100})}
  <path d="M594 405l13-27h-16l18-28-4 22h19z" fill="#cc81ff" opacity=".9"/>
  <path d="M148 485H418 M783 485H1053" stroke="#553b81" stroke-width="4"/>
  <path d="M170 592H394 M806 592H1030" stroke="url(#bar)" stroke-width="3" opacity=".54"/>
  ${vectorText('$'+left,282,503,{pixel:10,color:'#ffffff',tracking:3,align:'middle',maxWidth:430})}
  ${vectorText('$'+right,918,503,{pixel:10,color:'#ffffff',tracking:3,align:'middle',maxWidth:430})}
  <path d="M505 579H695" stroke="#8259bf" stroke-width="2" opacity=".8"/>
  ${vectorText('50% VOTES - 50% PRICE',600,589,{pixel:4,color:'#d0bceb',tracking:2,align:'middle',maxWidth:610})}
  <path d="M232 622H968" stroke="#61409d" stroke-width="1" opacity=".8"/>
  ${vectorText('POWERED BY ASTY - ARBSTRATEGY.NET',600,632,{pixel:4,color:'#cbb0ff',tracking:2,align:'middle',maxWidth:900})}
  </svg>`;
}

export async function fightImage(a,b){
  const astyAsset='https://raw.githubusercontent.com/ArbStrategy-ASTY/ArbStrategy-ASTY/main/assets/logo.png';
  const safeLogo=a?.logo_url||(String(a?.symbol??'').replace(/^\$+/,'').toUpperCase()==='ASTY'?astyAsset:null);
  const safeLogoB=b?.logo_url||(String(b?.symbol??'').replace(/^\$+/,'').toUpperCase()==='ASTY'?astyAsset:null);
  const [logoA,logoB]=await Promise.all([embedLogo(safeLogo),embedLogo(safeLogoB)]);
  return new Resvg(fightCardSvg(a,b,logoA,logoB)).render().asPng();
}
