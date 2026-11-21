import { calculateScore } from './scoring.mjs';
import { fightImage } from './card.js';
import { birdeyeTokenInfo, birdeyePairPrices, pause } from './birdeye.mjs';
import { normalizeProjectWebsite, projectWebsiteDisplay } from './website.mjs';
import { countdownThreshold } from './countdown.mjs';
import { ensureLogoTable, cachedLogo, ensureTokenLogo, saveUploadedLogo, telegramUploadedBytes } from './logo-cache.mjs';

const DAY=86400;
const PENDING_TTL=7*DAY;
const VOTE_RETENTION=30*DAY;
const REFRESH_INTERVAL=1800;
const now=()=>Math.floor(Date.now()/1000);
const mintOk=s=>typeof s==='string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const eid=()=>crypto.randomUUID().replaceAll('-','').slice(0,14);
const html=s=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=n=>`${n>=0?'+':''}${n.toFixed(2)}%`;
const tokenLabel=s=>'$'+String(s??'?').replace(/^\$+/,'');
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
  return env.DB.prepare(`SELECT f.*,a.symbol sym_a,a.name name_a,a.logo_url logo_a,b.symbol sym_b,b.name name_b,b.logo_url logo_b,wa.website_url website_a,wb.website_url website_b FROM fights f JOIN projects a ON a.mint=f.mint_a JOIN projects b ON b.mint=f.mint_b LEFT JOIN project_websites wa ON wa.mint=f.mint_a LEFT JOIN project_websites wb ON wb.mint=f.mint_b WHERE f.id=?`).bind(id).first();
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
  const header=`<b>🥊 ${statuses[f.status]||'TOKEN FIGHT'}</b>\nID: ${html(f.id)}`;
  const lines=[header,'',`⚡ ${html(tokenLabel(f.sym_a))} VS ${html(tokenLabel(f.sym_b))} ⚡`,'',
    `🗳️ Votes: <b>${va}</b> · <b>${vb}</b>`,
    `📈 Price change: ${ra===null?'n/a':pct(ra)} · ${rb===null?'n/a':pct(rb)}`];
  if(aScore!==undefined&&['active','ended'].includes(f.status))lines.push(`🏆 Score: <b>${aScore.toFixed(1)}%</b> · <b>${bScore.toFixed(1)}%</b>`);
  if(f.status==='active')lines.push(`⏳ Remaining: ${time}`);
  if(f.status==='ended')lines.push(`🥇 ${f.winner==='draw'?'DRAW':html(tokenLabel(f.winner==='a'?f.sym_a:f.sym_b))+' WINS!'}`);
  if(f.status==='unresolved')lines.push('No winner declared. Manual price review required.');
  if(f.status==='active')lines.push('','<i>...Stats update every 30 minutes...</i>');
  lines.push('','<b>Powered by ASTY <a href="https://arbstrategy.net/">ArbStrategy.net</a></b>');
  return lines.join('\n');
}
function votingButtons(f){const rows=[[{text:`🗳️ ${tokenLabel(f.sym_a)}`,callback_data:`vote:${f.id}:a`},{text:`🗳️ ${tokenLabel(f.sym_b)}`,callback_data:`vote:${f.id}:b`}]]; return keyboard([...rows,...siteButtons(f).inline_keyboard]);}
async function postFight(env,id){
  const f=await detail(env,id);if(!f||f.status!=='active')return new Set();
  const groups=await env.DB.prepare(`SELECT DISTINCT pg.chat_id FROM project_groups pg WHERE pg.mint IN (?,?) AND NOT EXISTS (SELECT 1 FROM group_messages gm WHERE gm.fight_id=? AND gm.chat_id=pg.chat_id)`).bind(f.mint_a,f.mint_b,id).all();
  if(!groups.results?.length)return new Set();
  const videoId=await getFightVideo(env);
  if(!videoId){console.error('postFight: no reusable video configured',id);return new Set();}
  const [a,b]=await stats(env,id);
  const posted=new Set();
  for(const group of groups.results){
    try{
      const sent=await telegram(env,'sendVideo',{
        chat_id:group.chat_id,video:videoId,caption:caption(f,a,b),
        parse_mode:'HTML',reply_markup:votingButtons(await websiteViewForChat(env,f,group.chat_id)),supports_streaming:true
      });
      if(!Number.isInteger(sent?.message_id))throw new Error('Telegram sendVideo returned no message ID');
      const record=await env.DB.prepare(`INSERT OR IGNORE INTO group_messages(fight_id,chat_id,live_message_id,message_type) VALUES(?,?,?,'video')`)
        .bind(id,group.chat_id,sent.message_id).run();
      if(changed(record))posted.add(String(group.chat_id));
    }catch(e){console.error('postFight video',id,group.chat_id,errString(e));}
  }
  return posted;
}
// Durable at-least-once group message delivery. Negative sent_at is a 90-second lease.
// In the rare case Telegram accepts a message but the database write fails, it may retry once.
async function deliverEvent(env,id,chat,eventType,text,reply_markup=null){
  await env.DB.prepare('INSERT OR IGNORE INTO sent_events(fight_id,chat_id,event_type,sent_at) VALUES(?,?,?,0)').bind(id,chat,eventType).run();
  const lease=-now()-90;
  const r=await env.DB.prepare('UPDATE sent_events SET sent_at=? WHERE fight_id=? AND chat_id=? AND event_type=? AND (sent_at=0 OR (sent_at<0 AND sent_at>=?))').bind(lease,id,chat,eventType,-now()).run();
  if(!changed(r))return;
  try{
    await say(env,chat,text,reply_markup?.inline_keyboard?.length?{reply_markup}:{});
    await env.DB.prepare('UPDATE sent_events SET sent_at=? WHERE fight_id=? AND chat_id=? AND event_type=? AND sent_at=?').bind(now(),id,chat,eventType,lease).run();
  }catch(e){
    console.error('event delivery',id,eventType,errString(e));
    await env.DB.prepare('UPDATE sent_events SET sent_at=0 WHERE fight_id=? AND chat_id=? AND event_type=? AND sent_at=?').bind(id,chat,eventType,lease).run().catch(()=>{});
  }
}
// Every 30 minutes, post a NEW battle message with the current numbers.
// Telegram copyMessage reuses the already uploaded photo without rendering/reuploading it.
// Keep only the newest message ID in D1 so the next update copies the newest card.
async function refreshMessages(env,id,final=false,repost=false,skipChats=null){
  const f=await detail(env,id);
  if(!f)return {targets:0,sent:0,failed:0};
  const [va,vb]=await stats(env,id);
  const msgs=await env.DB.prepare('SELECT * FROM group_messages WHERE fight_id=?').bind(id).all();
  const currentCaption=caption(f,va,vb),summary={targets:0,sent:0,failed:0};
  const videoId=repost&&f.status==='active'?await getFightVideo(env):null;
  for(const m of msgs.results||[]){
    if(skipChats?.has(String(m.chat_id)))continue;
    const chatView=await websiteViewForChat(env,f,m.chat_id);
    summary.targets++;
    if(repost&&f.status==='active'){
      try{
        let sent,kind=m.message_type;
        if(videoId){
          // The SAME permanent video file_id is reusable for every fight and every update.
          sent=await telegram(env,'sendVideo',{
            chat_id:m.chat_id,video:videoId,caption:currentCaption,parse_mode:'HTML',
            reply_markup:votingButtons(chatView),supports_streaming:true
          });
          kind='video';
        }else if(m.message_type==='text'){
          sent=await say(env,m.chat_id,currentCaption,{reply_markup:votingButtons(chatView)});
        }else{
          // Existing fights can still be reposted before the first video is configured.
          sent=await telegram(env,'copyMessage',{
            chat_id:m.chat_id,from_chat_id:m.chat_id,message_id:m.live_message_id,
            caption:currentCaption,parse_mode:'HTML',reply_markup:votingButtons(chatView)
          });
        }
        if(!Number.isInteger(sent?.message_id))throw new Error('Telegram returned no new post ID');
        const updated=await env.DB.prepare('UPDATE group_messages SET live_message_id=?,message_type=? WHERE fight_id=? AND chat_id=? AND live_message_id=?')
          .bind(sent.message_id,kind,id,m.chat_id,m.live_message_id).run();
        if(!changed(updated))throw new Error('New group message could not be saved');
        summary.sent++;
      }catch(e){
        summary.failed++;
        console.error('repost failed',id,m.chat_id,errString(e));
        // Keep current visible stats readable, but retry a NEW post at the next cron run.
        try{
          await telegram(env,m.message_type==='text'?'editMessageText':'editMessageCaption',{
            chat_id:m.chat_id,message_id:m.live_message_id,
            [m.message_type==='text'?'text':'caption']:currentCaption,
            parse_mode:'HTML',reply_markup:votingButtons(chatView)
          });
        }catch(editError){
          if(!errString(editError).includes('message is not modified'))console.error('repost fallback',id,m.chat_id,errString(editError));
        }
      }
      continue;
    }
    try{
      await telegram(env,m.message_type==='text'?'editMessageText':'editMessageCaption',{
        chat_id:m.chat_id,message_id:m.live_message_id,
        [m.message_type==='text'?'text':'caption']:currentCaption,parse_mode:'HTML',
        reply_markup:f.status==='active'?votingButtons(chatView):siteButtons(chatView)
      });
    }catch(e){if(!errString(e).includes('message is not modified'))console.error('edit',id,m.chat_id,errString(e));}
    if(final)await deliverEvent(env,id,m.chat_id,`end_${f.status}`,currentCaption,siteButtons(chatView))
      .catch(e=>console.error('final event',id,m.chat_id,errString(e)));
  }
  return summary;
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
    const chatView=await websiteViewForChat(env,f,m.chat_id);
    await deliverEvent(env,id,m.chat_id,`milestone_${milestone}`,`🥊 <b>ASTY TOKEN FIGHT</b> – ${html(tokenLabel(f.sym_a))} VS ${html(tokenLabel(f.sym_b))}\n${milestone==='23h'?'⏰ Only 1 hour left!':'⚡ Battle update'}\n\n<b>Powered by ASTY <a href="https://arbstrategy.net/">ArbStrategy.net</a></b>`,siteButtons(chatView)).catch(e=>console.error('milestone',id,errString(e)));
  }
}

async function sendFinalCountdownReminders(env){
  // Run on EVERY one-minute cron tick, independent of the normal 30-minute posts
  // and independent of price APIs. Only one reminder for each countdown threshold.
  const t=now();
  const soon=await env.DB.prepare("SELECT id FROM fights WHERE status='active' AND ends_at>? AND ends_at<=? ORDER BY ends_at LIMIT 60")
    .bind(t,t+15*60).all();
  for(const item of soon.results||[]){
    try{
      const f=await detail(env,item.id);
      if(!f||f.status!=='active')continue;
      const left=f.ends_at-now();
      if(left<=0||left>15*60)continue;
      const minutes=countdownThreshold(left);
      if(minutes===null)continue;
      const [va,vb]=await stats(env,f.id);
      const result=calculateScore(va,vb,f.start_price_a,f.latest_price_a,f.start_price_b,f.latest_price_b);
      const line=result?`🏆 Score: <b>${result.scoreA.toFixed(1)}%</b> · <b>${result.scoreB.toFixed(1)}%</b>`:'🏆 Score: n/a';
      const text=[
        `⏰ <b>${minutes} MINUTES LEFT!</b>`,'',
        `⚡ ${html(tokenLabel(f.sym_a))} VS ${html(tokenLabel(f.sym_b))} ⚡`,'',
        `🗳️ Votes: <b>${va}</b> · <b>${vb}</b>`,
        line,'','🔥 Vote before the fight ends!','',
        '<b>Powered by ASTY <a href="https://arbstrategy.net/">ArbStrategy.net</a></b>'
      ].join('\n');
      const posts=await env.DB.prepare('SELECT chat_id FROM group_messages WHERE fight_id=?').bind(f.id).all();
      await Promise.all((posts.results||[]).map(async post=>deliverEvent(env,f.id,post.chat_id,
        `countdown_${minutes}m`,text,votingButtons(await websiteViewForChat(env,f,post.chat_id))).catch(e=>console.error('countdown reminder',f.id,minutes,post.chat_id,errString(e)))));
    }catch(e){console.error('countdown scan',item.id,errString(e));}
  }
}

function compactGroupChat(chatId){return BigInt(String(chatId)).toString(36);}

function restoreGroupChat(encoded){
  if(typeof encoded!=='string'||!/^-?[0-9a-z]{1,13}$/.test(encoded))return null;
  const negative=encoded.startsWith('-'),digits=negative?encoded.slice(1):encoded;
  let number=0n;
  for(const character of digits)number=number*36n+BigInt(parseInt(character,36));
  const value=(negative?-number:number).toString();
  return /^-\d{4,20}$/.test(value)?value:null;
}

async function groupAdminForWebsite(env,mint,groupId,user){
  if(!mintOk(mint)||!/^-\d{4,20}$/.test(String(groupId)))return null;
  const group=await env.DB.prepare('SELECT chat_id,chat_title FROM project_groups WHERE mint=? AND chat_id=?')
    .bind(mint,String(groupId)).first();
  if(!group||!(await tgAdmin(env,group.chat_id,user)))return null;
  return group;
}

async function websiteViewForChat(env,f,chatId){
  const rows=await env.DB.prepare(`SELECT gw.mint,gw.website_url FROM group_websites gw
    JOIN project_groups pg ON pg.chat_id=gw.chat_id AND pg.mint=gw.mint
    WHERE gw.chat_id=? AND gw.mint IN (?,?)`)
    .bind(String(chatId),f.mint_a,f.mint_b).all();
  const override={...f};
  for(const r of rows.results||[]){
    if(r.mint===f.mint_a)override.website_a=r.website_url;
    if(r.mint===f.mint_b)override.website_b=r.website_url;
  }
  return override;
}

function siteButtons(f){
  const rows=[];
  if(f?.website_a)rows.push([{text:`🌐 ${tokenLabel(f.sym_a)} Website`,url:f.website_a}]);
  if(f?.website_b)rows.push([{text:`🌐 ${tokenLabel(f.sym_b)} Website`,url:f.website_b}]);
  return keyboard(rows);
}

function websiteOptions(f){const links=siteButtons(f);return links.inline_keyboard.length?{reply_markup:links}:{};}


function menuButtons(){
  return keyboard([
    [{text:'🥊 New Fight',callback_data:'menu:new'},{text:'🪙 My Projects',callback_data:'menu:projects'}],
    [{text:'⚡ Active Fights',callback_data:'menu:active'},{text:'🏆 Hall of Fame',callback_data:'menu:history'}],
    [{text:'🌐 Project Websites',callback_data:'menu:sites'},{text:'❓ Help',callback_data:'menu:help'}]
  ]);
}

function groupButtons(env){
  return keyboard([
    [{text:'🔗 Link Project Token',callback_data:'group:link'}],
    [{text:'🔓 Unlink Project Token',callback_data:'group:unlink'}],
    [{text:'🌐 Manage Project Website',callback_data:'group:sites'}],
    [{text:'❓ Help',callback_data:'menu:help'}],
    [{text:'🥊 Open Fight Bot',url:`https://t.me/${env.BOT_USERNAME.replace('@','')}`}]
  ]);
}

async function screen(env,chat,text,reply_markup,q=null) {
  if(q?.message?.message_id) {
    try{
      return await telegram(env,'editMessageText',{chat_id:chat,message_id:q.message.message_id,text,parse_mode:'HTML',disable_web_page_preview:true,reply_markup});
    }catch(e){ if(!errString(e).includes('message is not modified'))console.log('menu edit fallback',errString(e));}
  }
  return say(env,chat,text,{reply_markup});
}

async function menuHome(env,chat,q=null){
  return screen(env,chat,'🥊 <b>ASTY TOKEN FIGHT</b>\n\nTwo Solana projects. One 24-hour battle.\n50% community votes + 50% price change.\n\nSelect an option to get started.\n\n<b>Powered by ASTY <a href="https://arbstrategy.net/">ArbStrategy.net</a></b>',menuButtons(),q);
}

async function groupHome(env,chat,q=null){
  return screen(env,chat,'🥊 <b>ASTY TOKEN FIGHT</b>\n\nConnect this Telegram group to its Solana token. Group administrators can link a token and promote its website.\n\nUse the button below to get started.',groupButtons(env),q);
}

function helpKeyboard(isGroup=false){
  const rows=[
    [{text:'🥊 How It Works',callback_data:'help:setup'},{text:'⚖️ Scoring Rules',callback_data:'help:rules'}],
    [{text:'🏆 Fight Results',callback_data:'help:ending'},{text:'📋 Commands',callback_data:'help:commands'}],
    [{text:'🔐 Bot Permissions',callback_data:'help:permissions'}],
    [{text:'🏠 Back to Menu',callback_data:isGroup?'menu:group':'menu:home'}]
  ];
  return keyboard(rows);
}
async function helpScreen(env,chat,q=null,isGroup=false){
  const help=[
    '❓ <b>ASTY TOKEN FIGHT — HELP</b>',
    '',
    '🥊 <b>24-hour Solana token battles</b>',
    'One Telegram account = one vote per fight, even across both groups.',
    '',
    '⚖️ <b>FINAL SCORE</b>',
    '50% community votes + 50% price performance.',
    'In the price category, every 0.1 percentage-point lead in 24h token return earns 1 point (maximum 100).',
    '',
    '⏱️ Live stats are posted every 30 minutes. Both groups get extra reminders 15, 10 and 5 minutes before the fight ends.',
    '',
    '🏆 At the end, both groups receive a winner announcement, and the result appears in the Hall of Fame.',
    '',
    'Project websites appear as optional buttons below battle posts.',
    '',
    '🔐 <b>GROUP PERMISSIONS</b>',
    'For reliable group-admin verification, make the bot an administrator in both project groups and allow it to post text messages and videos.',
    '',
    'Select a topic below to see the details.'
  ];
  return screen(env,chat,help.join('\n'),helpKeyboard(isGroup),q);
}
async function helpSection(env,chat,section,q=null,isGroup=false){
  let lines;
  switch(section){
    case 'permissions':
      lines=[
        '🔐 <b>BOT PERMISSIONS & SETUP</b>',
        '',
        'For reliable operation, add @ASTY_TokenFightBot to BOTH participating project groups and promote it to group administrator.',
        '',
        '<b>Why admin?</b>',
        'The bot checks whether the people linking tokens and accepting challenges are group admins. Telegram only guarantees the required getChatMember checks when the bot is a chat administrator.',
        '',
        '<b>What it must be allowed to do</b>',
        '• Send text messages (votes, updates and winner announcements).',
        '• Send videos (new battle posts every 30 minutes).',
        '• Edit its own battle messages to show the final result.',
        '',
        '<b>Not needed</b>',
        'Deleting messages, pinning posts, banning/restricting members, adding admins or changing group information.',
        '',
        '<b>Project setup</b>',
        'A human group administrator must link the project token using /link MINT or the group menu. The bot does not need permission to pin the posts.',
        '',
        'If the bot is only a regular member and can post messages and videos, basic battle posts may still work, but group-admin verification may fail.',
        '',
        'Check this setup in BOTH groups before starting a challenge.'
      ];break;
    case 'setup':
      lines=[
        '🥊 <b>HOW ASTY TOKEN FIGHT WORKS</b>',
        '',
        '1. Add the bot to both project groups. For reliable admin checks, promote it to administrator and allow text/video posts. A group admin then links its token once.',
        '2. A project admin may add the official website. Websites are shown as buttons.',
        '3. In the private bot chat, select New Fight → your registered project → an opponent.',
        '4. The opposing project admin accepts the challenge.',
        '5. A 24-hour fight starts in both groups.',
        '6. Vote using the buttons. Each Telegram account has one vote per fight, no matter which group.',
        '7. A new message with the current votes, price change, scores and countdown is posted approximately every 30 minutes. Every successful new vote also triggers a short group message.',
        '8. Both groups receive extra reminders with voting buttons at 15, 10 and 5 minutes remaining.',
        '9. When 24 hours end, both groups get a winner or draw notification.'
      ];break;
    case 'rules':
      lines=[
        '⚖️ <b>SCORING RULES</b>',
        '',
        '<b>50% Community Votes</b>',
        'Vote score = each token’s share of all valid Telegram votes. Without votes, it is 50:50.',
        '',
        '<b>50% Price Performance</b>',
        'Compare the two tokens’ percentage price changes over the same 24-hour fight. Absolute token price and trading volume do not determine this score.',
        'For every <b>0.1 percentage-point</b> advantage in price change, a token earns <b>1 price-category point</b>.',
        'Price points for token A = 50 + 10 × (A price change − B price change). These points are limited to 0–100. Token B receives the rest.',
        '',
        '<b>Final score = (vote percentage + price points) ÷ 2.</b>',
        '',
        '<b>Example</b>',
        '$ASTY: 30 votes, +5.00% price change.',
        '$ARBX: 20 votes, +3.00% price change.',
        'Votes: 60–40. Price points: 70–30.',
        '🏆 Final score: <b>$ASTY 65.0% · $ARBX 35.0%</b>.',
        '',
        'A difference of 5 percentage points already reaches the 100-point cap in the price category.'
      ];break;
    case 'ending':
      lines=[
        '🏆 <b>WHEN THE FIGHT ENDS</b>',
        '',
        'Before the end, both groups receive separate reminders at 15, 10 and 5 minutes remaining, each with voting buttons.',
        '',
        'After 24 hours, the bot checks the final votes and both token prices.',
        'The final 50:50 score determines the winner. Exactly equal final scores result in a draw.',
        '',
        '📣 Both groups receive a <b>new text result announcement</b> showing the votes, price change, final score and winning token.',
        'The latest battle message is updated and voting closes. The result is saved in the Hall of Fame. Both tokens are released for rematches.',
        '',
        'If valid final prices cannot be retrieved, the bot retries briefly (up to about 3 minutes). If the data is still missing, the fight closes without a declared winner rather than inventing a result.',
        '',
        'A fight stopped early by its creator does not receive a winner.'
      ];break;
    case 'commands':
      lines=[
        '📋 <b>COMMANDS</b>',
        '',
        '<b>Private bot chat</b>',
        '<code>/start</code> or <code>/menu</code> — Open button menu',
        '<code>/new</code> — New challenge',
        '<code>/projects</code> — Manage registered projects',
        '<code>/website</code> — Add/change project website',
        '<code>/fights</code> — Active fights',
        '<code>/history</code> — Hall of Fame',
        '<code>/status ID</code> — Fight details',
        '<code>/refresh ID</code> — Repost live stats (creator only)',
        '<code>/withdraw ID</code> — Withdraw pending challenge',
        '<code>/stop ID</code> — Stop active fight (creator only)',
        '<code>/cancel</code> — Cancel current input',
        '<code>/help</code> — Help & rules',
        '',
        '🔐 <b>Permissions:</b> Promote the bot to administrator in both groups for reliable admin verification. Allow text and video posts.',
        '',
        '<b>Inside project groups</b>',
        '<code>/start</code> — Group menu',
        '<code>/link MINT</code> — Link token (admins)',
        '<code>/unlink MINT</code> — Unlink token (admins)',
        '<code>/help</code> — Help & rules',
        '',
        'All main actions can also be opened using buttons. A new mint address or website only has to be pasted when first configured.'
      ];break;
    default:return helpScreen(env,chat,q,isGroup);
  }
  return screen(env,chat,lines.join('\n'),
    keyboard([[{text:'↩️ Help Topics',callback_data:'menu:help'}],[{text:'🏠 Main Menu',callback_data:isGroup?'menu:group':'menu:home'}]]),q);
}

async function adminProjects(env,user) {
  // Do not restrict the project list to the account which originally linked a group.
  // Other current admins of that group are also entitled to manage its project.
  const groups=await env.DB.prepare(`SELECT pg.chat_id,pg.mint,pg.chat_title,p.symbol
    FROM project_groups pg JOIN projects p ON p.mint=pg.mint
    ORDER BY CASE WHEN pg.registered_by=? THEN 0 ELSE 1 END,pg.registered_at DESC LIMIT 100`)
    .bind(String(user)).all();
  const found=[],seen=new Set(),candidates=groups.results||[];
  // Limit simultaneous Telegram calls and stop once enough visible projects are found.
  for(let i=0;i<candidates.length&&found.length<18;i+=8){
    const batch=candidates.slice(i,i+8);
    const checks=await Promise.all(batch.map(async g=>await tgAdmin(env,g.chat_id,user)));
    for(let j=0;j<batch.length;j++){
      const group=batch[j];
      if(checks[j]&&!seen.has(group.mint)){seen.add(group.mint);found.push(group);}
    }
  }
  return found.slice(0,18);
}

async function projectsScreen(env,chat,user,q=null,forSite=false){
  const items=await adminProjects(env,user);
  if(!items.length&&!forSite)return screen(env,chat,'🪙 <b>MY PROJECTS</b>\n\nNo linked project groups found where you are an administrator.\n\nAdd this bot to a Telegram group and use the group’s /start menu to link its Solana token.',keyboard([[{text:'➕ Add Bot to Group',url:`https://t.me/${env.BOT_USERNAME.replace('@','')}?startgroup=true`}],[{text:'🏠 Main Menu',callback_data:'menu:home'}]]),q);
  const rows=[];
  const seen=new Set();
  for(const p of items){
    seen.add(p.mint);
    rows.push([{text:`${forSite?'🌐':'🪙'} ${tokenLabel(p.symbol)}`,callback_data:`${forSite?'site:open:':'project:view:'}${p.mint}`}]);
  }
  if(forSite){
    // Make opponents from the user's fights visible, but do NOT grant edit permissions.
    // A non-admin sees a read-only explanation rather than a missing ARBX project.
    const other=await env.DB.prepare(`SELECT DISTINCT p.mint,p.symbol FROM projects p
      WHERE p.mint IN (
        SELECT mint_a FROM fights WHERE creator_id=? OR accepted_by=?
        UNION SELECT mint_b FROM fights WHERE creator_id=? OR accepted_by=?
      ) LIMIT 30`).bind(String(user),String(user),String(user),String(user)).all();
    for(const p of other.results||[]){
      if(seen.has(p.mint))continue;
      seen.add(p.mint);
      rows.push([{text:`🔒 ${tokenLabel(p.symbol)} (admin required)`,callback_data:`site:open:${p.mint}`}]);
    }
  }
  rows.push([{text:forSite?'🥊 New Fight':'🌐 Manage Websites',callback_data:forSite?'menu:new':'menu:sites'}]);
  rows.push([{text:'🏠 Main Menu',callback_data:'menu:home'}]);
  return screen(env,chat,forSite?'🌐 <b>PROJECT WEBSITES</b>\n\nChoose a project. Group admins can manage their own websites; only original-group admins can change the official link.':'🪙 <b>MY PROJECTS</b>\n\nSelect a project to view its website or start a challenge.',keyboard(rows),q);
}

async function projectScreen(env,chat,user,mint,q=null){
  if(!mintOk(mint)||!(await groupForAdmin(env,mint,user)))return screen(env,chat,'This project is not linked to a group you currently administer.',keyboard([[{text:'🪙 My Projects',callback_data:'menu:projects'}]]),q);
  const p=await env.DB.prepare(`SELECT p.*,w.website_url FROM projects p LEFT JOIN project_websites w ON w.mint=p.mint WHERE p.mint=?`).bind(mint).first();
  if(!p)return say(env,chat,'Project not found.');
  const web=p.website_url ? `🌐 Website: <a href="${html(p.website_url)}">${html(projectWebsiteDisplay(p.website_url))}</a>`:'🌐 Website: Not set';
  const rows=[
    [{text:`🥊 Challenge as ${tokenLabel(p.symbol)}`,callback_data:`new:own:${mint}`}],
  ];
  const websiteAdmin=await canManageWebsite(env,mint,user);
  rows.push([{text:'🌐 Manage Websites',callback_data:`site:info:${mint}`}]);
  if(p.website_url&&websiteAdmin)rows.push([{text:'🗑 Remove Website',callback_data:`site:remove:${mint}`}]);
  if(p.website_url)rows.push([{text:`🌐 Visit ${tokenLabel(p.symbol)}`,url:p.website_url}]);
  rows.push([{text:'🪙 My Projects',callback_data:'menu:projects'},{text:'🏠 Menu',callback_data:'menu:home'}]);
  return screen(env,chat,`🪙 <b>${html(tokenLabel(p.symbol))}</b>\n${html(p.name)}\n\n${web}`,keyboard(rows),q);
}

async function newFightScreen(env,chat,user,q=null){
  const mine=await adminProjects(env,user);
  if(!mine.length)return projectsScreen(env,chat,user,q);
  const rows=mine.map(p=>[{text:`🥊 Challenge as ${tokenLabel(p.symbol)}`,callback_data:`new:own:${p.mint}`}]);
  rows.push([{text:'🏠 Main Menu',callback_data:'menu:home'}]);
  return screen(env,chat,'🥊 <b>NEW TOKEN FIGHT</b>\n\nFirst choose the project you want to represent.',keyboard(rows),q);
}

async function chooseOwn(env,chat,user,mint,q=null){
  if(!mintOk(mint)||!(await groupForAdmin(env,mint,user)))return screen(env,chat,'You must be a current admin of the linked project group.',keyboard([[{text:'↩️ Choose Project',callback_data:'menu:new'}]]),q);
  await env.DB.prepare(`INSERT INTO draft_state(user_id,step,own_mint,updated_at) VALUES(?,'opponent',?,?) ON CONFLICT(user_id) DO UPDATE SET step='opponent',own_mint=excluded.own_mint,updated_at=excluded.updated_at`).bind(String(user),mint,now()).run();
  const p=await env.DB.prepare('SELECT symbol FROM projects WHERE mint=?').bind(mint).first();
  const registered=await env.DB.prepare(`SELECT p.mint,p.symbol FROM projects p WHERE p.mint<>? AND EXISTS(SELECT 1 FROM project_groups pg WHERE pg.mint=p.mint) ORDER BY p.updated_at DESC LIMIT 25`).bind(mint).all();
  const rows=(registered.results||[]).map(p=>[{text:`⚔️ ${tokenLabel(p.symbol)}`,callback_data:`new:opp:${p.mint}`}]);
  rows.push([{text:'📋 Paste Another Token Mint',callback_data:'new:paste'}]);
  rows.push([{text:'↩️ Change My Project',callback_data:'menu:new'}]);
  return screen(env,chat,`🥊 <b>${html(tokenLabel(p?.symbol||'TOKEN'))} VS ?</b>\n\nChoose a registered opponent or paste a Solana token mint address.`,keyboard(rows),q);
}

async function canManageWebsite(env,mint,user){
  if(!mintOk(mint))return false;
  // Minimize link impersonation: only administrators of the earliest linked group
  // may advertise or change this token's project website.
  const earliest=await env.DB.prepare('SELECT chat_id FROM project_groups WHERE mint=? ORDER BY registered_at ASC, chat_id ASC LIMIT 1').bind(mint).first();
  return !!earliest&&await tgAdmin(env,earliest.chat_id,user);
}

async function websiteInfo(env,chat,user,mint,q=null){
  if(!mintOk(mint))return say(env,chat,'Invalid project mint.');
  const p=await env.DB.prepare(`SELECT p.mint,p.symbol,p.name,w.website_url FROM projects p LEFT JOIN project_websites w ON w.mint=p.mint WHERE p.mint=?`).bind(mint).first();
  if(!p)return say(env,chat,'Project not found.');
  const groups=(await env.DB.prepare('SELECT chat_id,chat_title FROM project_groups WHERE mint=? ORDER BY registered_at ASC,chat_id ASC LIMIT 30').bind(mint).all()).results||[];
  const checks=await Promise.all(groups.map(g=>tgAdmin(env,g.chat_id,user)));
  const mine=groups.filter((_,i)=>checks[i]);
  const original=groups.length>0&&checks[0];
  const rows=[];
  if(original){
    rows.push([{text:p.website_url?'✏️ Edit Official Website':'🌐 Add Official Website',callback_data:`site:set:${mint}`}]);
    if(p.website_url)rows.push([{text:'🗑 Remove Official Website',callback_data:`site:remove:${mint}`}]);
  }
  for(const g of mine.slice(0,12))rows.push([{text:`🌐 Website for ${String(g.chat_title||'My Group').slice(0,28)}`,callback_data:`sg:${mint}:${compactGroupChat(g.chat_id)}`}]);
  if(p.website_url)rows.push([{text:'🌐 Open Official Website',url:p.website_url}]);
  rows.push([{text:'↩️ Project Websites',callback_data:'menu:sites'},{text:'🏠 Menu',callback_data:'menu:home'}]);
  const site=p.website_url?`<a href="${html(p.website_url)}">${html(projectWebsiteDisplay(p.website_url))}</a>`:'Not set';
  const explain=!mine.length?'🔒 Only admins of linked Telegram groups may manage their group websites. Make sure the bot is also a group admin.'
    :original?'✅ You can manage the official project website or a separate link for your group.'
    :'✅ You can add a website for your own Telegram group. The official website for this token is managed by its original group and is not changed by your group link.';
  return screen(env,chat,`🌐 <b>${html(tokenLabel(p.symbol))} WEBSITES</b>\n\nOfficial website: ${site}\n\n${explain}\n\nSelect a website to manage:`,keyboard(rows),q);
}

async function websiteGroupInfo(env,chat,user,mint,groupId,q=null){
  const g=await groupAdminForWebsite(env,mint,groupId,user);
  if(!g)return screen(env,chat,'🔒 Only a current admin of this linked Telegram group may manage its website.',keyboard([[{text:'🌐 Websites',callback_data:'menu:sites'}]]),q);
  const p=await env.DB.prepare('SELECT symbol FROM projects WHERE mint=?').bind(mint).first();
  const record=await env.DB.prepare('SELECT website_url FROM group_websites WHERE mint=? AND chat_id=?').bind(mint,String(groupId)).first();
  const url=record?.website_url,scope=compactGroupChat(groupId);
  const rows=[[{text:url?'✏️ Edit Group Website':'🌐 Set Group Website',callback_data:`swg:${mint}:${scope}`}]];
  if(url){
    rows.push([{text:'🗑 Remove Group Website',callback_data:`srm:${mint}:${scope}`}]);
    rows.push([{text:'🌐 Visit Website',url}]);
  }
  rows.push([{text:'↩️ Websites',callback_data:`site:open:${mint}`}],[{text:'🏠 Menu',callback_data:'menu:home'}]);
  return screen(env,chat,`🌐 <b>${html(tokenLabel(p?.symbol||'TOKEN'))} — GROUP WEBSITE</b>\n\nGroup: ${html(g.chat_title||'Telegram Group')}\nWebsite: ${url?`<a href="${html(url)}">${html(projectWebsiteDisplay(url))}</a>`:'Not set'}\n\nThis link appears only in battle posts in this Telegram group. The official project website remains unchanged.\n\nYou may change this during an active fight.`,keyboard(rows),q);
}

async function websiteGroupStart(env,chat,user,mint,groupId,q=null){
  const g=await groupAdminForWebsite(env,mint,groupId,user);
  if(!g)return say(env,chat,'Only an admin of this linked Telegram group may set its website.');
  await env.DB.prepare("INSERT INTO draft_state(user_id,step,own_mint,updated_at) VALUES(?,'website_group',?,?) ON CONFLICT(user_id) DO UPDATE SET step='website_group',own_mint=excluded.own_mint,updated_at=excluded.updated_at").bind(String(user),`${mint}|${groupId}`,now()).run();
  const p=await env.DB.prepare('SELECT symbol FROM projects WHERE mint=?').bind(mint).first();
  return screen(env,chat,`🌐 <b>SET WEBSITE FOR ${html(tokenLabel(p?.symbol||'TOKEN'))}</b>\n\nGroup: ${html(g.chat_title||'Telegram Group')}\n\nSend the HTTPS website URL as your next message in this private chat.\n\nThis link affects only your Telegram group, not other groups.`,keyboard([[{text:'↩️ Back',callback_data:`sg:${mint}:${compactGroupChat(groupId)}`}],[{text:'🏠 Menu',callback_data:'menu:home'}]]),q);
}

async function websiteGroupSave(env,chat,user,mint,groupId,raw){
  const g=await groupAdminForWebsite(env,mint,groupId,user);
  if(!g)return say(env,chat,'Only an admin of this linked Telegram group may save its website.');
  const url=normalizeProjectWebsite(raw);
  if(!url)return say(env,chat,'⚠️ Send a valid public HTTPS website URL (for example https://arbstrategy.net).');
  await env.DB.prepare(`INSERT INTO group_websites(mint,chat_id,website_url,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(mint,chat_id) DO UPDATE SET website_url=excluded.website_url,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(mint,String(groupId),url,String(user),now()).run();
  await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(user)).run();
  await refreshActiveWebsiteButtons(env,mint,String(groupId));
  await say(env,chat,`✅ Group website saved: ${html(projectWebsiteDisplay(url))}\n\nThe link now appears in battle posts in ${html(g.chat_title||'your group')} only.`);
  return websiteGroupInfo(env,chat,user,mint,groupId);
}

async function websiteGroupRemove(env,chat,user,mint,groupId,confirmed=false,q=null){
  const g=await groupAdminForWebsite(env,mint,groupId,user);
  if(!g)return say(env,chat,'Only an admin of this linked Telegram group may remove its website.');
  if(!confirmed)return screen(env,chat,`🗑 <b>REMOVE GROUP WEBSITE?</b>\n\nRemove the local website for ${html(g.chat_title||'this group')}? The official link will not change.`,keyboard([[{text:'✅ Remove',callback_data:`sdel:${mint}:${compactGroupChat(groupId)}`}],[{text:'↩️ Keep',callback_data:`sg:${mint}:${compactGroupChat(groupId)}`}]]),q);
  await env.DB.prepare('DELETE FROM group_websites WHERE mint=? AND chat_id=?').bind(mint,String(groupId)).run();
  await refreshActiveWebsiteButtons(env,mint,String(groupId));
  return websiteGroupInfo(env,chat,user,mint,groupId,q);
}

async function websiteStart(env,chat,user,mint,q=null){
  if(!mintOk(mint)||!(await canManageWebsite(env,mint,user)))return screen(env,chat,'Only a current admin of the first group linked to this token may edit its website. The bot should also be a group admin for reliable verification. Active fights do not block website changes.',keyboard([[{text:'🪙 My Projects',callback_data:'menu:projects'}]]),q);
  await env.DB.prepare(`INSERT INTO draft_state(user_id,step,own_mint,updated_at) VALUES(?,'website',?,?) ON CONFLICT(user_id) DO UPDATE SET step='website',own_mint=excluded.own_mint,updated_at=excluded.updated_at`).bind(String(user),mint,now()).run();
  const p=await env.DB.prepare('SELECT symbol FROM projects WHERE mint=?').bind(mint).first();
  return screen(env,chat,`🌐 <b>SET WEBSITE FOR ${html(tokenLabel(p?.symbol||'TOKEN'))}</b>\n\nPaste your project's HTTPS website address (for example: https://arbstrategy.net).\n\nThis is the only information you need to enter manually. You can change it later.`,keyboard([[{text:'↩️ My Projects',callback_data:'menu:sites'}],[{text:'🏠 Main Menu',callback_data:'menu:home'}]]),q);
}

async function refreshActiveWebsiteButtons(env,mint,onlyChatId=null){
  // A website may be created or changed while a fight is LIVE.
  // Update the latest post in both groups without sending an unnecessary new video.
  try{
    const ongoing=await env.DB.prepare("SELECT id FROM fights WHERE status='active' AND (mint_a=? OR mint_b=?) LIMIT 10").bind(mint,mint).all();
    for(const fight of ongoing.results||[]){
      const f=await detail(env,fight.id);if(!f)continue;
      const posts=await env.DB.prepare('SELECT chat_id,live_message_id FROM group_messages WHERE fight_id=?').bind(f.id).all();
      await Promise.all((posts.results||[]).filter(p=>p.live_message_id&&(onlyChatId===null||String(p.chat_id)===String(onlyChatId))).map(async p=>{
        try{
          const chatView=await websiteViewForChat(env,f,p.chat_id);
          const current=votingButtons(chatView);
          await telegram(env,'editMessageReplyMarkup',{chat_id:p.chat_id,message_id:p.live_message_id,reply_markup:current});
        }catch(e){
          if(!errString(e).includes('message is not modified'))console.error('website buttons refresh',f.id,p.chat_id,errString(e));
        }
      }));
    }
  }catch(e){console.error('website live updates',mint,errString(e));}
}

async function websiteSave(env,chat,user,mint,raw){
  if(!mintOk(mint)||!(await canManageWebsite(env,mint,user)))return say(env,chat,'Only a current admin of the first group linked to this token can save its website. Check your group admin rights and whether the bot is also a group admin.');
  const website_url=normalizeProjectWebsite(raw);
  if(!website_url)return say(env,chat,'⚠️ Please paste a valid HTTPS website URL, such as https://arbstrategy.net. Public domain names only, maximum 160 characters.');
  await env.DB.prepare(`INSERT INTO project_websites(mint,website_url,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(mint) DO UPDATE SET website_url=excluded.website_url,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).bind(mint,website_url,String(user),now()).run();
  await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(user)).run();
  await refreshActiveWebsiteButtons(env,mint);
  await say(env,chat,'✅ Website saved! The latest fight posts have been updated where possible; future battle posts will automatically include the link.');
  return projectScreen(env,chat,user,mint);
}

async function websiteRemove(env,chat,user,mint,q=null){
  if(!mintOk(mint)||!(await canManageWebsite(env,mint,user)))return say(env,chat,'Only a current admin of the first linked project group may remove its website. Active fights do not restrict this.');
  await env.DB.prepare('DELETE FROM project_websites WHERE mint=?').bind(mint).run();
  await refreshActiveWebsiteButtons(env,mint);
  return projectScreen(env,chat,user,mint,q);
}

async function fightScreen(env,chat,user,history=false,q=null){
  const sql=history?`SELECT id FROM fights WHERE status IN ('ended','unresolved') ORDER BY archived_at DESC LIMIT 12`:`SELECT id FROM fights WHERE status='active' ORDER BY ends_at ASC LIMIT 12`;
  const rows=await env.DB.prepare(sql).all();
  const buttons=[];
  const lines=[history?'🏆 <b>HALL OF FAME</b>':'⚡ <b>ACTIVE TOKEN FIGHTS</b>'];
  for(const item of rows.results||[]){
    const f=await detail(env,item.id);if(!f)continue;
    lines.push(`• ${html(tokenLabel(f.sym_a))} VS ${html(tokenLabel(f.sym_b))} — ${f.status==='ended' ? `🏆 ${html(f.winner==='a'?tokenLabel(f.sym_a):f.winner==='b'?tokenLabel(f.sym_b):'DRAW')}`:f.status==='active'?'LIVE':f.status.toUpperCase()}`);
    buttons.push([{text:`📊 ${tokenLabel(f.sym_a)} VS ${tokenLabel(f.sym_b)}`,callback_data:`fight:view:${f.id}`}]);
    if(!history&&String(f.creator_id)===String(user))buttons.push([{text:`🛑 Stop ${tokenLabel(f.sym_a)} VS ${tokenLabel(f.sym_b)}`,callback_data:`stop:confirm:${f.id}`}]);
    if(!history&&String(f.creator_id)===String(user))buttons.push([{text:`🔄 Refresh ${tokenLabel(f.sym_a)} VS ${tokenLabel(f.sym_b)}`,callback_data:`fight:refresh:${f.id}`}]);
  }
  if(lines.length===1)lines.push(history?'No completed fights yet.':'No active fights right now.');
  buttons.push([{text:'🏠 Main Menu',callback_data:'menu:home'}]);
  return screen(env,chat,lines.join('\n'),keyboard(buttons),q);
}

async function fightView(env,chat,user,id,q=null){
  const f=await detail(env,id);
  if(!f)return screen(env,chat,'Fight not found.',keyboard([[{text:'🏠 Menu',callback_data:'menu:home'}]]),q);
  const [a,b]=await stats(env,id);
  const rows=[];
  if(f.website_a)rows.push([{text:`🌐 ${tokenLabel(f.sym_a)} Website`,url:f.website_a}]);
  if(f.website_b)rows.push([{text:`🌐 ${tokenLabel(f.sym_b)} Website`,url:f.website_b}]);
  if(f.status==='active'&&String(f.creator_id)===String(user))rows.push([{text:'🛑 Stop This Fight',callback_data:`stop:confirm:${f.id}`}]);
  if(f.status==='active'&&String(f.creator_id)===String(user))rows.push([{text:'🔄 Refresh Now',callback_data:`fight:refresh:${f.id}`}]);
  rows.push([{text:'↩️ Back',callback_data:f.status==='active'?'menu:active':'menu:history'}],[{text:'🏠 Menu',callback_data:'menu:home'}]);
  return screen(env,chat,caption(f,a,b),keyboard(rows),q);
}

async function refreshFightNow(env,chat,user,id){
  const fight=id?await detail(env,id):null;
  if(!fight||fight.status!=='active')return say(env,chat,'This fight is not currently active.');
  if(String(fight.creator_id)!==String(user))return say(env,chat,'Only the challenge creator may refresh this fight manually.');
  const key='manual_refresh_'+fight.id,t=now();
  await env.DB.prepare('INSERT OR IGNORE INTO worker_settings(key,value,updated_at) VALUES(?,?,0)').bind(key,'manual').run();
  const lock=await env.DB.prepare('UPDATE worker_settings SET updated_at=? WHERE key=? AND updated_at<=?').bind(t,key,t-60).run();
  if(!changed(lock))return say(env,chat,'⏳ Please wait one minute before another manual update.');
  let newGroups=new Set(),result={targets:0,sent:0,failed:0};
  try{newGroups=await postFight(env,id);}catch(e){console.error('manual first post',id,errString(e));}
  try{result=await refreshMessages(env,id,false,true,newGroups);}catch(e){console.error('manual refresh',id,errString(e));result.failed++;}
  const success=result.failed===0&&(result.sent>0||newGroups.size>0);
  await env.DB.prepare("UPDATE fights SET next_refresh_at=? WHERE id=? AND status='active'")
    .bind(t+(success?REFRESH_INTERVAL:90),id).run();
  return say(env,chat,`${success?'✅':'⚠️'} Fight refresh completed. New posts: ${result.sent+newGroups.size}. Failed groups: ${result.failed}.\n\nAutomatic updates are scheduled every 30 minutes.`,{
    reply_markup:keyboard([[{text:'📊 Fight Status',callback_data:`fight:view:${id}`}],[{text:'🏠 Menu',callback_data:'menu:home'}]])
  });
}

async function stopFight(env,chat,user,id){
  const f=id?await detail(env,id):null;
  if(!f)return say(env,chat,'Fight not found. Use Active Fights to select one.');
  if(String(f.creator_id)!==String(user))return say(env,chat,'Only the challenge creator can stop this fight.');
  if(f.status!=='active')return say(env,chat,'This fight is not active.');
  const t=now();
  const batch=await env.DB.batch([
    env.DB.prepare(`UPDATE fights SET status='cancelled',settled_at=?,archived_at=? WHERE id=? AND creator_id=? AND status='active'`).bind(t,t,id,String(user)),
    env.DB.prepare(`DELETE FROM active_token_locks WHERE fight_id=? AND EXISTS(SELECT 1 FROM fights WHERE id=? AND status='cancelled')`).bind(id,id)
  ]);
  if(!changed(batch[0]))return say(env,chat,'This fight has already been stopped.');
  await say(env,chat,`🛑 Fight ${html(f.id)} stopped. Both tokens are ready for a rematch.`,{reply_markup:keyboard([[{text:'🥊 New Fight',callback_data:'menu:new'}],[{text:'🏠 Menu',callback_data:'menu:home'}]])});
  await refreshMessages(env,id,true);
}

async function groupCallback(env,q){
  const chat=q.message.chat.id,user=q.from.id,cmd=q.data||'';
  if(cmd==='group:link'){
    if(!await tgAdmin(env,chat,user))return say(env,chat,'Only a group administrator can link a token.');
    return say(env,chat,'🔗 Reply with the Solana token mint address for this Telegram group:',{reply_markup:{force_reply:true,input_field_placeholder:'Paste token mint address'}});
  }
  if(cmd==='group:logos'){
    if(!await tgAdmin(env,chat,user))return say(env,chat,'Only a group administrator can upload project logos.');
    const linked=await env.DB.prepare('SELECT pg.mint,p.symbol FROM project_groups pg JOIN projects p ON p.mint=pg.mint WHERE pg.chat_id=? ORDER BY pg.registered_at DESC LIMIT 20').bind(String(chat)).all();
    const rows=(linked.results||[]).map(p=>[{text:'📷 Upload '+tokenLabel(p.symbol)+' Logo',url:'https://t.me/'+env.BOT_USERNAME.replace('@','')+'?start=logo_'+p.mint}]);
    rows.push([{text:'↩️ Group Menu',callback_data:'menu:group'}]);
    return screen(env,chat,linked.results?.length?'🖼️ <b>PROJECT LOGOS</b>\n\nSelect your token to upload its official logo in the private bot chat.':'No linked projects found in this group.',keyboard(rows),q);
  }
  if(cmd==='menu:help')return helpScreen(env,chat,q,true);
  if(cmd.startsWith('help:'))return helpSection(env,chat,cmd.slice(5),q,true);
  if(cmd==='group:sites'){
    if(!await tgAdmin(env,chat,user))return say(env,chat,'Only group administrators can manage project websites. The bot should also be an administrator.');
    const linked=await env.DB.prepare(`SELECT pg.mint,p.symbol FROM project_groups pg
      JOIN projects p ON p.mint=pg.mint WHERE pg.chat_id=? ORDER BY pg.registered_at DESC LIMIT 20`).bind(String(chat)).all();
    const rows=(linked.results||[]).map(p=>[{text:`🌐 Manage ${tokenLabel(p.symbol)} Website`,
      url:`https://t.me/${env.BOT_USERNAME.replace('@','')}?start=website_${p.mint}`}]);
    rows.push([{text:'↩️ Group Menu',callback_data:'menu:group'}]);
    return screen(env,chat,linked.results?.length?
      '🌐 <b>PROJECT WEBSITES</b>\n\nSelect your project to set a website for your own Telegram group. The official project website stays protected.':
      'No project tokens linked to this group.',keyboard(rows),q);
  }
  if(cmd==='group:unlink'){
    if(!await tgAdmin(env,chat,user))return say(env,chat,'Only group administrators can unlink tokens.');
    const linked=await env.DB.prepare('SELECT pg.mint,p.symbol FROM project_groups pg JOIN projects p ON p.mint=pg.mint WHERE pg.chat_id=? ORDER BY pg.registered_at DESC LIMIT 20').bind(String(chat)).all();
    const rows=(linked.results||[]).map(p=>[{text:`🔓 Unlink ${tokenLabel(p.symbol)}`,callback_data:`group:remove:${p.mint}`}]);
    rows.push([{text:'↩️ Back',callback_data:'menu:group'}]);
    return screen(env,chat,linked.results?.length?'Select the token link to remove from this group.':'No token links found for this group.',keyboard(rows),q);
  }
  if(cmd.startsWith('group:remove:')){
    if(!await tgAdmin(env,chat,user))return say(env,chat,'Only group administrators can unlink tokens.');
    const mint=cmd.slice(13);
    if(!mintOk(mint))return groupHome(env,chat,q);
    return screen(env,chat,'🔓 <b>UNLINK PROJECT?</b>\n\nThis removes the group-token link. Existing battle messages remain.',keyboard([[{text:'✅ Unlink Token',callback_data:`group:do:${mint}`}],[{text:'↩️ Keep Linked',callback_data:'menu:group'}]]),q);
  }
  if(cmd.startsWith('group:do:')){
    if(!await tgAdmin(env,chat,user))return say(env,chat,'Only group administrators can unlink tokens.');
    const mint=cmd.slice(9);
    if(!mintOk(mint))return groupHome(env,chat,q);
    await env.DB.prepare('DELETE FROM project_groups WHERE mint=? AND chat_id=?').bind(mint,String(chat)).run();
    return screen(env,chat,'✅ This token is no longer linked to the group.',groupButtons(env),q);
  }
  return groupHome(env,chat,q);
}

async function confirmWebsiteRemove(env,chat,user,mint,q){
  if(!mintOk(mint)||!(await canManageWebsite(env,mint,user)))return say(env,chat,'Only admins of the first linked project group can change the website.');
  return screen(env,chat,'🗑 <b>REMOVE PROJECT WEBSITE?</b>\n\nThis removes the website from the latest active fight post and upcoming updates. You can add a new URL any time.',keyboard([[{text:'✅ Remove Website',callback_data:`site:delete:${mint}`}],[{text:'↩️ Keep Website',callback_data:`site:open:${mint}`}]]),q);
}

async function beginLogoUpload(env,chat,user,mint,q=null){
  if(!mintOk(mint)||!(await canManageWebsite(env,mint,user)))return say(env,chat,'Only admins of the first linked project group can manage this logo.');
  await env.DB.prepare("INSERT INTO draft_state(user_id,step,own_mint,updated_at) VALUES(?,'logo',?,?) ON CONFLICT(user_id) DO UPDATE SET step='logo',own_mint=excluded.own_mint,updated_at=excluded.updated_at").bind(String(user),mint,now()).run();
  const p=await env.DB.prepare('SELECT symbol FROM projects WHERE mint=?').bind(mint).first();
  return screen(env,chat,`🖼️ <b>UPLOAD LOGO FOR ${html(tokenLabel(p?.symbol||'TOKEN'))}</b>\n\nSend your official logo as a Telegram photo in this private chat.\n\nPNG/JPEG, under 440 KB. Telegram compresses photo uploads automatically.\n\nOnce saved, the logo is reused in every future fight.`,keyboard([[{text:'↩️ My Projects',callback_data:'menu:projects'}],[{text:'🏠 Main Menu',callback_data:'menu:home'}]]),q);
}

async function findLogoAutomatically(env,chat,user,mint,q=null){
  if(!mintOk(mint)||!(await canManageWebsite(env,mint,user)))return say(env,chat,'Only a project admin can manage its logo.');
  const p=await env.DB.prepare('SELECT mint,symbol,logo_url FROM projects WHERE mint=?').bind(mint).first();
  if(!p)return say(env,chat,'Project not found.');
  const image=await ensureTokenLogo(env,p);
  return screen(env,chat,image?`✅ <b>${html(tokenLabel(p.symbol))} LOGO READY</b>\n\nSaved permanently for future battles.`:`🖼️ <b>LOGO MISSING FOR ${html(tokenLabel(p.symbol))}</b>\n\nNo usable image was found automatically. Please upload the official logo once.`,keyboard([[{text:image?'📷 Replace Logo':'📷 Upload Logo',callback_data:`logo:set:${mint}`}],[{text:'🪙 My Projects',callback_data:'menu:projects'}]]),q);
}

async function receiveLogoPhoto(env,msg){
  if(msg?.chat?.type!=='private'||!msg?.from?.id||!msg.photo?.length)return;
  const user=msg.from.id,chat=msg.chat.id;
  const draft=await env.DB.prepare('SELECT * FROM draft_state WHERE user_id=?').bind(String(user)).first();
  if(!draft||draft.step!=='logo')return;
  if(now()-draft.updated_at>1800){
    await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(user)).run();
    return say(env,chat,'Logo upload expired. Please choose Upload Logo again.');
  }
  if(!(await canManageWebsite(env,draft.own_mint,user)))return say(env,chat,'Only admins of the first linked group can upload this logo.');
  const sizes=[...msg.photo].filter(p=>p?.file_id&&Number(p.file_size||0)<=440000).sort((a,b)=>Number(b.width||0)*Number(b.height||0)-Number(a.width||0)*Number(a.height||0));
  if(!sizes.length)return say(env,chat,'Please send a smaller logo photo (under 440 KB).');
  try{
    const bytes=await telegramUploadedBytes(env,sizes[0].file_id);
    await saveUploadedLogo(env,draft.own_mint,user,bytes);
    await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(user)).run();
    await say(env,chat,'✅ Official logo saved permanently! All future battles will use this image.');
    return projectScreen(env,chat,user,draft.own_mint);
  }catch(e){
    console.error('logo upload',errString(e));
    return say(env,chat,'⚠️ '+html(errString(e))+'\n\nPlease try a smaller Telegram photo.');
  }
}

async function menuCallback(env,q){
  const chat=q?.message?.chat?.id,user=q?.from?.id,cmd=q?.data||'';
  if(chat==null||user==null)return;
  const privateChat=q.message.chat.type==='private';
  if(!privateChat)return groupCallback(env,q);
  if(['menu:home','menu:new','menu:projects','menu:sites','menu:logos'].includes(cmd))await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(user)).run();
  if(cmd==='menu:home')return menuHome(env,chat,q);
  if(cmd==='menu:help')return helpScreen(env,chat,q);
  if(cmd.startsWith('help:'))return helpSection(env,chat,cmd.slice(5),q);
  if(cmd==='menu:projects')return projectsScreen(env,chat,user,q);
  if(cmd==='menu:sites')return projectsScreen(env,chat,user,q,true);
  if(cmd==='menu:video')return videoScreen(env,chat,user,q);
  if(cmd==='video:upload')return startVideoUpload(env,chat,user,q);
  if(cmd==='video:preview'){
    const fileId=await getFightVideo(env);
    if(!fileId)return videoScreen(env,chat,user,q);
    return telegram(env,'sendVideo',{chat_id:chat,video:fileId,caption:'🎬 Fixed ASTY Token Fight video',supports_streaming:true});
  }
  if(cmd==='menu:new')return newFightScreen(env,chat,user,q);
  if(cmd==='menu:active')return fightScreen(env,chat,user,false,q);
  if(cmd==='menu:history')return fightScreen(env,chat,user,true,q);
  if(cmd.startsWith('project:view:'))return projectScreen(env,chat,user,cmd.slice(13),q);
  if(cmd.startsWith('site:open:'))return websiteInfo(env,chat,user,cmd.slice(10),q);
  for(const prefix of ['sg:','swg:','srm:','sdel:']){
    if(cmd.startsWith(prefix)){
      const segments=cmd.slice(prefix.length).split(':');
      const mint=segments[0],groupId=segments.length===2?restoreGroupChat(segments[1]):null;
      if(!mintOk(mint)||!groupId)return say(env,chat,'Invalid group website selection. Please reopen Project Websites.');
      if(prefix==='sg:')return websiteGroupInfo(env,chat,user,mint,groupId,q);
      if(prefix==='swg:')return websiteGroupStart(env,chat,user,mint,groupId,q);
      if(prefix==='srm:')return websiteGroupRemove(env,chat,user,mint,groupId,false,q);
      return websiteGroupRemove(env,chat,user,mint,groupId,true,q);
    }
  }

  if(cmd.startsWith('site:info:'))return websiteInfo(env,chat,user,cmd.slice(10),q);
  if(cmd.startsWith('site:set:'))return websiteStart(env,chat,user,cmd.slice(9),q);
  if(cmd.startsWith('logo:set:'))return beginLogoUpload(env,chat,user,cmd.slice(9),q);
  if(cmd.startsWith('logo:auto:'))return findLogoAutomatically(env,chat,user,cmd.slice(10),q);
  if(cmd.startsWith('site:remove:'))return confirmWebsiteRemove(env,chat,user,cmd.slice(12),q);
  if(cmd.startsWith('site:delete:'))return websiteRemove(env,chat,user,cmd.slice(12),q);
  if(cmd.startsWith('new:own:'))return chooseOwn(env,chat,user,cmd.slice(8),q);
  if(cmd==='new:paste')return screen(env,chat,'📋 Paste the opponent’s Solana token mint address in this private chat.',keyboard([[{text:'↩️ Choose Own Project',callback_data:'menu:new'}],[{text:'🏠 Menu',callback_data:'menu:home'}]]),q);
  if(cmd.startsWith('new:opp:')){
    const mint=cmd.slice(8);
    const draft=await env.DB.prepare('SELECT * FROM draft_state WHERE user_id=?').bind(String(user)).first();
    if(!draft||draft.step!=='opponent'||now()-draft.updated_at>1800)return newFightScreen(env,chat,user,q);
    return createFight(env,user,draft.own_mint,mint,chat);
  }
  if(cmd.startsWith('fight:view:'))return fightView(env,chat,user,cmd.slice(11),q);
  if(cmd.startsWith('fight:refresh:'))return refreshFightNow(env,chat,user,cmd.slice(14));
  if(cmd.startsWith('stop:confirm:')){
    const id=cmd.slice(13),f=await detail(env,id);
    if(!f||String(f.creator_id)!==String(user)||f.status!=='active')return say(env,chat,'Only the creator can stop an active fight.');
    return screen(env,chat,`🛑 <b>STOP FIGHT?</b>\n\n${html(tokenLabel(f.sym_a))} VS ${html(tokenLabel(f.sym_b))}\n\nThis ends the battle without a winner. Both tokens become available for a rematch.`,keyboard([[{text:'✅ Yes, Stop Fight',callback_data:`stop:do:${id}`}],[{text:'↩️ Keep Fighting',callback_data:`fight:view:${id}`}]]),q);
  }
  if(cmd.startsWith('stop:do:'))return stopFight(env,chat,user,cmd.slice(8));
  return menuHome(env,chat,q);
}

let websiteTableReady=false;
async function ensureWebsiteTable(env){
  // Non-destructive migration for existing D1 deployments.
  if(websiteTableReady)return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS project_websites(mint TEXT PRIMARY KEY,website_url TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(mint) REFERENCES projects(mint))`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS group_websites(mint TEXT NOT NULL,chat_id TEXT NOT NULL,website_url TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(mint,chat_id),FOREIGN KEY(mint) REFERENCES projects(mint))`).run();
  websiteTableReady=true;
}

async function ensureBotCommands(env){
  // Persist a version marker so Telegram's command menu isn't rewritten each minute.
  const key='bot_commands_v7_no_video_button';;
  const current=await env.DB.prepare('SELECT value FROM worker_settings WHERE key=?').bind(key).first();
  if(current)return;
  const commands=[
    {command:'start',description:'Open the main menu'},
    {command:'menu',description:'Show all menu buttons'},
    {command:'new',description:'Create a new token fight'},
    {command:'projects',description:'Manage linked projects'},
    {command:'website',description:'Set project websites'},
    {command:'fights',description:'Active token fights'},
    {command:'history',description:'Hall of Fame'},
    {command:'help',description:'Commands and how to play'},
    {command:'link',description:'Link a token in a group'},
    {command:'unlink',description:'Unlink token from a group'},
    {command:'status',description:'Detailed fight statistics'},
    {command:'withdraw',description:'Withdraw a pending challenge'},
    {command:'stop',description:'Stop your active fight'},
    {command:'refresh',description:'Repost current fight stats'},
    {command:'cancel',description:'Cancel an input wizard'}
  ];
  await telegram(env,'setMyCommands',{commands});
  await env.DB.prepare(`INSERT OR IGNORE INTO worker_settings(key,value,updated_at) VALUES(?,?,?)`).bind(key,'ok',now()).run();
}

function fixedVideoKey(){return 'fight_video_file_id';}

async function getFightVideo(env){
  const r=await env.DB.prepare('SELECT value FROM worker_settings WHERE key=?').bind(fixedVideoKey()).first();
  return r?.value||null;
}

async function getVideoOwner(env){
  const owner=await env.DB.prepare("SELECT value FROM worker_settings WHERE key='fight_video_owner_id'").first();
  return owner?.value||null;
}
async function isVideoManager(env,user){
  const owner=await getVideoOwner(env);
  // Once the first approved uploader succeeds, that Telegram user ID is locked.
  // Neither another project/group admin nor a later change to the environment can replace it.
  if(owner)return String(user)===String(owner);
  // Before first upload, a configured explicit owner has priority.
  if(env.FIGHT_VIDEO_ADMIN_ID)return String(user)===String(env.FIGHT_VIDEO_ADMIN_ID);
  // Backwards-compatible first-upload bootstrap for the original ASTY group registrar.
  const mint='ASTYqeaoK83Zs1pTFEXZUB6BM8cG8YLTsN852NUkt7ZR';
  const origin=await env.DB.prepare('SELECT chat_id,registered_by FROM project_groups WHERE mint=? ORDER BY registered_at ASC,chat_id ASC LIMIT 1').bind(mint).first();
  return !!origin&&String(origin.registered_by)===String(user)&&await tgAdmin(env,origin.chat_id,user);
}

async function videoScreen(env,chat,user,q=null){
  const fileId=await getFightVideo(env);
  if(fileId){
    return screen(env,chat,
      '🎬 <b>OFFICIAL FIGHT VIDEO</b>\n\n✅ Video configured and permanently locked.\n\nEvery fight and every scheduled update uses this exact video. No project or group administrator can upload or replace it.',
      keyboard([[{text:'▶️ Preview Video',callback_data:'video:preview'}],[{text:'🏠 Main Menu',callback_data:'menu:home'}]]),q);
  }
  if(!(await isVideoManager(env,user)))return screen(env,chat,
    '🎬 <b>OFFICIAL FIGHT VIDEO</b>\n\nThe official video has not been configured yet. Only the authorized ASTY operator can upload it once.',
    keyboard([[{text:'🏠 Main Menu',callback_data:'menu:home'}]]),q);
  return screen(env,chat,
    '🎬 <b>OFFICIAL FIGHT VIDEO</b>\n\nNo video configured yet. Upload an MP4 once; after a successful upload the video is permanently locked.',
    keyboard([[{text:'🎬 Upload Official Video',callback_data:'video:upload'}],[{text:'🏠 Main Menu',callback_data:'menu:home'}]]),q);
}

async function startVideoUpload(env,chat,user,q=null){
  if(await getFightVideo(env))return videoScreen(env,chat,user,q);
  if(!(await isVideoManager(env,user)))return say(env,chat,'Only the authorized ASTY operator can upload the initial official video.');
  await env.DB.prepare("INSERT INTO draft_state(user_id,step,own_mint,updated_at) VALUES(?,'video',NULL,?) ON CONFLICT(user_id) DO UPDATE SET step='video',own_mint=NULL,updated_at=excluded.updated_at")
    .bind(String(user),now()).run();
  return screen(env,chat,
    '🎬 <b>UPLOAD OFFICIAL FIGHT VIDEO</b>\n\nSend your MP4 as a Telegram video (not a link).\n\nOnce saved, this exact video is permanently locked and cannot be replaced through the bot.',
    keyboard([[{text:'↩️ Fight Video',callback_data:'menu:video'}],[{text:'🏠 Menu',callback_data:'menu:home'}]]),q);
}

async function receiveFightVideo(env,msg){
  if(msg?.chat?.type!=='private'||!msg?.video?.file_id||!msg?.from?.id)return;
  const chat=msg.chat.id,user=msg.from.id;
  const draft=await env.DB.prepare('SELECT * FROM draft_state WHERE user_id=?').bind(String(user)).first();
  if(!draft||draft.step!=='video')return;
  if(now()-draft.updated_at>1800){
    await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(user)).run();
    return say(env,chat,'Video upload session expired. Open Fight Video and try again.');
  }
  if(await getFightVideo(env))return say(env,chat,'🔒 The official fight video is already saved and permanently locked.');
  if(!(await isVideoManager(env,user)))return say(env,chat,'Only the authorized ASTY operator may upload the initial video.');
  const video=msg.video;
  if(Number(video.file_size||0)>50*1024*1024)return say(env,chat,'Please send a video under 50 MB.');
  if(video.mime_type&&video.mime_type!=='video/mp4')return say(env,chat,'Please send an MP4 video.');
  try{
    // Prove that Telegram accepts the same file_id in sendVideo before saving it.
    const preview=await telegram(env,'sendVideo',{chat_id:chat,video:video.file_id,
      caption:'🎬 ASTY Token Fight — fixed video preview',supports_streaming:true});
    const saved=preview?.video?.file_id||video.file_id;
    if(typeof saved!=='string'||!saved||saved.length>300)throw new Error('Telegram returned no usable video file ID');
    // A single D1 transaction claims the first uploader as permanent owner, then
    // accepts the new video ONLY when its Telegram user ID matches that owner.
    const committed=await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO worker_settings(key,value,updated_at) VALUES('fight_video_owner_id',?,?)")
        .bind(String(user),now()),
      env.DB.prepare(`INSERT OR IGNORE INTO worker_settings(key,value,updated_at)
        SELECT 'fight_video_file_id',?,?
        WHERE EXISTS (SELECT 1 FROM worker_settings WHERE key='fight_video_owner_id' AND value=?)`)
        .bind(saved,now(),String(user))
    ]);
    if(!changed(committed[1]))return say(env,chat,'🔒 The official video is already locked and cannot be replaced.');
    await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(user)).run();
    return say(env,chat,'✅ Official video saved and permanently locked! All future fights and 30-minute updates will reuse this video.',{
      reply_markup:keyboard([[{text:'🥊 New Fight',callback_data:'menu:new'}]])
    });
  }catch(error){
    console.error('video upload',errString(error));
    return say(env,chat,'⚠️ Telegram could not reuse this video: '+html(errString(error))+'\n\nPlease send a shorter MP4 video.');
  }
}

async function createFight(env,user,a,b,chat){
  if(!mintOk(a)||!mintOk(b)||a===b)return say(env,chat,'Please provide two different valid Solana token mint addresses.');
  if(!(await groupForAdmin(env,a,user)))return say(env,chat,`First link your project group as an admin: <code>/link ${html(a)}</code>.`);
  const pending=await env.DB.prepare(`SELECT COUNT(*) n FROM fights WHERE creator_id=? AND status='pending'`).bind(String(user)).first();
  if(Number(pending?.n||0)>=3)return say(env,chat,'You can have a maximum of three pending challenges.');
  const busy=await env.DB.prepare(`SELECT COUNT(*) n FROM active_token_locks WHERE mint IN (?,?)`).bind(a,b).first();
  if(Number(busy?.n||0)>0)return say(env,chat,'At least one token is already in an active fight. Try again after it ends.');
  try{await tokenInfo(env,a);await pause(1200);await tokenInfo(env,b);}catch(e){return say(env,chat,`Token lookup failed: ${html(errString(e))}`);}
  const id=eid();
  try{await env.DB.prepare(`INSERT INTO fights(id,mint_a,mint_b,creator_id,status,created_at) VALUES(?,?,?,?,'pending',?)`).bind(id,a,b,String(user),now()).run();}
  catch(e){return say(env,chat,'This token pair already has an open or active challenge. Wait for it to finish.');}
  await say(env,chat,`🥊 <b>Challenge created!</b>\nShare this link with your opponent:\n${botLink(env,id)}\n\nThe opponent must link their Telegram group and accept the challenge.`,{reply_markup:keyboard([[{text:'🔗 Share challenge',url:botLink(env,id)}],...siteButtons(await detail(env,id)).inline_keyboard])});
  const opponents=await env.DB.prepare('SELECT DISTINCT registered_by FROM project_groups WHERE mint=?').bind(b).all();
  for(const x of opponents.results){try{await say(env,x.registered_by,`🥊 New challenge for your project!\n${botLink(env,id)}`,websiteOptions(await detail(env,id)));}catch{}}
}
async function linkGroup(env,msg,arg){
  if(!['group','supergroup'].includes(msg.chat.type))return say(env,msg.chat.id,'Use <code>/link TOKEN_MINT</code> in your Telegram group.');
  if(!await tgAdmin(env,msg.chat.id,msg.from.id))return say(env,msg.chat.id,'Only a group administrator can link a token.');
  if(!arg)return say(env,msg.chat.id,'🔗 Reply with the Solana token mint address for this Telegram group:',{reply_markup:{force_reply:true,input_field_placeholder:'Paste token mint address'}});
  if(!mintOk(arg))return say(env,msg.chat.id,'Please provide a valid Solana token mint address.');
  try{await tokenInfo(env,arg);}catch(e){return say(env,msg.chat.id,'Token not found: '+html(errString(e)));}
  await env.DB.prepare(`INSERT INTO project_groups(mint,chat_id,chat_title,registered_by,registered_at) VALUES(?,?,?,?,?) ON CONFLICT(mint,chat_id) DO UPDATE SET chat_title=excluded.chat_title`).bind(arg,String(msg.chat.id),msg.chat.title||'',String(msg.from.id),now()).run();
  return say(env,msg.chat.id,`✅ Group linked to <code>${html(arg)}</code>. Ready for future battles.`,{reply_markup:keyboard([[{text:'🌐 Set Project Website',url:`https://t.me/${env.BOT_USERNAME.replace('@','')}?start=website_${arg}`}],[{text:'🥊 Bot Menu',url:`https://t.me/${env.BOT_USERNAME.replace('@','')}`}]] )});
}
async function unlinkGroup(env,msg,arg){
  if(!['group','supergroup'].includes(msg.chat.type)||!await tgAdmin(env,msg.chat.id,msg.from.id))return say(env,msg.chat.id,'Only a group administrator can unlink a token.');
  if(!mintOk(arg))return say(env,msg.chat.id,'Usage: <code>/unlink SOLANA_TOKEN_MINT</code>');
  const r=await env.DB.prepare('DELETE FROM project_groups WHERE mint=? AND chat_id=?').bind(arg,String(msg.chat.id)).run();
  return say(env,msg.chat.id,changed(r)?'✅ Group unlinked. Active battle posts will remain until the fight ends.':'This token is not linked to this group.');
}
async function challengeView(env,chat,id){
  const f=await detail(env,id);if(!f)return say(env,chat,'Challenge not found.');
  if(f.status!=='pending')return say(env,chat,`This fight has the status ${html(f.status)}.`);
  return say(env,chat,`🥊 <b>NEW ASTY TOKEN FIGHT CHALLENGE</b>\n${html(tokenLabel(f.sym_a))} challenges ${html(tokenLabel(f.sym_b))}!\n⏳ 24 hours · 50% votes · 50% price change\n\nYou must be an admin of a group linked to ${html(tokenLabel(f.sym_b))}.`,{reply_markup:keyboard([[{text:'✅ Accept challenge',callback_data:`accept:${f.id}`}],[{text:'❌ Decline',callback_data:`decline:${f.id}`} ],...siteButtons(f).inline_keyboard])});
}
async function accept(env,query,id,decline=false){
  const uid=query.from.id,chat=query.message.chat.id;
  if(query.message.chat.type!=='private')return say(env,chat,'Open this challenge in the private bot chat.');
  const f=await detail(env,id);if(!f||f.status!=='pending')return say(env,chat,'This challenge is no longer pending.');
  if(!(await groupForAdmin(env,f.mint_b,uid)))return say(env,chat,`You must be an admin of a group linked to ${html(tokenLabel(f.sym_b))}. Link the group first using <code>/link ${html(f.mint_b)}</code>.`);
  if(decline){
    const r=await env.DB.prepare(`UPDATE fights SET status='declined' WHERE id=? AND status='pending'`).bind(id).run();
    return say(env,chat,changed(r)?'Challenge declined.':'Challenge already processed.');
  }
  let p;
  try{p=await prices(env,f.mint_a,f.mint_b);}catch(e){return say(env,chat,'Cannot start this fight because the price source is unavailable: '+html(errString(e)));}
  if(!p[0]||!p[1])return say(env,chat,'Birdeye has no price for at least one token. Fight not started.');
  const videoId=await getFightVideo(env);
  if(!videoId)return say(env,chat,
    '🎬 The official fight video is not configured. Ask the ASTY operator to finish the initial setup before starting a fight.',
    {reply_markup:keyboard([[{text:'🏠 Main Menu',callback_data:'menu:home'}]])});
  const t=now();
  try{
    // D1 batch is transactional: either BOTH token locks + status change succeed or none.
    const batch=await env.DB.batch([
      env.DB.prepare(`INSERT INTO active_token_locks(mint,fight_id) SELECT mint_a,id FROM fights WHERE id=? AND status='pending'`).bind(id),
      env.DB.prepare(`INSERT INTO active_token_locks(mint,fight_id) SELECT mint_b,id FROM fights WHERE id=? AND status='pending'`).bind(id),
      env.DB.prepare(`UPDATE fights SET status='active',accepted_by=?,started_at=?,ends_at=?,start_price_a=?,start_price_b=?,latest_price_a=?,latest_price_b=?,last_price_at=?,next_refresh_at=? WHERE id=? AND status='pending'`).bind(String(uid),t,t+DAY,p[0],p[1],p[0],p[1],t,t+REFRESH_INTERVAL,id)
    ]);
    if(!changed(batch[2]))return say(env,chat,'This challenge has already been processed.');
  }catch(e){return say(env,chat,'One of these tokens is already in another active fight. Try accepting the challenge later.');}
  await say(env,chat,`✅ Challenge accepted! The 24-hour fight is now live in both groups.`,websiteOptions(f));
  await say(env,f.creator_id,`🥊 ${html(tokenLabel(f.sym_b))} accepted! Fight ${f.id} is LIVE.`,websiteOptions(f)).catch(()=>{});
  await postFight(env,id);
}
async function vote(env,q,id,side){
  const f=await detail(env,id);
  if(!f||f.status!=='active'||now()>=f.ends_at)return telegram(env,'answerCallbackQuery',{callback_query_id:q.id,text:'This fight is no longer active.',show_alert:true});
  const r=await env.DB.prepare(`INSERT OR IGNORE INTO votes(fight_id,voter_id,side,voted_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM fights WHERE id=? AND status='active' AND ends_at>?)`).bind(id,String(q.from.id),side,now(),id,now()).run();
  const selected=tokenLabel(side==='a'?f.sym_a:f.sym_b);
  const newVote=changed(r), message=`🔥 New vote for ${selected} 🔥`;
  // Acknowledge Telegram's tap promptly; the public post is a separate group message.
  await telegram(env,'answerCallbackQuery',{callback_query_id:q.id,text:newVote?message:'You have already voted or this fight has ended.',show_alert:false});
  if(newVote){
    // Announce each newly counted vote in BOTH project communities, concurrently.
    // Include chats from existing fight posts if a group was unlinked mid-fight.
    try{
      const chats=await env.DB.prepare(`SELECT DISTINCT chat_id FROM project_groups WHERE mint IN (?,?)
        UNION SELECT DISTINCT chat_id FROM group_messages WHERE fight_id=?`)
        .bind(f.mint_a,f.mint_b,id).all();
      const targets=(chats.results||[]).map(row=>row.chat_id).filter(chatId=>chatId!=null);
      const deliveries=await Promise.allSettled(targets.map(chatId=>say(env,chatId,message)));
      deliveries.forEach((delivery,i)=>{
        if(delivery.status==='rejected')console.error('vote announcement failed',id,targets[i],errString(delivery.reason));
      });
      if(!targets.length)console.error('vote announcement: no project groups found',id);
    }catch(e){
      // The vote remains valid even when Telegram or group discovery is temporarily down.
      console.error('vote announcement lookup',id,errString(e));
    }
  }
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
  if(!list.results.length)return say(env,chat,history?'No completed fights yet.':'No active fights right now.');
  const lines=[history?'🏆 <b>ASTY Token Fight – Hall of Fame</b>':'🥊 <b>Active fights</b>'];
  for(const row of list.results){const f=await detail(env,row.id);if(!f)continue;
    lines.push(`${html(tokenLabel(f.sym_a))} VS ${html(tokenLabel(f.sym_b))} · <code>${html(f.id)}</code>${history?(f.status==='ended'?` · Winner: ${f.winner==='draw'?'Draw':html(tokenLabel(f.winner==='a'?f.sym_a:f.sym_b))}`:' · No result'):' · LIVE'}`);
  }
  lines.push('\n/status FIGHT_ID for details\n\n<b>Powered by ASTY <a href="https://arbstrategy.net/">ArbStrategy.net</a></b>');
  return say(env,chat,lines.join('\n'));
}
async function onUpdate(env,u){
  if(u.callback_query){
    const q=u.callback_query,parts=(q.data||'').split(':');
    if(parts[0]==='vote'&&['a','b'].includes(parts[2]))return vote(env,q,parts[1],parts[2]);
    await telegram(env,'answerCallbackQuery',{callback_query_id:q.id}).catch(()=>{});
    if(parts[0]==='accept'||parts[0]==='decline')return accept(env,q,parts[1],parts[0]==='decline');
    return menuCallback(env,q);
  }
  const msg=u.message;
  if(msg?.video?.file_id)return receiveFightVideo(env,msg);
  if(msg?.photo?.length)return receiveLogoPhoto(env,msg);
  if(!msg?.text||!msg.from)return;
  const chat=msg.chat.id,privateChat=msg.chat.type==='private';
  const [raw,...args]=msg.text.trim().split(/\s+/),cmd=raw.toLowerCase().split('@')[0];
  if(cmd==='/link')return linkGroup(env,msg,args[0]);
  if(cmd==='/unlink')return unlinkGroup(env,msg,args[0]);
  if(!privateChat){
    if(msg.reply_to_message?.from?.username===env.BOT_USERNAME.replace('@','') &&
      msg.reply_to_message?.text?.startsWith('🔗 Reply with the Solana token mint address')){
      return linkGroup(env,msg,raw);
    }
    if(cmd==='/start'||cmd==='/menu')return groupHome(env,chat);
    if(cmd==='/help')return helpScreen(env,chat,null,true);
    return;
  }
  if(cmd==='/start'){
    if(args[0]?.startsWith('challenge_'))return challengeView(env,chat,args[0].slice(10));
    if(args[0]?.startsWith('website_'))return websiteInfo(env,chat,msg.from.id,args[0].slice(8));
    if(args[0]?.startsWith('logo_'))return beginLogoUpload(env,chat,msg.from.id,args[0].slice(5));
    return menuHome(env,chat);
  }
  if(cmd==='/menu')return menuHome(env,chat);
  if(cmd==='/projects')return projectsScreen(env,chat,msg.from.id);
  if(cmd==='/website')return projectsScreen(env,chat,msg.from.id,null,true);
  if(cmd==='/video')return videoScreen(env,chat,msg.from.id);
  if(cmd==='/help')return helpScreen(env,chat);
  if(cmd==='/fights')return fightScreen(env,chat,msg.from.id,false);
  if(cmd==='/history')return args[0]&&mintOk(args[0])?fightList(env,chat,true,args[0]):fightScreen(env,chat,msg.from.id,true);
  if(cmd==='/status'){
    if(!args[0])return say(env,chat,'Usage: <code>/status FIGHT_ID</code>');
    const text=await statusText(env,args[0]);return say(env,chat,text||'Fight not found.');
  }
  if(cmd==='/withdraw'){
    const f=args[0]?await detail(env,args[0]):null;
    if(!f||f.creator_id!==String(msg.from.id)||f.status!=='pending')return say(env,chat,'Only the creator can withdraw a pending challenge.');
    const r=await env.DB.prepare(`UPDATE fights SET status='cancelled' WHERE id=? AND status='pending'`).bind(f.id).run();
    return say(env,chat,changed(r)?'✅ Challenge withdrawn. You can create a new fight.':'This challenge has already been processed.');
  }
  if(cmd==='/stop')return stopFight(env,chat,msg.from.id,args[0]);
  if(cmd==='/refresh')return refreshFightNow(env,chat,msg.from.id,args[0]);
  if(cmd==='/cancel'){await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();return say(env,chat,'Challenge setup cancelled.');}
  if(cmd==='/new'){
    if(args.length>=2)return createFight(env,msg.from.id,args[0],args[1],chat);
    await env.DB.prepare('DELETE FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).run();
    return newFightScreen(env,chat,msg.from.id);
  }
  if(!raw.startsWith('/')){
    const draft=await env.DB.prepare('SELECT * FROM draft_state WHERE user_id=?').bind(String(msg.from.id)).first();
    if(draft?.step==='website'&&now()-draft.updated_at<=1800)return websiteSave(env,chat,msg.from.id,draft.own_mint,raw);
    if(draft?.step==='website_group'&&now()-draft.updated_at<=1800){
      const [mint,groupId,...extra]=String(draft.own_mint||'').split('|');
      if(extra.length||!mintOk(mint)||!groupId)return say(env,chat,'Invalid group website session. Please reopen Project Websites.');
      return websiteGroupSave(env,chat,msg.from.id,mint,groupId,raw);
    }
    if(draft?.step==='logo'&&now()-draft.updated_at<=1800)return say(env,chat,'📷 Please send an image as a Telegram photo, not a text message.');
    if(draft?.step==='video'&&now()-draft.updated_at<=1800)return say(env,chat,'🎬 Please send the MP4 as a Telegram video attachment, not a text message.');
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
  // Countdown reminders must run every minute, not only when 30-minute posts are due.
  await sendFinalCountdownReminders(env).catch(e=>console.error('countdown scheduler',errString(e)));
  // Rotate through all eligible active fights. A price API failure must NEVER stop
  // voting/countdown updates or block a new Telegram post.
  const active=await env.DB.prepare(`SELECT id,mint_a,mint_b FROM fights WHERE status='active' AND ends_at>? AND (next_refresh_at IS NULL OR next_refresh_at<=?) ORDER BY next_refresh_at LIMIT 40`)
    .bind(now(),now()).all();
  for(const f of active.results||[]){
    const claim=await env.DB.prepare(`UPDATE fights SET next_refresh_at=? WHERE id=? AND status='active' AND ends_at>? AND (next_refresh_at IS NULL OR next_refresh_at<=?)`)
      .bind(now()+120,f.id,now(),now()).run();
    if(!changed(claim))continue;
    let justPosted=new Set(),result={targets:0,sent:0,failed:0};
    let priceError=null;
    try{
      const [a,b]=await prices(env,f.mint_a,f.mint_b);
      if(a&&b){
        await env.DB.prepare(`UPDATE fights SET latest_price_a=?,latest_price_b=?,last_price_at=? WHERE id=? AND status='active'`)
          .bind(a,b,now(),f.id).run();
      }else priceError='Price API returned incomplete data';
    }catch(e){
      priceError=errString(e);
      console.error('price refresh failed but Telegram posting continues',f.id,priceError);
    }
    try{justPosted=await postFight(env,f.id);}
    catch(e){console.error('initial video retry',f.id,errString(e));}
    try{result=await refreshMessages(env,f.id,false,true,justPosted);}
    catch(e){result.failed++;console.error('repost',f.id,errString(e));}
    try{await sendMilestones(env,f.id);}
    catch(e){console.error('milestone',f.id,errString(e));}
    const success=result.failed===0&&(result.sent>0||justPosted.size>0);
    const delay=success?REFRESH_INTERVAL:90;
    await env.DB.prepare("UPDATE fights SET next_refresh_at=? WHERE id=? AND status='active'")
      .bind(now()+delay,f.id).run();
    console.log('fight refresh',f.id,'new_posts',result.sent,'new_groups',justPosted.size,
      'failed_groups',result.failed,'next_seconds',delay,'price',priceError||'ok');
  }
  // Retry unfinished final notifications if Telegram was temporarily unavailable.
  const pendingNotifications=await env.DB.prepare(`SELECT DISTINCT gm.fight_id FROM group_messages gm JOIN fights f ON f.id=gm.fight_id LEFT JOIN sent_events e ON e.fight_id=f.id AND e.chat_id=gm.chat_id AND e.event_type='end_'||f.status WHERE f.status IN ('ended','unresolved','cancelled') AND (e.sent_at IS NULL OR e.sent_at<=0) ORDER BY f.archived_at DESC LIMIT 15`).all();
  for(const row of pendingNotifications.results)await refreshMessages(env,row.fight_id,true).catch(e=>console.error('retry final',row.fight_id,errString(e)));
  // After 30 days the votes are deleted. The archived aggregate remains correct.
  await env.DB.prepare(`DELETE FROM votes WHERE fight_id IN (SELECT id FROM fights WHERE status IN ('ended','unresolved','cancelled') AND archived_at<?)`).bind(now()-VOTE_RETENTION).run();
}
// Register the Telegram webhook from inside Cloudflare. Secrets never pass through a browser URL.
// The fingerprint makes registration idempotent and reconfigures Telegram if secrets change.
async function handleUpdateWithFeedback(env,update){
  try{
    await ensureWebsiteTable(env);
    await ensureLogoTable(env);
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
    if(url.pathname==='/health'&&request.method==='GET'){
      let started=null,completed=null,videoConfigured=false;
      try{
        const rows=await env.DB.prepare("SELECT key,value FROM worker_settings WHERE key IN ('cron_last_started','cron_last_completed','fight_video_file_id')").all();
        for(const row of rows.results||[]){
          if(row.key==='cron_last_started')started=row.value;
          if(row.key==='cron_last_completed')completed=row.value;
          if(row.key==='fight_video_file_id')videoConfigured=!!row.value;
        }
      }catch(e){console.error('health database query',errString(e));}
      return Response.json({status:'ok',app:'ASTY Token Fight',version:'0.8.2',
        cron_last_started:started,cron_last_completed:completed,video_configured:videoConfigured});
    }
    if(url.pathname!=='/telegram'||request.method!=='POST')return new Response('Not Found',{status:404});
    if(!env.TELEGRAM_WEBHOOK_SECRET||request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.TELEGRAM_WEBHOOK_SECRET)return new Response('Unauthorized',{status:401});
    let update;try{update=await request.json();}catch{return new Response('Bad JSON',{status:400});}
    ctx.waitUntil(handleUpdateWithFeedback(env,update));
    return new Response('OK');
  },
  async scheduled(_event,env,ctx){
    ctx.waitUntil((async()=>{
      await ensureWebsiteTable(env);
      await ensureLogoTable(env);
      // A persisted heartbeat tells us if Cloudflare actually executes the cron.
      await env.DB.prepare("INSERT INTO worker_settings(key,value,updated_at) VALUES('cron_last_started',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(new Date().toISOString(),now()).run().catch(e=>console.error('cron heartbeat',errString(e)));
      await ensureTelegramWebhook(env).catch(e=>console.error('telegram webhook setup',errString(e)));
      await ensureBotCommands(env).catch(e=>console.error('Telegram commands setup',errString(e)));
      await tick(env);
      await env.DB.prepare("INSERT INTO worker_settings(key,value,updated_at) VALUES('cron_last_completed',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(new Date().toISOString(),now()).run().catch(e=>console.error('cron completion heartbeat',errString(e)));
    })().catch(e=>console.error('cron',errString(e))));
  }
};
