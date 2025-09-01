// auto-news.js — 熱門新聞（維持原版型：六段落）→ 兩張圖 → WordPress（分類、標籤、RankMath）
// Node >= 18
require('dotenv').config();
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

const axios   = require('axios');
const Parser  = require('rss-parser');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const slugify = require('slugify');
const sharp   = require('sharp');
const OpenAI  = require('openai');

const {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_PROJECT,
  OPENAI_MODEL = 'gpt-4o-mini',

  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,

  FEED_URLS = '',
  FEED_FILTER_EXCLUDE = '娛樂,影劇,星座',   // 逗號分隔：排除字詞（標題含這些就跳過）
  WP_CATEGORY_ANALYSIS_ID = '',

  // 直接發佈；若要草稿請設 WP_STATUS=draft
  WP_STATUS = 'publish',

  IMG_SIZE = '1536x1024',
  DEBUG    = '0',

  SCHEDULE   = '1',
  WEB_ENABLE = '0',
  WEB_TOKEN  = '',
  PORT       = '3000',

  // 0=不疊字（建議，避免 fontconfig 警告）；1=封面疊字
  HERO_TEXT = '0',

  // 0=不插 CTA；1=插入 CTA（保留你的版型但預設關閉）
  SHOW_CTA = '0',
} = process.env;

if (!OPENAI_API_KEY || !WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.error('❌ 缺少必要環境變數：OPENAI_API_KEY / WP_URL / WP_USER / WP_APP_PASSWORD');
  process.exit(1);
}

const client = new OpenAI({
  apiKey : OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL || undefined,
  project: OPENAI_PROJECT || undefined,
});
const base = (OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/,'');
const log  = (...a) => (DEBUG === '1' ? console.log('[debug]', ...a) : void 0);

/* =============== util =============== */
const STORE_FILE = path.resolve(__dirname, 'posted.json');
function readStore(){ try{ return JSON.parse(fs.readFileSync(STORE_FILE,'utf8')); }catch{ return {items:[]}; } }
function writeStore(d){ try{ fs.writeFileSync(STORE_FILE, JSON.stringify(d,null,2)); }catch{} }
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

function explainError(e,label='錯誤'){
  const parts=[];
  if(e?.status) parts.push(`status=${e.status}`);
  if(e?.code) parts.push(`code=${e.code}`);
  if(e?.response?.status) parts.push(`resp=${e.response.status}`);
  if(e?.response?.data){ try{ parts.push(`data=${JSON.stringify(e.response.data).slice(0,250)}`);}catch{} }
  if(e?.message) parts.push(`msg=${e.message}`);
  console.error(`✖ ${label}：` + (parts.join(' | ') || e));
}
const NET_CODES = new Set(['ECONNRESET','ETIMEDOUT','ENETDOWN','ENETUNREACH','EAI_AGAIN']);
const isConnErr = e => (e?.message||'').toLowerCase().includes('connection error') || NET_CODES.has(e?.code);
async function withRetry(fn,label='動作',tries=4,baseMs=600){
  let last;
  for(let i=0;i<tries;i++){
    try{ return await fn(); }
    catch(e){
      last=e;
      if(!isConnErr(e) || i===tries-1){ explainError(e,label); throw e; }
      const wait=Math.round(baseMs*Math.pow(2,i)*(1+Math.random()*0.3));
      console.warn(`⚠ ${label} 第${i+1}/${tries}次失敗，${wait}ms 後重試…`); await new Promise(r=>setTimeout(r,wait));
    }
  } throw last;
}

/* =============== RSS =============== */
// 一般熱門新聞：Google 要聞 / BBC World / Reuters World
const DEFAULT_FEEDS = [
  'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.reuters.com/reuters/worldNews'
];
const parser = new Parser({
  headers:{ 'User-Agent':'Mozilla/5.0', 'Accept':'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
});

// 標題清洗：移除《》《》等與尾巴網站名（—,–,-,| 後面）
function normalizeTitle(t=''){
  let s = (t || '').replace(/[《》「」『』【】]/g, '').trim();
  s = s.split(/[\-|–—|｜]/)[0].trim();
  return s;
}
function shouldSkipByFilter(title=''){
  const bad = (FEED_FILTER_EXCLUDE||'').split(',').map(s=>s.trim()).filter(Boolean);
  const t = title.toLowerCase();
  return bad.some(w=>w && t.includes(w.toLowerCase()));
}

async function pickOneFeedItem(){
  const FEEDS=(FEED_URLS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const sources=FEEDS.length?FEEDS:DEFAULT_FEEDS;
  const store=readStore(); const seen=new Set(store.items.map(x=>x.hash));
  for(const url of sources){
    try{
      const feed=await parser.parseURL(url);
      for(const item of (feed.items||[])){
        const rawTitle = item.title || '';
        if(!rawTitle) continue;
        if(shouldSkipByFilter(rawTitle)) continue;

        const key=item.link||item.guid||rawTitle||JSON.stringify(item);
        const h=sha1(key);
        if(seen.has(h)) continue;
        if(await wpAlreadyPostedByTitle(normalizeTitle(rawTitle))) continue;
        return {feedUrl:url,item,hash:h};
      }
    }catch(e){ explainError(e,'讀取RSS失敗 '+url); }
  }
  return null;
}

/* =============== OpenAI：文字 + JSON =============== */
function authHeaders(){
  const h={ Authorization:`Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' };
  if(OPENAI_PROJECT) h['OpenAI-Project']=OPENAI_PROJECT;
  return h;
}
async function chatText(system,user,label='OpenAI'){
  return await withRetry(async ()=>{
    try{
      const r=await client.chat.completions.create({
        model:OPENAI_MODEL, temperature:0.6,
        messages:[{role:'system',content:system},{role:'user',content:user}]
      });
      return r.choices?.[0]?.message?.content?.trim()||'';
    }catch(e){
      if(isConnErr(e)){
        const body={model:OPENAI_MODEL,temperature:0.6,messages:[{role:'system',content:system},{role:'user',content:user}]};
        const r=await fetch(base+'/chat/completions',{method:'POST',headers:authHeaders(),body:JSON.stringify(body)});
        if(!r.ok) throw new Error(`REST /chat：${r.status} ${await r.text().then(t=>t.slice(0,200))}`);
        const j=await r.json(); return j.choices?.[0]?.message?.content?.trim()||'';
      }
      throw e;
    }
  },label);
}
function extractJSON(text){
  if(!text) return null;
  const m=text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(m){ try{ return JSON.parse(m[1]); }catch{} }
  const s=text.indexOf('{'); const e=text.lastIndexOf('}');
  if(s>-1 && e>s){ try{ return JSON.parse(text.slice(s,e+1)); }catch{} }
  try{ return JSON.parse(text); }catch{ return null; }
}

/* =============== 內容清理（移除網址/來源詞） =============== */
const URL_RE = /\bhttps?:\/\/[^\s<>"'）)]+/gi;
const WWW_RE = /\bwww\.[^\s<>"'）)]+/gi;
// 不把「延伸閱讀」列入，因為它是你的固定段落
const BAD_H2_RE   = /(來源|出處|參考資料|傳送門|原文|全文|更多|新聞來源)/i;
const BAD_LINE_RE = /(來源|出處|參考資料|傳送門|新聞來源)[:：]/i;

function stripUrls(s=''){ return s.replace(URL_RE,'').replace(WWW_RE,'').replace(/\s{2,}/g,' ').trim(); }
function cleanParagraph(p){ return stripUrls((p||'').replace(BAD_LINE_RE,'').trim()); }
function cleanHeading(h){ const t=(h||'').trim(); return BAD_H2_RE.test(t) ? '' : t; }

function sanitizeDraft(draft){
  const out = {
    focus_keyword: stripUrls(draft.focus_keyword || ''),
    catchy_title : stripUrls(draft.catchy_title  || ''),
    hero_text    : stripUrls(draft.hero_text     || ''),
    intro_paragraphs: (draft.intro_paragraphs||[]).map(cleanParagraph).filter(Boolean),
    sections: [],
  };
  (draft.sections||[]).forEach(sec=>{
    const hh = cleanHeading(sec.heading);
    if(!hh) return;
    const pars = (sec.paragraphs||sec.paras||[]).map(cleanParagraph).filter(Boolean);
    out.sections.push({ heading: hh, paragraphs: pars });
  });
  return out;
}

/* =============== 長文生成（維持你原本 6 段版型） =============== */
async function writeLongArticle({title,link,snippet}){
  const sys = `你是繁體中文（台灣）新聞編輯。請依「標題與摘要」寫出 3000–3600 字、可直接發布的文章草稿：
- 完全用自己的話改寫與擴寫，避免抄襲；中立客觀、資訊密度高。
- 全文**禁止**任何連結或網址（http、https、www、.com、.tw…），**禁止**出現「來源／出處／參考資料／傳送門」等字眼。
- 固定 6 段：事件重點、背景脈絡、目前進展、可能影響、延伸閱讀、結語（小標中文字固定不改）。
- 每段 2–4 段落；開頭固定第一句：「哈囉，大家好，我是文樂。」後接 2–3 段導言。
- 在任一合適段落末尾只出現一次「[內文圖]」標記（供內文插圖插入）。
- 僅輸出 JSON 主體：{
  "focus_keyword": "...",
  "catchy_title":  "...",
  "hero_text":     "...",
  "intro_paragraphs": ["..."],
  "sections": [
    {"heading":"事件重點","paragraphs":["..."]},
    {"heading":"背景脈絡","paragraphs":["..."]},
    {"heading":"目前進展","paragraphs":["..."]},
    {"heading":"可能影響","paragraphs":["..."]},
    {"heading":"延伸閱讀","paragraphs":["..."]},
    {"heading":"結語","paragraphs":["..."]}
  ]
}`;

  const usr = `標題：${title}
摘要：${snippet || '(RSS 無摘要)'}
（備註：不要把來源或連結寫進文章，六個小標必須使用上述固定名稱。）`;

  let txt = await chatText(sys, usr, 'OpenAI 文字生成');
  let data = extractJSON(txt);
  if(!data){
    const fixSys='只輸出有效 JSON；修正成 {focus_keyword,catchy_title,hero_text,intro_paragraphs,sections[]} 結構。';
    data = extractJSON(await chatText(fixSys, txt, 'OpenAI JSON修復'));
    if(!data) throw new Error('最終仍無法解析 JSON');
  }
  data.catchy_title = normalizeTitle(data.catchy_title || title || '最新焦點');
  return sanitizeDraft(data);
}

/* =============== 產圖（封面疊字可關閉） =============== */
function esc(s=''){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function wrapLines(t,n=12){
  const s=(t||'').trim(); if(!s) return [''];
  if(/\s/.test(s)){ const w=s.split(/\s+/), lines=[]; let line='';
    for(const x of w){ if((line+' '+x).trim().length<=n) line=(line?line+' ':'')+x; else{ if(line) lines.push(line); line=x; } }
    if(line) lines.push(line); return lines; }
  const lines=[]; for(let i=0;i<s.length;i+=n) lines.push(s.slice(i,i+n)); return lines;
}
function buildHeroSVG(overlayText){
  const lines=wrapLines(overlayText,12);
  let fontSize=86; if(lines.length>=4) fontSize=68; if(lines.length>=6) fontSize=56;
  const lh=Math.round(fontSize*1.25), total=lines.length*lh, startY=512-Math.round(total/2)+fontSize;
  const tsp=lines.map((ln,i)=>`<tspan x="768" dy="${i===0?0:lh}">${esc(ln)}</tspan>`).join('');
  return Buffer.from(
`<svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1536" height="1024" fill="rgba(0,0,0,0.28)"/>
  <text x="768" y="${startY}" text-anchor="middle"
        font-family="Noto Sans CJK TC, Noto Sans TC, Microsoft JhengHei, PingFang TC, system-ui, -apple-system, Segoe UI, Arial"
        font-weight="900" font-size="${fontSize}" fill="#fff" stroke="#000" stroke-width="8" paint-order="stroke">${tsp}</text>
</svg>`, 'utf8');
}
async function imageB64(prompt,size,label='OpenAI 產圖'){
  return await withRetry(async ()=>{
    try{
      const img=await client.images.generate({ model:'gpt-image-1', size, prompt });
      return img.data[0].b64_json;
    }catch(e){
      if(isConnErr(e)){
        const r=await fetch(base+'/images/generations',{method:'POST',headers:authHeaders(),body:JSON.stringify({model:'gpt-image-1',size,prompt})});
        if(!r.ok) throw new Error(`REST /images：${r.status} ${await r.text().then(t=>t.slice(0,200))}`);
        const j=await r.json(); return j.data?.[0]?.b64_json;
      }
      throw e;
    }
  },label);
}
async function genImageBuffer(prompt,withText=false,overlayText=''){
  const overlayOff = String(HERO_TEXT||'0')!=='1';
  let b64;
  try{ b64=await imageB64(prompt, IMG_SIZE||'1536x1024'); }
  catch{ b64=await imageB64(prompt,'1024x1024'); }
  const baseBuf=Buffer.from(b64,'base64');
  if(!withText || overlayOff) return baseBuf;
  const svg=buildHeroSVG(overlayText);
  return await sharp(baseBuf).composite([{input:svg,blend:'over'}]).png().toBuffer();
}

/* =============== WP =============== */
const WP = axios.create({
  baseURL: WP_URL.replace(/\/+$/,''),
  headers: { Authorization: 'Basic '+Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64'), 'User-Agent':'auto-news-script' },
  validateStatus: () => true,
});
async function uploadMedia(buf,filename,mime){
  const r=await WP.post('/wp-json/wp/v2/media', buf, {
    headers:{ 'Content-Disposition':`attachment; filename="${filename}"`, 'Content-Type':mime },
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  if(r.status>=200 && r.status<300) return r.data;
  throw new Error(`WP 媒體上傳失敗：${r.status} ${JSON.stringify(r.data).slice(0,300)}`);
}
async function ensureTerm(tax,name){
  const slug=slugify(name,{lower:true,strict:true});
  const q=await WP.get(`/wp-json/wp/v2/${tax}`,{params:{per_page:100,search:name}});
  if(q.status===200 && Array.isArray(q.data)){
    const hit=q.data.find(t=>t.name===name || t.slug===slug);
    if(hit) return hit.id;
  }
  const c=await WP.post(`/wp-json/wp/v2/${tax}`,{name,slug});
  if(c.status>=200 && c.status<300) return c.data.id;
  throw new Error(`建立 ${tax} 失敗：${c.status} ${JSON.stringify(c.data).slice(0,200)}`);
}
async function ensureDefaultCategories(){
  const names=['即時新聞','最新文章']; const ids=[];
  for(const n of names) ids.push(await ensureTerm('categories',n));
  return ids;
}
async function pickCategories(){
  const baseIds=await ensureDefaultCategories();
  const extra=Number(WP_CATEGORY_ANALYSIS_ID);
  if(Number.isFinite(extra) && extra>0) baseIds.unshift(extra);
  return Array.from(new Set(baseIds));
}
async function postToWP({title,content,excerpt,featured_media,focus_kw}){
  const categories=await pickCategories();
  const payload={ title, status:WP_STATUS||'publish', content, excerpt, categories, featured_media, meta:{ rank_math_focus_keyword:focus_kw||'' } };
  for(const ep of ['/wp-json/wp/v2/posts','/index.php?rest_route=/wp/v2/posts']){
    const r=await WP.post(ep,payload,{headers:{'Content-Type':'application/json'}});
    if(r.status>=200 && r.status<300) return r.data;
  }
  throw new Error('發文失敗');
}
async function setPostTags(postId, names){
  if(!names?.length) return;
  const ids=[]; for(const n of names) ids.push(await ensureTerm('tags', n));
  const r=await WP.post(`/wp-json/wp/v2/posts/${postId}`,{ tags: ids },{headers:{'Content-Type':'application/json'}});
  if(!(r.status>=200 && r.status<300)) console.warn('⚠ 設定標籤失敗：', r.status);
}
async function wpAlreadyPostedByTitle(title){
  if(!title) return false;
  try{
    const r=await WP.get('/wp-json/wp/v2/posts',{params:{search:title,per_page:10,status:'any'}});
    if(r.status!==200 || !Array.isArray(r.data)) return false;
    const t=title.trim().toLowerCase();
    return r.data.some(p=>(p?.title?.rendered||'').replace(/<[^>]+>/g,'').trim().toLowerCase()===t);
  }catch{ return false; }
}

/* =============== Gutenberg blocks（保留你的藍色小標） =============== */
function h2Block(text){ return `<!-- wp:heading {"style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"}},"color":{"background":"#0a2a70"},"typography":{"lineHeight":"1.5"}},"textColor":"palette-color-7","fontSize":"large"} --><h2 class="wp-block-heading has-palette-color-7-color has-text-color has-background has-large-font-size" style="background-color:#0a2a70;line-height:1.5"><strong>${text}</strong></h2><!-- /wp:heading -->`; }
function pBlock(text){ return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`; }
function heroFigure(src,cap){ return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} --><figure class="wp-block-image size-full"><img src="${src}" alt="${cap}"/><figcaption class="wp-element-caption"><strong>${cap}</strong></figcaption></figure><!-- /wp:image -->`; }
function inlineFigure(src){ return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} --><figure class="wp-block-image size-full"><img src="${src}" alt=""/></figure><!-- /wp:image -->`; }
function ctaBlock(){ return `
${h2Block('關注加入文樂運彩分析領取投注策略')}
${pBlock('（此區塊預設關閉；若 SHOW_CTA=1 才會出現）')}
`; }

function buildContentJSONToBlocks({heroUrl,heroCaption,inlineImgUrl,intro_paragraphs,sections}){
  let blocks=''; blocks+=heroFigure(heroUrl,heroCaption); blocks+=pBlock('哈囉，大家好，我是文樂。');
  (intro_paragraphs||[]).forEach(t=>{ if(t) blocks+=pBlock(t); });
  let used=false;
  const order=['事件重點','背景脈絡','目前進展','可能影響','延伸閱讀','結語'];
  order.forEach(wanted=>{
    const sec=(sections||[]).find(s=>s.heading===wanted);
    if(!sec) return;
    blocks+=h2Block(sec.heading);
    (sec.paragraphs||[]).forEach((par,i)=>{
      if(!par) return;
      blocks+=pBlock(par);
      if(!used && inlineImgUrl && wanted==='目前進展' && i>=0){ blocks+=inlineFigure(inlineImgUrl); used=true; }
    });
  });
  if(String(SHOW_CTA||'0')==='1') blocks+=ctaBlock();
  return blocks;
}

/* =============== 自檢、主流程、HTTP =============== */
async function preflight(){
  try{
    const r=await fetch(base+'/models',{headers:{Authorization:`Bearer ${OPENAI_API_KEY}`}}); 
    console.log('OpenAI /models:', r.status, r.statusText);
    if(!r.ok) throw new Error('OpenAI /models 非 2xx');
  }catch(e){ explainError(e,'OpenAI 連線測試失敗'); throw e; }
  try{
    const first=(FEED_URLS||'').split(',').map(s=>s.trim()).filter(Boolean)[0];
    if(first){ const r=await fetch(first); console.log('RSS 測試:', r.status, r.statusText); }
  }catch(e){ console.warn('⚠ RSS 測試警告：', e?.message||e); }
  try{
    const r=await WP.get('/wp-json'); console.log('WP /wp-json:', r.status);
  }catch(e){ explainError(e,'WP 連線測試失敗（不阻擋）'); }
}

async function runOnce(){
  console.log('▶ 開始一次任務');
  const picked=await pickOneFeedItem();
  if(!picked){ console.log('⚠ 沒有新的 RSS 文章'); return; }
  const {item,hash,feedUrl}=picked; log('來源',feedUrl,'→',item.title);

  const cleanTitle = normalizeTitle(item.title||'');
  const draft = await writeLongArticle({ title: cleanTitle, link:item.link||'', snippet:item.contentSnippet||item.content||'' });

  const focusKeyword = draft.focus_keyword || cleanTitle.split(' ')[0] || '熱門新聞';
  const catchyTitle  = normalizeTitle(draft.catchy_title || cleanTitle || '最新焦點');
  const heroText     = draft.hero_text || catchyTitle;

  const basePrompt   = `以「${catchyTitle}」為主題，產生一張不含文字、無商標的寫實新聞示意圖，構圖清楚、對比自然、色彩中性。`;
  const contentImgBuf= await genImageBuffer(basePrompt+' 構圖適合內文插圖。', false);
  const heroImgBuf   = await genImageBuffer(basePrompt+' 構圖適合封面。', true, heroText);

  const mediaA=await uploadMedia(heroImgBuf,   `hero-${Date.now()}.png`,   'image/png');
  const mediaB=await uploadMedia(contentImgBuf,`inline-${Date.now()}.png`, 'image/png');

  const contentBlocks=buildContentJSONToBlocks({
    heroUrl:mediaA.source_url, heroCaption:`▲ ${heroText}`, inlineImgUrl:mediaB.source_url,
    intro_paragraphs:draft.intro_paragraphs||[], sections:draft.sections||[],
  });

  const wpPost=await postToWP({
    title:catchyTitle, content:contentBlocks, excerpt:focusKeyword, featured_media:mediaA.id, focus_kw:focusKeyword,
  });

  // 標籤：用標題+焦點詞生成三個
  try{
    const tagLine=await chatText(
      '請用繁體中文回覆三個貼切的標籤，僅用中文逗號或頓號分隔，禁止加引號與任何說明。',
      `主題：${catchyTitle}；焦點詞：${focusKeyword}`,
      'OpenAI 標籤生成'
    );
    const tags=(tagLine||'').split(/[，,、]/).map(s=>s.trim()).filter(Boolean).slice(0,3);
    await setPostTags(wpPost.id, tags);
  }catch(e){ explainError(e,'產生標籤失敗（略過）'); }

  const store=readStore(); store.items.push({hash,link:item.link,title:item.title,time:Date.now(),wp_id:wpPost.id}); writeStore(store);
  console.log((WP_STATUS||'publish')==='publish' ? '✅ 已發佈：' : '✅ 已建立草稿：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');
}

let isRunning=false;
async function safeRun(){ if(isRunning){ console.log('⏳ 任務執行中，跳過本輪'); return; } isRunning=true; try{ await runOnce(); }catch(e){ explainError(e,'任務失敗'); } finally{ isRunning=false; } }
function bootHttp(){
  const http=require('http'); const {URL}=require('url');
  const srv=http.createServer(async (req,res)=>{
    try{
      const u=new URL(req.url,`http://localhost:${PORT}`);
      if(u.pathname==='/health'){ const s=readStore(); const last=s.items?.[s.items.length-1]?.time||null;
        res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true,items:s.items.length,last_post_time:last})); }
      if(u.pathname==='/run' && req.method==='POST'){
        const token=u.searchParams.get('token')||req.headers['x-run-token'];
        if(!WEB_TOKEN || token!==WEB_TOKEN){ res.writeHead(401); return res.end('unauthorized'); }
        safeRun().then(()=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); })
                 .catch(e=>{ res.writeHead(500); res.end(String(e)); }); return;
      }
      res.writeHead(404); res.end('not found');
    }catch(e){ res.writeHead(500); res.end(String(e)); }
  });
  srv.listen(Number(PORT), ()=>console.log(`HTTP ready on :${PORT}`));
}

(async()=>{
  await preflight();
  if(SCHEDULE==='1'){
    const cron=require('node-cron');
    cron.schedule('0 8,12,20 * * *', ()=>{ console.log('⏰ 排程觸發（Asia/Taipei）'); safeRun(); }, {timezone:'Asia/Taipei'});
    console.log('▶ 已啟動排程：每日 08:00、12:00、20:00（Asia/Taipei）');
    if(WEB_ENABLE==='1') bootHttp();
  }else{
    if(WEB_ENABLE==='1'){ console.log('▶ SCHEDULE=0：等待 /run 觸發'); bootHttp(); }
    else{ await safeRun(); process.exit(0); }
  }
})().catch(e=>{ explainError(e,'啟動失敗'); process.exitCode=1; });
