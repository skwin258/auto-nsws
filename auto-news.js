// auto-news.js — 熱門新聞 → 3000字文章 → 兩張圖 → WP 草稿（RankMath焦點詞）
// Node >= 18
require('dotenv').config();

// 讓 Node 解析域名時以 IPv4 優先，避免某些環境 IPv6 連線不穩
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
  OPENAI_BASE_URL,     // 可選：自訂 API base（預設 https://api.openai.com/v1）
  OPENAI_PROJECT,      // 可選：sk-proj-… 時可設定 project id
  OPENAI_MODEL = 'gpt-4o-mini',

  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,

  FEED_URLS = '',
  WP_CATEGORY_ANALYSIS_ID = '',
  WP_STATUS = 'draft',
  IMG_SIZE = '1536x1024',
  DEBUG = '0',

  SCHEDULE = '1',
  WEB_ENABLE = '0',
  WEB_TOKEN = '',
  PORT = '3000',

  HERO_TEXT = '1',     // 1=封面疊字；0=不疊字（字型未備妥可先關）
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

const log = (...a) => (DEBUG === '1' ? console.log(...a) : void 0);

/* =============================
   小工具
============================= */
const STORE_FILE = path.resolve(__dirname, 'posted.json');
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return { items: [] }; }
}
function writeStore(data) {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2)); } catch {}
}
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

function explainError(e, label = '錯誤') {
  const parts = [];
  if (e?.status) parts.push(`status=${e.status}`);
  if (e?.code) parts.push(`code=${e.code}`);
  if (e?.response?.status) parts.push(`respStatus=${e.response.status}`);
  if (e?.response?.data) {
    try { parts.push(`respData=${JSON.stringify(e.response.data).slice(0,300)}`); } catch {}
  }
  if (e?.message) parts.push(`msg=${e.message}`);
  console.error(`✖ ${label}：` + (parts.join(' | ') || e));
}

// 重試與指數退避（針對連線錯、逾時等網路層錯誤）
const RETRY_CODES = new Set(['ECONNRESET','ETIMEDOUT','ENETDOWN','ENETUNREACH','EAI_AGAIN']);
function isConnError(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('connection error') || RETRY_CODES.has(err?.code);
}
async function withRetry(fn, label='動作', tries=4, baseMs=600) {
  let last;
  for (let i=0;i<tries;i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (!isConnError(e) || i === tries-1) { explainError(e, label); throw e; }
      const wait = Math.round(baseMs * Math.pow(2, i) * (1 + Math.random()*0.3));
      console.warn(`⚠ ${label} 網路不穩，${i+1}/${tries} 次失敗，${wait}ms 後重試…`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

/* =============================
   RSS
============================= */
const DEFAULT_FEEDS = [
  'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.reuters.com/reuters/worldNews'
];
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});

/* =============================
   WordPress API
============================= */
const WP = axios.create({
  baseURL: WP_URL.replace(/\/+$/, ''),
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64'),
    'User-Agent': 'auto-news-script',
  },
  validateStatus: () => true,
});

async function uploadMedia(buffer, filename, mime) {
  const r = await WP.post('/wp-json/wp/v2/media', buffer, {
    headers: {
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': mime,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`WP 媒體上傳失敗：${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
}

async function ensureTerm(tax, name) {
  const slug = slugify(name, { lower: true, strict: true });
  const q = await WP.get(`/wp-json/wp/v2/${tax}`, { params: { per_page: 100, search: name } });
  if (q.status === 200 && Array.isArray(q.data)) {
    const hit = q.data.find((t) => t.name === name || t.slug === slug);
    if (hit) return hit.id;
  }
  const c = await WP.post(`/wp-json/wp/v2/${tax}`, { name, slug });
  if (c.status >= 200 && c.status < 300) return c.data.id;
  throw new Error(`建立 ${tax} 失敗：${c.status} ${JSON.stringify(c.data).slice(0, 200)}`);
}

async function ensureDefaultCategories() {
  const names = ['即時新聞', '最新文章'];
  const ids = [];
  for (const n of names) ids.push(await ensureTerm('categories', n));
  return ids;
}

async function setPostTags(postId, tagNames) {
  const tagIds = [];
  for (const n of tagNames) tagIds.push(await ensureTerm('tags', n));
  const r = await WP.post(`/wp-json/wp/v2/posts/${postId}`, { tags: tagIds }, { headers: { 'Content-Type': 'application/json' } });
  if (!(r.status >= 200 && r.status < 300)) console.warn('⚠ 設定標籤失敗：', r.status);
}

async function wpAlreadyPostedByTitle(title) {
  if (!title) return false;
  try {
    const res = await WP.get('/wp-json/wp/v2/posts', {
      params: { search: title, per_page: 10, status: 'any' },
    });
    if (res.status !== 200 || !Array.isArray(res.data)) return false;
    const t = title.trim().toLowerCase();
    return res.data.some((p) =>
      (p?.title?.rendered || '')
        .replace(/<[^>]+>/g, '')
        .trim()
        .toLowerCase() === t
    );
  } catch { return false; }
}

/* =============================
   挑一則未發過的 RSS
============================= */
async function pickOneFeedItem() {
  const FEEDS = (FEED_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sources = FEEDS.length ? FEEDS : DEFAULT_FEEDS;

  const store = readStore();
  const seen = new Set(store.items.map((x) => x.hash));

  for (const url of sources) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items || []) {
        const key = item.link || item.guid || item.title || JSON.stringify(item);
        const h = sha1(key);
        if (seen.has(h)) continue;
        if (await wpAlreadyPostedByTitle(item.title || '')) continue;
        return { feedUrl: url, item, hash: h };
      }
    } catch (e) { explainError(e, '讀取 RSS 失敗 ' + url); }
  }
  return null;
}

/* =============================
   OpenAI：SDK→REST 後備封裝
============================= */
const base = (OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/,'');
function authHeaders() {
  const h = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
  if (OPENAI_PROJECT) h['OpenAI-Project'] = OPENAI_PROJECT;
  return h;
}

async function chatJSON(system, user, label='OpenAI 文字生成') {
  return await withRetry(async () => {
    // 先試 SDK
    try {
      const resp = await client.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.6,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const text = resp.choices?.[0]?.message?.content || '{}';
      return JSON.parse(text);
    } catch (e) {
      if (isConnError(e)) {
        // 後備：REST
        const body = {
          model: OPENAI_MODEL,
          temperature: 0.6,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        };
        const r = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`REST /chat 失敗：${r.status} ${await r.text().then(t=>t.slice(0,300))}`);
        const j = await r.json();
        const text = j.choices?.[0]?.message?.content || '{}';
        return JSON.parse(text);
      }
      throw e;
    }
  }, label);
}

// 產生「純文字」回覆（不解析 JSON）
async function chatPlain(system, user, label='OpenAI 純文字') {
  return await withRetry(async () => {
    try {
      const resp = await client.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.5,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      return resp.choices?.[0]?.message?.content?.trim() || '';
    } catch (e) {
      if (isConnError(e)) {
        const body = { model: OPENAI_MODEL, temperature: 0.5,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
        const r = await fetch(base + '/chat/completions', {
          method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`REST /chat 失敗：${r.status} ${await r.text().then(t=>t.slice(0,300))}`);
        const j = await r.json();
        return j.choices?.[0]?.message?.content?.trim() || '';
      }
      throw e;
    }
  }, label);
}

/* =============================
   文字生成（3000–3600 字）
============================= */
async function writeLongArticle({ title, link, snippet }) {
  const sys = `你是中文新聞專欄編輯。請根據「來源標題、摘要與連結」寫出 3000–3600 字、可發布的文章草稿：
- 口吻中立、可讀性強、避免抄襲；需改寫與延伸
- 分成 6 段主題，每段有一個 h2 小標（不含井號），小標精煉
- 每段 2–4 段敘述，具體、有邏輯
- 開頭固定第一句：「哈囉，大家好，我是文樂。」接著 2–3 段前言
- 正文中僅一次在適當段落結尾放「[內文圖]」標記
- 結尾 2 段收束觀點與延伸
- 產出 JSON：{focus_keyword, catchy_title, hero_text, sections:[{heading, paragraphs:[...]}], intro_paragraphs:[...]}
- sections 必須剛好 6 個；paragraphs 為純文字陣列；請只輸出 JSON`;
  const usr = `來源標題：${title}
來源連結：${link}
來源摘要：${snippet || '(RSS 無摘要)'}
請務必回傳 JSON，且盡量達到 3000–3600 字。`;

  try {
    return await chatJSON(sys, usr, 'OpenAI 文字生成');
  } catch (e) {
    explainError(e, 'OpenAI 文字生成失敗');
    throw e;
  }
}

/* =============================
   產圖（封面有字、內文無字）
============================= */
function esc(s='') { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function wrapLines(t, n=12) {
  const s=(t||'').trim(); if (!s) return [''];
  if (/\s/.test(s)) {
    const words=s.split(/\s+/); const lines=[]; let line='';
    for (const w of words) {
      if ((line + ' ' + w).trim().length <= n) line=(line?line+' ':'')+w;
      else { if (line) lines.push(line); line = w; }
    } if (line) lines.push(line); return lines;
  }
  const lines=[]; for (let i=0;i<s.length;i+=n) lines.push(s.slice(i,i+n)); return lines;
}
function buildHeroSVG(overlayText) {
  const lines = wrapLines(overlayText, 12);
  let fontSize = 86; if (lines.length >= 4) fontSize = 68; if (lines.length >= 6) fontSize = 56;
  const lineHeight = Math.round(fontSize * 1.25);
  const total = lines.length * lineHeight;
  const startY = 512 - Math.round(total / 2) + fontSize;
  const tspans = lines.map((ln, i)=>`<tspan x="768" dy="${i===0?0:lineHeight}">${esc(ln)}</tspan>`).join('');
  return Buffer.from(
`<svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1536" height="1024" fill="rgba(0,0,0,0.28)"/>
  <text x="768" y="${startY}" text-anchor="middle"
        font-family="Noto Sans CJK TC, Noto Sans TC, Microsoft JhengHei, PingFang TC, system-ui, -apple-system, Segoe UI, Arial"
        font-weight="900" font-size="${fontSize}"
        fill="#ffffff" stroke="#000000" stroke-width="8" paint-order="stroke">${tspans}</text>
</svg>`, 'utf8');
}

async function imageB64(prompt, size, label='OpenAI 產圖') {
  return await withRetry(async () => {
    try {
      const img = await client.images.generate({ model: 'gpt-image-1', size, prompt });
      return img.data[0].b64_json;
    } catch (e) {
      if (isConnError(e)) {
        const body = { model: 'gpt-image-1', size, prompt };
        const r = await fetch(base + '/images/generations', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`REST /images 失敗：${r.status} ${await r.text().then(t=>t.slice(0,300))}`);
        const j = await r.json();
        return j.data?.[0]?.b64_json;
      }
      throw e;
    }
  }, label);
}

async function genImageBuffer(prompt, withText=false, overlayText='') {
  const overlayOff = (String(HERO_TEXT || '1') !== '1'); // 可關閉疊字

  try {
    let b64;
    try { b64 = await imageB64(prompt, IMG_SIZE || '1536x1024', 'OpenAI 產圖'); }
    catch { b64 = await imageB64(prompt, '1024x1024', 'OpenAI 產圖(降級)'); }

    const base = Buffer.from(b64, 'base64');
    if (!withText || overlayOff) return base;

    const svg = buildHeroSVG(overlayText);
    return await sharp(base).composite([{ input: svg, blend: 'over' }]).png().toBuffer();
  } catch (e) {
    explainError(e, 'OpenAI 產圖失敗');
    throw e;
  }
}

/* =============================
   Gutenberg Blocks
============================= */
function h2Block(text) {
  return `<!-- wp:heading {"style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"}},"elements":{"link":{"color":{"text":"var:preset|color|palette-color-7"}}},"color":{"background":"#0a2a70"},"typography":{"lineHeight":"1.5"}},"textColor":"palette-color-7","fontSize":"large"} -->
<h2 class="wp-block-heading has-palette-color-7-color has-text-color has-background has-link-color has-large-font-size" style="background-color:#0a2a70;line-height:1.5"><strong>${text}</strong></h2>
<!-- /wp:heading -->`;
}
function pBlock(text) { return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`; }
function heroFigure(src, caption) {
  return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt="${caption}"/><figcaption class="wp-element-caption"><strong>${caption}</strong></figcaption></figure>
<!-- /wp:image -->`;
}
function inlineFigure(src) {
  return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt=""/></figure>
<!-- /wp:image -->`;
}
function ctaBlock() {
  return `
${h2Block('關注加入文樂運彩分析領取投注策略')}
${pBlock('我是文樂，一個擁有八年看球及運彩經驗的分析師，2022-25賽季長期穩定勝率57%以上；MLB與NBA預測主推勝率更高。沒時間看球？沒關係，文樂幫您解析進階數據與事件背景，讓我們一起擊敗莊家！')}
${pBlock('<strong>更多賽事推薦請加入官方 LINE：<a href="https://lin.ee/XJQjpHj">@912rdzda</a></strong>')}
<!-- wp:image {"sizeSlug":"full","linkDestination":"none","align":"center","style":{"border":{"radius":"30px"}}} -->
<figure class="wp-block-image aligncenter size-full has-custom-border"><img src="https://bc78999.com/wp-content/uploads/2024/08/M_gainfriends_2dbarcodes_GW-1.png" alt="" style="border-radius:30px"/></figure>
<!-- /wp:image -->
<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">文樂運彩Line官方QR code</p>
<!-- /wp:paragraph -->
`;
}

function buildContentJSONToBlocks({ heroUrl, heroCaption, inlineImgUrl, intro_paragraphs, sections }) {
  let blocks = '';
  blocks += heroFigure(heroUrl, heroCaption);
  blocks += pBlock('哈囉，大家好，我是文樂。');
  (intro_paragraphs || []).forEach(t => blocks += pBlock(t));
  let used = false;
  (sections || []).forEach((sec, idx) => {
    blocks += h2Block(sec.heading);
    (sec.paragraphs || []).forEach(par => {
      blocks += pBlock(par);
      if (!used && (/\[內文圖\]/.test(par) || idx === 2)) {
        if (inlineImgUrl) blocks += inlineFigure(inlineImgUrl);
        used = true;
      }
    });
  });
  blocks += ctaBlock();
  return blocks;
}

/* =============================
   發文（分類：你的 ID + 即時新聞/最新文章）
============================= */
async function pickCategories() {
  const baseIds = await ensureDefaultCategories(); // [即時新聞, 最新文章]
  const extra = Number(WP_CATEGORY_ANALYSIS_ID);
  if (Number.isFinite(extra) && extra > 0) baseIds.unshift(extra);
  return Array.from(new Set(baseIds)); // 去重
}

async function postToWP({ title, content, excerpt, featured_media, focus_kw }) {
  const categories = await pickCategories();
  const payload = {
    title,
    status: WP_STATUS || 'draft',
    content,
    excerpt,
    categories,
    featured_media,
    meta: { rank_math_focus_keyword: focus_kw || '' },
  };
  const endpoints = ['/wp-json/wp/v2/posts', '/index.php?rest_route=/wp/v2/posts'];
  for (const ep of endpoints) {
    const r = await WP.post(ep, payload, { headers: { 'Content-Type': 'application/json' } });
    if (r.status >= 200 && r.status < 300) return r.data;
  }
  throw new Error('發文失敗');
}

/* =============================
   開機自檢（OpenAI /models、RSS、WP）
============================= */
async function preflight() {
  // OpenAI
  try {
    const r = await fetch(base + '/models', { method: 'GET', headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    console.log('OpenAI /models:', r.status, r.statusText);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`OpenAI /models 非 2xx：${r.status} ${t.slice(0, 200)}`);
    }
  } catch (e) { explainError(e, 'OpenAI 連線測試失敗'); throw e; }

  // RSS（不阻擋）
  try {
    const firstFeed = (FEED_URLS || '').split(',').map(s=>s.trim()).filter(Boolean)[0];
    if (firstFeed) {
      const r = await fetch(firstFeed, { method: 'GET' });
      console.log('RSS 測試:', r.status, r.statusText);
    }
  } catch (e) { console.warn('⚠ RSS 測試警告：', e?.message || e); }

  // WP（不阻擋）
  try {
    const r = await WP.get('/wp-json');
    console.log('WP /wp-json:', r.status);
  } catch (e) { explainError(e, 'WP 連線測試失敗（不阻擋）'); }
}

/* =============================
   主流程
============================= */
async function runOnce() {
  console.log('▶ 開始一次任務');

  const pick = await pickOneFeedItem();
  if (!pick) { console.log('⚠ 沒有新的 RSS 文章（可能都發過了）'); return; }
  const { item, hash, feedUrl } = pick;
  log('選到來源：', feedUrl, '→', item.title, item.link);

  const draft = await writeLongArticle({
    title: item.title || '',
    link: item.link || '',
    snippet: item.contentSnippet || item.content || '',
  });

  const focusKeyword = draft.focus_keyword || (item.title || '').split(' ')[0] || '熱門新聞';
  const catchyTitle = draft.catchy_title || item.title || '最新焦點';
  const heroText = draft.hero_text || catchyTitle;

  const basePrompt = `為以下主題產生一張寫實風格、能代表內容的新聞配圖，構圖清楚、對比強烈、適合做橫幅封面：主題「${catchyTitle}」。不要商標、不要文字、避免不當內容。`;

  const contentImgBuf = await genImageBuffer(basePrompt + ' 構圖適合內文插圖。', false);
  const heroImgBuf = await genImageBuffer(basePrompt + ' 構圖適合封面。', true, heroText);

  const mediaA = await uploadMedia(heroImgBuf, `hero-${Date.now()}.png`, 'image/png');
  const mediaB = await uploadMedia(contentImgBuf, `inline-${Date.now()}.png`, 'image/png');

  const contentBlocks = buildContentJSONToBlocks({
    heroUrl: mediaA.source_url,
    heroCaption: `▲ ${heroText}`,
    inlineImgUrl: mediaB.source_url,
    intro_paragraphs: draft.intro_paragraphs || [],
    sections: draft.sections || [],
  });

  const wpPost = await postToWP({
    title: catchyTitle,
    content: contentBlocks,
    excerpt: focusKeyword,
    featured_media: mediaA.id,
    focus_kw: focusKeyword,
  });

  // 標籤（失敗不擋流程）—— 純文字生成
  try {
    const tagLine = await chatPlain(
      '給我 3 個適合的「繁體中文」標籤關鍵詞，純文字用逗號或頓號分隔，不要加引號、不要多餘說明。',
      `主題：${catchyTitle}；焦點詞：${focusKeyword}`,
      'OpenAI 標籤生成'
    );
    const tagNames = (tagLine || '')
      .split(/[，,]/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (tagNames.length) await setPostTags(wpPost.id, tagNames);
  } catch (e) { explainError(e, '產生標籤失敗（略過）'); }

  const store = readStore();
  store.items.push({ hash, link: item.link, title: item.title, time: Date.now(), wp_id: wpPost.id });
  writeStore(store);

  console.log('✅ 已建立草稿：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');
}

/* =============================
   啟動：排程或單次 / HTTP
============================= */
let isRunning = false;
async function safeRun() {
  if (isRunning) { console.log('⏳ 任務執行中，跳過本輪'); return; }
  isRunning = true;
  try { await runOnce(); } catch(e) { explainError(e, '任務失敗'); } finally { isRunning = false; }
}

function bootHttp() {
  const http = require('http');
  const { URL } = require('url');
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname === '/health') {
        const store = readStore();
        const last = store.items?.[store.items.length - 1]?.time || null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok:true, items: store.items.length, last_post_time: last }));
      }
      if (u.pathname === '/run' && req.method === 'POST') {
        const token = u.searchParams.get('token') || req.headers['x-run-token'];
        if (!WEB_TOKEN || token !== WEB_TOKEN) { res.writeHead(401); return res.end('unauthorized'); }
        safeRun().then(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok:true })); })
                 .catch(e => { res.writeHead(500); res.end(String(e)); });
        return;
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  server.listen(Number(PORT), () => console.log(`HTTP ready on :${PORT}`));
}

/* =============================
   MAIN
============================= */
(async () => {
  await preflight(); // 先自檢，避免只看到 "Connection error"

  if (SCHEDULE === '1') {
    const cron = require('node-cron');
    // 每天台北 08:00 / 12:00 / 20:00
    cron.schedule('0 8,12,20 * * *', () => { console.log('⏰ 觸發排程（Asia/Taipei）'); safeRun(); }, { timezone: 'Asia/Taipei' });
    console.log('▶ 已啟動排程：每日 08:00、12:00、20:00（Asia/Taipei）');
    if (WEB_ENABLE === '1') bootHttp();
  } else {
    if (WEB_ENABLE === '1') { console.log('▶ SCHEDULE=0：等待 /run 觸發（HTTP 已啟動）'); bootHttp(); }
    else { await safeRun(); process.exit(0); }
  }
})().catch(e => { explainError(e, '啟動失敗'); process.exitCode = 1; });
