// auto-news.js — 熱門新聞自動產文（不中斷版）+ 兩張圖 + RankMath + 可直接發佈
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

  // 如果你自訂 RSS，請用逗號分隔；若留空就用「綜合熱門」
  FEED_URLS = '',

  // 可用來排除體育：例如 "MLB,NBA,體育,棒球,籃球"
  FEED_EXCLUDE = '',

  // 0 = 立即執行一次
  START_DELAY_MIN = '0',

  // publish = 直接發佈；draft = 草稿
  WP_STATUS = 'publish',

  // RankMath 焦點關鍵字預設拿標題第一組詞
  IMG_SIZE = '1536x1024',
  DEBUG = '0',
} = process.env;

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

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  },
});

// ---------- 工具 ----------
const STORE = path.join(__dirname, 'posted.json');
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return { items: [] }; }
}
function writeStore(data) {
  fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
}
const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchWithRetry(doReq, { tries = 3, baseDelay = 800 } = {}) {
  let lastErr;
  for (let i=0;i<tries;i++){
    try { return await doReq(); }
    catch (e) {
      lastErr = e;
      const code = e?.response?.status || e?.code || '';
      if (DEBUG==='1') console.log(`⚠️ 請求失敗（第 ${i+1}/${tries} 次）`, code || e.message);
      await sleep(baseDelay * (i+1));
    }
  }
  throw lastErr;
}

// ---------- OpenAI：健康檢查（不致命） ----------
async function pingOpenAI() {
  try {
    await fetchWithRetry(() => client.models.list(), { tries: 2, baseDelay: 500 });
    if (DEBUG==='1') console.log('✅ OpenAI /models 200 OK');
    return true;
  } catch (e) {
    console.warn('⚠️ OpenAI /models 測試失敗：', e?.message || e);
    return false; // 只回傳 false，不中止流程
  }
}

// ---------- 產圖 ----------
async function genImage(prompt, withText=false, overlay='') {
  const res = await fetchWithRetry(() => client.images.generate({
    model: 'gpt-image-1',
    size: IMG_SIZE,
    prompt,
  }), { tries: 2, baseDelay: 800 });

  const b64 = res.data[0].b64_json;
  const base = Buffer.from(b64, 'base64');
  if (!withText) return base;

  // 疊字
  function esc(s=''){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function wrapLines(t, n=12){
    const s=(t||'').trim();
    if(!s) return [''];
    if(/\s/.test(s)){
      const ws = s.split(/\s+/), lines=[], L=n;
      let line='';
      for(const w of ws){
        if((line+' '+w).trim().length<=L) line=(line?line+' ':'')+w;
        else { if(line) lines.push(line); line=w; }
      }
      if(line) lines.push(line);
      return lines;
    }else{
      const out=[]; for(let i=0;i<s.length;i+=n) out.push(s.slice(i,i+n)); return out;
    }
  }
  const lines = wrapLines(overlay, 12);
  let fontSize = 86; if(lines.length>=4) fontSize=68; if(lines.length>=6) fontSize=56;
  const lineH = Math.round(fontSize*1.25);
  const total = lines.length*lineH;
  const startY = 512 - Math.round(total/2) + fontSize;

  const svg = Buffer.from(
`<svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1536" height="1024" fill="rgba(0,0,0,0.28)"/>
  <text x="768" y="${startY}" text-anchor="middle"
        font-family="Noto Sans TC, PingFang TC, Microsoft JhengHei, system-ui, -apple-system, Segoe UI, Arial"
        font-weight="900" font-size="${fontSize}"
        fill="#fff" stroke="#000" stroke-width="8" paint-order="stroke">
    ${wrapLines(overlay,12).map((ln,i)=>`<tspan x="768" dy="${i===0?0:lineH}">${esc(ln)}</tspan>`).join('')}
  </text>
</svg>`, 'utf8');

  return await sharp(base).composite([{ input: svg, blend: 'over' }]).png().toBuffer();
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
  if (DEBUG==='1') console.log('媒體上傳：', res.status, res.data?.id, res.data?.source_url);
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
  // 你可改成站上既有分類
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
function pBlock(text) {
  return `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;
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
${pBlock('我是文樂，一個擁有八年看球及運彩經驗的分析師，2022-25賽季長期穩定勝率57%以上；MLB與NBA預測主推勝率更高。沒時間看球？沒關係，文樂幫您解析進階數據與關鍵資訊，讓我們一起擊敗莊家！')}
${pBlock('<strong>更多賽事推薦請加入官方LINE ID：<a href="https://lin.ee/XJQjpHj">@912rdzda</a></strong>')}
<!-- wp:image {"sizeSlug":"full","linkDestination":"none","align":"center","style":{"border":{"radius":"30px"}}} -->
<figure class="wp-block-image aligncenter size-full has-custom-border"><img src="https://bc78999.com/wp-content/uploads/2024/08/M_gainfriends_2dbarcodes_GW-1.png" alt="" style="border-radius:30px"/></figure>
<!-- /wp:image -->
<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">文樂運彩Line官方QR code</p>
<!-- /wp:paragraph -->
`;
}
function toBlocks({ heroUrl, heroCaption, inlineImgUrl, intro_paragraphs, sections }) {
  let blocks = '';
  blocks += heroFigure(heroUrl, heroCaption);
  blocks += pBlock('哈囉，大家好，我是文樂。');
  (intro_paragraphs || []).forEach(t => { blocks += pBlock(t); });
  let inlineUsed = false;
  (sections || []).forEach((sec, idx) => {
    blocks += h2Block(sec.heading);
    (sec.paragraphs || []).forEach(par => {
      blocks += pBlock(par);
      if (!inlineUsed && (/\[內文圖\]/.test(par) || idx === 2)) {
        if (inlineImgUrl) blocks += inlineFigure(inlineImgUrl);
        inlineUsed = true;
      }
    });
  });
  blocks += ctaBlock();
  return blocks;
}

// ---------- RSS 擷取 ----------
function defaultFeeds() {
  // 綜合熱門（不是體育），你也可以自己指定 FEED_URLS
  return [
    'https://news.google.com/rss?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
    'https://news.google.com/rss/headlines/section/topic/NATION.zh-TW_TW?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
    'https://news.google.com/rss/headlines/section/topic/WORLD.zh-TW_TW?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
    'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY.zh-TW_TW?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
    'https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT.zh-TW_TW?hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
  ];
}

function shouldExclude(title, excludeCsv) {
  if (!excludeCsv) return false;
  const ks = excludeCsv.split(',').map(s=>s.trim()).filter(Boolean);
  return ks.some(k => title.includes(k));
}

async function pickOneFeedItem() {
  const feeds = (FEED_URLS || '').split(',').map(s=>s.trim()).filter(Boolean);
  const FEEDS = feeds.length ? feeds : defaultFeeds();

  const store = readStore();
  const seen = new Set(store.items.map(x => x.hash));

  for (const url of FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items) {
        const key = item.link || item.guid || item.title || JSON.stringify(item);
        const h = sha1(key);
        if (seen.has(h)) continue;
        if (shouldExclude(item.title || '', FEED_EXCLUDE)) continue;
        return { feedUrl: url, item, hash: h };
      }
    } catch (e) {
      console.error('讀取 RSS 失敗：', url, e.message);
    }
  }
  return null;
}

// ---------- 文字生成（3000–3600） ----------
async function writeLongArticle({ title, link, snippet }) {
  const sys = `你是中文新聞專欄編輯。請根據「來源標題、摘要與連結」寫出 3000–3600 字、可發布的文章草稿：
- 口吻中立、具可讀性、避免抄襲；改寫與延伸
- 分成 6 段主題，每段有一個 h2 小標（不含井號）
- 每段 2–4 段敘述，具體、不流水帳
- 開頭固定：第一句「哈囉，大家好，我是文樂。」接著 2–3 段前言
- 文章中段合適位置，段落末標「[內文圖]」（僅一次）
- 結尾 2 段收束觀點與延伸
- 請回傳 JSON：{focus_keyword, catchy_title, hero_text, sections:[{heading, paragraphs:[...]}], intro_paragraphs:[...]}
- sections 恰好 6 個，paragraphs 為陣列
- 所有字串為純文字（不要 HTML）`;

  const user = `來源標題：${title}
來源連結：${link}
來源摘要：${snippet || '(RSS 無摘要)'}
請務必回傳 JSON，並盡量達到 3000–3600 字。`;

  const resp = await fetchWithRetry(() => client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.6,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  }), { tries: 3, baseDelay: 1200 });

  let data;
  try {
    const text = resp.choices[0]?.message?.content || '{}';
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('GPT 回傳非 JSON，無法解析：' + e.message);
  }
  return data;
}

// ---------- 發文 ----------
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
  for (let i=0; i<endpoints.length; i++) {
    const res = await WP.post(endpoints[i], payload, { headers: { 'Content-Type': 'application/json' } });
    if (DEBUG==='1') console.log('WP 回應：', res.status, (res.data && res.data.id));
    if (res.status >= 200 && res.status < 300) return res.data;
  }
  throw new Error('發文失敗：' + JSON.stringify(payload).slice(0, 400));
}

// ---------- 主流程 ----------
async function runOnce() {
  console.log('▶️ 開始一次任務');

  // 健康檢查：失敗只警告，不中斷
  await pingOpenAI();

  const picked = await pickOneFeedItem();
  if (!picked) {
    console.log('⚠ 沒有找到新的 RSS 文章（或都被排除）');
    return;
  }
  const { item, hash, feedUrl } = picked;
  if (DEBUG==='1') console.log('選到來源：', feedUrl, '→', item.title, item.link);

  // 產文
  let draft;
  try {
    draft = await writeLongArticle({
      title: item.title || '',
      link: item.link || '',
      snippet: item.contentSnippet || item.content || '',
    });
  } catch (e) {
    console.error('OpenAI 產生內容失敗：', e.message || e);
    return; // 不中斷整個容器，等待下次排程
  }

  const focusKeyword = draft.focus_keyword || (item.title || '').split(' ')[0] || '熱門新聞';
  const catchyTitle = draft.catchy_title || item.title || '最新焦點';
  const heroText = draft.hero_text || catchyTitle;

  // 兩張圖
  let mediaA, mediaB;
  try {
    const basePrompt = `為以下主題產生一張寫實風格、能代表內容的新聞配圖，構圖清楚、對比強烈、適合做橫幅封面：主題：「${catchyTitle}」。不要商標、不要文字。`;
    const contentImgBuf = await genImage(basePrompt + ' 構圖適合內文插圖。', false);
    const heroImgBuf    = await genImage(basePrompt + ' 構圖適合封面。', true, heroText);
    mediaA = await uploadMedia(heroImgBuf, `hero-${Date.now()}.png`, 'image/png');
    mediaB = await uploadMedia(contentImgBuf, `inline-${Date.now()}.png`, 'image/png');
  } catch (e) {
    console.error('產圖或上傳媒體失敗：', e.message || e);
    // 照樣發文，只是沒有圖片
  }

  // 分類 / 標籤
  const catIds = await ensureCategories();
  let tagIds = [];
  try {
    const tagResp = await fetchWithRetry(() => client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: '給我 3 個適合的繁體中文標籤關鍵詞，純文字用逗號分隔。' },
        { role: 'user', content: `主題：${catchyTitle}；焦點詞：${focusKeyword}` },
      ],
    }), { tries: 2, baseDelay: 800 });
    const tagLine = tagResp.choices[0]?.message?.content || '';
    const tagNames = tagLine.split(/[，,]/).map(s => s.trim()).filter(Boolean).slice(0,3);
    tagIds = await ensureTags(tagNames.length ? tagNames : [focusKeyword]);
  } catch {
    tagIds = await ensureTags([focusKeyword]);
  }

  // 內文區塊
  const blocks = toBlocks({
    heroUrl: mediaA?.source_url || '',
    heroCaption: `▲ ${heroText}`,
    inlineImgUrl: mediaB?.source_url || '',
    intro_paragraphs: draft.intro_paragraphs || [],
    sections: draft.sections || [],
  });

  // 發文
  const wpPost = await postToWP({
    title: catchyTitle,
    content: blocks,
    excerpt: focusKeyword,
    categories: catIds,
    tags: tagIds,
    featured_media: mediaA?.id,
    focus_kw: focusKeyword,
  });

  console.log('✅ 已建立文章：', wpPost.id, wpPost.link || wpPost.guid?.rendered || '(no-link)');

  // 去重紀錄
  const store = readStore();
  store.items.push({ hash, link: item.link, time: Date.now(), wp_id: wpPost.id });
  writeStore(store);
}

async function main() {
  console.log('Starting Container');

  // 立即執行
  const delay = Number(START_DELAY_MIN || '0') || 0;
  if (delay === 0) {
    await runOnce();
  } else {
    setTimeout(runOnce, delay * 60 * 1000);
  }

  // 保持進程（Railway 不中斷）
  setInterval(() => {}, 1 << 30);
}

main().catch(e => {
  console.error('❌ 主程序錯誤：', e.message || e);
});
