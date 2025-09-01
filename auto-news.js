// auto-news.js — 熱門新聞自動發文（禁放來源/網址；兩張圖；Gutenberg；RankMath）
// -------------------------------------------------------
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
  OPENAI_BASE_URL = 'https://api.openai.com/v1',
  OPENAI_TIMEOUT_MS = '60000',
  WP_URL,
  WP_USER,
  WP_APP_PASSWORD,
  // 若 FEED_URLS 留空，預設使用「綜合熱門」的 Google News（避免偏體育）
  FEED_URLS = '',
  DEBUG = '0',
  WP_STATUS = 'publish',  // ← 直接發佈
  START_DELAY_MIN = '0',  // ← 容器啟動立即跑一次
} = process.env;

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

// ---------- OpenAI ----------
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
  timeout: parseInt(OPENAI_TIMEOUT_MS, 10) || 60000,
});

// ---------- RSS ----------
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});

// ---------- 去重存檔 ----------
const STORE = path.join(__dirname, 'posted.json');
function readStore() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return { items: [] }; } }
function writeStore(data) { fs.writeFileSync(STORE, JSON.stringify(data, null, 2)); }
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

// 預設熱門（避免體育）
function defaultFeeds() {
  return [
    'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant', // 綜合要聞
    'https://news.google.com/rss/headlines/section/CAAqKggKIiNDQkFTRlFvSUwyMHZNR0Z5Y0dFNU1YQnlaVzRvQ2hFUWlsa0tBQVAB?hl=zh-TW&gl=TW&ceid=TW:zh-Hant', // 熱門新聞（台灣）
  ];
}

async function pickOneFeedItem() {
  const list = FEED_URLS
    ? FEED_URLS.split(',').map(s => s.trim()).filter(Boolean)
    : defaultFeeds();
  const store = readStore();
  const seen = new Set(store.items.map(x => x.hash));

  for (const url of list) {
    try {
      const feed = await parser.parseURL(url);
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

// ---------- 文字生成（3000–3600字，禁止來源/網址） ----------
async function writeLongArticle({ title, link, snippet }) {
  const sys = `你是中文新聞與專欄寫作者。請根據「標題與摘要」創作 3000–3600 字、可直接發布的文章：
- 立場中立、避免抄襲；用自己的話改寫與延伸。
- 全文禁止出現任何來源/出處/延伸閱讀/參考資料，小標或文字都不允許。
- 全文禁止出現任何連結或網址；不要含 http/https、www、.com、.tw 等字樣。
- 分 6 個主題段落，每段有一個精煉的 h2 小標（不含井號）；每段 2–4 段落。
- 開頭固定第一行：「哈囉，大家好，我是文樂。」接著 2–3 段前言。
- 文中適合放一張圖片的位置，請在該段落文末用「[內文圖]」標記（僅一次）。
- 收尾 2 段作結。
- 僅回傳 JSON：{focus_keyword, catchy_title, hero_text, sections:[{heading, paragraphs:[...]}], intro_paragraphs:[...]}
- sections 恰好 6 個；paragraphs 是文字陣列；所有字串都是純文字（不要 HTML/網址/來源）。`;

  const user = `標題：${title || '(未提供)'}
摘要：${snippet || '(RSS 無摘要)'}
（備註：你可以把「標題與摘要」當題目靈感延伸，不用也不要放任何來源或網址。）`;

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

// ---------- 內容清洗：移除網址／來源型小標 ----------
const URL_RE = /\bhttps?:\/\/[^\s<>"'）)]+/gi;
const WWW_RE = /\bwww\.[^\s<>"'）)]+/gi;
const BAD_H2_RE = /(來源|出處|延伸閱讀|參考資料|傳送門|原文|全文|更多)/i;
const BAD_LINE_RE = /(來源|出處|延伸閱讀|參考資料|傳送門)[:：]/i;

function stripUrls(s = '') {
  return s.replace(URL_RE, '').replace(WWW_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function cleanParagraph(p) {
  let t = p || '';
  t = t.replace(BAD_LINE_RE, '').trim();
  t = stripUrls(t);
  return t;
}
function cleanHeading(h) {
  const hh = (h || '').trim();
  if (BAD_H2_RE.test(hh)) return ''; // 丟掉
  return hh;
}

function sanitizeArticle(draft) {
  const out = {
    focus_keyword: stripUrls(draft.focus_keyword || ''),
    catchy_title: stripUrls(draft.catchy_title || ''),
    hero_text: stripUrls(draft.hero_text || ''),
    intro_paragraphs: (draft.intro_paragraphs || []).map(cleanParagraph).filter(Boolean),
    sections: [],
  };

  // 過濾 6 個段落
  (draft.sections || []).forEach(sec => {
    const h = cleanHeading(sec.heading);
    if (!h) return;
    const pars = (sec.paragraphs || []).map(cleanParagraph).filter(Boolean);
    if (pars.length) out.sections.push({ heading: h, paragraphs: pars });
  });

  // 若清完不足 6 個段落，保留現有即可（避免中斷）
  return out;
}

// ---------- SVG 疊字 ----------
function esc(s=''){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function wrapLines(text, n=12){
  const t=(text||'').trim(); if(!t) return [''];
  if (/\s/.test(t)) {
    const words = t.split(/\s+/); const lines=[]; let line='';
    for (const w of words) {
      if ((line+' '+w).trim().length<=n) line = (line?line+' ':'')+w;
      else { if(line) lines.push(line); line=w; }
    } if (line) lines.push(line); return lines;
  } else {
    const lines=[]; for(let i=0;i<t.length;i+=n) lines.push(t.slice(i,i+n)); return lines;
  }
}
function buildHeroSVG(overlayText) {
  let lines = wrapLines(overlayText, 12);
  let fontSize = 86; if (lines.length>=4) fontSize=68; if (lines.length>=6) fontSize=56;
  const lineHeight = Math.round(fontSize * 1.25);
  const total = lines.length * lineHeight;
  const startY = 512 - Math.round(total/2) + fontSize;
  const tspans = lines.map((ln,i)=>`<tspan x="768" dy="${i===0?0:lineHeight}">${esc(ln)}</tspan>`).join('');
  return Buffer.from(
`<svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1536" height="1024" fill="rgba(0,0,0,0.28)"/>
  <text x="768" y="${startY}" text-anchor="middle"
        font-family="Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, -apple-system, Segoe UI, Arial"
        font-weight="900" font-size="${fontSize}" fill="#ffffff" stroke="#000" stroke-width="8" paint-order="stroke">
    ${tspans}
  </text>
</svg>`, 'utf8');
}

// ---------- 產圖（內文無字；封面有字） ----------
async function genImageBuffer(prompt, withText=false, overlayText='') {
  const img = await client.images.generate({
    model: 'gpt-image-1',
    size: '1536x1024',
    prompt,
  });
  const b64 = img.data[0].b64_json;
  const base = Buffer.from(b64, 'base64');
  if (!withText) return base;
  const svgOverlay = buildHeroSVG(overlayText);
  return await sharp(base).composite([{ input: svgOverlay, blend: 'over' }]).png().toBuffer();
}

// ---------- WordPress ----------
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
  if (res.status>=200 && res.status<300) return res.data;
  throw new Error(`媒體上傳失敗：${res.status} ${JSON.stringify(res.data).slice(0,500)}`);
}
async function ensureTerm(tax, name) {
  const slug = slugify(name, { lower: true, strict: true });
  const q = await WP.get(`/wp-json/wp/v2/${tax}`, { params: { per_page: 100, search: name } });
  if (q.status===200 && Array.isArray(q.data)) {
    const hit = q.data.find(t => t.name===name || t.slug===slug);
    if (hit) return hit.id;
  }
  const c = await WP.post(`/wp-json/wp/v2/${tax}`, { name, slug });
  if (c.status>=200 && c.status<300) return c.data.id;
  throw new Error(`建立 ${tax} 失敗：${c.status} ${JSON.stringify(c.data).slice(0,300)}`);
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

// ---------- Gutenberg blocks ----------
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
function inlineFigure(src) {
  return `<!-- wp:image {"sizeSlug":"full","linkDestination":"none"} -->
<figure class="wp-block-image size-full"><img src="${src}" alt=""/></figure>
<!-- /wp:image -->`;
}
function ctaBlock() {
  return `
${h2Block('關注加入文樂運彩分析領取投注策略')}
${pBlock('我是文樂，一個擁有八年看球及運彩經驗的分析師，2022-25賽季長期穩定勝率57%以上，本季依然保持在57%；MLB與NBA預測主推勝率更高達60%。沒時間看球？沒關係，文樂幫您解析進階數據與背後意義；讓我們攜手擊敗莊家！')}
${pBlock('<strong>更多賽事推薦請加入官方LINE ID：<a href="https://lin.ee/XJQjpHj">@912rdzda</a></strong>')}
<!-- wp:image {"sizeSlug":"full","linkDestination":"none","align":"center","style":{"border":{"radius":"30px"}}} -->
<figure class="wp-block-image aligncenter size-full has-custom-border"><img src="https://bc78999.com/wp-content/uploads/2024/08/M_gainfriends_2dbarcodes_GW-1.png" alt="" style="border-radius:30px"/></figure>
<!-- /wp:image -->
<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">文樂運彩Line官方QR code</p>
<!-- /wp:paragraph -->`;
}

// 內容轉 Gutenberg（內建清洗）
function buildContentJSONToBlocks({ heroUrl, heroCaption, inlineImgUrl, intro_paragraphs, sections }) {
  let blocks = '';
  blocks += heroFigure(heroUrl, heroCaption);

  // 開頭固定＋前言
  blocks += pBlock('哈囉，大家好，我是文樂。');
  (intro_paragraphs || []).forEach(t => { if (t) blocks += pBlock(t); });

  // 主文
  let inlineUsed = false;
  (sections || []).forEach((sec, idx) => {
    if (!sec?.heading || !sec?.paragraphs?.length) return;
    blocks += h2Block(sec.heading);
    sec.paragraphs.forEach(par => {
      if (!par) return;
      blocks += pBlock(par);
      if (!inlineUsed && (/\[內文圖\]/.test(par) || idx === 2)) {
        if (inlineImgUrl) blocks += inlineFigure(inlineImgUrl);
        inlineUsed = true;
      }
    });
  });

  // CTA
  blocks += ctaBlock();
  return blocks;
}

// ---------- 發文 ----------
async function postToWP({ title, content, excerpt, categories, tags, featured_media, focus_kw }) {
  const payload = {
    title,
    status: WP_STATUS, // publish / draft
    content,
    excerpt,
    categories,
    tags,
    featured_media,
    meta: { rank_math_focus_keyword: focus_kw || '' },
  };
  const endpoints = ['/wp-json/wp/v2/posts', '/index.php?rest_route=/wp/v2/posts'];
  for (const ep of endpoints) {
    const res = await WP.post(ep, payload, { headers: { 'Content-Type': 'application/json' } });
    if (DEBUG === '1') console.log('WP 回應：', res.status, (res.data && res.data.id));
    if (res.status>=200 && res.status<300) return res.data;
  }
  throw new Error('發文失敗：' + JSON.stringify(payload).slice(0,400));
}

// ---------- 主流程 ----------
(async () => {
  try {
    const delay = parseInt(START_DELAY_MIN, 10) || 0;
    if (delay>0) { console.log(`延遲 ${delay} 分鐘啟動…`); await new Promise(r=>setTimeout(r, delay*60*1000)); }

    const picked = await pickOneFeedItem();
    if (!picked) { console.log('⚠ 沒有找到新的 RSS 文章（可能都發過了或被排除）'); return; }
    const { item, hash, feedUrl } = picked;
    if (DEBUG === '1') console.log('選到來源：', feedUrl, '→', item.title, item.link);

    const raw = await writeLongArticle({
      title: item.title || '',
      link: item.link || '', // 只作為靈感，不會寫到文內
      snippet: item.contentSnippet || item.content || '',
    });

    const draft = sanitizeArticle(raw);

    const focusKeyword = draft.focus_keyword || (item.title || '').split(' ')[0] || '熱門新聞';
    const catchyTitle  = draft.catchy_title || item.title || '最新焦點';
    const heroText     = draft.hero_text || catchyTitle;

    const basePrompt = `為以下主題產生一張寫實風格、能代表內容的新聞配圖：主題「${catchyTitle}」。不含文字與商標，避免不當內容。`;
    const contentImgBuf = await genImageBuffer(basePrompt + ' 構圖適合新聞內文插圖。', false);
    const heroImgBuf    = await genImageBuffer(basePrompt + ' 構圖適合封面。', true, heroText);

    const mediaA = await uploadMedia(heroImgBuf, `hero-${Date.now()}.png`, 'image/png');
    const mediaB = await uploadMedia(contentImgBuf, `inline-${Date.now()}.png`, 'image/png');

    const catIds = await ensureCategories();
    const tagResp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: '給我 3 個適合的繁體中文標籤關鍵詞，純文字用逗號分隔，避免體育相關字。' },
        { role: 'user', content: `主題：${catchyTitle}；焦點詞：${focusKeyword}` },
      ],
    });
    const tagLine = tagResp.choices[0]?.message?.content || '';
    const tagNames = tagLine.split(/[，,]/).map(s => s.trim()).filter(Boolean).slice(0,3);
    const tagIds  = await ensureTags(tagNames.length ? tagNames : [focusKeyword]);

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

    console.log('✅ 已建立文章：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');

    const store = readStore();
    store.items.push({ hash, link: item.link, time: Date.now(), wp_id: wpPost.id });
    writeStore(store);

  } catch (err) {
    const msg = err?.response?.data || err.message || err;
    console.error('❌ 失敗：', msg);
    process.exitCode = 1;
  }
})();
