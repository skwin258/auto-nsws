// auto-news.js — 熱門新聞（不限體育）＋ 固定排程 08:00/12:00/20:00（台北時間）
// 兩張圖：封面有字、內文無字；3000字文章；分類/標籤/RankMath 不變
require('dotenv').config();
const axios = require('axios');
const Parser = require('rss-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const slugify = require('slugify');
const sharp = require('sharp');
const OpenAI = require('openai');
const cron = require('node-cron');

const {
  OPENAI_API_KEY,
  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,
  FEED_URLS = '',                 // 若留空，會自動用 Google 新聞熱門 / 總覽
  DEBUG = '0',
  SCHEDULE = '1'                  // 1=啟用排程；0=只跑一次
} = process.env;

// ==== 預設：熱門新聞來源（Google News：台灣、繁中）====
function defaultFeeds() {
  // 「頭條」「台灣熱門」「國際」「娛樂」「體育」「科技」「商業」等可加減；至少保留 Top Stories
  return [
    'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',                                   // 總覽 / 頭條（熱門排序）
    'https://news.google.com/rss/headlines/section/topic/WORLD?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',     // 國際
    'https://news.google.com/rss/headlines/section/topic/NATION?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',    // 台灣
    'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',// 科技
    'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-TW&gl=TW&ceid=TW:zh-Hant'   // 商業
  ];
}

function assertEnv() {
  const miss = [];
  if (!OPENAI_API_KEY) miss.push('OPENAI_API_KEY');
  if (!WP_URL) miss.push('WP_URL');
  if (!WP_USER) miss.push('WP_USER');
  if (!WP_APP_PASSWORD) miss.push('WP_APP_PASSWORD');
  if (miss.length) {
    console.error('缺少必要環境變數：', miss.join(', '));
    process.exit(1);
  }
}
assertEnv();

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});

// 簡單去重
const STORE = path.join(__dirname, 'posted.json');
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { items: [] }; }
}
function writeStore(data) { fs.writeFileSync(STORE, JSON.stringify(data, null, 2)); }
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

// 取得熱門 RSS 項目（優先未發過）
async function pickOneFeedItem() {
  const FEEDS = FEED_URLS.split(',').map(s => s.trim()).filter(Boolean);
  const sources = FEEDS.length ? FEEDS : defaultFeeds();

  const store = readStore();
  const seen = new Set(store.items.map(x => x.hash));

  for (const url of sources) {
    try {
      const feed = await parser.parseURL(url);
      // Google News RSS 已經是熱門＋最新；依序找第一個沒發過的
      for (const item of feed.items) {
        const key = item.link || item.guid || item.title || JSON.stringify(item);
        const h = sha1(key);
        if (!seen.has(h)) {
          return { feedUrl: url, item, hash: h };
        }
      }
    } catch (e) {
      console.error('讀取 RSS 失敗：', url, e.message);
    }
  }
  return null;
}

// ========= 文字生成（3000–3600 字 + 區塊） =========
async function writeLongArticle({ title, link, snippet }) {
  // ✅ 改成「熱門新聞（不限領域）」口吻；其餘不動
  const sys = `你是一位中文「熱門新聞」專欄編輯（不限領域：國內外、財經、科技、娛樂、體育等皆可）。請根據「來源標題、摘要與連結」寫出 3000–3600 字、可發布的文章草稿：
- 口吻中立、可讀性強、避免抄襲；需改寫與延伸
- 分成 6 段主題，每段一個 h2 小標（不含井號），小標精煉
- 每段落 2–4 段敘述，行文具體，不要流水帳
- 文章開頭固定：第一句「哈囉，大家好，我是文樂。」接著 2–3 段前言
- 文章中段適合放一張相關圖片的位置，請在該段落文末用「[內文圖]」標記（僅一次）
- 文章結尾加入 2 段收束觀點與延伸
- 產出 JSON：{focus_keyword, catchy_title, hero_text, sections:[{heading, paragraphs:[...]}], intro_paragraphs:[...]}
- sections 需剛好 6 個，paragraphs 為陣列（每段 2~4 段）
- 所有字串為純文字（不要 HTML）`;

  const user = `來源標題：${title}
來源連結：${link}
來源摘要：${snippet || '(RSS 無摘要)'}
請務必回傳 JSON，並盡量達到 3000–3600 字。`;

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
    const text = resp.choices[0]?.message?.content || '{}';
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('GPT 回傳非 JSON，無法解析：' + e.message);
  }
  return data;
}

// ========= 純 SVG 疊字（libvips 支援） =========
function esc(s='') { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function wrapLines(text, maxCharsPerLine = 12) {
  const t = (text || '').trim();
  if (!t) return [''];
  if (/\s/.test(t)) {
    const words = t.split(/\s+/); const lines = []; let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length <= maxCharsPerLine) line = (line ? line + ' ' : '') + w;
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines;
  } else {
    const lines = [];
    for (let i=0; i<t.length; i+=maxCharsPerLine) lines.push(t.slice(i, i+maxCharsPerLine));
    return lines;
  }
}
function buildHeroSVG(overlayText) {
  let lines = wrapLines(overlayText, 12);
  let fontSize = 86; if (lines.length >= 4) fontSize = 68; if (lines.length >= 6) fontSize = 56;
  const lineHeight = Math.round(fontSize * 1.25);
  const total = lines.length * lineHeight;
  const startY = 512 - Math.round(total / 2) + fontSize;
  const tspans = lines.map((ln, i) => `<tspan x="768" dy="${i === 0 ? 0 : lineHeight}">${esc(ln)}</tspan>`).join('');
  return Buffer.from(
`<svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1536" height="1024" fill="rgba(0,0,0,0.28)"/>
  <text x="768" y="${startY}" text-anchor="middle"
        font-family="Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, -apple-system, Segoe UI, Arial"
        font-weight="900" font-size="${fontSize}"
        fill="#ffffff" stroke="#000000" stroke-width="8" paint-order="stroke">${tspans}</text>
</svg>`, 'utf8');
}

// ========= 產圖（兩張：內文無字；封面有字） =========
async function genImageBuffer(prompt, withText = false, overlayText = '') {
  const img = await client.images.generate({
    model: 'gpt-image-1',
    size: '1536x1024',
    prompt,
  });
  const b64 = img.data[0].b64_json;
  const base = Buffer.from(b64, 'base64');
  if (!withText) return base;
  const svgOverlay = buildHeroSVG(overlayText);
  const composed = await sharp(base).composite([{ input: svgOverlay, blend: 'over' }]).png().toBuffer();
  return composed;
}

// ========= 上傳到 WP =========
const WP = axios.create({
  baseURL: WP_URL.replace(/\/+$/, ''),
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64'),
    'User-Agent': 'auto-news-script',
  },
  validateStatus: () => true,
});
async function uploadMedia(buffer, filename, mime) {
  const res = await WP.post('/wp-json/wp/v2/media', buffer, {
    headers: { 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Type': mime },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  if (DEBUG === '1') console.log('媒體上傳：', res.status, res.data?.id, res.data?.source_url);
  if (res.status >= 200 && res.status < 300) return res.data;
  throw new Error(`媒體上傳失敗：${res.status} ${JSON.stringify(res.data).slice(0,500)}`);
}
async function ensureTerm(tax, name) {
  const slug = slugify(name, { lower: true, strict: true });
  const q = await WP.get(`/wp-json/wp/v2/${tax}`, { params: { per_page: 100, search: name } });
  if (q.status === 200 && Array.isArray(q.data)) {
    const hit = q.data.find(t => t.name === name || t.slug === slug);
    if (hit) return hit.id;
  }
  const c = await WP.post(`/wp-json/wp/v2/${tax}`, { name, slug });
  if (c.status >= 200 && c.status < 300) return c.data.id;
  throw new Error(`建立 ${tax} 失敗：${c.status} ${JSON.stringify(c.data).slice(0,300)}`);
}
async function ensureCategories() { const names = ['即時新聞', '最新文章']; const ids = []; for (const n of names) ids.push(await ensureTerm('categories', n)); return ids; }
async function ensureTags(tagNames) { const ids = []; for (const n of tagNames) ids.push(await ensureTerm('tags', n)); return ids; }

// ========= Gutenberg blocks（原樣） =========
function h2Block(text) {
  return `<!-- wp:heading {"style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"}},"elements":{"link":{"color":{"text":"var:preset|color|palette-color-7"}}},"color":{"background":"#0a2a70"},"typography":{"lineHeight":"1.5"}},"textColor":"palette-color-7","fontSize":"large"} -->
<h2 class="wp-block-heading has-palette-color-7-color has-text-color has-background has-link-color has-large-font-size" style="background-color:#0a2a70;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0;line-height:1.5"><strong>${text}</strong></h2>
<!-- /wp:heading -->`;
}
function pBlock(text) { return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`; }
function heroFigure(src, caption) {
  return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt="${caption}"/><figcaption class="wp-element-caption"><strong>${caption}</strong></figcaption></figure>
<!-- /wp:image -->`;
}
function inlineFigure(src) { return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} --><figure class="wp-block-image size-full"><img src="${src}" alt=""/></figure><!-- /wp:image -->`; }
function ctaBlock() {
  return `
${h2Block('關注加入文樂運彩分析領取投注策略')}
${pBlock('我是文樂，一個擁有八年看球及運彩經驗的分析師，2022-25賽季長期穩定勝率57%以上，本季依然保持在57%；MLB與NBA預測主推勝率更高達60%。沒時間看球？沒關係，文樂幫您解析MLB和NBA的進階數據及背後意義；長期關注隨隊記者推特、球員動態，賽事結果與球隊定位和心態皆有所關聯，最全面的分析盡在文樂運彩分析，讓我們攜手擊敗莊家！')}
${pBlock('<strong>更多賽事推薦請加入官方LINE ID：<a href="https://lin.ee/XJQjpHj">@912rdzda</a></strong>')}
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
  (intro_paragraphs || []).forEach(t => { blocks += pBlock(t); });
  let inlineUsed = false;
  (sections || []).forEach((sec, idx) => {
    blocks += h2Block(sec.heading);
    (sec.paragraphs || []).forEach(par => {
      blocks += pBlock(par);
      if (!inlineUsed && (/\[內文圖\]/.test(par) || (idx === 2))) {
        if (inlineImgUrl) blocks += inlineFigure(inlineImgUrl);
        inlineUsed = true;
      }
    });
  });
  blocks += ctaBlock();
  return blocks;
}

// ========= 發文 =========
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
  for (let i = 0; i < endpoints.length; i++) {
    const res = await WP.post(endpoints[i], payload, { headers: { 'Content-Type': 'application/json' } });
    if (DEBUG === '1') console.log('WP 回應：', res.status, (res.data && res.data.id));
    if (res.status >= 200 && res.status < 300) return res.data;
  }
  throw new Error('發文失敗：' + JSON.stringify(payload).slice(0, 400));
}

// ========= 主流程（包成函式，提供排程呼叫）=========
async function runOnce() {
  try {
    const picked = await pickOneFeedItem();
    if (!picked) {
      console.log('⚠ 沒有找到新的 RSS 文章（可能都發過了）');
      return;
    }
    const { item, hash, feedUrl } = picked;
    if (DEBUG === '1') console.log('選到來源：', feedUrl, '→', item.title, item.link);

    const draft = await writeLongArticle({
      title: item.title || '',
      link: item.link || '',
      snippet: item.contentSnippet || item.content || '',
    });

    const focusKeyword = draft.focus_keyword || (item.title || '').split(' ')[0] || '熱門新聞';
    const catchyTitle = draft.catchy_title || item.title || '最新焦點';
    const heroText = draft.hero_text || catchyTitle;

    const basePrompt = `為以下主題產生一張寫實風格、能代表內容的新聞配圖，構圖清楚、對比強烈、適合做橫幅封面：
主題：「${catchyTitle}」
注意：不要出現商標、不要含文字、避免露點或不當內容。`;

    // 內文圖（無字）
    const contentImgBuf = await genImageBuffer(basePrompt + ' 構圖適合新聞內文插圖。', false);

    // 封面圖（有字）
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

    console.log('✅ 已建立草稿：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');

    const store = readStore();
    store.items.push({ hash, link: item.link, time: Date.now(), wp_id: wpPost.id });
    writeStore(store);
  } catch (err) {
    const msg = err?.response?.data || err.message || err;
    console.error('❌ 失敗：', msg);
  }
}

// ========= 啟動模式：排程 or 單次 =========
let isRunning = false;
async function safeRun() {
  if (isRunning) { console.log('⏳ 任務執行中，跳過本輪'); return; }
  isRunning = true;
  try { await runOnce(); } finally { isRunning = false; }
}

if (SCHEDULE === '0') {
  // 單次執行（保留原有用法）
  safeRun().then(() => process.exit(0));
} else {
  // 每天台北時間 08:00、12:00、20:00 執行
  cron.schedule('0 8,12,20 * * *', () => { console.log('⏰ 觸發排程（Asia/Taipei）'); safeRun(); }, { timezone: 'Asia/Taipei' });
  console.log('▶ 已啟動排程：每日 08:00、12:00、20:00（Asia/Taipei）');
}
