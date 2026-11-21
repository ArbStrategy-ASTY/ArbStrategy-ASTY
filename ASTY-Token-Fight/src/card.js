import { Resvg } from '@cf-wasm/resvg';
import { vectorText } from './vector-font.mjs';


const IMAGE_HOSTS=new Set(['raw.githubusercontent.com','static.jup.ag','cdn.dexscreener.com','dd.dexscreener.com','img.fotofolio.xyz','img.birdeye.so','images.birdeye.so','static.birdeye.so','ipfs.birdeye.so','assets.coingecko.com','gateway.pinata.cloud','ipfs.io','arweave.net','cf-ipfs.com','cdn.jsdelivr.net']);
const BINARY_TYPES=new Set(['image/png','image/jpeg','image/webp']);


function approvedImage(url){
  try{
    const u=new URL(url);
    if(u.protocol!=='https:'||u.port||u.username||u.password)return null;
    const host=u.hostname.toLowerCase();
    if(IMAGE_HOSTS.has(host)||host.endsWith('.birdeye.so')||host.endsWith('.dexscreener.com'))return u;
  }catch{}
  return null;
}

function toBase64(bytes){
  let text='';
  for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return btoa(text);
}

async function embedLogo(url){
  let current=approvedImage(url);
  if(!current)return null;
  try{
    for(let n=0;n<3;n++){
      const response=await fetch(current.toString(),{redirect:'manual',signal:AbortSignal.timeout(4800),headers:{accept:'image/png,image/jpeg,image/webp'}});
      if([301,302,303,307,308].includes(response.status)){
        const redirected=response.headers.get('location');
        if(!redirected)return null;
        current=approvedImage(new URL(redirected,current).toString());
        if(!current)return null;
        continue;
      }
      if(!response.ok)return null;
      const declaredType=(response.headers.get('content-type')||'').split(';')[0].toLowerCase().trim();
      if(Number(response.headers.get('content-length')||0)>650000)return null;
      const data=new Uint8Array(await response.arrayBuffer());
      if(data.length===0||data.length>650000)return null;
      const png=data.length>8&&data[0]===137&&data[1]===80&&data[2]===78&&data[3]===71;
      const jpg=data.length>3&&data[0]===255&&data[1]===216&&data[2]===255;
      const webp=data.length>12&&String.fromCharCode(...data.subarray(0,4))==='RIFF'&&String.fromCharCode(...data.subarray(8,12))==='WEBP';
      const kind=png?'image/png':jpg?'image/jpeg':webp?'image/webp':null;
      if(!kind ||(declaredType && !BINARY_TYPES.has(declaredType)&&declaredType!=='application/octet-stream'))return null;
      return 'data:'+kind+';base64,'+toBase64(data);
    }
  }catch(e){console.log('Logo embed unavailable',String(e).slice(0,90))}
  return null;
}

async function dexscreenerImage(mint){
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint||''))return null;
  try{
    const response=await fetch('https://api.dexscreener.com/token-pairs/v1/solana/'+encodeURIComponent(mint),{signal:AbortSignal.timeout(4500)});
    if(!response.ok)return null;
    const raw=await response.json();
    if(!Array.isArray(raw))return null;
    const pairs=raw.filter(p=>p?.baseToken?.address===mint && p?.info?.imageUrl && p?.chainId==='solana')
      .sort((a,b)=>Number(b?.liquidity?.usd||0)-Number(a?.liquidity?.usd||0));
    return pairs[0]?.info?.imageUrl||null;
  }catch{return null;}
}

async function resolveLogo(token){
  const mint=token?.mint;
  let logo=await embedLogo(token?.logo_url);
  if(logo)return logo;
  if(String(token?.symbol||'').replace(/^\$+/,'').toUpperCase()==='ASTY'){
    logo=await embedLogo('https://raw.githubusercontent.com/ArbStrategy-ASTY/ArbStrategy-ASTY/main/assets/logo.png');
    if(logo)return logo;
  }
  const alternative=await dexscreenerImage(mint);
  return alternative?await embedLogo(alternative):null;
}

function coinLogo(x,logo,symbol,side){
  const ring=side==='a'?'borderA':'borderB';
  const clip=side==='a'?'logoClipA':'logoClipB';
  const highlight=side==='a'?'#b782ff':'#79d9f5';
  const text=String(symbol||'?').replace(/^\$+/,'').slice(0,9);
  let face;
  if(logo){
    face=`<image href="${logo}" x="${x-113}" y="181" width="226" height="226" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    // No fake logo: display token's actual ticker in a subtle placeholder coin.
    face=`<circle cx="${x}" cy="294" r="112" fill="${side==='a'?'#1f163d':'#102635'}"/>
      ${vectorText(text,x,273,{pixel:7,color:'#f1e9ff',align:'middle',maxWidth:170})}`;
  }
  return `<circle cx="${x}" cy="294" r="141" fill="${highlight}" opacity=".07"/>
    <circle cx="${x}" cy="294" r="128" fill="#070b16" stroke="url(#${ring})" stroke-width="9"/>
    <circle cx="${x}" cy="294" r="116" fill="#0d1120"/>
    ${face}
    <circle cx="${x}" cy="294" r="113" fill="none" stroke="#ffffff" stroke-width="2" opacity=".14"/>
    <path d="M${x-96} 236Q${x} 140 ${x+95} 236" stroke="#ffffff" opacity=".24" stroke-width="4" fill="none"/>
    `;
}

export function fightCardSvg(a,b,logoA=null,logoB=null){
  const left=String(a?.symbol||'TOKEN A').replace(/^\$+/,'').slice(0,15);
  const right=String(b?.symbol||'TOKEN B').replace(/^\$+/,'').slice(0,15);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620">
    <defs>
      <linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#090916"/><stop offset=".5" stop-color="#110c23"/><stop offset="1" stop-color="#07101e"/></linearGradient>
      <radialGradient id="leftGlow"><stop stop-color="#813ad8" stop-opacity=".24"/><stop offset="1" stop-color="#813ad8" stop-opacity="0"/></radialGradient>
      <radialGradient id="rightGlow"><stop stop-color="#1fb7df" stop-opacity=".16"/><stop offset="1" stop-color="#1fb7df" stop-opacity="0"/></radialGradient>
      <linearGradient id="borderA" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ddc1ff"/><stop offset=".55" stop-color="#975ae5"/><stop offset="1" stop-color="#3a1b84"/></linearGradient>
      <linearGradient id="borderB" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d0f5ff"/><stop offset=".55" stop-color="#63aed6"/><stop offset="1" stop-color="#1f537e"/></linearGradient>
      <clipPath id="logoClipA"><circle cx="305" cy="294" r="112"/></clipPath>
      <clipPath id="logoClipB"><circle cx="895" cy="294" r="112"/></clipPath>
    </defs>
    <rect width="1200" height="620" fill="url(#background)"/>
    <ellipse cx="270" cy="280" rx="410" ry="400" fill="url(#leftGlow)"/>
    <ellipse cx="935" cy="280" rx="400" ry="400" fill="url(#rightGlow)"/>
    <path d="M0 0H1200V4H0Z" fill="#aa79fc" opacity=".5"/>
    <path d="M0 616H1200V620H0Z" fill="#aa79fc" opacity=".24"/>
    <path d="M58 135H460 M740 135H1142" stroke="#7c63a5" stroke-width="2" opacity=".32"/>
    <path d="M600 161V433" stroke="#b79cff" stroke-width="1" opacity=".25"/>
    <rect x="56" y="157" width="480" height="337" rx="26" fill="#ffffff" opacity=".018" stroke="#c699ff" stroke-width="2"/>
    <rect x="664" y="157" width="480" height="337" rx="26" fill="#ffffff" opacity=".018" stroke="#6ea6ce" stroke-width="2"/>
    ${vectorText('ASTY TOKEN FIGHT',600,59,{pixel:7.7,color:'#ffffff',tracking:4,align:'middle',maxWidth:920})}
    ${coinLogo(305,logoA,left,'a')}
    ${coinLogo(895,logoB,right,'b')}
    <circle cx="600" cy="298" r="77" fill="#151024" stroke="#8c5ec3" stroke-width="2"/>
    <circle cx="600" cy="298" r="65" fill="#0a0d19" stroke="#a88fd8" stroke-width="1" opacity=".93"/>
    ${vectorText('VS',600,263,{pixel:12,color:'#ffffff',tracking:4,align:'middle',maxWidth:103})}
    ${vectorText('$'+left,305,453,{pixel:9,color:'#f5f0ff',tracking:3,align:'middle',maxWidth:425})}
    ${vectorText('$'+right,895,453,{pixel:9,color:'#f5f0ff',tracking:3,align:'middle',maxWidth:425})}
    <path d="M60 519H1140" stroke="#9e87c5" stroke-width="2" opacity=".24"/>
    ${vectorText('24H BATTLE',600,529,{pixel:4.1,color:'#b6a8d5',tracking:4,align:'middle',maxWidth:450})}
    ${vectorText('POWERED BY ASTY - ARBSTRATEGY.NET',600,568,{pixel:3.9,color:'#c9b5e7',tracking:2.5,align:'middle',maxWidth:940})}
  </svg>`;
}

export async function fightImage(a,b){
  // D1-cached logos always win over transient metadata URLs.
  const cached=a?.logo_data_uri&&b?.logo_data_uri;
  const [logoA,logoB]=cached?[a.logo_data_uri,b.logo_data_uri]:await Promise.all([resolveLogo(a),resolveLogo(b)]);
  // Do not publish a logo-less battle. The owner can submit a photo in the bot.
  if(!logoA||!logoB)throw new Error('Both token logos are required to render a battle.');
  return new Resvg(fightCardSvg(a,b,logoA,logoB)).render().asPng();
}
