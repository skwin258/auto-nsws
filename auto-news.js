// auto-news.js — 熱門新聞 → 3000字文章 → 兩張圖 → WP 草稿（RankMath焦點詞）
// Node >= 18
require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const slugify = require('slugify');
const sharp = require('sharp');
const OpenAI = require('openai');

/* =============================
   ENV
============================= */
const {
  OPENAI_API_KEY,
  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,
  FEED_URLS = '',
  DEBUG = '0',
  SCHEDULE = '1',
  WEB_ENABLE = '0',
  WEB_TOKEN = '',
  PORT = '3000',
} = process.env;

if (!OPENAI_API_KEY || !WP_URL || !WP_USER || !WP_APP_PASSWORD) {
  console.error('❌ 缺少必要環境變數：OPENAI_API_KEY / WP_URL / WP_USER / WP_APP_PASSWORD');
  process.exit(1);
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =============================
   常用工具
============================= */
const STORE_FILE = path.resolve(__dirname, 'posted.json');
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return { items: [] }; }
}
function writeStore(data) {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2)); }
  catch {}
}
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const log = (...a) => (DEBUG === '1' ? console.log(...a) : void 0);

/* =============================
   RSS：熱門來源（預設）
============================= */
const DEFAULT_FEEDS = [
  // Google News 台灣熱門（繁中）
  'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  // BBC World
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  // Reuters World
  'https://feeds.reuters.com/reuters/worldNews',
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
    'User-Agent': 'auto-news',
  },
  validateStatus: () => true,
});

// 以「標題」在 WP 查重（避免重複）
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
  } catch {
    return false;
  }
}

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
  throw new Error('WP 媒體上傳失敗：' + r.status + ' ' + JSON.stringify(r.data).slice(0, 400));
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

async function ensureCategories() {
  const names = ['即時新聞', '最新文章'];
  const ids = [];
  for (const n of names) ids.push(await ensureTerm('categories', n));
  return ids;
}
async function ensureTags(tagNames) {
  const ids = [];
  for (const n of tagNames) ids.push(await ensureTerm('tags', n));
  return ids;
}

/* =============================
   取一則「未發過」的熱門新聞
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
        if (await wpAlreadyPostedByTitle(item.title || '')) continue; // WP 查重
        return { feedUrl: url, item, hash: h };
      }
    } catch (e) {
      console.error('讀取 RSS 失敗：', url, e?.message || e);
    }
  }
  return null;
}

/* =============================
   文字生成（3000–3600 字，分段 JSON）
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
  const user = `來源標題：${title}
來源連結：${link}
來源摘要：${snippet || '(RSS 無摘要)'}
請務必回傳 JSON，且盡量達到 3000–3600 字。`;

  const resp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.6,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });

  let data;
  try {
    data = JSON.parse(resp.choices?.[0]?.message?.content || '{}');
  } catch (e) {
    throw new Error('GPT 回傳非 JSON，無法解析：' + e.message);
  }
  return data;
}

/* =============================
   製圖（封面：有字，內文：無字）
============================= */
function esc(s='') { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function wrapLines(t, n=12) {
  const s=(t||'').trim();
  if (!s) return [''];
  if (/\s/.test(s)) {
    const words=s.split(/\s+/); const lines=[]; let line='';
    for (const w of words) {
      if ((line + ' ' + w).trim().length <= n) line=(line?line+' ':'')+w;
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line); return lines;
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
        font-family="Noto Sans TC, Microsoft JhengHei, system-ui, -apple-system, Segoe UI, Arial"
        font-weight="900" font-size="${fontSize}"
        fill="#ffffff" stroke="#000" stroke-width="8" paint-order="stroke">
    ${tspans}
  </text>
</svg>`, 'utf8');
}
async function genImageBuffer(prompt, withText=false, overlayText='') {
  const img = await client.images.generate({ model: 'gpt-image-1', size: '1536x1024', prompt });
  const b64 = img.data[0].b64_json;
  const base = Buffer.from(b64, 'base64');
  if (!withText) return base;
  const svg = buildHeroSVG(overlayText);
  return await sharp(base).composite([{ input: svg, blend: 'over' }]).png().toBuffer();
}

/* =============================
   Gutenberg Blocks（簡版）
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
   發文
============================= */
async function postToWP({ title, content, excerpt, categories, tags, featured_media, focus_kw }) {
  const payload = {
    title,
    status: 'draft',
    content,
    excerpt,
    categories,
    tags,
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
   主流程：跑一次
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

  const catIds = await ensureCategories();
  const tagResp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.5,
    messages: [
      { role: 'system', content: '給我 3 個適合的繁體中文標籤關鍵詞，純文字用逗號分隔。' },
      { role: 'user', content: `主題：${catchyTitle}；焦點詞：${focusKeyword}` },
    ],
  });
  const tagLine = tagResp.choices[0]?.message?.content || '';
  const tagNames = tagLine.split(/[，,]/).map(s => s.trim()).filter(Boolean).slice(0,3);
  const tagIds = await ensureTags(tagNames.length ? tagNames : [focusKeyword]);

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
    categories: catIds,
    tags: tagIds,
    featured_media: mediaA.id,
    focus_kw: focusKeyword,
  });

  // 記錄 hash（僅作輔助；真正去重靠 WP 查重）
  const store = readStore();
  store.items.push({ hash, link: item.link, title: item.title, time: Date.now(), wp_id: wpPost.id });
  writeStore(store);

  console.log('✅ 已建立草稿：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');
}

/* =============================
   啟動模式：排程（預設）或 單次 / HTTP
============================= */
let isRunning = false;
async function safeRun() {
  if (isRunning) { console.log('⏳ 任務執行中，跳過本輪'); return; }
  isRunning = true;
  try { await runOnce(); } finally { isRunning = false; }
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

(async () => {
  if (SCHEDULE === '1') {
    // 每天台北 08:00 / 12:00 / 20:00
    const cron = require('node-cron');
    cron.schedule('0 8,12,20 * * *', () => { console.log('⏰ 觸發排程（Asia/Taipei）'); safeRun(); }, { timezone: 'Asia/Taipei' });
    console.log('▶ 已啟動排程：每日 08:00、12:00、20:00（Asia/Taipei）');
    if (WEB_ENABLE === '1') bootHttp();
  } else {
    if (WEB_ENABLE === '1') {
      console.log('▶ SCHEDULE=0：等待 /run 觸發（HTTP 已啟動）'); bootHttp();
    } else {
      await safeRun(); process.exit(0);
    }
  }
})().catch(e => { console.error('❌ 失敗：', e?.response?.data || e.message || e); process.exitCode = 1; });
