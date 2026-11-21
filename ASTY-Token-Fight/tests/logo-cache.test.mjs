import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedLogo,ensureLogoTable,ensureTokenLogo,saveUploadedLogo,telegramUploadedBytes} from '../src/logo-cache.mjs';

const ARBX='ARBXtxRCZeSQwbYM51Nvdg2SE3PEnFTcWEuyEygPWm8F';
function jpeg(size=140){
  const a=new Uint8Array(size);a[0]=255;a[1]=216;a[2]=255;a[3]=224;a[size-2]=255;a[size-1]=217;return a;
}
function db(){
  const rows=new Map();
  return {rows,DB:{prepare(sql){
    let a=[];
    return {bind(...args){a=args;return this;},
      async first(){const row=rows.get(a[0]);return row?{data_uri:row.uri}:null;},
      async run(){
        if(sql.startsWith('INSERT OR IGNORE')&&!rows.has(a[0]))rows.set(a[0],{uri:a[1],source:'metadata'});
        if(sql.startsWith('INSERT INTO project_logos'))rows.set(a[0],{uri:a[1],source:'admin'});
        return {meta:{changes:1}};
      }
    };
  }}};
}
test('approved token logo downloaded once then permanently reused',async()=>{
  const original=globalThis.fetch;
  let requests=0;
  globalThis.fetch=async url=>{
    requests++;
    assert.equal(url,'https://static.birdeye.so/official-arbx.png');
    const bytes=jpeg();
    return {ok:true,status:200,headers:new Headers({'content-length':String(bytes.length)}),
      arrayBuffer:async()=>bytes.buffer};
  };
  try{
    const env=db();await ensureLogoTable(env);
    const token={mint:ARBX,symbol:'ARBX',logo_url:'https://static.birdeye.so/official-arbx.png'};
    const first=await ensureTokenLogo(env,token);
    const second=await ensureTokenLogo(env,token);
    assert.ok(first?.startsWith('data:image/jpeg;base64,'));
    assert.equal(first,second);
    assert.equal(requests,1);
  }finally{globalThis.fetch=original;}
});
test('uploaded official photo replaces metadata and becomes authoritative',async()=>{
  const env=db();await ensureLogoTable(env);
  const data=await saveUploadedLogo(env,ARBX,42,jpeg());
  assert.ok(data.startsWith('data:image/jpeg;base64,'));
  assert.equal(env.rows.get(ARBX).source,'admin');
  assert.equal(await cachedLogo(env,ARBX),data);
});
test('refuse unsupported image or oversized photo',async()=>{
  const env=db();
  await assert.rejects(()=>saveUploadedLogo(env,ARBX,42,new Uint8Array(120)));
  await assert.rejects(()=>saveUploadedLogo(env,ARBX,42,jpeg(440001)));
});
test('Telegram photo getFile downloads bytes without saving a transient URL',async()=>{
  const original=globalThis.fetch,bytes=jpeg();
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/getFile')){
      return {ok:true,json:async()=>({ok:true,result:{file_path:'photos/file_3.jpg',file_size:bytes.length}})};
    }
    assert.match(String(url),/\/file\/botTEST_BOT_TOKEN\/photos\/file_3\.jpg$/);
    return {ok:true,headers:new Headers({'content-length':String(bytes.length)}),arrayBuffer:async()=>bytes.buffer};
  };
  try{
    const downloaded=await telegramUploadedBytes({TELEGRAM_BOT_TOKEN:'TEST_BOT_TOKEN'},'FAKE_ID_3');
    assert.equal(downloaded.length,bytes.length);
  }finally{globalThis.fetch=original;}
});
