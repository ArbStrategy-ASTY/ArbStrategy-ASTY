import { calculateScore } from './scoring.mjs';
import { fightImage } from './card.js';
import { birdeyeTokenInfo, birdeyePairPrices, pause } from './birdeye.mjs';

const DAY=86400;
const PENDING_TTL=7*DAY;
const VOTE_RETENTION=30*DAY;
const REFRESH_INTERVAL=600;
const now=()=>Math.floor(Date.now()/1000);
const mintOk=s=>typeof s==='string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const eid=()=>crypto.randomUUID().replaceAll('-','').slice(0,14);
const html=s=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=n=>`${n>=0?'+':''}${n.toFixed(2)}%`;
const tokenLabel=s=>'
const errString=e=>String(e?.message || e).slice(0,220);
const changed=r=>Number(r?.meta?.changes||0)>0;

async function telegram(env,method,body){
  const url=`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response=await fetch(url,{method:'POST',body:body instanceof FormData?body:JSON.stringify(body),headers:body instanceof FormData?{}:{'content-type':'application/json'},signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data?.ok)throw new Error(`Telegram ${method}: ${data?.description||response.status}`);
  return data.result;
}
const say=(env,chat,text,options={})=>telegram(env,'sendMessage',{chat_id:chat,text,parse_mode:'HTML',disable_web_page_preview:true,...options});
const keyboard=rows=>({inline_keyboard:rows});
async function tgAdmin(env,chat,user){
  try{const m=await telegram(env,'getChatMember',{chat_id:chat,user_id:Number(user)});return ['administrator','creator'].includes(m.status);}catch{return false;}
}
async function groupForAdmin(env,mint,user){
  const groups=await env.DB.prepare('SELECT * FROM project_groups WHERE mint=?').bind(mint).all();
  for(const g of groups.results)if(await tgAdmin(env,g.chat_id,user))return g;
  return null;
}
function botLink(env,fightId){return `https://t.me/${env.BOT_USERNAME.replace('@','')}?start=challenge_${fightId}`;}

async function tokenInfo(env,mint){
  const prev=await env.DB.prepare('SELECT * FROM projects WHERE mint=?').bind(mint).first();
  if(prev&&now()-prev.updated_at<DAY)return prev;
  const data=await birdeyeTokenInfo(env,mint);
  const p={...data,updated_at:now()};
  await env.DB.prepare(`INSERT INTO projects(mint,name,symbol,logo_url,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET name=excluded.name,symbol=excluded.symbol,logo_url=excluded.logo_url,updated_at=excluded.updated_at`).bind(p.mint,p.name,p.symbol,p.logo_url,p.updated_at).run();
  return p;
}
async function prices(env,a,b){
  return birdeyePairPrices(env,a,b);
}
async function stats(env,id){
  const r=await env.DB.prepare(`SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN side='a' THEN 1 ELSE 0 END),0) a FROM votes WHERE fight_id=?`).bind(id).first();
  return [Number(r?.a||0),Number(r?.n||0)-Number(r?.a||0)];
}
async function detail(env,id){
  return env.DB.prepare(`SELECT f.*,a.symbol sym_a,a.name name_a,a.logo_url logo_a,b.symbol sym_b,b.name name_b,b.logo_url logo_b FROM fights f JOIN projects a ON a.mint=f.mint_a JOIN projects b ON b.mint=f.mint_b WHERE f.id=?`).bind(id).first();
}
function publicStats(f,votesA,votesB){
  const closed=['ended','unresolved'].includes(f.status);
  return closed&&f.final_votes_a!==null&&f.final_votes_b!==null?[f.final_votes_a,f.final_votes_b]:[votesA,votesB];
}
function caption(f,votesA,votesB){
  const [va,vb]=publicStats(f,votesA,votesB);
  const ra=f.start_price_a&&f.latest_price_a?100*(f.latest_price_a/f.start_price_a-1):null;
  const rb=f.start_price_b&&f.latest_price_b?100*(f.latest_price_b/f.start_price_b-1):null;
  const computed=calculateScore(va,vb,f.start_price_a,f.latest_price_a,f.start_price_b,f.latest_price_b);
  const aScore=f.status==='ended'&&f.final_score_a!==null?f.final_score_a:computed?.scoreA;
  const bScore=f.status==='ended'&&f.final_score_b!==null?f.final_score_b:computed?.scoreB;
  const left=Math.max(0,(f.ends_at||now())-now()),time=`${Math.floor(left/3600)}h ${Math.floor((left%3600)/60)}m`;
  const statuses={pending:'CHALLENGE PENDING',active:'LIVE TOKEN FIGHT',ended:'FINISHED TOKEN FIGHT',unresolved:'PRICE UNAVAILABLE',declined:'CHALLENGE DECLINED',cancelled:'FIGHT STOPPED',expired:'CHALLENGE EXPIRED'};
  const lines=[`<b>🥊 ${statuses[f.status]||'TOKEN FIGHT'} ${html(f.id)}</b>`,`⚡ ${html(tokenLabel(f.sym_a))} VS ${html(tokenLabel(f.sym_b))}`,`🗳️ Votes: <b>${va}</b> · <b>${vb}</b>`,`📈 Price change: ${ra===null?'n/a':pct(ra)} · ${rb===null?'n/a':pct(rb)}`];
  if(aScore!==undefined&&['active','ended'].includes(f.status))lines.push(`🏆 Score: <b>${aScore.toFixed(1)}%</b> · <b>${bScore.toFixed(1)}%</b>`);
  if(f.status==='active')lines.push(`⏳ Remaining: ${time}`);
  if(f.status==='ended')lines.push(`🥇 ${f.winner==='draw'?'DRAW':html(tokenLabel(f.winner==='a'?f.sym_a:f.sym_b))+' WINS!'}`);
  if(f.status==='unresolved')lines.push('No winner declared. Manual price review required.');
  lines.push('🟣 <b>Powered by ASTY - ArbStrategy.net</b>');
  return lines.join('\n');
}
function votingButtons(f){return keyboard([[{text:`🗳️ ${tokenLabel(f.sym_a)}`,callback_data:`vote:${f.id}:a`},{text:`🗳️ ${tokenLabel(f.sym_b)}`,callback_data:`vote:${f.id}:b`}]]);}
async function postFight(env,id){
  const f=await detail(env,id);if(!f||f.status!=='active')return;
  // Only groups whose live post is missing need an image. Normal 10-minute refreshes never re-render.
  const groups=await env.DB.prepare(`SELECT DISTINCT pg.chat_id FROM project_groups pg WHERE pg.mint IN (?,?) AND NOT EXISTS (SELECT 1 FROM group_messages gm WHERE gm.fight_id=? AND gm.chat_id=pg.chat_id)`).bind(f.mint_a,f.mint_b,id).all();
  if(!groups.results.length)return;
  let img=null;
  try{img=await fightImage({symbol:f.sym_a,logo_url:f.logo_a},{symbol:f.sym_b,logo_url:f.logo_b});}catch(e){console.error('Battle graphic unavailable, using text fallback',errString(e));}
  for(const group of groups.results){
    const existing=await env.DB.prepare('SELECT live_message_id FROM group_messages WHERE fight_id=? AND chat_id=?').bind(id,group.chat_id).first();
    if(existing?.live_message_id)continue;
    try{
      let r,kind='photo';
      if(img){
        const form=new FormData();form.append('chat_id',group.chat_id);form.append('photo',new Blob([img],{type:'image/png'}),'ASTY-Fight.png');form.append('caption',caption(f,0,0));form.append('parse_mode','HTML');form.append('reply_markup',JSON.stringify(votingButtons(f)));
        try{r=await telegram(env,'sendPhoto',form);}catch(e){console.error('Photo upload failed; falling back to text',errString(e));}
      }
      if(!r){kind='text';r=await say(env,group.chat_id,caption(f,0,0),{reply_markup:votingButtons(f)});}
      await env.DB.prepare('INSERT OR IGNORE INTO group_messages(fight_id,chat_id,live_message_id,message_type) VALUES(?,?,?,?)').bind(id,group.chat_id,r.message_id,kind).run();
    }catch(e){console.error('postFight group',group.chat_id,errString(e));}
  }
}
// Durable at-least-once group message delivery. Negative sent_at is a 90-second lease.
// In the rare case Telegram accepts a message but the database write fails, it may retry once.
async function deliverEvent(env,id,chat,eventType,text){
  await env.DB.prepare('INSERT OR IGNORE INTO sent_events(fight_id,chat_id,event_type,sent_at) VALUES(?,?,?,0)').bind(id,chat,eventType).run();
  const lease=-now()-90;
  const r=await env.DB.prepare('UPDATE sent_events SET sent_at=? WHERE fight_id=? AND chat_id=? AND event_type=? AND (sent_at=0 OR (sent_at<0 AND sent_at>=?))').bind(lease,id,chat,eventType,-now()).run();
  if(!changed(r))return;
  try{
    await say(env,chat,text);
    await env.DB.prepare('UPDATE sent_events SET sent_at=? WHERE fight_id=? AND chat_id=? AND event_type=? AND sent_at=?').bind(now(),id,chat,eventType,lease).run();
  }catch(e){
    console.error('event delivery',id,eventType,errString(e));
    await env.DB.prepare('UPDATE sent_events SET sent_at=0 WHERE fight_id=? AND chat_id=? AND event_type=? AND sent_at=?').bind(id,chat,eventType,lease).run().catch(()=>{});
  }
}
// Every 10 minutes, post a NEW battle message with the current numbers.
// Telegram copyMessage reuses the already uploaded photo without rendering/reuploading it.
// Keep only the newest message ID in D1 so the next update copies the newest card.
async function refreshMessages(env,id,final=false,repost=false){
  const f=await detail(env,id);if(!f)return;
  const [va,vb]=await stats(env,id),msgs=await env.DB.prepare('SELECT * FROM group_messages WHERE fight_id=?').bind(id).all();
  const currentCaption=caption(f,va,vb);
  for(const m of msgs.results){
    if(repost&&f.status==='active'){
      try{
        let sent;
        if(m.message_type==='text'){
          sent=await say(env,m.chat_id,currentCaption,{reply_markup:votingButtons(f)});
        }else{
          sent=await telegram(env,'copyMessage',{
            chat_id:m.chat_id,from_chat_id:m.chat_id,message_id:m.live_message_id,
            caption:currentCaption,parse_mode:'HTML',reply_markup:votingButtons(f)
          });
        }
        if(!Number.isInteger(sent?.message_id))throw new Error('Telegram returned no copied message ID');
        await env.DB.prepare('UPDATE group_messages SET live_message_id=? WHERE fight_id=? AND chat_id=? AND live_message_id=?')
          .bind(sent.message_id,id,m.chat_id,m.live_message_id).run();
      }catch(e){
        console.error('repost',id,m.chat_id,errString(e));
        // Never lose live stats if Telegram rejects a repost; edit the previous post instead.
        try{
          await telegram(env,m.message_type==='text'?'editMessageText':'editMessageCaption',{
            chat_id:m.chat_id,message_id:m.live_message_id,
            [m.message_type==='text'?'text':'caption']:currentCaption,
            parse_mode:'HTML',reply_markup:votingButtons(f)
          });
        }catch(fallbackError){
          if(!errString(fallbackError).includes('message is not modified'))console.error('repost fallback',id,m.chat_id,errString(fallbackError));
        }
      }
      continue;
    }
    // The final result updates the latest posted card and adds one final notification.
    try{
      await telegram(env,m.message_type==='text'?'editMessageText':'editMessageCaption',{
        chat_id:m.chat_id,message_id:m.live_message_id,
        [m.message_type==='text'?'text':'caption']:currentCaption,
        parse_mode:'HTML',reply_markup:f.status==='active'?votingButtons(f):keyboard([])
      });
    }catch(e){if(!errString(e).includes('message is not modified'))console.error('edit',id,m.chat_id,errString(e));}
    if(final)await deliverEvent(env,id,m.chat_id,`end_${f.status}`,currentCaption).catch(e=>console.error('final event',id,m.chat_id,errString(e)));
  }
}
async function sendMilestones(env,id){
  const f=await detail(env,id);if(!f||f.status!=='active')return;
  const elapsed=now()-f.started_at;
  const milestone=elapsed>=23*3600?'23h':elapsed>=12*3600?'12h':elapsed>=6*3600?'6h':null;
  if(!milestone)return;
  // Milestones are sent only once per exact threshold; delayed checks do not flood older notices.
  const minTime={'6h':6*3600,'12h':12*3600,'23h':23*3600}[milestone];
  if(elapsed>minTime+2*REFRESH_INTERVAL)return;
  const msgs=await env.DB.prepare('SELECT * FROM group_messages WHERE fight_id=?').bind(id).all();
  for(const m of msgs.results){
    await deliverEvent(env,id,m.chat_id,`milestone_${milestone}`,`🥊 <b>ASTY TOKEN FIGHT</b> – ${html(f.sym_a)} VS ${html(f.sym_b)}\n${milestone==='23h'?'⏰ Only 1 hour left!':'⚡ Battle update'}\n\n🟣 Powered by ASTY`).catch(e=>console.error('milestone',id,errString(e)));
  }
}

async function createFight(env,user,a,b,chat){
  if(!mintOk(a)||!mintOk(b)||a===b)return say(env,chat,'Please provide two different valid Solana token mint addresses.');
  if(!(await groupForAdmin(env,a,user)))return say(env,chat,`First link your project group as an admin: <code>/link ${html(a)}</code>.`);
  const pending=await env.DB.prepare(`SELECT COUNT(*) n FROM fights WHERE creator_id=? AND status='pending'`).bind(String(user)).first();
  if(Number(pending?.n||0)>=3)return say(env,chat,'Maximal drei offene Herausforderungen gleichzeitig.');
  const busy=await env.DB.prepare(`SELECT COUNT(*) n FROM active_token_locks WHERE mint IN (?,?)`).bind(a,b).first();
  if(Number(busy?.n||0)>0)return say(env,chat,'Mindestens einer der Tokens kämpft bereits in einem aktiven Fight. Nach dessen Ende kannst du erneut herausfordern.');
  try{await tokenInfo(env,a);await pause(1200);await tokenInfo(env,b);}catch(e){return say(env,chat,`Token lookup failed: ${html(errString(e))}`);}
  const id=eid();
  try{await env.DB.prepare(`INSERT INTO fights(id,mint_a,mint_b,creator_id,status,created_at) VALUES(?,?,?,?,'pending',?)`).bind(id,a,b,String(user),now()).run();}
  catch(e){return say(env,chat,'Für dieses Token-Paar existiert bereits eine offene oder aktive Herausforderung. Wiederholung erst nach deren Abschluss möglich.');}
  await say(env,chat,`🥊 <b>Challenge created!</b>\nShare this link with your opponent:\n${botLink(env,id)}\n\nThe opponent must link their Telegram group and accept the challenge.`,{reply_markup:keyboard([[{text:'🔗 Share challenge',url:botLink(env,id)}]])});
  const opponents=await env.DB.prepare('SELECT DISTINCT registered_by FROM project_groups WHERE mint=?').bind(b).all();
  for(const x of opponents.results){try{await say(env,x.registered_by,`🥊 Neue Herausforderung für dein Projekt!\n${botLink(env,id)}`);}catch{}}
}
async function linkGroup(env,msg,arg){
  if(!['group','supergroup'].includes(msg.chat.type))return say(env,msg.chat.id,'Bitte direkt in deiner Telegram-Gruppe <code>/link TOKENADRESSE</code> verwenden.');
  if(!await tgAdmin(env,msg.chat.id,msg.from.id))return say(env,msg.chat.id,'Nur ein Gruppenadmin kann einen Token verknüpfen.');
  if(!mintOk(arg))return say(env,msg.chat.id,'Syntax: <code>/link SOLANA_TOKENADRESSE</code>');
  try{await tokenInfo(env,arg);}catch(e){return say(env,msg.chat.id,'Token nicht gefunden: '+html(errString(e)));}
  await env.DB.prepare(`INSERT INTO project_groups(mint,chat_id,chat_title,registered_by,registered_at) VALUES(?,?,?,?,?) ON CONFLICT(mint,chat_id) DO UPDATE SET chat_title=excluded.chat_title,registered_by=excluded.registered_by,registered_at=excluded.registered_at`).bind(arg,String(msg.chat.id),msg.chat.title||'',String(msg.from.id),now()).run();
  return say(env,msg.chat.id,`✅ Group linked to <code>${html(arg)}</code>. Ready for future battles.`);
}
async function unlinkGroup(env,msg,arg){
  if(!['group','supergroup'].includes(msg.chat.type)||!await tgAdmin(env,msg.chat.id,msg.from.id))return say(env,msg.chat.id,'Nur ein Gruppenadmin kann hier eine Gruppe trennen.');
  if(!mintOk(arg))return say(env,msg.chat.id,'Syntax: <code>/unlink TOKENADRESSE</code>');
  const r=await env.DB.prepare('DELETE FROM project_groups WHERE mint=? AND chat_id=?').bind(arg,String(msg.chat.id)).run();
  return say(env,msg.chat.id,changed(r)?'✅ Gruppenverknüpfung entfernt. Laufende Battle-Nachrichten bleiben bis zum Ende bestehen.':'Für diesen Token besteht hier keine Verknüpfung.');
}
async function challengeView(env,chat,id){
  const f=await detail(env,id);if(!f)return say(env,chat,'Herausforderung nicht gefunden.');
  if(f.status!=='pending')return say(env,chat,`Dieser Fight hat den Status ${html(f.status)}.`);
  return say(env,chat,`🥊 <b>NEW ASTY TOKEN FIGHT CHALLENGE</b>\n${html(f.sym_a)} fordert ${html(f.sym_b)} heraus!\n⏳ 24 Stunden · 50 % Voting · 50 % Preisentwicklung\n\nDu musst Admin einer mit ${html(f.sym_b)} verknüpften Gruppe sein.`,{reply_markup:keyboard([[{text:'✅ Herausforderung annehmen',callback_data:`accept:${f.id}`}],[{text:'❌ Ablehnen',callback_data:`decline:${f.id}`} ]])});
}
async function accept(env,query,id,decline=false){
  const uid=query.from.id,chat=query.message.chat.id;
  if(query.message.chat.type!=='private')return say(env,chat,'Bitte diese Anfrage im privaten Bot-Chat öffnen.');
  const f=await detail(env,id);if(!f||f.status!=='pending')return say(env,chat,'Diese Herausforderung ist nicht mehr offen.');
  if(!(await groupForAdmin(env,f.mint_b,uid)))return say(env,chat,`Du musst Admin einer verknüpften Gruppe für ${html(f.sym_b)} sein. Dort zuerst <code>/link ${html(f.mint_b)}</code> eingeben.`);
  if(decline){
    const r=await env.DB.prepare(`UPDATE fights SET status='declined' WHERE id=? AND status='pending'`).bind(id).run();
    return say(env,chat,changed(r)?'Herausforderung abgelehnt.':'Herausforderung wurde bereits bearbeitet.');
  }
  let p;
  try{p=await prices(env,f.mint_a,f.mint_b);}catch(e){return say(env,chat,'Der Start ist derzeit wegen der Preisquelle nicht möglich: '+html(errString(e)));}
  if(!p[0]||!p[1])return say(env,chat,'Für mindestens einen Token fehlt gerade ein Birdeye-Preis. Kein Fight gestartet.');
  const t=now();
  try{
    // D1 batch is transactional: either BOTH token locks + status change succeed or none.
    const batch=await env.DB.batch([
      env.DB.prepare(`INSERT INTO active_token_locks(mint,fight_id) SELECT mint_a,id FROM fights WHERE id=? AND status='pending'`).bind(id),
      env.DB.prepare(`INSERT INTO active_token_locks(mint,fight_id) SELECT mint_b,id FROM fights WHERE id=? AND status='pending'`).bind(id),
      env.DB.prepare(`UPDATE fights SET status='active',accepted_by=?,started_at=?,ends_at=?,start_price_a=?,start_price_b=?,latest_price_a=?,latest_price_b=?,last_price_at=?,next_refresh_at=? WHERE id=? AND status='pending'`).bind(String(uid),t,t+DAY,p[0],p[1],p[0],p[1],t,t+REFRESH_INTERVAL,id)
    ]);
    if(!changed(batch[2]))return say(env,chat,'Diese Herausforderung wurde bereits bearbeitet.');
  }catch(e){return say(env,chat,'Einer der beiden Tokens kämpft bereits in einem anderen aktiven Fight. Die Herausforderung bleibt offen und kann später erneut angenommen werden.');}
  await say(env,chat,'✅ Fight angenommen! 24-Stunden-Uhr läuft. Die Battle-Anzeige wird in beide Gruppen geschickt.');
  await say(env,f.creator_id,`🥊 ${html(f.sym_b)} hat angenommen! Fight #${f.id} ist LIVE.`).catch(()=>{});
  await postFight(env,id);
}
async function vote(env,q,id,side){
  const f=await detail(env,id);
  if(!f||f.status!=='active'||now()>=f.ends_at)return telegram(env,'answerCallbackQuery',{callback_query_id:q.id,text:'This fight is no longer active.',show_alert:true});
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO votes(fight_id,voter_id,side,voted_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM fights WHERE id=? AND status='active' AND ends_at>?)`).bind(id,String(q.from.id),side,now(),id,now()).run();
  const selected=tokenLabel(side==='a'?f.sym_a:f.sym_b);
  return telegram(env,'answerCallbackQuery',{callback_query_id:q.id,text:changed(r)?`🔥 New vote for ${selected} 🔥`:'You have already voted or this fight has ended.',show_alert:false});
}
async function statusText(env,id){
  const f=await detail(env,id);if(!f)return null;
  const [a,b]=await stats(env,id);return caption(f,a,b);
}
async function fightList(env,chat,history=false,mint=null){
  let sql=history?`SELECT id FROM fights WHERE status IN ('ended','unresolved')`:`SELECT id FROM fights WHERE status='active'`;
  const binds=[];
  if(mint){sql+=' AND (mint_a=? OR mint_b=?)';binds.push(mint,mint);}
  sql+=history?' ORDER BY archived_at DESC LIMIT 10':' ORDER BY ends_at ASC LIMIT 10';
  const list=await env.DB.prepare(sql).bind(...binds).all();
  if(!list.results.length)return say(env,chat,history?'Noch keine abgeschlossenen Fights gefunden.':'Derzeit keine aktiven Fights.');
  const lines=[history?'🏆 <b>ASTY Token Fight – Hall of Fame</b>':'🥊 <b>Aktive Fights</b>'];
  for(const row of list.results){const f=await detail(env,row.id);if(!f)continue;
    lines.push(`${html(f.sym_a)} VS ${html(f.sym_b)} · <code>${html(f.id)}</code>${history?(f.status==='ended'?` · Sieger: ${f.winner==='draw'?'Unentschieden':html(f.winner==='a'?f.sym_a:f.sym_b)}`:' · Ohne Wertung'):' · LIVE'}`);
  }
  lines.push('\n/status FIGHT_ID für Details · 🟣 Powered by ASTY');
  return say(env,chat,lines.join('\n'));
}
async function onUpdate(env,u){
  if(u.callback_query){
    const q=u.callback_query,parts=(q.data||'').split(':');
    if(parts[0]==='vote'&&['a','b'].includes(parts[2]))return vote(env,q,parts[1],parts[2]);
    await telegram(env,'answerCallbackQuery',{callback_query_id:q.id}).catch(()=>{});
    if(parts[0]==='accept'||parts[0]==='decline')return accept(env,q,parts[1],parts[0]==='decline');
    return;
  }
  const msg=u.message;if(!msg?.text||!msg.from)return;
  const chat=msg.chat.id,privateChat=msg.chat.type==='private';
  const [raw,...args]=msg.text.trim().split(/\s+/),cmd=raw.toLowerCase().split('@')[0];
  if(cmd==='/link')return linkGroup(env,msg,args[0]);
  if(cmd==='/unlink')return unlinkGroup(env,msg,args[0]);
  if(!privateChat)return;
  if(cmd==='/start'){
    if(args[0]?.startsWith('challenge_'))return challengeView(env,chat,args[0].slice(10));
    return say(env,chat,'🥊 <b>ASTY TOKEN FIGHT</b>\n\nZwei Projekte. 24 Stunden. 50 % Stimmen + 50 % Kursentwicklung.\n\n1. In der Projektgruppe als Admin <code>/link TOKENADRESSE</code> senden.\n2. Hier <code>/new</code> starten.\n3. Challenge-Link an den Gegner schicken.\n\n/fights zeigt laufende Duelle, /history die Hall of Fame.\n\n🟣 Powered by ASTY');
  }
  if(cmd==='/help')return say(env,chat,'Privat: <code>/new</code>, <code>/new EIGENER_MINT GEGNER_MINT</code>, <code>/fights</code>, <code>/history [MINT]</code>, <code>/status FIGHT_ID</code>, <code>/withdraw FIGHT_ID</code>, <code>/cancel</code>. Gruppe: <code>/link MINT</code>, <code>/unlink MINT</code>.');
  if(cmd==='/fights')return fightList(env,chat,false);
  if(cmd==='/history')return fightList(env,chat,true,mintOk(args[0])?args[0]:null);
  if(cmd==='/status'){
    if(!args[0])return say(env,chat,'Syntax: <code>/status FIGHT_ID</code>');
    const text=await statusText(env,args[0]);return say(env,chat,text||'Fight nicht gefunden.');
  }
  if(cmd==='/withdraw'){
    const f=args[0]?await detail(env,args[0]):null;
    if(!f||f.creator_id!==String(msg.from.id)||f.status!=='pending')return say(env,chat,'Nur der Ersteller kann seine noch offene Herausforderung zurückziehen.');
    const r=await env.DB.prepare(`UPDATE fights SET status='cancelled' WHERE id=? AND status='pending'`).bind(f.id).run();
    return say(env,chat,changed(r)?'✅ Herausforderung zurückgezogen. Ein neuer Fight ist jetzt möglich.':'Die Herausforderung wurde inzwischen bearbeitet.');
  }
  if(cmd==='/stop'){
    const f=args[0]?await detail(env,args[0]):null;
    if(!f)return say(env,chat,'Usage: /stop FIGHT_ID');
    if(f.creator_id!==String(msg.from.id))return say(env,chat,'Only the challenge creator can stop this fight.');
    if(f.status!=='active')return say(env,chat,'This fight is not active.');
    const t=now();
    const changedRows=await env.DB.batch([
      env.DB.prepare(`UPDATE fights SET status='cancelled',settled_at=?,archived_at=? WHERE id=? AND creator_id=? AND status='active'`).bind(t,t,f.id,String(msg.from.id)),
      env.DB.prepare(`DELETE FROM active_token_locks WHERE fight_id=? AND EXISTS(SELECT 1 FROM fights WHERE id=? AND status='cancelled')`).bind(f.id,f.id)
    ]);
    if(!changed(changedRows[0]))return say(env,chat,'This fight has already been stopped.');
    await say(env,chat,`🛑 Fight ${html(f.id)} stopped. Both tokens are available for a new challenge.`);
    await refreshMessages(env,f.id,true);
    return;
  }
  if(cmd==='/cancel'){await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();return say(env,chat,'Challenge setup cancelled.');}
  if(cmd==='/new'){
    if(args.length>=2)return createFight(env,msg.from.id,args[0],args[1],chat);
    await env.DB.prepare(`INSERT INTO draft_state(user_id,step,own_mint,updated_at) VALUES(?,'own',NULL,?) ON CONFLICT(user_id) DO UPDATE SET step='own',own_mint=NULL,updated_at=excluded.updated_at`).bind(String(msg.from.id),now()).run();
    return say(env,chat,'Send your <b>project token mint address</b>. Use /cancel to stop.');
  }
  if(!raw.startsWith('/')){
    const draft=await env.DB.prepare('SELECT * FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).first();
    if(!draft||now()-draft.updated_at>1800){
      if(draft)await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();
      // Never silently ignore a submitted mint when a challenge draft has expired.
      if(mintOk(raw))return say(env,chat,'Your challenge setup has expired or is no longer active. Send /new to start again.');
      return;
    }
    if(!mintOk(raw))return say(env,chat,'Please send a valid Solana token address.');
    if(draft.step==='own'){
      await env.DB.prepare(`UPDATE draft_state SET step='opponent',own_mint=?,updated_at=? WHERE user_id=?`).bind(raw,now(),String(msg.from.id)).run();
      return say(env,chat,'Now send the <b>opponent token mint address</b>.');
    }
    await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();
    return createFight(env,msg.from.id,draft.own_mint,raw,chat);
  }
}
async function closeFight(env,id,status,pricesPair=null){
  const f=await detail(env,id);if(!f||f.status!=='active')return false;
  const [va,vb]=await stats(env,id),t=now();
  let score=null;
  if(status==='ended'&&pricesPair){score=calculateScore(va,vb,f.start_price_a,pricesPair[0],f.start_price_b,pricesPair[1]);if(!score)throw new Error('Invalid settlement price');}
  if(status==='ended'&&!score)throw new Error('Cannot settle without a valid score');
  // Atomic final snapshot and release of BOTH token locks. Rematches are now possible.
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE fights SET status=?,settled_at=?,archived_at=?,latest_price_a=COALESCE(?,latest_price_a),latest_price_b=COALESCE(?,latest_price_b),last_price_at=?,final_votes_a=?,final_votes_b=?,final_score_a=?,final_score_b=?,winner=? WHERE id=? AND status='active'`).bind(status,t,t,pricesPair?.[0]??null,pricesPair?.[1]??null,t,va,vb,score?.scoreA??null,score?.scoreB??null,score?.winner??null,id),
    env.DB.prepare(`DELETE FROM active_token_locks WHERE fight_id=? AND EXISTS(SELECT 1 FROM fights WHERE id=? AND status IN ('ended','unresolved'))`).bind(id,id)
  ]);
  if(!changed(result[0]))return false;
  await refreshMessages(env,id,true);
  return true;
}
async function tick(env){
  const t=now();
  // Expired links cannot hold open the same token-pair indefinitely.
  await env.DB.prepare(`UPDATE fights SET status='expired' WHERE status='pending' AND created_at<?`).bind(t-PENDING_TTL).run();
  // Due settlements run first. Claim next_settle_at to avoid overlapping cron executions.
  const due=await env.DB.prepare(`SELECT id,ends_at,mint_a,mint_b FROM fights WHERE status='active' AND ends_at<=? AND (next_settle_at IS NULL OR next_settle_at<=?) ORDER BY ends_at LIMIT 40`).bind(t,t).all();
  for(const f of due.results){
    try{
      const claim=await env.DB.prepare(`UPDATE fights SET next_settle_at=? WHERE id=? AND status='active' AND ends_at<=? AND (next_settle_at IS NULL OR next_settle_at<=?)`).bind(now()+45,f.id,now(),now()).run();
      if(!changed(claim))continue;
      if(now()-f.ends_at>180){await closeFight(env,f.id,'unresolved');continue;}
      const [a,b]=await prices(env,f.mint_a,f.mint_b);
      if(!a||!b)throw new Error('missing end price');
      await closeFight(env,f.id,'ended',[a,b]);
    }catch(e){console.error('settlement',f.id,errString(e));}
  }
  // Rotate through all eligible active fights in subsequent runs: no permanent LIMIT starvation.
  const active=await env.DB.prepare(`SELECT id,mint_a,mint_b FROM fights WHERE status='active' AND ends_at>? AND (next_refresh_at IS NULL OR next_refresh_at<=?) ORDER BY next_refresh_at LIMIT 40`).bind(now(),now()).all();
  for(const f of active.results){
    try{
      const claim=await env.DB.prepare(`UPDATE fights SET next_refresh_at=? WHERE id=? AND status='active' AND ends_at>? AND (next_refresh_at IS NULL OR next_refresh_at<=?)`).bind(now()+REFRESH_INTERVAL,f.id,now(),now()).run();
      if(!changed(claim))continue;
      const [a,b]=await prices(env,f.mint_a,f.mint_b);
      if(a&&b)await env.DB.prepare(`UPDATE fights SET latest_price_a=?,latest_price_b=?,last_price_at=? WHERE id=? AND status='active'`).bind(a,b,now(),f.id).run();
      await postFight(env,f.id); // Retry only groups that never received an initial post.
      await refreshMessages(env,f.id,false,true); // New post every 10 minutes (not only an edit).
      await sendMilestones(env,f.id);
    }catch(e){console.error('refresh',f.id,errString(e));}
  }
  // Retry unfinished final notifications if Telegram was temporarily unavailable.
  const pendingNotifications=await env.DB.prepare(`SELECT DISTINCT gm.fight_id FROM group_messages gm JOIN fights f ON f.id=gm.fight_id LEFT JOIN sent_events e ON e.fight_id=f.id AND e.chat_id=gm.chat_id AND e.event_type='end_'||f.status WHERE f.status IN ('ended','unresolved') AND (e.sent_at IS NULL OR e.sent_at<=0) ORDER BY f.archived_at DESC LIMIT 15`).all();
  for(const row of pendingNotifications.results)await refreshMessages(env,row.fight_id,true).catch(e=>console.error('retry final',row.fight_id,errString(e)));
  // After 30 days the votes are deleted. The archived aggregate remains correct.
  await env.DB.prepare(`DELETE FROM votes WHERE fight_id IN (SELECT id FROM fights WHERE status IN ('ended','unresolved','cancelled') AND archived_at<?)`).bind(now()-VOTE_RETENTION).run();
}
// Register the Telegram webhook from inside Cloudflare. Secrets never pass through a browser URL.
// The fingerprint makes registration idempotent and reconfigures Telegram if secrets change.
async function handleUpdateWithFeedback(env,update){
  try{
    await onUpdate(env,update);
  }catch(error){
    const errorId=crypto.randomUUID().slice(0,8);
    console.error('webhook update failure',errorId,errString(error));
    const chat=update?.callback_query?.message?.chat?.id ?? update?.message?.chat?.id;
    if(chat!=null){
      try{
        await say(env,chat,`⚠️ Something went wrong while processing your request. Please retry. If it persists, report error ${errorId}.`);
      }catch(replyError){
        console.error('webhook error response failed',errorId,errString(replyError));
      }
    }
  }
}

async function ensureTelegramWebhook(env){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET||!env.WEBHOOK_URL){
    throw new Error('Telegram setup: Cloudflare secrets or WEBHOOK_URL missing');
  }
  const target=new URL(env.WEBHOOK_URL);
  if(target.protocol!=='https:'||target.pathname!=='/telegram')throw new Error('Telegram setup: invalid webhook URL');
  const input=new TextEncoder().encode([target.toString(),env.TELEGRAM_BOT_TOKEN,env.TELEGRAM_WEBHOOK_SECRET].join('|'));
  const hash=await crypto.subtle.digest('SHA-256',input);
  const fingerprint=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  let existing=null;
  try{
    existing=await env.DB.prepare("SELECT value FROM worker_settings WHERE key='telegram_webhook'").first();
  }catch{
    // Existing v0.2 databases don't yet have the settings table.
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS worker_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
  }
  if(existing?.value===fingerprint)return;
  const successful=await telegram(env,'setWebhook',{
    url:target.toString(),
    secret_token:env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates:['message','callback_query'],
    drop_pending_updates:false
  });
  if(!successful)throw new Error('Telegram did not confirm webhook registration');
  await env.DB.prepare("INSERT INTO worker_settings(key,value,updated_at) VALUES('telegram_webhook',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(fingerprint,now()).run();
  console.log('ASTY Token Fight: Telegram webhook registered');
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/health'&&request.method==='GET')return Response.json({status:'ok',app:'ASTY Token Fight',version:'0.3.0'});
    if(url.pathname!=='/telegram'||request.method!=='POST')return new Response('Not Found',{status:404});
    if(!env.TELEGRAM_WEBHOOK_SECRET||request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Unauthorized',{status:401});
    let update;try{update=await request.json();}catch{return new Response('Bad JSON',{status:400});}
    ctx.waitUntil(handleUpdateWithFeedback(env,update));
    return new Response('OK');
  },
  async scheduled(_event,env,ctx){
    ctx.waitUntil((async()=>{
      await ensureTelegramWebhook(env).catch(e=>console.error('telegram webhook setup',errString(e)));
      await tick(env);
    })().catch(e=>console.error('cron',errString(e))));
  }
};
+String(s??'?').replace(/^\$+/,'');
const errString=e=>String(e?.message || e).slice(0,220);
const changed=r=>Number(r?.meta?.changes||0)>0;

async function telegram(env,method,body){
  const url=`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response=await fetch(url,{method:'POST',body:body instanceof FormData?body:JSON.stringify(body),headers:body instanceof FormData?{}:{'content-type':'application/json'},signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>null);
  if(!response.ok||!data?.ok)throw new Error(`Telegram ${method}: ${data?.description||response.status}`);
  return data.result;
}
const say=(env,chat,text,options={})=>telegram(env,'sendMessage',{chat_id:chat,text,parse_mode:'HTML',disable_web_page_preview:true,...options});
const keyboard=rows=>({inline_keyboard:rows});
async function tgAdmin(env,chat,user){
  try{const m=await telegram(env,'getChatMember',{chat_id:chat,user_id:Number(user)});return ['administrator','creator'].includes(m.status);}catch{return false;}
}
async function groupForAdmin(env,mint,user){
  const groups=await env.DB.prepare('SELECT * FROM project_groups WHERE mint=?').bind(mint).all();
  for(const g of groups.results)if(await tgAdmin(env,g.chat_id,user))return g;
  return null;
}
function botLink(env,fightId){return `https://t.me/${env.BOT_USERNAME.replace('@','')}?start=challenge_${fightId}`;}

async function tokenInfo(env,mint){
  const prev=await env.DB.prepare('SELECT * FROM projects WHERE mint=?').bind(mint).first();
  if(prev&&now()-prev.updated_at<DAY)return prev;
  const data=await birdeyeTokenInfo(env,mint);
  const p={...data,updated_at:now()};
  await env.DB.prepare(`INSERT INTO projects(mint,name,symbol,logo_url,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET name=excluded.name,symbol=excluded.symbol,logo_url=excluded.logo_url,updated_at=excluded.updated_at`).bind(p.mint,p.name,p.symbol,p.logo_url,p.updated_at).run();
  return p;
}
async function prices(env,a,b){
  return birdeyePairPrices(env,a,b);
}
async function stats(env,id){
  const r=await env.DB.prepare(`SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN side='a' THEN 1 ELSE 0 END),0) a FROM votes WHERE fight_id=?`).bind(id).first();
  return [Number(r?.a||0),Number(r?.n||0)-Number(r?.a||0)];
}
async function detail(env,id){
  return env.DB.prepare(`SELECT f.*,a.symbol sym_a,a.name name_a,a.logo_url logo_a,b.symbol sym_b,b.name name_b,b.logo_url logo_b FROM fights f JOIN projects a ON a.mint=f.mint_a JOIN projects b ON b.mint=f.mint_b WHERE f.id=?`).bind(id).first();
}
function publicStats(f,votesA,votesB){
  const closed=['ended','unresolved'].includes(f.status);
  return closed&&f.final_votes_a!==null&&f.final_votes_b!==null?[f.final_votes_a,f.final_votes_b]:[votesA,votesB];
}
function caption(f,votesA,votesB){
  const [va,vb]=publicStats(f,votesA,votesB);
  const ra=f.start_price_a&&f.latest_price_a?100*(f.latest_price_a/f.start_price_a-1):null;
  const rb=f.start_price_b&&f.latest_price_b?100*(f.latest_price_b/f.start_price_b-1):null;
  const computed=calculateScore(va,vb,f.start_price_a,f.latest_price_a,f.start_price_b,f.latest_price_b);
  const aScore=f.status==='ended'&&f.final_score_a!==null?f.final_score_a:computed?.scoreA;
  const bScore=f.status==='ended'&&f.final_score_b!==null?f.final_score_b:computed?.scoreB;
  const left=Math.max(0,(f.ends_at||now())-now()),time=`${Math.floor(left/3600)}h ${Math.floor((left%3600)/60)}m`;
  const statuses={pending:'⏳ CHALLENGE PENDING',active:'🥊 LIVE TOKEN FIGHT',ended:'🏆 FINISHED',unresolved:'⚠️ PRICE NOT AVAILABLE',declined:'❌ DECLINED',cancelled:'🚫 CANCELLED',expired:'⌛ EXPIRED'};
  const lines=[`<b>${statuses[f.status]||'TOKEN FIGHT'} #${html(f.id)}</b>`,`⚡ ${html(f.sym_a)} VS ${html(f.sym_b)}`,`🗳️ Votes: <b>${va}</b> · <b>${vb}</b>`,`📈 Price: ${ra===null?'n/a':pct(ra)} · ${rb===null?'n/a':pct(rb)}`];
  if(aScore!==undefined&&f.status!=='unresolved')lines.push(`🏆 Score: <b>${aScore.toFixed(1)}%</b> · <b>${bScore.toFixed(1)}%</b>`);
  if(f.status==='active')lines.push(`⏳ Remaining: ${time}`);
  if(f.status==='ended')lines.push(`🥇 ${f.winner==='draw'?'DRAW':f.winner==='a'?html(f.sym_a)+' WINS!':html(f.sym_b)+' WINS!'}`);
  if(f.status==='unresolved')lines.push('No winner declared. Manual price review required.');
  lines.push('🟣 <b>Powered by ASTY</b>');
  return lines.join('\n');
}
function votingButtons(f){return keyboard([[{text:`🗳️ ${f.sym_a}`,callback_data:`vote:${f.id}:a`},{text:`🗳️ ${f.sym_b}`,callback_data:`vote:${f.id}:b`}]]);}

async function postFight(env,id){
  const f=await detail(env,id);if(!f||f.status!=='active')return;
  // Only groups whose live post is missing need an image. Normal 10-minute refreshes never re-render.
  const groups=await env.DB.prepare(`SELECT DISTINCT pg.chat_id FROM project_groups pg WHERE pg.mint IN (?,?) AND NOT EXISTS (SELECT 1 FROM group_messages gm WHERE gm.fight_id=? AND gm.chat_id=pg.chat_id)`).bind(f.mint_a,f.mint_b,id).all();
  if(!groups.results.length)return;
  let img=null;
  try{img=await fightImage({symbol:f.sym_a,logo_url:f.logo_a},{symbol:f.sym_b,logo_url:f.logo_b});}catch(e){console.error('Battle graphic unavailable, using text fallback',errString(e));}
  for(const group of groups.results){
    const existing=await env.DB.prepare('SELECT live_message_id FROM group_messages WHERE fight_id=? AND chat_id=?').bind(id,group.chat_id).first();
    if(existing?.live_message_id)continue;
    try{
      let r,kind='photo';
      if(img){
        const form=new FormData();form.append('chat_id',group.chat_id);form.append('photo',new Blob([img],{type:'image/png'}),'ASTY-Fight.png');form.append('caption',caption(f,0,0));form.append('parse_mode','HTML');form.append('reply_markup',JSON.stringify(votingButtons(f)));
        try{r=await telegram(env,'sendPhoto',form);}catch(e){console.error('Photo upload failed; falling back to text',errString(e));}
      }
      if(!r){kind='text';r=await say(env,group.chat_id,caption(f,0,0),{reply_markup:votingButtons(f)});}
      await env.DB.prepare('INSERT OR IGNORE INTO group_messages(fight_id,chat_id,live_message_id,message_type) VALUES(?,?,?,?)').bind(id,group.chat_id,r.message_id,kind).run();
    }catch(e){console.error('postFight group',group.chat_id,errString(e));}
  }
}
// Durable at-least-once group message delivery. Negative sent_at is a 90-second lease.
// In the rare case Telegram accepts a message but the database write fails, it may retry once.
async function deliverEvent(env,id,chat,eventType,text){
  await env.DB.prepare('INSERT OR IGNORE INTO sent_events(fight_id,chat_id,event_type,sent_at) VALUES(?,?,?,0)').bind(id,chat,eventType).run();
  const lease=-now()-90;
  const r=await env.DB.prepare('UPDATE sent_events SET sent_at=? WHERE fight_id=? AND chat_id=? AND event_type=? AND (sent_at=0 OR (sent_at<0 AND sent_at>=?))').bind(lease,id,chat,eventType,-now()).run();
  if(!changed(r))return;
  try{
    await say(env,chat,text);
    await env.DB.prepare('UPDATE sent_events SET sent_at=? WHERE fight_id=? AND chat_id=? AND event_type=? AND sent_at=?').bind(now(),id,chat,eventType,lease).run();
  }catch(e){
    console.error('event delivery',id,eventType,errString(e));
    await env.DB.prepare('UPDATE sent_events SET sent_at=0 WHERE fight_id=? AND chat_id=? AND event_type=? AND sent_at=?').bind(id,chat,eventType,lease).run().catch(()=>{});
  }
}
// Every 10 minutes, post a NEW battle message with the current numbers.
// Telegram copyMessage reuses the already uploaded photo without rendering/reuploading it.
// Keep only the newest message ID in D1 so the next update copies the newest card.
async function refreshMessages(env,id,final=false,repost=false){
  const f=await detail(env,id);if(!f)return;
  const [va,vb]=await stats(env,id),msgs=await env.DB.prepare('SELECT * FROM group_messages WHERE fight_id=?').bind(id).all();
  const currentCaption=caption(f,va,vb);
  for(const m of msgs.results){
    if(repost&&f.status==='active'){
      try{
        let sent;
        if(m.message_type==='text'){
          sent=await say(env,m.chat_id,currentCaption,{reply_markup:votingButtons(f)});
        }else{
          sent=await telegram(env,'copyMessage',{
            chat_id:m.chat_id,from_chat_id:m.chat_id,message_id:m.live_message_id,
            caption:currentCaption,parse_mode:'HTML',reply_markup:votingButtons(f)
          });
        }
        if(!Number.isInteger(sent?.message_id))throw new Error('Telegram returned no copied message ID');
        await env.DB.prepare('UPDATE group_messages SET live_message_id=? WHERE fight_id=? AND chat_id=? AND live_message_id=?')
          .bind(sent.message_id,id,m.chat_id,m.live_message_id).run();
      }catch(e){
        console.error('repost',id,m.chat_id,errString(e));
        // Never lose live stats if Telegram rejects a repost; edit the previous post instead.
        try{
          await telegram(env,m.message_type==='text'?'editMessageText':'editMessageCaption',{
            chat_id:m.chat_id,message_id:m.live_message_id,
            [m.message_type==='text'?'text':'caption']:currentCaption,
            parse_mode:'HTML',reply_markup:votingButtons(f)
          });
        }catch(fallbackError){
          if(!errString(fallbackError).includes('message is not modified'))console.error('repost fallback',id,m.chat_id,errString(fallbackError));
        }
      }
      continue;
    }
    // The final result updates the latest posted card and adds one final notification.
    try{
      await telegram(env,m.message_type==='text'?'editMessageText':'editMessageCaption',{
        chat_id:m.chat_id,message_id:m.live_message_id,
        [m.message_type==='text'?'text':'caption']:currentCaption,
        parse_mode:'HTML',reply_markup:f.status==='active'?votingButtons(f):keyboard([])
      });
    }catch(e){if(!errString(e).includes('message is not modified'))console.error('edit',id,m.chat_id,errString(e));}
    if(final)await deliverEvent(env,id,m.chat_id,`end_${f.status}`,currentCaption).catch(e=>console.error('final event',id,m.chat_id,errString(e)));
  }
}
async function sendMilestones(env,id){
  const f=await detail(env,id);if(!f||f.status!=='active')return;
  const elapsed=now()-f.started_at;
  const milestone=elapsed>=23*3600?'23h':elapsed>=12*3600?'12h':elapsed>=6*3600?'6h':null;
  if(!milestone)return;
  // Milestones are sent only once per exact threshold; delayed checks do not flood older notices.
  const minTime={'6h':6*3600,'12h':12*3600,'23h':23*3600}[milestone];
  if(elapsed>minTime+2*REFRESH_INTERVAL)return;
  const msgs=await env.DB.prepare('SELECT * FROM group_messages WHERE fight_id=?').bind(id).all();
  for(const m of msgs.results){
    await deliverEvent(env,id,m.chat_id,`milestone_${milestone}`,`🥊 <b>ASTY TOKEN FIGHT</b> – ${html(f.sym_a)} VS ${html(f.sym_b)}\n${milestone==='23h'?'⏰ Only 1 hour left!':'⚡ Battle update'}\n\n🟣 Powered by ASTY`).catch(e=>console.error('milestone',id,errString(e)));
  }
}

async function createFight(env,user,a,b,chat){
  if(!mintOk(a)||!mintOk(b)||a===b)return say(env,chat,'Please provide two different valid Solana token mint addresses.');
  if(!(await groupForAdmin(env,a,user)))return say(env,chat,`First link your project group as an admin: <code>/link ${html(a)}</code>.`);
  const pending=await env.DB.prepare(`SELECT COUNT(*) n FROM fights WHERE creator_id=? AND status='pending'`).bind(String(user)).first();
  if(Number(pending?.n||0)>=3)return say(env,chat,'Maximal drei offene Herausforderungen gleichzeitig.');
  const busy=await env.DB.prepare(`SELECT COUNT(*) n FROM active_token_locks WHERE mint IN (?,?)`).bind(a,b).first();
  if(Number(busy?.n||0)>0)return say(env,chat,'Mindestens einer der Tokens kämpft bereits in einem aktiven Fight. Nach dessen Ende kannst du erneut herausfordern.');
  try{await tokenInfo(env,a);await pause(1200);await tokenInfo(env,b);}catch(e){return say(env,chat,`Token lookup failed: ${html(errString(e))}`);}
  const id=eid();
  try{await env.DB.prepare(`INSERT INTO fights(id,mint_a,mint_b,creator_id,status,created_at) VALUES(?,?,?,?,'pending',?)`).bind(id,a,b,String(user),now()).run();}
  catch(e){return say(env,chat,'Für dieses Token-Paar existiert bereits eine offene oder aktive Herausforderung. Wiederholung erst nach deren Abschluss möglich.');}
  await say(env,chat,`🥊 <b>Challenge created!</b>\nShare this link with your opponent:\n${botLink(env,id)}\n\nThe opponent must link their Telegram group and accept the challenge.`,{reply_markup:keyboard([[{text:'🔗 Share challenge',url:botLink(env,id)}]])});
  const opponents=await env.DB.prepare('SELECT DISTINCT registered_by FROM project_groups WHERE mint=?').bind(b).all();
  for(const x of opponents.results){try{await say(env,x.registered_by,`🥊 Neue Herausforderung für dein Projekt!\n${botLink(env,id)}`);}catch{}}
}
async function linkGroup(env,msg,arg){
  if(!['group','supergroup'].includes(msg.chat.type))return say(env,msg.chat.id,'Bitte direkt in deiner Telegram-Gruppe <code>/link TOKENADRESSE</code> verwenden.');
  if(!await tgAdmin(env,msg.chat.id,msg.from.id))return say(env,msg.chat.id,'Nur ein Gruppenadmin kann einen Token verknüpfen.');
  if(!mintOk(arg))return say(env,msg.chat.id,'Syntax: <code>/link SOLANA_TOKENADRESSE</code>');
  try{await tokenInfo(env,arg);}catch(e){return say(env,msg.chat.id,'Token nicht gefunden: '+html(errString(e)));}
  await env.DB.prepare(`INSERT INTO project_groups(mint,chat_id,chat_title,registered_by,registered_at) VALUES(?,?,?,?,?) ON CONFLICT(mint,chat_id) DO UPDATE SET chat_title=excluded.chat_title,registered_by=excluded.registered_by,registered_at=excluded.registered_at`).bind(arg,String(msg.chat.id),msg.chat.title||'',String(msg.from.id),now()).run();
  return say(env,msg.chat.id,`✅ Group linked to <code>${html(arg)}</code>. Ready for future battles.`);
}
async function unlinkGroup(env,msg,arg){
  if(!['group','supergroup'].includes(msg.chat.type)||!await tgAdmin(env,msg.chat.id,msg.from.id))return say(env,msg.chat.id,'Nur ein Gruppenadmin kann hier eine Gruppe trennen.');
  if(!mintOk(arg))return say(env,msg.chat.id,'Syntax: <code>/unlink TOKENADRESSE</code>');
  const r=await env.DB.prepare('DELETE FROM project_groups WHERE mint=? AND chat_id=?').bind(arg,String(msg.chat.id)).run();
  return say(env,msg.chat.id,changed(r)?'✅ Gruppenverknüpfung entfernt. Laufende Battle-Nachrichten bleiben bis zum Ende bestehen.':'Für diesen Token besteht hier keine Verknüpfung.');
}
async function challengeView(env,chat,id){
  const f=await detail(env,id);if(!f)return say(env,chat,'Herausforderung nicht gefunden.');
  if(f.status!=='pending')return say(env,chat,`Dieser Fight hat den Status ${html(f.status)}.`);
  return say(env,chat,`🥊 <b>NEW ASTY TOKEN FIGHT CHALLENGE</b>\n${html(f.sym_a)} fordert ${html(f.sym_b)} heraus!\n⏳ 24 Stunden · 50 % Voting · 50 % Preisentwicklung\n\nDu musst Admin einer mit ${html(f.sym_b)} verknüpften Gruppe sein.`,{reply_markup:keyboard([[{text:'✅ Herausforderung annehmen',callback_data:`accept:${f.id}`}],[{text:'❌ Ablehnen',callback_data:`decline:${f.id}`} ]])});
}
async function accept(env,query,id,decline=false){
  const uid=query.from.id,chat=query.message.chat.id;
  if(query.message.chat.type!=='private')return say(env,chat,'Bitte diese Anfrage im privaten Bot-Chat öffnen.');
  const f=await detail(env,id);if(!f||f.status!=='pending')return say(env,chat,'Diese Herausforderung ist nicht mehr offen.');
  if(!(await groupForAdmin(env,f.mint_b,uid)))return say(env,chat,`Du musst Admin einer verknüpften Gruppe für ${html(f.sym_b)} sein. Dort zuerst <code>/link ${html(f.mint_b)}</code> eingeben.`);
  if(decline){
    const r=await env.DB.prepare(`UPDATE fights SET status='declined' WHERE id=? AND status='pending'`).bind(id).run();
    return say(env,chat,changed(r)?'Herausforderung abgelehnt.':'Herausforderung wurde bereits bearbeitet.');
  }
  let p;
  try{p=await prices(env,f.mint_a,f.mint_b);}catch(e){return say(env,chat,'Der Start ist derzeit wegen der Preisquelle nicht möglich: '+html(errString(e)));}
  if(!p[0]||!p[1])return say(env,chat,'Für mindestens einen Token fehlt gerade ein Birdeye-Preis. Kein Fight gestartet.');
  const t=now();
  try{
    // D1 batch is transactional: either BOTH token locks + status change succeed or none.
    const batch=await env.DB.batch([
      env.DB.prepare(`INSERT INTO active_token_locks(mint,fight_id) SELECT mint_a,id FROM fights WHERE id=? AND status='pending'`).bind(id),
      env.DB.prepare(`INSERT INTO active_token_locks(mint,fight_id) SELECT mint_b,id FROM fights WHERE id=? AND status='pending'`).bind(id),
      env.DB.prepare(`UPDATE fights SET status='active',accepted_by=?,started_at=?,ends_at=?,start_price_a=?,start_price_b=?,latest_price_a=?,latest_price_b=?,last_price_at=?,next_refresh_at=? WHERE id=? AND status='pending'`).bind(String(uid),t,t+DAY,p[0],p[1],p[0],p[1],t,t+REFRESH_INTERVAL,id)
    ]);
    if(!changed(batch[2]))return say(env,chat,'Diese Herausforderung wurde bereits bearbeitet.');
  }catch(e){return say(env,chat,'Einer der beiden Tokens kämpft bereits in einem anderen aktiven Fight. Die Herausforderung bleibt offen und kann später erneut angenommen werden.');}
  await say(env,chat,'✅ Fight angenommen! 24-Stunden-Uhr läuft. Die Battle-Anzeige wird in beide Gruppen geschickt.');
  await say(env,f.creator_id,`🥊 ${html(f.sym_b)} hat angenommen! Fight #${f.id} ist LIVE.`).catch(()=>{});
  await postFight(env,id);
}
async function vote(env,q,id,side){
  const f=await detail(env,id);
  if(!f||f.status!=='active'||now()>=f.ends_at)return telegram(env,'answerCallbackQuery',{callback_query_id:q.id,text:'This fight is no longer active.',show_alert:true});
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO votes(fight_id,voter_id,side,voted_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM fights WHERE id=? AND status='active' AND ends_at>?)`).bind(id,String(q.from.id),side,now(),id,now()).run();
  const symbol=String(side==='a'?f.sym_a:f.sym_b).replace(/^[$]/,'').slice(0,50);
  return telegram(env,'answerCallbackQuery',{
    callback_query_id:q.id,
    text:changed(r)?`🔥 New vote for ${symbol} 🔥`:'You have already voted or this fight has ended.',
    show_alert:false
  });
}
async function statusText(env,id){
  const f=await detail(env,id);if(!f)return null;
  const [a,b]=await stats(env,id);return caption(f,a,b);
}
async function fightList(env,chat,history=false,mint=null){
  let sql=history?`SELECT id FROM fights WHERE status IN ('ended','unresolved')`:`SELECT id FROM fights WHERE status='active'`;
  const binds=[];
  if(mint){sql+=' AND (mint_a=? OR mint_b=?)';binds.push(mint,mint);}
  sql+=history?' ORDER BY archived_at DESC LIMIT 10':' ORDER BY ends_at ASC LIMIT 10';
  const list=await env.DB.prepare(sql).bind(...binds).all();
  if(!list.results.length)return say(env,chat,history?'Noch keine abgeschlossenen Fights gefunden.':'Derzeit keine aktiven Fights.');
  const lines=[history?'🏆 <b>ASTY Token Fight – Hall of Fame</b>':'🥊 <b>Aktive Fights</b>'];
  for(const row of list.results){const f=await detail(env,row.id);if(!f)continue;
    lines.push(`${html(f.sym_a)} VS ${html(f.sym_b)} · <code>${html(f.id)}</code>${history?(f.status==='ended'?` · Sieger: ${f.winner==='draw'?'Unentschieden':html(f.winner==='a'?f.sym_a:f.sym_b)}`:' · Ohne Wertung'):' · LIVE'}`);
  }
  lines.push('\n/status FIGHT_ID für Details · 🟣 Powered by ASTY');
  return say(env,chat,lines.join('\n'));
}
async function onUpdate(env,u){
  if(u.callback_query){
    const q=u.callback_query,parts=(q.data||'').split(':');
    if(parts[0]==='vote'&&['a','b'].includes(parts[2]))return vote(env,q,parts[1],parts[2]);
    await telegram(env,'answerCallbackQuery',{callback_query_id:q.id}).catch(()=>{});
    if(parts[0]==='accept'||parts[0]==='decline')return accept(env,q,parts[1],parts[0]==='decline');
    return;
  }
  const msg=u.message;if(!msg?.text||!msg.from)return;
  const chat=msg.chat.id,privateChat=msg.chat.type==='private';
  const [raw,...args]=msg.text.trim().split(/\s+/),cmd=raw.toLowerCase().split('@')[0];
  if(cmd==='/link')return linkGroup(env,msg,args[0]);
  if(cmd==='/unlink')return unlinkGroup(env,msg,args[0]);
  if(!privateChat)return;
  if(cmd==='/start'){
    if(args[0]?.startsWith('challenge_'))return challengeView(env,chat,args[0].slice(10));
    return say(env,chat,'🥊 <b>ASTY TOKEN FIGHT</b>\n\nZwei Projekte. 24 Stunden. 50 % Stimmen + 50 % Kursentwicklung.\n\n1. In der Projektgruppe als Admin <code>/link TOKENADRESSE</code> senden.\n2. Hier <code>/new</code> starten.\n3. Challenge-Link an den Gegner schicken.\n\n/fights zeigt laufende Duelle, /history die Hall of Fame.\n\n🟣 Powered by ASTY');
  }
  if(cmd==='/help')return say(env,chat,'Privat: <code>/new</code>, <code>/new EIGENER_MINT GEGNER_MINT</code>, <code>/fights</code>, <code>/history [MINT]</code>, <code>/status FIGHT_ID</code>, <code>/withdraw FIGHT_ID</code>, <code>/cancel</code>. Gruppe: <code>/link MINT</code>, <code>/unlink MINT</code>.');
  if(cmd==='/fights')return fightList(env,chat,false);
  if(cmd==='/history')return fightList(env,chat,true,mintOk(args[0])?args[0]:null);
  if(cmd==='/status'){
    if(!args[0])return say(env,chat,'Syntax: <code>/status FIGHT_ID</code>');
    const text=await statusText(env,args[0]);return say(env,chat,text||'Fight nicht gefunden.');
  }
  if(cmd==='/withdraw'){
    const f=args[0]?await detail(env,args[0]):null;
    if(!f||f.creator_id!==String(msg.from.id)||f.status!=='pending')return say(env,chat,'Nur der Ersteller kann seine noch offene Herausforderung zurückziehen.');
    const r=await env.DB.prepare(`UPDATE fights SET status='cancelled' WHERE id=? AND status='pending'`).bind(f.id).run();
    return say(env,chat,changed(r)?'✅ Herausforderung zurückgezogen. Ein neuer Fight ist jetzt möglich.':'Die Herausforderung wurde inzwischen bearbeitet.');
  }
  if(cmd==='/cancel'){await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();return say(env,chat,'Eingabe abgebrochen.');}
  if(cmd==='/new'){
    if(args.length>=2)return createFight(env,msg.from.id,args[0],args[1],chat);
    await env.DB.prepare(`INSERT INTO draft_state(user_id,step,own_mint,updated_at) VALUES(?,'own',NULL,?) ON CONFLICT(user_id) DO UPDATE SET step='own',own_mint=NULL,updated_at=excluded.updated_at`).bind(String(msg.from.id),now()).run();
    return say(env,chat,'Send your <b>project token mint address</b>. Use /cancel to stop.');
  }
  if(!raw.startsWith('/')){
    const draft=await env.DB.prepare('SELECT * FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).first();
    if(!draft||now()-draft.updated_at>1800){
      if(draft)await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();
      // Never silently ignore a submitted mint when a challenge draft has expired.
      if(mintOk(raw))return say(env,chat,'Your challenge setup has expired or is no longer active. Send /new to start again.');
      return;
    }
    if(!mintOk(raw))return say(env,chat,'Please send a valid Solana token address.');
    if(draft.step==='own'){
      await env.DB.prepare(`UPDATE draft_state SET step='opponent',own_mint=?,updated_at=? WHERE user_id=?`).bind(raw,now(),String(msg.from.id)).run();
      return say(env,chat,'Now send the <b>opponent token mint address</b>.');
    }
    await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();
    return createFight(env,msg.from.id,draft.own_mint,raw,chat);
  }
}
async function closeFight(env,id,status,pricesPair=null){
  const f=await detail(env,id);if(!f||f.status!=='active')return false;
  const [va,vb]=await stats(env,id),t=now();
  let score=null;
  if(status==='ended'&&pricesPair){score=calculateScore(va,vb,f.start_price_a,pricesPair[0],f.start_price_b,pricesPair[1]);if(!score)throw new Error('Invalid settlement price');}
  if(status==='ended'&&!score)throw new Error('Cannot settle without a valid score');
  // Atomic final snapshot and release of BOTH token locks. Rematches are now possible.
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE fights SET status=?,settled_at=?,archived_at=?,latest_price_a=COALESCE(?,latest_price_a),latest_price_b=COALESCE(?,latest_price_b),last_price_at=?,final_votes_a=?,final_votes_b=?,final_score_a=?,final_score_b=?,winner=? WHERE id=? AND status='active'`).bind(status,t,t,pricesPair?.[0]??null,pricesPair?.[1]??null,t,va,vb,score?.scoreA??null,score?.scoreB??null,score?.winner??null,id),
    env.DB.prepare(`DELETE FROM active_token_locks WHERE fight_id=? AND EXISTS(SELECT 1 FROM fights WHERE id=? AND status IN ('ended','unresolved'))`).bind(id,id)
  ]);
  if(!changed(result[0]))return false;
  await refreshMessages(env,id,true);
  return true;
}
async function tick(env){
  const t=now();
  // Expired links cannot hold open the same token-pair indefinitely.
  await env.DB.prepare(`UPDATE fights SET status='expired' WHERE status='pending' AND created_at<?`).bind(t-PENDING_TTL).run();
  // Due settlements run first. Claim next_settle_at to avoid overlapping cron executions.
  const due=await env.DB.prepare(`SELECT id,ends_at,mint_a,mint_b FROM fights WHERE status='active' AND ends_at<=? AND (next_settle_at IS NULL OR next_settle_at<=?) ORDER BY ends_at LIMIT 40`).bind(t,t).all();
  for(const f of due.results){
    try{
      const claim=await env.DB.prepare(`UPDATE fights SET next_settle_at=? WHERE id=? AND status='active' AND ends_at<=? AND (next_settle_at IS NULL OR next_settle_at<=?)`).bind(now()+45,f.id,now(),now()).run();
      if(!changed(claim))continue;
      if(now()-f.ends_at>180){await closeFight(env,f.id,'unresolved');continue;}
      const [a,b]=await prices(env,f.mint_a,f.mint_b);
      if(!a||!b)throw new Error('missing end price');
      await closeFight(env,f.id,'ended',[a,b]);
    }catch(e){console.error('settlement',f.id,errString(e));}
  }
  // Rotate through all eligible active fights in subsequent runs: no permanent LIMIT starvation.
  const active=await env.DB.prepare(`SELECT id,mint_a,mint_b FROM fights WHERE status='active' AND ends_at>? AND (next_refresh_at IS NULL OR next_refresh_at<=?) ORDER BY next_refresh_at LIMIT 40`).bind(now(),now()).all();
  for(const f of active.results){
    try{
      const claim=await env.DB.prepare(`UPDATE fights SET next_refresh_at=? WHERE id=? AND status='active' AND ends_at>? AND (next_refresh_at IS NULL OR next_refresh_at<=?)`).bind(now()+REFRESH_INTERVAL,f.id,now(),now()).run();
      if(!changed(claim))continue;
      const [a,b]=await prices(env,f.mint_a,f.mint_b);
      if(a&&b)await env.DB.prepare(`UPDATE fights SET latest_price_a=?,latest_price_b=?,last_price_at=? WHERE id=? AND status='active'`).bind(a,b,now(),f.id).run();
      await postFight(env,f.id); // Retry only groups that never received an initial post.
      await refreshMessages(env,f.id,false,true); // New post every 10 minutes (not only an edit).
      await sendMilestones(env,f.id);
    }catch(e){console.error('refresh',f.id,errString(e));}
  }
  // Retry unfinished final notifications if Telegram was temporarily unavailable.
  const pendingNotifications=await env.DB.prepare(`SELECT DISTINCT gm.fight_id FROM group_messages gm JOIN fights f ON f.id=gm.fight_id LEFT JOIN sent_events e ON e.fight_id=f.id AND e.chat_id=gm.chat_id AND e.event_type='end_'||f.status WHERE f.status IN ('ended','unresolved') AND (e.sent_at IS NULL OR e.sent_at<=0) ORDER BY f.archived_at DESC LIMIT 15`).all();
  for(const row of pendingNotifications.results)await refreshMessages(env,row.fight_id,true).catch(e=>console.error('retry final',row.fight_id,errString(e)));
  // After 30 days the votes are deleted. The archived aggregate remains correct.
  await env.DB.prepare(`DELETE FROM votes WHERE fight_id IN (SELECT id FROM fights WHERE status IN ('ended','unresolved') AND archived_at<?)`).bind(now()-VOTE_RETENTION).run();
}
// Register the Telegram webhook from inside Cloudflare. Secrets never pass through a browser URL.
// The fingerprint makes registration idempotent and reconfigures Telegram if secrets change.
async function handleUpdateWithFeedback(env,update){
  try{
    await onUpdate(env,update);
  }catch(error){
    const errorId=crypto.randomUUID().slice(0,8);
    console.error('webhook update failure',errorId,errString(error));
    const chat=update?.callback_query?.message?.chat?.id ?? update?.message?.chat?.id;
    if(chat!=null){
      try{
        await say(env,chat,`⚠️ Something went wrong while processing your request. Please retry. If it persists, report error ${errorId}.`);
      }catch(replyError){
        console.error('webhook error response failed',errorId,errString(replyError));
      }
    }
  }
}

async function ensureTelegramWebhook(env){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_WEBHOOK_SECRET||!env.WEBHOOK_URL){
    throw new Error('Telegram setup: Cloudflare secrets or WEBHOOK_URL missing');
  }
  const target=new URL(env.WEBHOOK_URL);
  if(target.protocol!=='https:'||target.pathname!=='/telegram')throw new Error('Telegram setup: invalid webhook URL');
  const input=new TextEncoder().encode([target.toString(),env.TELEGRAM_BOT_TOKEN,env.TELEGRAM_WEBHOOK_SECRET].join('|'));
  const hash=await crypto.subtle.digest('SHA-256',input);
  const fingerprint=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  let existing=null;
  try{
    existing=await env.DB.prepare("SELECT value FROM worker_settings WHERE key='telegram_webhook'").first();
  }catch{
    // Existing v0.2 databases don't yet have the settings table.
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS worker_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)").run();
  }
  if(existing?.value===fingerprint)return;
  const successful=await telegram(env,'setWebhook',{
    url:target.toString(),
    secret_token:env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates:['message','callback_query'],
    drop_pending_updates:false
  });
  if(!successful)throw new Error('Telegram did not confirm webhook registration');
  await env.DB.prepare("INSERT INTO worker_settings(key,value,updated_at) VALUES('telegram_webhook',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(fingerprint,now()).run();
  console.log('ASTY Token Fight: Telegram webhook registered');
}

export default {
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(url.pathname==='/health'&&request.method==='GET')return Response.json({status:'ok',app:'ASTY Token Fight',version:'0.2.5'});
    if(url.pathname!=='/telegram'||request.method!=='POST')return new Response('Not Found',{status:404});
    if(!env.TELEGRAM_WEBHOOK_SECRET||request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Unauthorized',{status:401});
    let update;try{update=await request.json();}catch{return new Response('Bad JSON',{status:400});}
    ctx.waitUntil(handleUpdateWithFeedback(env,update));
    return new Response('OK');
  },
  async scheduled(_event,env,ctx){
    ctx.waitUntil((async()=>{
      await ensureTelegramWebhook(env).catch(e=>console.error('telegram webhook setup',errString(e)));
      await tick(env);
    })().catch(e=>console.error('cron',errString(e))));
  }
};
