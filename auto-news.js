// auto-news.js — 熱門新聞 → 3000–3600字 → 兩張圖 → WordPress（分類、標籤、RankMath、排程/HTTP）
require('dotenv').config();
try { require('dns').setDefaultResultOrder('ipv4first'); } catch {}

const axios = require('axios');
const Parser = require('rss-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const slugify = require('slugify');
const sharp = require('sharp');
const OpenAI = require('openai');

const {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_PROJECT,
  OPENAI_MODEL = 'gpt-4o-mini',

  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,

  FEED_URLS = '',
  WP_CATEGORY_ANALYSIS_ID = '',
  WP_STATUS = 'publish',           // 改回草稿：draft
  IMG_SIZE = '1536x1024',
  DEBUG = '0',

  SCHEDULE = '1',
  WEB_ENABLE = '0',
  WEB_TOKEN = '',
  PORT = '3000',

  HERO_TEXT = '1',                 // 1=封面加字；0=不加字
  CTA_ENABLE = '1',                // 1=文末插入 CTA（含 QR 碼）
} = process.env;

if (!OPENAI_API_KEY || !WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.error('❌ 缺少必要環境變數：OPENAI_API_KEY / WP_URL / WP_USER / WP_APP_PASSWORD');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL || undefined,
  project: OPENAI_PROJECT || undefined,
});
const base = (OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/,'');
const log = (...a)=> (DEBUG==='1'?console.log(...a):void 0);

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
  console.error(`✖ ${label}：`+(parts.join(' | ')||e));
}
const NETCODES=new Set(['ECONNRESET','ETIMEDOUT','ENETDOWN','ENETUNREACH','EAI_AGAIN']);
const isConnErr=e=>(e?.message||'').toLowerCase().includes('connection error')||NETCODES.has(e?.code);
async function withRetry(fn,label='動作',tries=4,baseMs=600){
  let last; for(let i=0;i<tries;i++){
    try{ return await fn(); }
    catch(e){ last=e;
      if(!isConnErr(e) || i===tries-1){ explainError(e,label); throw e; }
      const wait=Math.round(baseMs*Math.pow(2,i)*(1+Math.random()*0.3));
      console.warn(`⚠ ${label} 第${i+1}/${tries}次失敗，${wait}ms 後重試…`); await new Promise(r=>setTimeout(r,wait));
    }
  } throw last;
}

/* =============== RSS =============== */
const DEFAULT_FEEDS = [
  'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.reuters.com/reuters/worldNews'
];
const parser=new Parser({
  headers:{'User-Agent':'Mozilla/5.0','Accept':'application/rss+xml,application/xml;q=0.9,*/*;q=0.8'},
});

// 👉 政治黑名單（只用於 RSS 過濾，避免政治類新聞）
const POLITICS_BLOCK = /(政治|選舉|總統|立法院|政黨|國會|議員|內閣|部長|罷免|公投|藍營|綠營|藍白|兩岸|統獨|外交|國防|國安|國臺辦|台獨|一國兩制|國民黨|民進黨|時力|基進|親民黨|民眾黨)/i;

async function pickOneFeedItem(){
  const FEEDS=(FEED_URLS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const sources=FEEDS.length?FEEDS:DEFAULT_FEEDS;
  const store=readStore(); const seen=new Set(store.items.map(x=>x.hash));
  for(const url of sources){
    try{
      const feed=await parser.parseURL(url);
      for(const item of (feed.items||[])){
        const key=item.link||item.guid||item.title||JSON.stringify(item);
        const h=sha1(key);
        if(seen.has(h)) continue;
        if(await wpAlreadyPostedByTitle(item.title || '')) continue;

        // 👉 新增：標題/摘要含政治關鍵字就跳過
        const ttl = item.title || '';
        const snip = item.contentSnippet || item.content || '';
        if (POLITICS_BLOCK.test(ttl) || POLITICS_BLOCK.test(snip)) continue;

        return {feedUrl:url,item,hash:h};
      }
    }catch(e){ explainError(e,'讀取RSS失敗 '+url); }
  }
  return null;
}

/* =============== OpenAI =============== */
function authHeaders(){
  const h={Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'};
  if(OPENAI_PROJECT) h['OpenAI-Project']=OPENAI_PROJECT;
  return h;
}
async function chatText(system,user,label='OpenAI'){
  return await withRetry(async ()=>{
    try{
      const resp=await client.chat.completions.create({ model:OPENAI_MODEL, temperature:0.6, messages:[
        {role:'system',content:system},{role:'user',content:user}
      ]});
      return resp.choices?.[0]?.message?.content?.trim()||'';
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
  const s=text.indexOf('{'), e=text.lastIndexOf('}');
  if(s>-1 && e>s){ try{ return JSON.parse(text.slice(s,e+1)); }catch{} }
  const m=text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(m){ try{ return JSON.parse(m[1]); }catch{} }
  try{ return JSON.parse(text); }catch{ return null; }
}

/* =============== 清理 & 標題去重 =============== */
const URL_RE=/\bhttps?:\/\/[^\s<>"'）)]+/gi;
const WWW_RE=/\bwww\.[^\s<>"'）)]+/gi;
const BAD_H2_RE=/(來源|出處|延伸閱讀|參考資料|傳送門|原文|全文|更多)/i;
const BAD_LINE_RE=/(來源|出處|延伸閱讀|參考資料|傳送門)[:：]/i;

const stripUrls=s=> (s||'').replace(URL_RE,'').replace(WWW_RE,'').replace(/\s{2,}/g,' ').trim();
const cleanParagraph=p=> stripUrls((p||'').replace(BAD_LINE_RE,'').trim());
const cleanHeading=h=>{ const t=(h||'').trim(); return BAD_H2_RE.test(t)?'':t; };

function sanitizeDraft(d){
  const out={
    focus_keyword: stripUrls(d.focus_keyword||''),
    catchy_title: stripUrls(d.catchy_title||''),
    hero_text: stripUrls(d.hero_text||''),
    intro_paragraphs:(d.intro_paragraphs||[]).map(cleanParagraph).filter(Boolean),
    sections:[]
  };
  (d.sections||[]).forEach(sec=>{
    const hh=cleanHeading(sec.heading);
    if(!hh) return;
    const pars=(sec.paragraphs||[]).map(cleanParagraph).filter(Boolean);
    if(pars.length) out.sections.push({heading:hh,paragraphs:pars});
  });
  return out;
}

function normalizeTitle(s){ return (s||'').toLowerCase().replace(/[^\u4e00-\u9fff\w]/g,''); }
async function ensureUniqueTitle(srcTitle, modelTitle){
  let t=modelTitle||'';
  const a=normalizeTitle(srcTitle), b=normalizeTitle(t);
  if(!t || a===b || a.includes(b) || b.includes(a)){
    const sys='你是資深中文標題編輯，請產出一個**與提供標題不同**、中立、可讀性高、12–24字的中文新標題。只輸出標題文字。';
    t = await chatText(sys, `提供標題：${srcTitle}`, 'OpenAI 標題改寫');
    t = (t||'').replace(/\n/g,'').trim();
  }
  return t || srcTitle;
}

// 👉 新增：避免第一個小標題與開頭重複或含「我是文樂」
function sameText(a, b) {
  const x = (a || '').replace(/\s+/g, '').slice(0, 20);
  const y = (b || '').replace(/\s+/g, '').slice(0, 20);
  return x && y && (x === y || x.includes(y) || y.includes(x));
}
function adjustFirstHeading(d) {
  if (!d?.sections?.length) return d;
  const helloRe = /哈囉，?大家好，?我是文樂/;
  const introFirst = (d.intro_paragraphs?.[0] || '').trim();
  const first = d.sections[0];

  if (!first.heading || helloRe.test(first.heading) || sameText(first.heading, introFirst)) {
    first.heading = '事件重點';
  }
  if (Array.isArray(first.paragraphs) && first.paragraphs.length) {
    first.paragraphs = first.paragraphs
      .map(p => (p || '').replace(helloRe, '').trim())
      .filter(Boolean);
  }
  return d;
}

/* =============== 長文生成 =============== */
async function writeLongArticle({title,link,snippet}){
  const sys=`你是繁體中文（台灣）新聞專欄編輯。請依「標題與摘要」寫出 3000–3600 字可直接發布的文章草稿：
- 用自己的話改寫與延伸，資訊密度高、結構清楚，口吻中立。
- 全文**禁止**出現「來源／出處／延伸閱讀／參考資料／傳送門」等字眼，**禁止**任何連結或網址（http、https、www、.com、.tw…）。
- 文章分成 **6 段主題**，每段一個 h2 小標（不含井號），每段 2–4 段敘述；小標精煉、不可含網址或來源字眼。
- 開頭第一句固定：「哈囉，大家好，我是文樂。」後接 2–3 段前言。
- 正文僅一次在適當段落末尾放「[內文圖]」標記（協助我們插入內文圖片）。
- 結尾 2 段做總結與延伸觀點。
- 僅輸出 **JSON**：{focus_keyword, catchy_title, hero_text, sections:[{heading, paragraphs:[...]}], intro_paragraphs:[...]}
- 不要加任何解釋或程式碼框。`;

  const usr=`標題：${title}
摘要：${snippet || '(RSS 無摘要)'}`;

  let txt; try{ txt=await chatText(sys, usr, 'OpenAI 文字生成(初次)'); }
  catch(e){ explainError(e,'OpenAI 文字生成失敗(初次)'); throw e; }

  let data=extractJSON(txt);
  if(!data){
    const fixSys='只輸出「有效 JSON」。結構必須為 {focus_keyword, catchy_title, hero_text, sections:[{heading, paragraphs:[...]}], intro_paragraphs:[...]}。';
    let fix=''; try{ fix=await chatText(fixSys, txt, 'OpenAI JSON修復'); }catch(e){ explainError(e,'OpenAI JSON修復失敗'); }
    data=extractJSON(fix); if(!data) throw new Error('最終仍無法解析 JSON');
  }
  // 👉 只在清理後補強第一個小標題
  return adjustFirstHeading(sanitizeDraft(data));
}

/* =============== 產圖（封面可疊字） =============== */
function esc(s=''){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function wrapLines(t,n=12){
  const s=(t||'').trim(); if(!s) return [''];
  if(/\s/.test(s)){ const w=s.split(/\s+/), lines=[]; let line='';
    for(const x of w){ if((line+' '+x).trim().length<=n) line=(line?line+' ':'')+x; else{ if(line) lines.push(line); line=x; } }
    if(line) lines.push(line); return lines;
  }
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
  const overlayOff=String(HERO_TEXT||'1')!=='1';
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
  headers: { Authorization:'Basic '+Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64'),
             'User-Agent':'auto-news-script' },
  validateStatus:()=>true,
});
async function uploadMedia(buf,filename,mime){
  const r=await WP.post('/wp-json/wp/v2/media', buf, {
    headers:{'Content-Disposition':`attachment; filename="${filename}"`,'Content-Type':mime},
    maxBodyLength:Infinity, maxContentLength:Infinity,
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
  if(Number.isFinite(extra)&&extra>0) baseIds.unshift(extra);
  return Array.from(new Set(baseIds));
}
async function postToWP({title,content,excerpt,featured_media,focus_kw}){
  const categories=await pickCategories();
  const payload={ title, status:WP_STATUS||'publish', content, excerpt, categories, featured_media,
                  meta:{ rank_math_focus_keyword:focus_kw||'' } };
  for(const ep of ['/wp-json/wp/v2/posts','/index.php?rest_route=/wp/v2/posts']){
    const r=await WP.post(ep,payload,{headers:{'Content-Type':'application/json'}});
    if(r.status>=200 && r.status<300) return r.data;
  }
  throw new Error('發文失敗');
}
async function setPostTags(postId, names){
  const ids=[]; for(const n of names) ids.push(await ensureTerm('tags', n));
  const r=await WP.post(`/wp-json/wp/v2/posts/${postId}`,{tags:ids},{headers:{'Content-Type':'application/json'}});
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

/* =============== Gutenberg blocks（左對齊、薄背景） =============== */
function h2Block(text){
  return `<!-- wp:heading {"textAlign":"left","style":{"spacing":{"padding":{"top":"8px","right":"12px","bottom":"8px","left":"12px"}},"typography":{"lineHeight":"1.2"},"border":{"radius":"8px"},"color":{"background":"#0a2a70","text":"#ffffff"}},"className":"wl-section"} -->
<h2 class="wp-block-heading has-text-align-left wl-section" style="background-color:#0a2a70;color:#ffffff;border-radius:8px;line-height:1.2;padding:8px 12px;"><strong>${text}</strong></h2>
<!-- /wp:heading -->`;
}
function pBlock(text){ return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`; }
function heroFigure(src,cap){
  return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt="${cap}"/><figcaption class="wp-element-caption"><strong>${cap}</strong></figcaption></figure>
<!-- /wp:image -->`;
}
function inlineFigure(src){
  return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt=""/></figure>
<!-- /wp:image -->`;
}
function ctaBlock(){
  if(String(CTA_ENABLE||'1')!=='1') return '';
  return `
${h2Block('關注加入文樂運彩分析領取投注策略')}
${pBlock('我是文樂，一個擁有八年看球及運彩經驗的分析師，2022-25賽季長期穩定勝率57%以上；MLB與NBA預測主推勝率更高。沒時間看球？沒關係，文樂幫您解析進階數據與事件背景，讓我們一起擊敗莊家！')}
${pBlock('<strong>更多賽事推薦請加入官方 LINE：<a href="https://lin.ee/XJQjpHj">@912rdzda</a></strong>')}
<!-- wp:image {"sizeSlug":"full","linkDestination":"none","align":"center","style":{"border":{"radius":"30px"}}} -->
<figure class="wp-block-image aligncenter size-full has-custom-border"><img src="https://bc78999.com/wp-content/uploads/2024/08/M_gainfriends_2dbarcodes_GW-1.png" alt="" style="border-radius:30px"/></figure>
<!-- /wp:image -->
<!-- wp:paragraph {"align":"center"} --><p class="has-text-align-center">文樂運彩Line官方QR code</p><!-- /wp:paragraph -->`;
}
function buildContentJSONToBlocks({heroUrl,heroCaption,inlineImgUrl,intro_paragraphs,sections}){
  let blocks='';
  blocks+=heroFigure(heroUrl,heroCaption);
  blocks+=pBlock('哈囉，大家好，我是文樂。');
  (intro_paragraphs||[]).forEach(t=>{ if(t) blocks+=pBlock(t); });
  let used=false;
  (sections||[]).forEach((sec,idx)=>{
    if(!sec?.heading || !sec?.paragraphs?.length) return;
    blocks+=h2Block(sec.heading);
    sec.paragraphs.forEach(par=>{
      if(!par) return;
      blocks+=pBlock(par);
      if(!used && (/\[內文圖\]/.test(par) || idx===2)){
        if(inlineImgUrl) blocks+=inlineFigure(inlineImgUrl);
        used=true;
      }
    });
  });
  blocks+=ctaBlock();
  return blocks;
}

/* =============== 主流程 =============== */
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

  const draft=await writeLongArticle({
    title:item.title||'', link:item.link||'', snippet:item.contentSnippet||item.content||''
  });

  // 確保標題改寫且不等於來源
  const catchyTitle = await ensureUniqueTitle(item.title||'', draft.catchy_title||item.title||'');
  const focusKeyword= draft.focus_keyword || (catchyTitle.split(' ')[0]) || '熱門新聞';
  const heroText    = draft.hero_text || catchyTitle;

  const basePrompt=`為以下主題產生一張寫實風格、能代表內容的新聞配圖，構圖清楚、對比強烈、適合做橫幅封面：主題「${catchyTitle}」。不要商標、不要文字、避免不當內容。`;
  const contentImgBuf=await genImageBuffer(basePrompt+' 構圖適合內文插圖。', false);
  const heroImgBuf   =await genImageBuffer(basePrompt+' 構圖適合封面。', true, heroText);

  const mediaA=await uploadMedia(heroImgBuf, `hero-${Date.now()}.png`, 'image/png');
  const mediaB=await uploadMedia(contentImgBuf, `inline-${Date.now()}.png`, 'image/png');

  const contentBlocks=buildContentJSONToBlocks({
    heroUrl:mediaA.source_url, heroCaption:`▲ ${heroText}`, inlineImgUrl:mediaB.source_url,
    intro_paragraphs:draft.intro_paragraphs||[], sections:draft.sections||[]
  });

  const wpPost=await postToWP({
    title:catchyTitle, content:contentBlocks, excerpt:focusKeyword, featured_media:mediaA.id, focus_kw:focusKeyword
  });

  // 標籤
  try{
    const tagLine=await chatText(
      '請用繁體中文回覆三個貼切的標籤，僅用中文逗號或頓號分隔，禁止加引號與任何說明。',
      `主題：${catchyTitle}；焦點詞：${focusKeyword}`,
      'OpenAI 標籤生成'
    );
    const tags=(tagLine||'').split(/[，,]/).map(s=>s.trim()).filter(Boolean).slice(0,3);
    if(tags.length){ await setPostTags(wpPost.id, tags); console.log('✓ 已設定標籤：', tags.join(', ')); }
  }catch(e){ explainError(e,'產生標籤失敗（略過）'); }

  const store=readStore(); store.items.push({hash,link:item.link,title:item.title,time:Date.now(),wp_id:wpPost.id}); writeStore(store);
  console.log((WP_STATUS||'publish')==='publish'?'✅ 已發佈：':'✅ 已建立草稿：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');
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
