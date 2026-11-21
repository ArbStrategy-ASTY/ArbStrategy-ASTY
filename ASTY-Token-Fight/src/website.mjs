// Project-submitted websites: never treat these URLs as verified endorsements.
// Only HTTPS public domain URLs are accepted (no credentials, ports or IP hosts).
export function normalizeProjectWebsite(value) {
  if(typeof value!=='string')return null;
  let raw=value.trim();
  if(!raw||raw.length>160||/[\x00-\x1F\x7F\s]/.test(raw))return null;
  if(!raw.includes('://'))raw='https://'+raw;
  try{
    const u=new URL(raw);
    if(u.protocol!=='https:'||u.username||u.password||u.port)return null;
    const host=u.hostname.toLowerCase();
    const parts=host.split('.');
    if(parts.length<2 || host.length>253 || parts.some(p=>!p||p.length>63||!(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))))return null;
    if(!/^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/.test(parts.at(-1)))return null;
    if(parts.some(p=>['localhost','local','internal','invalid','test','onion'].includes(p)))return null;
    if(u.hash)u.hash='';
    const canonical=u.toString();
    if(canonical.length>160)return null;
    return canonical;
  }catch{return null;}
}
export function projectWebsiteDisplay(url){
  try{
    const u=new URL(url);
    return u.hostname.replace(/^www\./,'');
  }catch{return '';}
}
