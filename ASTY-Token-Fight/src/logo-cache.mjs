// Persistent logo cache for ASTY Token Fight. No new Cloudflare product/binding.
// Cache verified JPEG/PNG bytes as data URIs in the existing D1 database.
const MINT_RE=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BYTES=440000;
const HOSTS=new Set([
  'raw.githubusercontent.com','static.jup.ag','cdn.dexscreener.com',
  'dd.dexscreener.com','img.fotofolio.xyz','img.birdeye.so','images.birdeye.so',
  'static.birdeye.so','ipfs.birdeye.so','assets.coingecko.com','gateway.pinata.cloud',
  'ipfs.io','arweave.net','cf-ipfs.com','cdn.jsdelivr.net','gateway.irys.xyz',
  'ipfs.nftstorage.link','image-cdn.solscan.io','coin-images.coingecko.com'
]);
function safeImageUrl(value){
  if(typeof value!=='string'||value.length>1200)return null;
  try{
    const u=new URL(value);
    const h=u.hostname.toLowerCase();
    if(u.protocol!=='https:'||u.port||u.username||u.password)return null;
    return HOSTS.has(h)||h.endsWith('.birdeye.so')||h.endsWith('.dexscreener.com')?u:null;
  }catch{return null;}
}
function imageType(b){
  if(b.length>8&&b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71&&b[4]===13&&b[5]===10&&b[6]===26&&b[7]===10)return 'image/png';
  if(b.length>3&&b[0]===255&&b[1]===216&&b[2]===255)return 'image/jpeg';
  return null;
}
function dataUri(bytes){
  if(bytes.length<32||bytes.length>MAX_BYTES)return null;
  const type=imageType(bytes);
  if(!type)return null;
  let base64='';
  for(let i=0;i<bytes.length;i+=16384)base64+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return 'data:'+type+';base64,'+btoa(base64);
}
async function fetchImage(uri){
  let u=safeImageUrl(uri);
  if(!u)return null;
  try{
    for(let i=0;i<3;i++){
      const res=await fetch(u.toString(),{redirect:'manual',signal:AbortSignal.timeout(5500),headers:{accept:'image/png,image/jpeg'}});
      if([301,302,303,307,308].includes(res.status)){
        const loc=res.headers.get('location');
        u=loc?safeImageUrl(new URL(loc,u).toString()):null;
        if(!u)return null;
        continue;
      }
      if(!res.ok||Number(res.headers.get('content-length')||0)>MAX_BYTES)return null;
      return dataUri(new Uint8Array(await res.arrayBuffer()));
    }
  }catch(e){console.log('logo host unavailable',String(e).slice(0,90));}
  return null;
}
async function externalCandidates(mint){
  const urls=[];
  try{
    const r=await fetch('https://tokens.jup.ag/token/'+encodeURIComponent(mint),{signal:AbortSignal.timeout(4800)});
    if(r.ok){const json=await r.json();if(json?.address===mint&&typeof json.logoURI==='string')urls.push(json.logoURI);}
  }catch{}
  try{
    const r=await fetch('https://api.dexscreener.com/token-pairs/v1/solana/'+encodeURIComponent(mint),{signal:AbortSignal.timeout(4800)});
    if(r.ok){
      const pairs=await r.json();
      if(Array.isArray(pairs))pairs.filter(p=>p?.chainId==='solana'&&p?.baseToken?.address===mint&&p?.info?.imageUrl)
        .sort((a,b)=>Number(b?.liquidity?.usd||0)-Number(a?.liquidity?.usd||0))
        .slice(0,5).forEach(p=>urls.push(p.info.imageUrl));
    }
  }catch{}
  return [...new Set(urls)];
}
export async function ensureLogoTable(env){
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS project_logos (mint TEXT PRIMARY KEY,data_uri TEXT NOT NULL,source TEXT NOT NULL,updated_by TEXT,updated_at INTEGER NOT NULL,FOREIGN KEY(mint) REFERENCES projects(mint))').run();
}
export async function cachedLogo(env,mint){
  if(!MINT_RE.test(mint||''))return null;
  const row=await env.DB.prepare('SELECT data_uri FROM project_logos WHERE mint=?').bind(mint).first();
  return row?.data_uri?.startsWith('data:image/')?row.data_uri:null;
}
export async function ensureTokenLogo(env,token){
  const mint=token?.mint;
  if(!MINT_RE.test(mint||''))return null;
  const cached=await cachedLogo(env,mint);
  if(cached)return cached;
  const urls=[token?.logo_url];
  if(String(token?.symbol||'').replace(/^\$+/,'').toUpperCase()==='ASTY')urls.push('https://raw.githubusercontent.com/ArbStrategy-ASTY/ArbStrategy-ASTY/main/assets/logo.png');
  urls.push(...await externalCandidates(mint));
  for(const url of [...new Set(urls.filter(Boolean))]){
    const image=await fetchImage(url);
    if(!image)continue;
    // Preserve any prior logo, especially an uploaded one.
    await env.DB.prepare("INSERT OR IGNORE INTO project_logos(mint,data_uri,source,updated_by,updated_at) VALUES(?,?,'metadata',NULL,?)").bind(mint,image,Math.floor(Date.now()/1000)).run();
    return cachedLogo(env,mint);
  }
  return null;
}
export async function saveUploadedLogo(env,mint,user,bytes){
  if(!MINT_RE.test(mint||''))throw new Error('Invalid mint.');
  const arr=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  const uri=dataUri(arr);
  if(!uri)throw new Error('Upload a valid JPEG or PNG logo smaller than 440 KB.');
  await env.DB.prepare("INSERT INTO project_logos(mint,data_uri,source,updated_by,updated_at) VALUES(?,?,'admin',?,?) ON CONFLICT(mint) DO UPDATE SET data_uri=excluded.data_uri,source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(mint,uri,String(user),Math.floor(Date.now()/1000)).run();
  return uri;
}
export async function telegramUploadedBytes(env,fileId){
  if(typeof fileId!=='string'||fileId.length>300||!/^[A-Za-z0-9_-]+$/.test(fileId))throw new Error('Invalid Telegram file ID.');
  const metadataRes=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getFile',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({file_id:fileId}),signal:AbortSignal.timeout(9000)
  });
  const metadata=await metadataRes.json();
  if(!metadataRes.ok||!metadata?.ok)throw new Error('Telegram could not read this image.');
  const path=metadata?.result?.file_path;
  if(typeof path!=='string'||!/^photos\/[A-Za-z0-9_-]+\.(jpg|jpeg|png)$/.test(path))throw new Error('Send the logo as a Telegram photo (PNG/JPEG).');
  if(Number(metadata.result?.file_size||0)>MAX_BYTES)throw new Error('Please send a smaller Telegram photo (under 440 KB).');
  const response=await fetch('https://api.telegram.org/file/bot'+env.TELEGRAM_BOT_TOKEN+'/'+path,{signal:AbortSignal.timeout(9000)});
  if(!response.ok||Number(response.headers.get('content-length')||0)>MAX_BYTES)throw new Error('Uploaded photo is too large.');
  const arr=new Uint8Array(await response.arrayBuffer());
  if(!dataUri(arr))throw new Error('Please send a valid PNG/JPEG photo smaller than 440 KB.');
  return arr;
}
