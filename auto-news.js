// auto-news.js — 熱門新聞自動產文（非體育優先）+ 2 圖 + RankMath + 分類/標籤 + 自動發佈
require('dotenv').config();
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
  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,
  FEED_URLS = '',
  DEBUG = '0',
  EXCLUDE_WORDS = '',                  // 允許自訂要排除的關鍵字
  WP_STATUS = 'publish',               // 預設直接發佈
  OPENAI_TIMEOUT_MS = '90000',         // OpenAI 連線 timeout (ms)
} = process.env;

/* ----------------------------- 基礎檢查 ----------------------------- */
function assertEnv() {
  const miss = [];
  if (!OPENAI_API_KEY) miss.push('OPENAI_API_KEY');
  if (!WP_URL) miss.push('WP_URL');
  if (!WP_USER) miss.push('WP_USER');
  if (!WP_APP_PASSWORD) miss.push('WP_APP_PASSWORD');
  if (miss.length) {
    console.error('❌ 缺少必要環境變數：', miss.join(', '));
    process.exit(1);
  }
}
assertEnv();

/* ----------------------------- OpenAI（加強版：timeout + 重試） ----------------------------- */
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const OPENAI_TIMEOUT = Number(OPENAI_TIMEOUT_MS) || 90000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(invoke, name = 'openai') {
  const tries = 4; // 0, 5s, 10s, 20s
  const delays = [0, 5000, 10000, 20000];
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      // v4 SDK 可在第二參數放 request options（timeout）
      return await invoke({ timeout: OPENAI_TIMEOUT });
    } catch (e) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      const transient = !status || status >= 500 || status === 429;
      if (transient && i < tries - 1) {
        if (DEBUG === '1') {
          console.error(`⚠ ${name} 第 ${i + 1} 次失敗（${status || 'net'}）：${e.message}，${delays[i + 1]}ms 後重試`);
        }
        await sleep(delays[i + 1]);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/* ----------------------------- RSS Parser ----------------------------- */
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});

/* ----------------------------- 去重存檔 ----------------------------- */
const STORE = path.join(__dirname, 'posted.json');
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { items: [] }; }
}
function writeStore(data) {
  fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
}
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

/* ----------------------------- 過濾：排除體育 ----------------------------- */
// 預設排除一堆體育字詞；可用 EXCLUDE_WORDS 客製（逗號分隔）
const DEFAULT_EXCLUDES = [
  'nba','mlb','nfl','nhl','ncaa','cba','kbo','j聯盟','j-league','j league',
  '英超','西甲','德甲','義甲','法甲','中職','中華職棒','職棒','中華男籃','t1','p.league',
  '籃球','棒球','足球','網球','高爾夫','羽球','職業聯賽','運彩','體育','sports',
  '勇士','湖人','公牛','洋基','道奇','紅襪','太空人'
];
const EXCLUDES = (EXCLUDE_WORDS
  ? EXCLUDE_WORDS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : DEFAULT_EXCLUDES
).map(s => s.toLowerCase());

function looksLikeSports(text = '') {
  const t = (text || '').toLowerCase();
  return EXCLUDES.some(k => t.includes(k));
}

/* ----------------------------- 挑一篇新新聞（非體育） ----------------------------- */
async function pickOneFeedItem() {
  const FEEDS = FEED_URLS.split(',').map(s => s.trim()).filter(Boolean);
  if (FEEDS.length === 0) {
    console.error('❌ FEED_URLS 為空，請設定 RSS 來源');
    process.exit(1);
  }

  const store = readStore();
  const seen = new Set(store.items.map(x => x.hash));

  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items) {
        const key = item.link || item.guid || item.title || JSON.stringify(item);
        const h = sha1(key);
        const title = item.title || '';
        if (seen.has(h)) continue;
        if (looksLikeSports(title)) {
          if (DEBUG === '1') console.log('⊗ 排除（體育）：', title);
          continue;
        }
        return { feedUrl: url, item, hash: h };
      }
    } catch (e) {
      console.error('讀取 RSS 失敗：', url, e.message);
    }
  }
  return null;
}

/* ----------------------------- 產出 3000~3600 字 JSON 草稿 ----------------------------- */
async function writeLongArticle({ title, link, snippet }) {
  const sys = `你是中文新聞編輯與專欄作者。根據「來源標題、摘要與連結」寫出 3000–3600 字、可發布的文章草稿：
- 文風中立、可讀性強、避免抄襲；需改寫與延伸背景脈絡
- 文章分成 6 個主題段落（sections），每段一個 h2 小標
- 每段 2–4 段敘述，具體，避免流水帳
- 開頭固定第一句：「哈囉，大家好，我是文樂。」接著 2–3 段前言
- 文中段落適合放一張相關圖片的位置，請在該段文末以「[內文圖]」標記（僅一次）
- 結尾加入 2 段收束與延伸觀點
- 嚴格輸出 JSON，且只能輸出 JSON（不要任何解說文字）
JSON 結構：
{
  "focus_keyword": "不超過 8 字、SEO 焦點詞",
  "catchy_title": "吸睛但不聳動標題",
  "hero_text": "封面圖上可疊的 8~16 字敘述",
  "intro_paragraphs": ["...", "..."],
  "sections": [{"heading":"...", "paragraphs":["...","..."]}, ... 六個剛好]
}`;

  const user = `來源標題：${title}
來源連結：${link}
來源摘要：${snippet || '(RSS 無摘要)'}
請務必回傳「有效 JSON」，不要加任何額外文字或標記。`;

  const resp = await withRetry(
    (opt) => client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    }, opt),
    'chat.completions'
  );

  let data;
  try {
    const text = resp.choices?.[0]?.message?.content?.trim() || '{}';
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('GPT 回傳非 JSON，解析失敗：' + e.message);
  }
  return data;
}

/* ----------------------------- SVG 疊字工具 ----------------------------- */
function esc(s='') {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function wrapLines(text, maxCharsPerLine = 12) {
  const t = (text || '').trim();
  if (!t) return [''];
  if (/\s/.test(t)) {
    const words = t.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length <= maxCharsPerLine) {
        line = (line ? line + ' ' : '') + w;
      } else {
        if (line) lines.push(line);
        line = w;
      }
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
  let fontSize = 86;
  if (lines.length >= 4) fontSize = 68;
  if (lines.length >= 6) fontSize = 56;
  const lineHeight = Math.round(fontSize * 1.25);
  const total = lines.length * lineHeight;
  const startY = 512 - Math.round(total / 2) + fontSize;

  const tspans = lines.map((ln, i) =>
    `<tspan x="768" dy="${i === 0 ? 0 : lineHeight}">${esc(ln)}</tspan>`
  ).join('');

  return Buffer.from(
`<svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1536" height="1024" fill="rgba(0,0,0,0.28)"/>
  <text x="768" y="${startY}" text-anchor="middle"
        font-family="Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, -apple-system, Segoe UI, Arial"
        font-weight="900" font-size="${fontSize}" fill="#ffffff"
        stroke="#000000" stroke-width="8" paint-order="stroke">
    ${tspans}
  </text>
</svg>`, 'utf8');
}

/* ----------------------------- 產圖（兩張：封面有字、內文無字） ----------------------------- */
async function genImageBuffer(prompt, withText = false, overlayText = '') {
  const img = await withRetry(
    (opt) => client.images.generate({
      model: 'gpt-image-1',
      size: '1536x1024',
      prompt,
    }, opt),
    'images.generate'
  );

  const b64 = img.data[0].b64_json;
  const base = Buffer.from(b64, 'base64');

  if (!withText) return base;

  const svgOverlay = buildHeroSVG(overlayText);
  const composed = await sharp(base)
    .composite([{ input: svgOverlay, blend: 'over' }])
    .png()
    .toBuffer();

  return composed;
}

/* ----------------------------- WordPress API ----------------------------- */
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
    headers: {
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': mime,
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
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

async function ensureCategories() {
  const names = ['即時新聞', '最新文章'];
  const ids = [];
  for (const n of names) {
    const id = await ensureTerm('categories', n);
    ids.push(id);
  }
  return ids;
}
async function ensureTags(tagNames) {
  const ids = [];
  for (const n of tagNames) {
    const id = await ensureTerm('tags', n);
    ids.push(id);
  }
  return ids;
}

async function postToWP({ title, content, excerpt, categories, tags, featured_media, focus_kw }) {
  const payload = {
    title,
    status: WP_STATUS || 'publish',
    content,
    excerpt,
    categories,
    tags,
    featured_media,
    meta: { rank_math_focus_keyword: focus_kw || '' },
  };
  const endpoints = [
    '/wp-json/wp/v2/posts',
    '/index.php?rest_route=/wp/v2/posts'
  ];
  for (let i = 0; i < endpoints.length; i++) {
    const res = await WP.post(endpoints[i], payload, { headers: { 'Content-Type': 'application/json' } });
    if (DEBUG === '1') console.log('WP 回應：', res.status, (res.data && res.data.id));
    if (res.status >= 200 && res.status < 300) return res.data;
  }
  throw new Error('發文失敗（兩路徑皆失敗）');
}

/* ----------------------------- Gutenberg Blocks ----------------------------- */
function h2Block(text) {
  return `<!-- wp:heading {"style":{"spacing":{"padding":{"top":"0","bottom":"0","left":"0","right":"0"}},"elements":{"link":{"color":{"text":"var:preset|color|palette-color-7"}}},"color":{"background":"#0a2a70"},"typography":{"lineHeight":"1.5"}},"textColor":"palette-color-7","fontSize":"large"} -->
<h2 class="wp-block-heading has-palette-color-7-color has-text-color has-background has-link-color has-large-font-size" style="background-color:#0a2a70;padding-top:0;padding-right:0;padding-bottom:0;padding-left:0;line-height:1.5"><strong>${text}</strong></h2>
<!-- /wp:heading -->`;
}
function pBlock(text) {
  return `<!-- wp:paragraph -->
<p>${text}</p>
<!-- /wp:paragraph -->`;
}
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
${pBlock('我是文樂，一個擁有多年寫作與數據整理經驗的編輯；如果你喜歡這類深入、好讀的整理，歡迎追蹤本站與社群。')}
${pBlock('<strong>更多文章與討論：<a href="https://lin.ee/XJQjpHj">@912rdzda</a></strong>')}
<!-- wp:image {"sizeSlug":"full","linkDestination":"none","align":"center","style":{"border":{"radius":"30px"}}} -->
<figure class="wp-block-image aligncenter size-full has-custom-border"><img src="https://bc78999.com/wp-content/uploads/2024/08/M_gainfriends_2dbarcodes_GW-1.png" alt="" style="border-radius:30px"/></figure>
<!-- /wp:image -->
<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">文樂Line官方QR code</p>
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

/* ----------------------------- 主流程 ----------------------------- */
(async () => {
  try {
    // 健康檢查（可略），方便在 Railway log 看
    try {
      const models = await withRetry((opt) => client.models.list({}, opt), 'models.list');
      if (DEBUG === '1') console.log('OpenAI /models OK，合計：', models.data?.length);
    } catch (e) {
      console.error('⚠ OpenAI /models 測試失敗：', e.message);
    }

    const picked = await pickOneFeedItem();
    if (!picked) {
      console.log('⚠ 沒有找到新的非體育 RSS 文章（可能都發過或都被排除）');
      return;
    }
    const { item, hash, feedUrl } = picked;
    if (DEBUG === '1') console.log('選到來源：', feedUrl, '→', item.title, item.link);

    // GPT 產出 JSON 草稿
    const draft = await writeLongArticle({
      title: item.title || '',
      link: item.link || '',
      snippet: item.contentSnippet || item.content || '',
    });

    const focusKeyword = draft.focus_keyword || (item.title || '').slice(0, 8) || '熱門新聞';
    const catchyTitle = draft.catchy_title || item.title || '最新焦點';
    const heroText = draft.hero_text || catchyTitle;

    // 產圖
    const basePrompt = `為以下主題產生一張寫實風格、能代表內容的新聞配圖，構圖清楚、對比強烈、適合做橫幅封面：
主題：「${catchyTitle}」
注意：不要出現商標、不要含文字、避免露點或不當內容。`;

    const contentImgBuf = await genImageBuffer(basePrompt + ' 構圖適合新聞內文插圖。', false);
    const heroImgBuf    = await genImageBuffer(basePrompt + ' 構圖適合封面。', true, heroText);

    const mediaA = await uploadMedia(heroImgBuf,   `hero-${Date.now()}.png`,   'image/png');
    const mediaB = await uploadMedia(contentImgBuf,`inline-${Date.now()}.png`, 'image/png');

    // 分類 / 標籤
    const catIds = await ensureCategories();
    const tagResp = await withRetry(
      (opt) => client.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        messages: [
          { role: 'system', content: '請給 3 個適合本文的繁體中文標籤關鍵詞，純文字用逗號分隔。' },
          { role: 'user', content: `標題：${catchyTitle}；焦點詞：${focusKeyword}` },
        ],
      }, opt),
      'chat.tags'
    );
    const tagLine = tagResp.choices?.[0]?.message?.content || '';
    const tagNames = tagLine.split(/[，,]/).map(s => s.trim()).filter(Boolean).slice(0,3);
    const tagIds = await ensureTags(tagNames.length ? tagNames : [focusKeyword]);

    // 組 Gutenberg 內容
    const contentBlocks = buildContentJSONToBlocks({
      heroUrl: mediaA.source_url,
      heroCaption: `▲ ${heroText}`,
      inlineImgUrl: mediaB.source_url,
      intro_paragraphs: draft.intro_paragraphs || [],
      sections: draft.sections || [],
    });

    // 發文（狀態來自 WP_STATUS，預設 publish）
    const wpPost = await postToWP({
      title: catchyTitle,
      content: contentBlocks,
      excerpt: focusKeyword,
      categories: catIds,
      tags: tagIds,
      featured_media: mediaA.id,
      focus_kw: focusKeyword,
    });

    console.log('✅ 已建立文章：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');

    // 記錄已發
    const store = readStore();
    store.items.push({ hash, link: item.link, time: Date.now(), wp_id: wpPost.id });
    writeStore(store);

  } catch (err) {
    const msg = err?.response?.data || err.message || err;
    console.error('❌ 失敗：', msg);
    process.exitCode = 1;
  }
})();
