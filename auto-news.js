// auto-news.js — 熱門新聞 → 六段版型（事件重點/背景脈絡/目前進展/可能影響/延伸閱讀/結語）→ 2 張圖 → WordPress
// Node >= 18
import 'dotenv/config';
import axios from 'axios';
import Parser from 'rss-parser';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import slugify from 'slugify';
import sharp from 'sharp';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';

try { import('dns').then(d => d.setDefaultResultOrder?.('ipv4first')).catch(() => {}); } catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ========= 環境變數 ========= */
const {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_PROJECT,
  OPENAI_MODEL = 'gpt-4o-mini',

  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,

  FEED_URLS = '',                         // 逗號分隔
  FEED_FILTER_EXCLUDE = '娛樂,影劇,星座',   // 逗號分隔（排除）
  WP_CATEGORY_ANALYSIS_ID = '',
  WP_STATUS = 'publish',                  // 直接發佈（改 draft 則存草稿）
  IMG_SIZE = '1536x1024',
  DEBUG = '0',

  // 額外開關
  SHOW_CTA = '0',       // 0 = 不放 CTA
  HERO_TEXT = '0',      // 0 = 不疊大字（避免 fontconfig 警告）
} = process.env;

if (!OPENAI_API_KEY || !WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.error('❌ 缺少必要環境變數：OPENAI_API_KEY / WP_URL / WP_USER / WP_APP_PASSWORD');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL || undefined,
  project: OPENAI_PROJECT  || undefined,
});
const base = (OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const log  = (...a) => (DEBUG === '1' ? console.log('[debug]', ...a) : void 0);

/* ========= 小工具 ========= */
const STORE_FILE = path.resolve(__dirname, 'posted.json');
function readStore(){ try{ return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }catch{ return {items:[]}; } }
function writeStore(d){ try{ fs.writeFileSync(STORE_FILE, JSON.stringify(d, null, 2)); }catch{} }
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
async function withRetry(fn,label='動作',tries=4,baseMs=700){
  let last;
  for(let i=0;i<tries;i++){
    try{ return await fn(); }
    catch(e){
      last=e;
      if(!isConnErr(e) || i===tries-1){ explainError(e,label); throw e; }
      const wait=Math.round(baseMs*Math.pow(2,i)*(1+Math.random()*0.3));
      console.warn(`⚠ ${label} 第 ${i+1}/${tries} 次失敗，${wait}ms 後重試…`); await new Promise(r=>setTimeout(r,wait));
    }
  } throw last;
}

/* ========= RSS 來源 ========= */
const DEFAULT_FEEDS = [
  'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  'https://feeds.reuters.com/reuters/worldNews',
  'https://feeds.bbci.co.uk/news/world/rss.xml'
];

const parser = new Parser({
  headers:{ 'User-Agent':'Mozilla/5.0 (auto-news)', 'Accept':'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' }
});

function shouldSkipTitleByFilter(title=''){
  const bad = (FEED_FILTER_EXCLUDE||'').split(',').map(s=>s.trim()).filter(Boolean);
  const t = title.toLowerCase();
  return bad.some(w=>w && t.includes(w.toLowerCase()));
}

// 去掉尾巴網站名與奇怪書名號
function normalizeTitle(t=''){
  let s = t.replace(/[《》「」『』【】]/g,'').trim();
  // 切掉「—」「–」「-」「｜」「|」後面的來源
  s = s.split(/[\-|–—|｜]/)[0].trim();
  return s;
}

async function pickOneFeedItem(){
  const FEEDS=(FEED_URLS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const sources=FEEDS.length?FEEDS:DEFAULT_FEEDS;
  const store=readStore(); const seen=new Set(store.items.map(x=>x.hash));
  for(const url of sources){
    try{
      const feed=await parser.parseURL(url);
      for(const item of feed.items||[]){
        const rawTitle = item.title || '';
        if(!rawTitle) continue;
        if(shouldSkipTitleByFilter(rawTitle)) continue;
        const key = item.link || item.guid || rawTitle || JSON.stringify(item);
        const h   = sha1(key);
        if(seen.has(h)) continue;
        if(await wpAlreadyPostedByTitle(normalizeTitle(rawTitle))) continue;
        return { feedUrl:url, item, hash:h };
      }
    }catch(e){ explainError(e,'讀取RSS失敗 '+url); }
  }
  return null;
}

/* ========= OpenAI ========= */
function authHeaders(){
  const h={ Authorization:`Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' };
  if(OPENAI_PROJECT) h['OpenAI-Project']=OPENAI_PROJECT;
  return h;
}
async function chatText(system,user,label='OpenAI'){
  return await withRetry(async ()=>{
    try{
      const r=await client.chat.completions.create({
        model: OPENAI_MODEL, temperature: 0.6, messages: [
          {role:'system',content:system},
          {role:'user',content:user}
        ]
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

// 抽 JSON
function extractJSON(text){
  if(!text) return null;
  const m=text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(m){ try{ return JSON.parse(m[1]); }catch{} }
  const s=text.indexOf('{'); const e=text.lastIndexOf('}');
  if(s>-1 && e>s){ try{ return JSON.parse(text.slice(s,e+1)); }catch{} }
  try{ return JSON.parse(text); }catch{ return null; }
}

/* ========= 生成稿件（嚴格改寫＋六段） ========= */
async function writeSixSections({title,link,snippet}){
  const sys=`你是台灣繁體中文新聞編輯。僅根據「來源標題與摘要」，用中立清楚的語氣，產出可直接發佈的文章結構。
**嚴禁**複製來源原句；**嚴禁**出現來源網站、時間、作者、網址或「新聞來源」區塊。
文章語言需自然、口語而專業，避免艱澀名詞堆疊。`;

  const usr=`請用 JSON 回覆：
{
  "catchy_title": "乾淨標題（不可帶網站名/記者名/書名號/管線）",
  "focus_keyword": "1 個焦點詞",
  "intro": "1~2 段導言（不提來源）",
  "sections": [
    {"heading":"事件重點","paras":["…","…"]},
    {"heading":"背景脈絡","paras":["…","…"]},
    {"heading":"目前進展","paras":["…","…"]},
    {"heading":"可能影響","paras":["…","…"]},
    {"heading":"延伸閱讀","paras":["…","…"]},
    {"heading":"結語","paras":["…","…"]}
  ],
  "tags": ["3 個貼切關鍵詞，無井號無引號"]
}
注意：
- 上述 6 個 heading 文案固定不改動。
- 內容需改寫 + 擴寫 + 整理脈絡，避免逐字重現原文，類似度<50%。
- 不要加任何說明文字或 Markdown，僅輸出 JSON 主體。

來源標題：${title}
來源摘要：${snippet || '(RSS 無摘要)'}
僅供理解，**不可**在文中提到或引用：${link || '(無)'}
`;

  let txt = await chatText(sys, usr, 'OpenAI 六段生成');
  let data = extractJSON(txt);
  if(!data){
    const fixSys='你是一個只輸出「有效 JSON」的修復器。直接回傳 JSON 主體，不得有任何多餘文字。';
    const fixUsr=`修正為有效 JSON：\n${txt}`;
    data = extractJSON(await chatText(fixSys, fixUsr, 'OpenAI JSON修復'));
    if(!data) throw new Error('最終仍無法解析 JSON');
  }
  // 清洗標題
  data.catchy_title = normalizeTitle(data.catchy_title||title||'最新焦點');
  return data;
}

/* ========= 產圖（不疊字） ========= */
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
async function genImageBuffer(prompt){
  let b64;
  try{ b64 = await imageB64(prompt, IMG_SIZE || '1536x1024'); }
  catch{ b64 = await imageB64(prompt, '1024x1024'); }
  return Buffer.from(b64,'base64');
}

/* ========= WordPress ========= */
const WP = axios.create({
  baseURL: WP_URL.replace(/\/+$/,''),
  headers: { Authorization: 'Basic '+Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64'),
             'User-Agent':'auto-news' },
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
  const q=await WP.get(`/wp-json/wp/v2/${tax}`,{params:{per_page:50,search:name}});
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
async function setPostTags(postId, names){
  if(!names?.length) return;
  const ids=[]; for(const n of names) ids.push(await ensureTerm('tags',n));
  await WP.post(`/wp-json/wp/v2/posts/${postId}`,{ tags: ids },{headers:{'Content-Type':'application/json'}});
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
async function wpAlreadyPostedByTitle(title){
  if(!title) return false;
  try{
    const r=await WP.get('/wp-json/wp/v2/posts',{params:{search:title,per_page:10,status:'any'}});
    if(r.status!==200 || !Array.isArray(r.data)) return false;
    const t=title.trim().toLowerCase();
    return r.data.some(p=>(p?.title?.rendered||'').replace(/<[^>]+>/g,'').trim().toLowerCase()===t);
  }catch{ return false; }
}

/* ========= Gutenberg 區塊（你的藍色小標版型） ========= */
function h2Block(text){ 
  return `<!-- wp:heading {"style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"}},"color":{"background":"#0a2a70"},"typography":{"lineHeight":"1.5"}},"textColor":"palette-color-7","fontSize":"large"} -->
<h2 class="wp-block-heading has-palette-color-7-color has-text-color has-background has-large-font-size" style="background-color:#0a2a70;line-height:1.5"><strong>${text}</strong></h2>
<!-- /wp:heading -->`;
}
function pBlock(text){ return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`; }
function heroFigure(src,cap){ return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt="${cap}"/><figcaption class="wp-element-caption"><strong>${cap}</strong></figcaption></figure>
<!-- /wp:image -->`; }
function inlineFigure(src){ return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt=""/></figure>
<!-- /wp:image -->`; }
function ctaBlock(){
  return `<!-- wp:paragraph --><p><em>（此處預留 CTA；若 SHOW_CTA=0 將不輸出）</em></p><!-- /wp:paragraph -->`;
}

function buildSixSectionBlocks({heroUrl,heroCaption,intro,sections,inlineImgUrl}){
  let blocks='';
  blocks += heroFigure(heroUrl, heroCaption);
  if(intro) blocks += pBlock(intro);

  let used = false;
  const order = ['事件重點','背景脈絡','目前進展','可能影響','延伸閱讀','結語'];
  for(const wanted of order){
    const sec = (sections||[]).find(s=>s.heading===wanted);
    if(!sec) continue;
    blocks += h2Block(wanted);
    (sec.paras||[]).forEach((pr,i)=>{
      blocks += pBlock(pr);
      if(!used && inlineImgUrl && wanted==='目前進展' && i>=0){
        blocks += inlineFigure(inlineImgUrl); used = true;
      }
    });
  }
  if(SHOW_CTA==='1') blocks += ctaBlock();
  return blocks;
}

/* ========= 主流程 ========= */
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
  const {item,hash}=picked;

  const cleanTitle = normalizeTitle(item.title||'');
  const draft = await writeSixSections({ title: cleanTitle, link: item.link||'', snippet: item.contentSnippet||item.content||'' });

  const catchyTitle  = normalizeTitle(draft.catchy_title || cleanTitle || '最新焦點');
  const focusKeyword = draft.focus_keyword || catchyTitle.split(/\s+/)[0] || '熱門新聞';

  const basePrompt = `以「${catchyTitle}」為主題，產生一張不含文字、無商標的寫實新聞示意圖，構圖清楚、對比適中、色彩自然。`;
  const heroImgBuf   = await genImageBuffer(basePrompt + ' 構圖適合做橫幅封面。');
  const inlineImgBuf = await genImageBuffer(basePrompt + ' 構圖適合做內文插圖。');

  const mediaA = await uploadMedia(heroImgBuf,   `hero-${Date.now()}.png`,   'image/png');
  const mediaB = await uploadMedia(inlineImgBuf, `inline-${Date.now()}.png`, 'image/png');

  const contentBlocks = buildSixSectionBlocks({
    heroUrl: mediaA.source_url,
    heroCaption: `▲ ${catchyTitle}`,
    intro: draft.intro,
    sections: draft.sections || [],
    inlineImgUrl: mediaB.source_url,
  });

  const wpPost = await postToWP({
    title: catchyTitle,
    content: contentBlocks,
    excerpt: focusKeyword,
    featured_media: mediaA.id,
    focus_kw: focusKeyword
  });

  // 標籤
  try{ await setPostTags(wpPost.id, (draft.tags||[]).slice(0,3)); }catch(e){ explainError(e,'設定標籤失敗（略過）'); }

  const store = readStore(); store.items.push({hash,link:item.link,title:item.title,time:Date.now(),wp_id:wpPost.id}); writeStore(store);
  console.log('✅ 已發佈：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');
}

/* ========= 執行 ========= */
(async ()=>{
  await preflight();
  await runOnce();   // 你的環境要即時產出，所以這裡直接跑一次；若要排程可自行改 node-cron
})().catch(e=>{ explainError(e,'啟動失敗'); process.exitCode=1; });
