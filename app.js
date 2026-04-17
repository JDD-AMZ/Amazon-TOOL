// ===== State =====
const state = {
  currentStep: 1,
  asin: '',
  asinUrl: '',
  rawListing: '',
  analysisResult: null,
  ourProductName: '',
  ourSellPoints: '',
  focusAreas: [],
  rivalAsins: [],      // 用户输入的参考竞品 ASIN 列表
  rivalListings: [],   // 已拉取的参考竞品 listing 数据 [{asin, title, bullets}]
  styleRefListings: [], // 风格参考竞品 listing [{asin, title, bullets}]
};

// ===== Settings =====
function getSettings() {
  return {
    provider: localStorage.getItem('apiProvider') || 'gemini',
    apiKey: localStorage.getItem('apiKey') || '',
    customUrl: localStorage.getItem('customUrl') || '',
    customModel: localStorage.getItem('customModel') || 'gpt-4o',
    geminiModel: localStorage.getItem('geminiModel') || 'gemini-2.5-flash-lite',
    openaiModel: localStorage.getItem('openaiModel') || 'gpt-4o',
    sorfTimeKey: localStorage.getItem('sorfTimeKey') || '',
  };
}
function saveSettings() {
  localStorage.setItem('apiProvider', document.getElementById('apiProvider').value);
  localStorage.setItem('apiKey', document.getElementById('apiKey').value);
  localStorage.setItem('customUrl', document.getElementById('customUrl').value || '');
  localStorage.setItem('customModel', document.getElementById('customModel').value || '');
  localStorage.setItem('geminiModel', document.getElementById('geminiModel').value);
  localStorage.setItem('openaiModel', document.getElementById('openaiModel').value);
  localStorage.setItem('sorfTimeKey', document.getElementById('sorfTimeKey').value || '');
  closeModal();
  showToast('API 配置已保存', 'success');
}

// ===== ASIN Extractor =====
function extractASIN(input) {
  input = input.trim();
  // Direct ASIN
  if (/^[A-Z0-9]{10}$/.test(input)) return input;
  // From URL /dp/ASIN or /gp/product/ASIN
  const m = input.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  // From URL asin= param
  const m2 = input.match(/[?&]asin=([A-Z0-9]{10})/i);
  if (m2) return m2[1].toUpperCase();
  return null;
}
function buildAmazonUrl(asin) {
  return `https://www.amazon.com/dp/${asin}`;
}

// ===== Step Navigation =====
function goToStep(n) {
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`step${n}`).classList.add('active');
  document.querySelectorAll('.step-item').forEach((el, i) => {
    el.classList.remove('active', 'done');
    const sn = parseInt(el.dataset.step);
    if (sn === n) el.classList.add('active');
    else if (sn < n) el.classList.add('done');
  });
  state.currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== AI Call =====
// forceGeminiModel: 若传入，Gemini provider 将强制使用该模型（忽略设置中的默认值）
// temperature: 0 用于需要确定性输出的评分，0.7 用于文案生成
async function callAI(systemPrompt, userPrompt, forceGeminiModel = null, temperature = 0.7) {
  const s = getSettings();
  if (!s.apiKey) {
    throw new Error('请先点击右上角"API 设置"配置您的 API Key');
  }

  let url, headers, body;

  if (s.provider === 'openai') {
    url = 'https://api.openai.com/v1/chat/completions';
    const model = s.openaiModel || 'gpt-4o';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${s.apiKey}`,
    };
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: 16000,
    });
  } else if (s.provider === 'custom') {
    url = s.customUrl || 'https://api.openai.com/v1/chat/completions';
    const model = s.customModel || 'gpt-4o';
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${s.apiKey}`,
    };
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature,
      max_tokens: 16000,
    });
  } else if (s.provider === 'gemini') {
    const model = forceGeminiModel || s.geminiModel || 'gemini-2.5-pro-preview-03-25';
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${s.apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({
      contents: [{
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
      }],
      generationConfig: { temperature, maxOutputTokens: 65536 },
    });
  }

  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body });
  } catch (networkErr) {
    if (s.provider === 'gemini') {
      throw new Error('网络请求被拦截（CORS）。请在 API 设置中改用"自定义接口"模式，填入代理地址，或直接在本地用 http-server 打开页面而非 file:// 协议。');
    }
    throw new Error('网络请求失败：' + networkErr.message);
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `API 请求失败 (${resp.status})`;
    if (resp.status === 400) throw new Error('请求参数错误：' + msg);
    if (resp.status === 403) throw new Error('API Key 无效或无权限：' + msg);
    if (resp.status === 429) throw new Error('请求过于频繁，请稍后再试：' + msg);
    throw new Error(msg);
  }
  const data = await resp.json();

  if (s.provider === 'gemini') {
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  return data?.choices?.[0]?.message?.content || '';
}

// ===== Auto-Fetch Listing =====
let fetchedListingData = null; // { title, bullets, brand, price, rating, reviewCount, source }

// ===== 健壮 JSON 解析（支持自动修复截断） =====
function safeParseJSON(raw) {
  if (!raw) throw new Error('AI 返回内容为空');
  // 去掉 markdown 代码块包裹
  let s = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/,'').trim();
  // 直接尝试解析
  try { return JSON.parse(s); } catch(_) {}
  // 提取最外层 { ... }
  const start = s.indexOf('{');
  if (start === -1) throw new Error('AI 返回内容中未找到 JSON 对象');
  s = s.slice(start);
  // 直接再试
  try { return JSON.parse(s); } catch(_) {}
  // 截断修复：找到最后一个完整值后强制闭合所有未闭合的 [ { "
  s = fixTruncatedJSON(s);
  try { return JSON.parse(s); } catch(e) {
    throw new Error('AI 返回的 JSON 格式无法修复，请重试。原始错误：' + e.message);
  }
}

function fixTruncatedJSON(s) {
  // 逐字符追踪堆栈，截掉不完整的末尾，然后补齐闭合符号
  const stack = [];
  let inStr = false, escape = false, lastValidPos = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') {
      inStr = !inStr;
      if (!inStr) lastValidPos = i + 1; // 字符串刚闭合
      continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') {
      stack.pop();
      lastValidPos = i + 1;
      continue;
    }
    if (c === ',' || c === ':') continue;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
    // 数字、布尔、null 等基础值
    if (!inStr) lastValidPos = i + 1;
  }
  // 截掉末尾可能不完整的部分（逗号、不完整的字符串、不完整的键名）
  let trimmed = s.slice(0, lastValidPos).trimEnd().replace(/,\s*$/, '');
  // 补齐未闭合的括号（反序）
  for (let i = stack.length - 1; i >= 0; i--) {
    trimmed += stack[i] === '{' ? '}' : ']';
  }
  return trimmed;
}

// --- Sorftime ProductRequest ---
async function fetchViaSorftime(asin, sk) {
  // 判断是否通过代理服务器运行（port 3001），自动切换代理路径
  const useProxy = location.port === '3001';
  const url = useProxy
    ? `http://localhost:3001/proxy/sorftime/ProductRequest?domain=1`
    : `https://standardapi.sorftime.com/api/ProductRequest?domain=1`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `BasicAuth ${sk}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: JSON.stringify({ asin }),
    });
  } catch (networkErr) {
    if (!useProxy) {
      throw new Error('CORS 拦截 — 请改用代理服务器启动：node proxy.js，然后访问 http://localhost:3001');
    }
    throw new Error('代理请求失败：' + networkErr.message);
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.message || `Sorftime 请求失败 (${resp.status})`;
    throw new Error(msg);
  }
  const data = await resp.json();
  // Sorftime 成功码是 Code:0，非0为错误
  if (data.Code !== 0) {
    if (data.Code === 4) throw new Error('Sorftime 积分余额不足，请充值后重试');
    if (data.Code === 1) throw new Error('Sorftime 认证失败，请检查 API Key');
    if (data.Code === 2) throw new Error('Sorftime 请求参数错误');
    if (data.Code === 3) throw new Error('Sorftime 数据不存在（ASIN 未收录）');
    throw new Error(data.Message || `Sorftime 返回异常 (Code: ${data.Code})`);
  }
  if (!data.Data) throw new Error('Sorftime 返回数据为空');
  const d = data.Data;

  // 解析 Description（HTML，用 <br> 分隔每条五点）
  let bullets = [];
  if (d.Description) {
    bullets = d.Description
      .split(/<br\s*\/?>/i)
      .map(s => s.replace(/<[^>]+>/g, '').trim())
      .filter(s => s.length > 0);
  }

  // Price 单位为分（整数），÷100 转美元
  const priceNum = d.Price && d.Price > 0 ? (d.Price / 100).toFixed(2) : null;

  // 星级分布
  const starRatings = {
    5: d.FiveStartRatings || 0,
    4: d.FourStartRatings || 0,
    3: d.ThreeStartRatings || 0,
    2: d.TwoStartRatings || 0,
    1: d.OneStartRatings || 0,
  };

  // Feature 评分（对象格式 { "Easy to clean": 4.5, ... }）
  const featureRatings = d.Feature && typeof d.Feature === 'object' ? d.Feature : null;

  // BSR 信息
  const bsrInfo = Array.isArray(d.BsrCategory) && d.BsrCategory[0]
    ? { category: d.BsrCategory[0][0], rank: d.BsrCategory[0][2] }
    : null;

  return {
    title: d.Title || '',
    bullets,
    brand: d.Brand || '',
    price: priceNum ? `$${priceNum}` : '',
    rating: d.Ratings || '',
    reviewCount: d.RatingsCount || '',
    starRatings,
    featureRatings,
    bsrInfo,
    asin: d.Asin || '',
    source: 'sorftime',
  };
}

// --- Sorftime 评论接口 ---
let fetchedReviewsData = null; // 原始评论数组

// --- Sorftime 子体销量历史接口 ---
async function fetchSalesHistoryViaSorftime(asin, sk) {
  const useProxy = location.port === '3001';
  const url = useProxy
    ? `http://localhost:3001/proxy/sorftime/ProductSalesQuery?domain=1`
    : `https://standardapi.sorftime.com/api/ProductSalesQuery?domain=1`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secretKey: sk, asin }),
  });
  if (!resp.ok) throw new Error(`Sorftime 销量接口请求失败 (${resp.status})`);
  const data = await resp.json();
  if (data.Code !== 0) {
    if (data.Code === 4) throw new Error('Sorftime 积分余额不足');
    if (data.Code === 1) throw new Error('Sorftime 认证失败，请检查 API Key');
    if (data.Code === 3) throw new Error('该 ASIN 暂无销量数据');
    throw new Error(data.Message || `Sorftime 销量接口异常 (Code: ${data.Code})`);
  }
  // Data 格式: [ [日期, 销量值, 子体数], ... ]
  return (data.Data || []).map(row => ({
    date: row[0],
    sales: parseInt(row[1], 10) || 0,
    variants: parseInt(row[2], 10) || 0,
  }));
}

// ===== 参考竞品 ASIN 批量拉取 =====
// 通过 Sorftime 或 AI 回退，逐个拉取 title + bullets，存入 state.rivalListings
async function fetchRivalListings() {
  const rows = document.querySelectorAll('.rival-asin-input');
  const inputs = Array.from(rows).map(el => el.value.trim()).filter(Boolean);
  if (inputs.length === 0) {
    showToast('请至少填写一个参考竞品 ASIN', 'error');
    return;
  }

  const sk = getSettings().sorfTimeKey;
  const btn = document.getElementById('fetchRivalsBtn');
  const btnText = document.getElementById('fetchRivalsBtnText');
  btn.disabled = true;
  btnText.textContent = '拉取中...';

  state.rivalListings = [];
  const summaryEl = document.getElementById('rivalFetchedSummary');
  summaryEl.style.display = 'none';

  // 逐行更新状态图标
  const statusEls = document.querySelectorAll('.rival-status');
  const resetStatuses = () => statusEls.forEach(el => { el.textContent = ''; el.className = 'rival-status'; });
  resetStatuses();

  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i];
    const asin = extractASIN(raw) || raw.toUpperCase();
    const rowStatus = document.querySelectorAll('.rival-row')[i]?.querySelector('.rival-status');
    if (rowStatus) { rowStatus.textContent = '⏳'; rowStatus.className = 'rival-status loading'; }

    try {
      let listing;
      if (sk) {
        listing = await fetchViaSorftime(asin, sk);
      } else {
        // AI 回退
        listing = await fetchViaAI(asin);
      }
      results.push({ asin, title: listing.title, bullets: listing.bullets });
      if (rowStatus) { rowStatus.textContent = '✓'; rowStatus.className = 'rival-status success'; }
    } catch (err) {
      results.push({ asin, title: '', bullets: [], error: err.message });
      if (rowStatus) { rowStatus.textContent = '✗'; rowStatus.className = 'rival-status error'; rowStatus.title = err.message; }
    }
  }

  state.rivalListings = results.filter(r => r.title || r.bullets?.length > 0);
  state.rivalAsins = state.rivalListings.map(r => r.asin);

  // 渲染摘要
  if (state.rivalListings.length > 0) {
    let html = `<div class="rival-fetched-header">已成功获取 ${state.rivalListings.length} 个参考竞品 Listing</div>`;
    state.rivalListings.forEach(item => {
      html += `<div class="rival-fetched-item">
        <div class="rival-fetched-asin">${item.asin}</div>
        <div class="rival-fetched-title">${escHtml(item.title)}</div>
        ${item.bullets?.length ? `<ul class="rival-fetched-bullets">${item.bullets.slice(0,3).map(b => `<li>${escHtml(b.slice(0,120))}${b.length>120?'…':''}</li>`).join('')}${item.bullets.length>3?`<li style="color:var(--text-muted)">…共${item.bullets.length}条</li>`:''}</ul>` : ''}
      </div>`;
    });
    summaryEl.innerHTML = html;
    summaryEl.style.display = 'block';
    showToast(`已拉取 ${state.rivalListings.length} 个参考竞品数据`, 'success');
  } else {
    showToast('所有参考竞品拉取失败，请检查 ASIN 或 API Key', 'error');
  }

  btn.disabled = false;
  btnText.textContent = state.rivalListings.length > 0 ? `✓ 已拉取（重新获取）` : '批量拉取竞品 Listing';
}

// ===== 风格参考竞品 ASIN 拉取（1~2个，用于生成风格参考版标题/五点/图需）=====
async function fetchStyleRefListings() {
  const rows = document.querySelectorAll('.styleref-asin-input');
  const inputs = Array.from(rows).map(el => el.value.trim()).filter(Boolean);
  if (inputs.length === 0) {
    showToast('请至少填写一个风格参考竞品 ASIN', 'error');
    return;
  }

  const sk = getSettings().sorfTimeKey;
  const btn = document.getElementById('fetchStyleRefBtn');
  const btnText = document.getElementById('fetchStyleRefBtnText');
  btn.disabled = true;
  btnText.textContent = '拉取中...';

  state.styleRefListings = [];
  const summaryEl = document.getElementById('styleRefFetchedSummary');
  summaryEl.style.display = 'none';

  const results = [];
  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i];
    const asin = extractASIN(raw) || raw.toUpperCase();
    const rowStatus = document.querySelectorAll('.styleref-row')[i]?.querySelector('.styleref-status');
    if (rowStatus) { rowStatus.textContent = '⏳'; rowStatus.className = 'styleref-status loading'; }

    try {
      const listing = sk ? await fetchViaSorftime(asin, sk) : await fetchViaAI(asin);
      results.push({ asin, title: listing.title, bullets: listing.bullets });
      if (rowStatus) { rowStatus.textContent = '✓'; rowStatus.className = 'styleref-status success'; }
    } catch (err) {
      results.push({ asin, title: '', bullets: [], error: err.message });
      if (rowStatus) { rowStatus.textContent = '✗'; rowStatus.className = 'styleref-status error'; rowStatus.title = err.message; }
    }
  }

  state.styleRefListings = results.filter(r => r.title || r.bullets?.length > 0);

  if (state.styleRefListings.length > 0) {
    let html = `<div class="rival-fetched-header">✅ 已获取 ${state.styleRefListings.length} 个风格参考竞品，生成时将额外输出「风格参考版」Tab</div>`;
    state.styleRefListings.forEach(item => {
      html += `<div class="rival-fetched-item">
        <div class="rival-fetched-asin">${item.asin}</div>
        <div class="rival-fetched-title">${escHtml(item.title)}</div>
        ${item.bullets?.length ? `<ul class="rival-fetched-bullets">${item.bullets.slice(0,2).map(b => `<li>${escHtml(b.slice(0,120))}${b.length>120?'…':''}</li>`).join('')}</ul>` : ''}
      </div>`;
    });
    summaryEl.innerHTML = html;
    summaryEl.style.display = 'block';
    showToast(`风格参考竞品已就绪，生成时将额外输出「风格参考版」Tab`, 'success');
  } else {
    showToast('拉取失败，请检查 ASIN 或 API Key', 'error');
  }

  btn.disabled = false;
  btnText.textContent = state.styleRefListings.length > 0 ? '✓ 已拉取（重新获取）' : '拉取风格参考 Listing';
}

// ===== Sorftime 评论拉取 =====
async function fetchReviewsViaSorftime(asin, sk) {
  const useProxy = location.port === '3001';
  const url = useProxy
    ? `http://localhost:3001/proxy/sorftime/ProductReviewsQuery?domain=1`
    : `https://standardapi.sorftime.com/api/ProductReviewsQuery?domain=1`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `BasicAuth ${sk}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify({ asin, star: 0, page: 1 }),
  });

  if (!resp.ok) throw new Error(`评论接口 HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.Code !== 0) {
    if (data.Code === 4) throw new Error('积分余额不足');
    throw new Error(data.Message || `Code: ${data.Code}`);
  }
  return Array.isArray(data.Data) ? data.Data : [];
}

// --- AI 评论分析 ---
async function analyzeReviewsWithAI(reviews) {
  if (!reviews || reviews.length === 0) throw new Error('没有评论数据');

  // 整理评论文本（最多100条，按星级分组）
  const positive = reviews.filter(r => r.Star >= 4).slice(0, 30);
  const neutral  = reviews.filter(r => r.Star === 3).slice(0, 15);
  const negative = reviews.filter(r => r.Star <= 2).slice(0, 40);

  const formatReviews = (arr) => arr.map(r =>
    `[${r.Star}★] ${r.Title}: ${r.Content}`
  ).join('\n');

  const system = `You are a senior Amazon product research analyst. Analyze customer reviews to extract actionable insights. 
Output in Chinese with structured JSON. Be specific, cite patterns from actual reviews.`;

  const user = `以下是亚马逊产品评论数据，请深入分析消费者反馈，提取核心信息。

【好评（4-5星）${positive.length}条】
${formatReviews(positive)}

【中评（3星）${neutral.length}条】
${formatReviews(neutral)}

【差评（1-2星）${negative.length}条】
${formatReviews(negative)}

请返回以下 JSON（只返回JSON，不加任何 markdown 代码块）：
{
  "summary": "一句话总结消费者整体态度（中文，50字以内）",
  "positivePainPoints": [
    { "point": "好评核心点标题", "detail": "具体描述（引用1-2个典型评论内容）", "frequency": "高/中/低" }
  ],
  "neutralPainPoints": [
    { "point": "中评核心点标题", "detail": "具体描述", "frequency": "高/中/低" }
  ],
  "negativePainPoints": [
    { "point": "差评核心痛点标题", "detail": "具体描述（引用典型评论）", "frequency": "高/中/低" }
  ],
  "topComplaints": ["最高频投诉1", "投诉2", "投诉3"],
  "buyerExpectationGap": "买家期望与产品实际表现的最大落差（中文，100字以内）",
  "listingOptimizationHints": ["针对差评可在 Listing 中提前消除的顾虑1", "提示2", "提示3"]
}`;

  const rawJson = await callAI(system, user);
  const parsed = safeParseJSON(rawJson);
  if (!parsed) throw new Error('AI 返回格式异常');
  return parsed;
}

// --- AI Fallback ---
async function fetchViaAI(asin) {
  const system = `You are an Amazon product database. When given an ASIN, retrieve the exact product title and five bullet points (bullet descriptions) from your training data for that Amazon US product listing. Return ONLY valid JSON — no extra text, no markdown.`;
  const user = `ASIN: ${asin}
Amazon URL: https://www.amazon.com/dp/${asin}

Return this exact JSON structure (fill in real data from your knowledge):
{
  "asin": "${asin}",
  "found": true,
  "title": "Full product title exactly as it appears on Amazon",
  "bullets": [
    "First bullet point (full text)",
    "Second bullet point (full text)",
    "Third bullet point (full text)",
    "Fourth bullet point (full text)",
    "Fifth bullet point (full text)"
  ],
  "confidence": "high/medium/low"
}

If you do not have reliable data for this ASIN, set "found": false and leave title/bullets as empty strings/array.`;

  const rawJson = await callAI(system, user);
  const parsed = safeParseJSON(rawJson);

  if (!parsed || !parsed.found || !parsed.title) return null;
  return {
    title: parsed.title,
    bullets: parsed.bullets || [],
    source: 'ai',
    confidence: parsed.confidence || 'low',
  };
}

async function autoFetchListing() {
  const raw = document.getElementById('asinInput').value.trim();
  if (!raw) { showToast('请先输入 ASIN 或亚马逊链接', 'error'); return; }
  const asin = extractASIN(raw);
  if (!asin) { showToast('无法识别有效的 ASIN，请检查格式', 'error'); return; }

  const s = getSettings();
  const hasSorftime = !!s.sorfTimeKey;
  const hasAI = !!s.apiKey;

  if (!hasSorftime && !hasAI) {
    showToast('请先在 API 设置中配置 Sorftime Key 或 AI Key', 'error');
    openModal();
    return;
  }

  const btn = document.getElementById('fetchListingBtn');
  const icon = document.getElementById('fetchBtnIcon');
  btn.disabled = true;
  icon.textContent = '⏳';

  try {
    let result = null;

    if (hasSorftime) {
      // 优先走 Sorftime 真实数据，失败直接报错（不静默 fallback，避免AI编造数据）
      try {
        result = await fetchViaSorftime(asin, s.sorfTimeKey);
      } catch (sorfErr) {
        icon.textContent = '⚡';
        btn.disabled = false;
        showToast('Sorftime 获取失败：' + sorfErr.message, 'error');
        return;
      }
    } else {
      // 无 Sorftime Key，走 AI（数据为模拟，可能不准确）
      result = await fetchViaAI(asin);
    }

    if (!result || !result.title) {
      showToast('未能获取到 Listing 数据，请手动粘贴到下方文本框', 'warning');
      icon.textContent = '⚡';
      btn.disabled = false;
      return;
    }

    fetchedListingData = result;
    fetchedReviewsData = null;      // 新产品重置评论缓存
    window._reviewAIResult = null;  // 重置AI分析缓存
    showFetchedListing(result);

    // 隐藏手动文本框（已自动获取，无需手动输入）
    document.getElementById('manualListingGroup').style.display = 'none';

    // 同步写入 rawListing 文本框（用于后续分析 prompt）
    let composed = `Title: ${result.title}\n\nBullet Points:\n${result.bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}`;
    if (result.brand) composed += `\n\nBrand: ${result.brand}`;
    if (result.price) composed += `\nPrice: ${result.price}`;
    if (result.rating) composed += `\nRating: ${result.rating} ★  (${result.reviewCount || '—'} reviews)`;
    document.getElementById('rawListing').value = composed;

    if (result.source === 'sorftime') {
      showToast('Sorftime 真实数据获取成功 ✓', 'success');
    } else {
      const conf = result.confidence === 'high' ? '高置信度' : result.confidence === 'medium' ? '中等置信度' : '低置信度（建议核实）';
      showToast(`AI 模拟数据（${conf}）`, 'success');
    }

  } catch (err) {
    showToast('获取失败：' + err.message, 'error');
  }

  icon.textContent = '⚡';
  btn.disabled = false;
}


function showFetchedListing(data) {
  // Source badge
  const label = document.querySelector('#fetchedListingCard .fetched-label');
  if (data.source === 'sorftime') {
    label.innerHTML = '✅ Sorftime 真实数据';
    label.style.color = '#259a4a';
  } else {
    const conf = data.confidence === 'high' ? '高置信度' : data.confidence === 'medium' ? '中等置信度' : '低置信度';
    label.innerHTML = `🤖 AI 模拟数据（${conf}）`;
    label.style.color = '#b07d00';
  }

  document.getElementById('fetchedTitle').textContent = data.title || '—';

  // Meta info row
  let metaEl = document.getElementById('fetchedMeta');
  if (!metaEl) {
    metaEl = document.createElement('div');
    metaEl.id = 'fetchedMeta';
    metaEl.className = 'fetched-meta';
    document.getElementById('fetchedTitle').after(metaEl);
  }
  const metaParts = [];
  if (data.brand) metaParts.push(`品牌：${data.brand}`);
  if (data.price) metaParts.push(`价格：${data.price}`);
  if (data.rating) metaParts.push(`评分：${data.rating}★`);
  if (data.reviewCount) metaParts.push(`评论：${Number(data.reviewCount).toLocaleString()}`);
  if (data.bsrInfo) metaParts.push(`BSR：#${data.bsrInfo.rank} ${data.bsrInfo.category}`);
  metaEl.textContent = metaParts.join('  ·  ');
  metaEl.style.display = metaParts.length ? '' : 'none';

  const ul = document.getElementById('fetchedBullets');
  ul.innerHTML = '';
  (data.bullets || []).forEach(b => {
    const li = document.createElement('li');
    li.textContent = b;
    ul.appendChild(li);
  });
  document.getElementById('fetchedListingCard').style.display = 'block';

  // 直接展示评分区并自动开始评分
  const scorePanel = document.getElementById('bulletScorePanel');
  if (scorePanel) {
    scorePanel.style.display = 'block';
    scorePanel.innerHTML = `
      <div class="bullet-score-header">
        <span class="bullet-score-title">🔍 A9 / COSMO / Rufus 三维质量评分</span>
        <button class="btn btn-ghost btn-xs" id="rescoreBulletsBtn" onclick="scoreBullets()" style="display:none;">↺ 重新评分</button>
      </div>
      <div id="bulletScoreResult"><div class="bullet-score-loading"><div class="spinner-sm"></div><span>AI 正在评分中...</span></div></div>
    `;
  }
  scoreBullets();
}

async function scoreBullets() {
  const resultEl = document.getElementById('bulletScoreResult');
  const rescoreBtn = document.getElementById('rescoreBulletsBtn');
  if (!resultEl) return;

  if (!fetchedListingData || !fetchedListingData.bullets || fetchedListingData.bullets.length === 0) {
    showToast('请先获取 Listing 数据', 'error'); return;
  }
  const s = getSettings();
  if (!s.apiKey) { showToast('请先配置 API Key', 'error'); openModal(); return; }

  if (rescoreBtn) rescoreBtn.style.display = 'none';
  resultEl.innerHTML = `<div class="bullet-score-loading"><div class="spinner-sm"></div><span>AI 正在评分中...</span></div>`;

  const bulletsText = fetchedListingData.bullets.map((b, i) => `Bullet ${i+1}: ${b}`).join('\n\n');

  const system = `You are an Amazon listing quality auditor. Score bullet points on 3 dimensions (A9, COSMO, Rufus), each 0–10.

## FIXED SCORING RUBRIC (apply strictly and consistently)

### A9 Score
10: All 5 bullets start with primary keyword; secondary keywords densely embedded; zero filler words; every character used for SEO value.
8-9: 4+ bullets have keyword-first structure; good keyword density; minor filler or missed long-tail.
6-7: Some keyword placement but inconsistent; readable but not optimized; 1-2 bullets have no front-loaded keywords.
4-5: Keywords present but buried mid-sentence; heavy filler ("This product…", "Perfect for…"); poor indexing signals.
2-3: Almost no deliberate keyword placement; purely descriptive prose; low chance of indexing for target terms.
0-1: No SEO intent at all; generic marketing language only.

### COSMO Score
10: Covers product category, material, use-case, user persona, compatible ecosystems, problem solved, sensory/emotional attributes.
8-9: Covers 6-7 semantic dimensions; only minor gaps in edge concepts.
6-7: Covers 4-5 dimensions; missing either use-case depth or persona specificity.
4-5: Covers 3 dimensions; typically feature-only with no scene/persona/emotion.
2-3: 1-2 dimensions; mostly spec listing (size, color, weight) with no conceptual richness.
0-1: Purely technical specs, zero semantic context.

### Rufus Score
10: Every bullet directly answers a likely customer question (What does it do? Who is it for? How is it better? Is it safe/compatible?); Q&A-ready phrasing.
8-9: Answers 4 of 5 top intents; conversational tone in most bullets.
6-7: Answers 3 intents; some bullets are monologue not dialogue.
4-5: Answers 1-2 intents; mostly feature proclamation without addressing buyer concerns.
2-3: No Q&A structure; ignores common buyer questions entirely.
0-1: Zero conversational relevance.

### Overall Score = round((A9 + COSMO + Rufus) / 3, 1)

### Per-Bullet Score
10: Keyword-first, semantic-rich, intent-answering.
8-9: Strong in 2 of 3 dimensions.
6-7: Average; functional but not optimized.
4-5: Weak; mostly filler or pure specs.
0-3: Very poor; no optimization value.

## Rules
- Apply the rubric literally. Do NOT adjust scores based on product category or personal taste.
- Scores must be integers (0-10) except overallScore which may have 1 decimal.
- Be consistent: identical bullet text must always receive identical scores.
- ALL text commentary fields must be in BOTH Chinese (zh) AND English (en).
- Output ONLY valid JSON, no markdown code blocks.`;

  const user = `Product Title: ${fetchedListingData.title}

Bullet Points:
${bulletsText}

Apply the rubric above. Score each of the 3 dimensions for the ENTIRE bullet set.
Extract top keywords found (positive signals) and missing keywords (gaps) for each dimension.
Per bullet, give a 1-sentence micro-critique in both zh and en.

Return this exact JSON:
{
  "overallScore": 0.0,
  "verdict_zh": "整体一句话总结：最大优势 + 最需改进点",
  "verdict_en": "One-sentence overall verdict: biggest strength + top improvement",
  "dimensions": {
    "a9":    { "score": 0, "summary_zh": "", "summary_en": "", "positiveKeywords": [], "missingKeywords": [], "tips_zh": [], "tips_en": [] },
    "cosmo": { "score": 0, "summary_zh": "", "summary_en": "", "positiveKeywords": [], "missingKeywords": [], "tips_zh": [], "tips_en": [] },
    "rufus": { "score": 0, "summary_zh": "", "summary_en": "", "positiveKeywords": [], "missingKeywords": [], "tips_zh": [], "tips_en": [] }
  },
  "perBulletCritique": [
    { "num": 1, "score": 0, "critique_zh": "", "critique_en": "" },
    { "num": 2, "score": 0, "critique_zh": "", "critique_en": "" },
    { "num": 3, "score": 0, "critique_zh": "", "critique_en": "" },
    { "num": 4, "score": 0, "critique_zh": "", "critique_en": "" },
    { "num": 5, "score": 0, "critique_zh": "", "critique_en": "" }
  ]
}`;

  try {
    const rawJson = await callAI(system, user, null, 0);
    const parsed = safeParseJSON(rawJson);
    if (!parsed) throw new Error('AI返回格式异常');

    renderBulletScore(parsed);
    if (rescoreBtn) rescoreBtn.style.display = '';
  } catch (err) {
    resultEl.innerHTML = `<div class="bullet-score-error">评分失败：${escHtml(err.message)}<br><button class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="scoreBullets()">重试</button></div>`;
    if (rescoreBtn) rescoreBtn.style.display = '';
  }
}

function renderBulletScore(data) {
  const el = document.getElementById('bulletScoreResult');
  if (!el) return;

  const overall = data.overallScore || 0;
  const scoreColor = overall >= 8 ? '#16A34A' : overall >= 6 ? '#F59E0B' : '#EF4444';
  const scoreLabel = overall >= 8 ? '优秀' : overall >= 6 ? '良好' : overall >= 4 ? '一般' : '较差';

  const bilingualText = (zh, en) => {
    if (!zh && !en) return '';
    return `<div class="bilingual-block">
      ${zh ? `<div class="bi-zh">${escHtml(zh)}</div>` : ''}
      ${en ? `<div class="bi-en">${escHtml(en)}</div>` : ''}
    </div>`;
  };

  const dimHtml = (key, label, icon, d) => {
    if (!d) return '';
    const sc = d.score || 0;
    const scColor = sc >= 8 ? '#16A34A' : sc >= 6 ? '#F59E0B' : '#EF4444';
    const posKw = (d.positiveKeywords || []).map(k => `<span class="score-kw score-kw-pos">${escHtml(k)}</span>`).join('');
    const misKw = (d.missingKeywords || []).map(k => `<span class="score-kw score-kw-miss">${escHtml(k)}</span>`).join('');
    const tipsZh = d.tips_zh || d.tips || [];
    const tipsEn = d.tips_en || [];
    const maxTips = Math.max(tipsZh.length, tipsEn.length);
    let tipsHtml = '';
    for (let i = 0; i < maxTips; i++) {
      tipsHtml += `<div class="score-tip">${
        tipsZh[i] ? `<div class="bi-zh">💡 ${escHtml(tipsZh[i])}</div>` : ''
      }${
        tipsEn[i] ? `<div class="bi-en">💡 ${escHtml(tipsEn[i])}</div>` : ''
      }</div>`;
    }
    return `
      <div class="score-dim-card">
        <div class="score-dim-header">
          <span class="score-dim-icon">${icon}</span>
          <span class="score-dim-label">${label}</span>
          <span class="score-dim-num" style="color:${scColor}">${sc} <span class="score-dim-total">/ 10</span></span>
        </div>
        <div class="score-dim-bar-wrap">
          <div class="score-dim-bar" style="width:${sc*10}%;background:${scColor};"></div>
        </div>
        ${bilingualText(d.summary_zh || d.summary, d.summary_en)}
        ${posKw ? `<div class="score-kw-row"><span class="score-kw-label">✅ 已覆盖</span>${posKw}</div>` : ''}
        ${misKw ? `<div class="score-kw-row"><span class="score-kw-label score-kw-label-miss">⚠️ 缺失</span>${misKw}</div>` : ''}
        ${tipsHtml ? `<div class="score-tips-list">${tipsHtml}</div>` : ''}
      </div>`;
  };

  const dims = data.dimensions || {};
  const perBullet = (data.perBulletCritique || []).map(b => {
    const bsc = b.score || 0;
    const bc = bsc >= 8 ? '#16A34A' : bsc >= 6 ? '#F59E0B' : '#EF4444';
    return `<div class="per-bullet-row">
      <span class="per-bullet-num">Bullet ${b.num}</span>
      <span class="per-bullet-score" style="color:${bc}">${bsc}</span>
      <div class="per-bullet-critique">
        ${b.critique_zh ? `<div class="bi-zh">${escHtml(b.critique_zh)}</div>` : (b.critique ? `<div class="bi-zh">${escHtml(b.critique)}</div>` : '')}
        ${b.critique_en ? `<div class="bi-en">${escHtml(b.critique_en)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="bullet-score-panel">
      <div class="bullet-score-overall">
        <div class="overall-score-circle" style="border-color:${scoreColor}">
          <span class="overall-score-num" style="color:${scoreColor}">${overall}</span>
          <span class="overall-score-label">${scoreLabel}</span>
        </div>
        <div class="overall-verdict">
          ${bilingualText(data.verdict_zh || data.verdict, data.verdict_en)}
        </div>
      </div>
      <div class="score-dims-grid">
        ${dimHtml('a9', 'A9 算法', '🔍', dims.a9)}
        ${dimHtml('cosmo', 'COSMO 语义', '🧠', dims.cosmo)}
        ${dimHtml('rufus', 'Rufus 意图', '🤖', dims.rufus)}
      </div>
      ${perBullet ? `
      <div class="per-bullet-section">
        <div class="per-bullet-title">逐条点评 / Per-Bullet Critique</div>
        ${perBullet}
      </div>` : ''}
    </div>
  `;
}

function clearFetchedListing() {
  fetchedListingData = null;
  fetchedReviewsData = null;
  window._reviewAIResult = null;
  document.getElementById('fetchedListingCard').style.display = 'none';
  document.getElementById('manualListingGroup').style.display = '';
  document.getElementById('rawListing').value = '';
}

// ===== Prompts =====
function buildAnalysisPrompt(asin, asinUrl, rawListing) {
  const system = `You are a senior Amazon marketplace analyst specializing in the US market. You have deep expertise in:
- Amazon A9/A10 algorithm optimization
- COSMO (Customer-centric OntolOgy) semantic search
- Rufus AI shopping assistant optimization
- Category BSR analysis and positioning
- Listing copywriting and conversion optimization

LANGUAGE RULES:
- All analysis text fields (categoryAnalysis, operationSuggestions, insight, highlightReason, weaknesses, opportunities) MUST be written in Simplified Chinese.
- Product titles, English keywords, category names, ASIN, and direct listing quotes stay in English.
- Do NOT mix English sentences into Chinese analysis paragraphs.`;

  const user = `Analyze the following Amazon US product listing comprehensively.

ASIN: ${asin}
Product URL: ${asinUrl}
${rawListing ? `\nListing Content (Original):\n${rawListing}` : ''}

Please provide a complete analysis in the following JSON format. IMPORTANT: Return ONLY valid JSON, no markdown code blocks.

{
  "productTitle": "Full product title in English",
  "asin": "${asin}",
  "category": "Main category > Sub-category > Leaf category",
  "bsr": "Estimated/provided BSR in its leaf category (e.g., #23 in Desk Lamps)",
  "params": [
    {"attribute": "Parameter name", "value": "Parameter value", "note": "Optional note"}
  ],
  "sellPoints": [
    {
      "title": "Sell point title (English keyword + Chinese label)",
      "englishOriginal": "Direct quote or paraphrase from listing in English",
      "insight": "中文分析：这个卖点对买家的意义、购买心理、转化影响",
      "isHighlight": true/false,
      "highlightReason": "中文说明：为什么这是加分项（仅 isHighlight=true 时填写）"
    }
  ],
  "categoryAnalysis": {
    "bsrInterpretation": "用中文解读该 BSR 排名的含义——市场规模、竞争激烈程度、产品表现",
    "marketGap": "用中文分析该品类存在的市场空白与机会点",
    "buyerPersona": "用中文描述买家画像：年龄、职业、使用场景、核心需求、决策因素",
    "pricePositioning": "用中文分析价格区间定位：所处价格段、竞争力、目标客群匹配度"
  },
  "operationSuggestions": {
    "a9Optimization": "用中文给出 A9 算法优化建议：关键词密度、相关性信号",
    "cosmosOptimization": "用中文给出 COSMO 语义实体覆盖建议：需补充哪些语义概念",
    "rufusOptimization": "用中文给出 Rufus 优化建议：Q&A 内容、使用场景覆盖、对话式查询",
    "imageStrategy": "用中文分析当前图片策略的优劣，给出改进方向",
    "weaknesses": ["用中文列出竞品弱点1", "弱点2"],
    "opportunities": ["用中文列出可利用的机会1", "机会2"]
  }
}`;

  return { system, user };
}

function buildComparisonPrompt(competitorData, ourProductName, ourSellPoints, focusAreas, rivalListings = []) {
  const system = `# ROLE: Senior Amazon Operations Strategist & Native English Copywriter — Triple-Engine Architecture (A9 × COSMO × Rufus, 2026)

## Identity & Mission
You are a 10-year veteran Amazon US operations strategist and listing copywriter. You have personally managed 200+ SKUs across competitive categories and understand that winning listings are built on THREE simultaneous engines:
- **A9/A10**: Keyword indexing, placement priority, backend coverage, field-level weight hierarchy
- **COSMO**: Semantic entity graph — scene associations, related objects, use-case clustering, commonsense linkage to activate Amazon's knowledge graph
- **Rufus**: Conversational AI shopping queries — pre-answer buyer questions, match natural language intent, structure copy as Q&A-embedded statements

You do NOT produce generic marketing copy. Every word is intentional: keyword-engineered, semantically loaded, intent-aligned.

## Amazon US Title Writing Doctrine (NON-NEGOTIABLE — APPLY TO ALL 5 TITLE OPTIONS)
Amazon title field weight hierarchy (highest → lowest):
1. **Position 1–3 words**: HIGHEST A9 weight. Must place the single most-searched root keyword here (e.g., "Smart Lock", "Wireless Earbuds"). This slot determines primary indexing category.
2. **Position 4–8 words**: HIGH weight. Place brand name + top modifier (material, size, color, compatibility). These words heavily influence search ranking for long-tail queries.
3. **Position 9–15 words**: MEDIUM weight. Include use-case cluster words, secondary keywords, and feature differentiators. Activate COSMO semantic nodes.
4. **Position 16–end**: LOWER weight but still indexed. Audience signals, compatibility claims, Rufus-targeted natural language phrases ("works with Alexa", "perfect for renters").

Title Format Rules:
- Max 200 characters (including spaces). Count exactly.
- Capitalize every major word (Title Case). Never ALL CAPS.
- NO promotional language: no "Best", "Top", "Amazing", "#1", no price/sale claims.
- NO subjective claims without evidence: no "Premium", "Luxury" unless category-standard.
- Include: Brand + Root Keyword + Key Modifier + Top Feature + Compatibility/Use-case.
- Separate logical segments with commas or dashes — no pipes (|) unless brand style.
- For each title option, vary the keyword POSITION and ANGLE to target different search intents.

5 Title Option Strategy (MANDATORY — produce ALL 5):
- Option 1: Root keyword first — pure A9 SEO dominance. Lead with exact match search term.
- Option 2: Brand-forward — brand + keyword. Best for brand-aware re-targeting traffic.
- Option 3: Feature-first — lead with the #1 differentiating spec/feature vs. competitor.
- Option 4: Use-case/audience-first — lead with who it's for or the core scenario (Rufus-optimized).
- Option 5: Long-tail combination — string 2-3 secondary keywords together for niche traffic capture.

For EACH title, provide:
- tokenWeights: breakdown of each meaningful keyword with its A9 weight tier (Primary/Secondary/Tertiary) and expected monthly search volume range
- trafficLogic: 2-3 sentence explanation of which search queries this title will capture, why the keyword order was chosen, and how it activates COSMO semantic associations
- rufusScore: how well this title answers Rufus natural-language queries (0-10)

## Bullet Writing Doctrine (NON-NEGOTIABLE)
1. Format: \`ALL-CAPS LABEL (max 6 words)\` — one space — benefit body with specs + causal closure sentence
2. A9 layer: The ALL-CAPS label MUST contain the highest-weight indexable keyword for that bullet's theme. Body must include 2-3 long-tail variants.
3. COSMO layer: Body must reference at least one scene anchor (where/when/with what), one associated object, and one use-case cluster to activate semantic graph nodes.
4. Rufus layer: Body must pre-answer at least one natural-language question buyers ask Rufus (e.g., "Is this good for...?", "Does it work with...?", "How long does it...?")
5. Emotional close: End every bullet with a 1-sentence outcome/transformation statement (what the buyer's life looks like AFTER using this product).
6. Length: 250–400 chars per bullet. Dense but scannable.

## Two-Set Strategy
- **Set A (Feature-Authority)**: Lead with technical precision, specs, materials, and certifications. Appeals to research-mode buyers and A9 indexing.
- **Set B (Scene-Transformation)**: Lead with the buyer's moment/emotion. Scene-first, outcome-rich. Appeals to Rufus conversational queries and COSMO lifestyle triggers.
Both sets must cover ALL 5 bullet themes but approach them from different angles. They should feel like two different but equally professional copywriters wrote them.

## Self-Scoring (MANDATORY)
After writing each set, you MUST score it objectively on the same 0–10 scale as competitor audits:
- A9 score: keyword coverage, placement density, indexing completeness
- COSMO score: semantic richness, entity diversity, scene/object/use-case graph nodes
- Rufus score: conversational query matching, intent pre-answering, Q&A structure
- Overall = weighted average. Be self-critical. Most copy lands 6–8. Reserve 9–10 for exceptional work.
Include specific self-critique notes and comparison against competitor bullet quality.

## Competitor Comparison (MANDATORY)
For each set, provide a structured comparison vs. competitor bullets:
- Where we WIN (specific advantages over competitor)
- Where competitor is STRONGER (honest gaps we still have)
- Net recommendation: which set to go live with and why

## Output Language Rules
- Chinese fields: differentiationSummary, audienceProfiles, titleAnalysis, bulletLogic, keySignal, all score summaries/tips/critiques, tokenWeights[].weightTier (can be bilingual), trafficLogic
- English fields: titles[].title, tokenWeights[].keyword, bulletSets[].bullets[].headline, bulletSets[].bullets[].body, imageRequirements[].promptEN
- Bilingual (zh+en): bulletSets[].bulletScore verdict fields
- visualNarrative: Chinese only

## Image Brief Standards
- Exactly 8 images: 1–5 correspond 1-to-1 with bullet themes; 6–8 are supplementary lifestyle/trust/CTA shots
- promptEN: standalone nanobanana prompt, natural US English, include: model demographics (US-native, age, lifestyle), scene, lighting, color, mood, product placement, text overlay hints
- promptZH: complete Chinese translation of promptEN

## A+ Content Image Brief Standards
- Amazon A+ module images use landscape/banner ratios (970×300, 970×600, 300×300 module tiles) — very different from main images
- A+ is NOT about product-on-white; it's about brand storytelling, lifestyle immersion, model interaction, feature deep-dives, comparison tables, and emotional connection
- Exactly 6 A+ images covering: (1) Hero lifestyle banner, (2) Core feature deep-dive, (3) Scene/model immersion, (4) Comparison or spec highlight, (5) Secondary feature/benefit, (6) Brand tone & trust/CTA closer
- Each A+ image must specify: module type (hero/feature/lifestyle/comparison/brand), aspect ratio, scene concept, model/prop description, color palette, mood/tone, copy overlay suggestion, and nanobanana promptEN + promptZH
- A+ images must reflect THIS product's core sell points — not generic lifestyle shots`;

  const focusStr = focusAreas.length ? `\n侧重方向：${focusAreas.join(', ')}` : '';

  const competitorBulletScoreNote = (() => {
    try {
      const sp = competitorData.sellPoints || [];
      return sp.slice(0, 5).map((s, i) => `Competitor Bullet ${i+1}: ${s.title || ''} — ${s.description || ''}`).join('\n');
    } catch { return ''; }
  })();

  // 参考竞品汇总（用于写作风格借鉴 + 差异化灵感）
  const rivalSummary = (() => {
    if (!rivalListings || rivalListings.length === 0) return '';
    let lines = `\n【参考竞品写作风格参考（共 ${rivalListings.length} 个）】\n`;
    lines += `（请从以下竞品的标题结构、五点写法中提炼优秀写作模式，在生成我方标题、五点文案时借鉴其关键词布局、句式风格、Headline 构造；\n同时在图需和A+中参考竞品的视觉表达规律，取长补短并突出我方差异化卖点）\n\n`;
    rivalListings.forEach((r, idx) => {
      lines += `参考竞品 ${idx + 1}：ASIN ${r.asin}\n`;
      lines += `标题：${r.title}\n`;
      if (r.bullets?.length) {
        lines += `五点描述：\n${r.bullets.map((b, i) => `  • Bullet ${i+1}: ${b}`).join('\n')}\n`;
      }
      lines += '\n';
    });
    return lines;
  })();

  const user = `竞品信息：
- 标题：${competitorData.productTitle}
- ASIN：${competitorData.asin}
- 品类：${competitorData.category}
- BSR：${competitorData.bsr}
- 竞品卖点（原文）：
${competitorBulletScoreNote}
- 竞品弱点：${(competitorData.operationSuggestions?.weaknesses || []).join('; ')}
- 竞品买家画像：${competitorData.categoryAnalysis?.buyerPersona || ''}
- 竞品价格定位：${competitorData.categoryAnalysis?.pricePositioning || ''}
- 竞品市场空白：${competitorData.categoryAnalysis?.marketGap || ''}
${rivalSummary}${focusStr}

我方产品信息（中文填写，提炼意图转化为英文文案，勿逐字翻译）：
${ourSellPoints}

请返回 ONLY valid JSON，不要加 markdown 代码块，结构如下：

{
  "differentiationSummary": {
    "coreAdvantages": ["差异化优势1（中文，一句话）", "优势2", "优势3", "优势4", "优势5"],
    "vsCompetitor": "与竞品相比，我们核心差异化方向的中文总结（2-3句）",
    "positioning": "一句话品牌/产品定位（中文）"
  },
  "audienceProfiles": [
    {
      "segment": "人群标签（如：租房青年）",
      "age": "年龄区间",
      "scenario": "典型使用场景（中文）",
      "painPoint": "核心痛点（中文）",
      "buyingMotivation": "购买动机（中文）",
      "priceAcceptance": "价格接受度（中文）"
    }
  ],
  "titleAnalysis": {
    "competitorTitleLogic": "竞品标题结构拆解：关键词布局逻辑、前置词选择、Feature顺序策略（中文分析，指出竞品标题在A9权重位的具体词选择）",
    "ourTitleStrategy": "我方标题应采取的策略方向（中文，基于差异化卖点和竞品对比，说明应争夺哪些关键词流量）",
    "keywordPriorityList": [
      {"keyword": "最高优先级关键词（英文）", "weightTier": "Primary", "reason": "为何该词必须前置（中文）"},
      {"keyword": "次优先关键词（英文）", "weightTier": "Secondary", "reason": "流量逻辑说明（中文）"},
      {"keyword": "第三优先关键词（英文）", "weightTier": "Tertiary", "reason": "补充覆盖逻辑（中文）"}
    ]
  },
  "titles": [
    {
      "option": 1,
      "strategy_name": "根关键词前置 — A9 SEO主导型",
      "title": "US-native English Amazon title Option 1 (max 200 chars, root keyword FIRST)",
      "charCount": 0,
      "strategy": "该方案侧重：以最高搜索量根关键词开头，强化A9主品类索引权重（中文说明）",
      "rufusKeywords": ["conversational keyword 1", "keyword 2"],
      "tokenWeights": [
        {"keyword": "word1", "weightTier": "Primary（主权重）", "searchVolEstimate": "50k-100k/mo", "role": "该词在标题中的作用（中文）"},
        {"keyword": "word2", "weightTier": "Secondary（次权重）", "searchVolEstimate": "10k-30k/mo", "role": "该词的覆盖逻辑（中文）"}
      ],
      "trafficLogic": "该标题捕获哪类搜索流量、关键词顺序的选择逻辑、激活哪些COSMO语义节点（中文，2-3句）"
    },
    {
      "option": 2,
      "strategy_name": "品牌前置 — 品牌复购+再营销型",
      "title": "US-native English Amazon title Option 2 (max 200 chars, BRAND + keyword)",
      "charCount": 0,
      "strategy": "该方案侧重：品牌名前置，强化品牌词搜索索引，适合有复购或广告再营销场景（中文）",
      "rufusKeywords": ["brand-aware keyword 1", "keyword 2"],
      "tokenWeights": [
        {"keyword": "BrandName", "weightTier": "Primary（品牌词）", "searchVolEstimate": "品牌词量级", "role": "品牌词前置占据A9品牌索引位"},
        {"keyword": "root keyword", "weightTier": "Secondary（品类词）", "searchVolEstimate": "估算量级", "role": "品类覆盖"}
      ],
      "trafficLogic": "该标题捕获哪类搜索流量的说明（中文，2-3句）"
    },
    {
      "option": 3,
      "strategy_name": "核心功能前置 — 差异化卖点主导型",
      "title": "US-native English Amazon title Option 3 (max 200 chars, DIFFERENTIATING FEATURE first)",
      "charCount": 0,
      "strategy": "该方案侧重：我方最强差异化功能前置，与竞品形成明显区隔，吸引对该功能有强需求的买家（中文）",
      "rufusKeywords": ["feature-specific keyword 1", "keyword 2"],
      "tokenWeights": [
        {"keyword": "differentiating feature word", "weightTier": "Primary（功能词）", "searchVolEstimate": "估算量级", "role": "功能词前置的流量捕获逻辑"},
        {"keyword": "secondary spec word", "weightTier": "Secondary（规格词）", "searchVolEstimate": "估算量级", "role": "规格词覆盖长尾搜索"}
      ],
      "trafficLogic": "该标题捕获哪类搜索流量的说明（中文，2-3句）"
    },
    {
      "option": 4,
      "strategy_name": "使用场景/人群前置 — Rufus意图匹配型",
      "title": "US-native English Amazon title Option 4 (max 200 chars, USE CASE or AUDIENCE first)",
      "charCount": 0,
      "strategy": "该方案侧重：以使用场景或目标人群开头，直接匹配Rufus自然语言查询，提升对话式搜索的相关性（中文）",
      "rufusKeywords": ["use-case phrase 1", "audience term 2"],
      "tokenWeights": [
        {"keyword": "use-case anchor word", "weightTier": "Primary（场景词）", "searchVolEstimate": "估算量级", "role": "场景词激活COSMO语义图谱节点"},
        {"keyword": "audience word", "weightTier": "Secondary（人群词）", "searchVolEstimate": "估算量级", "role": "人群词对应Rufus意图筛选"}
      ],
      "trafficLogic": "该标题捕获哪类搜索流量的说明（中文，2-3句）"
    },
    {
      "option": 5,
      "strategy_name": "长尾复合词 — 精准小流量捕获型",
      "title": "US-native English Amazon title Option 5 (max 200 chars, 2-3 SECONDARY KEYWORDS combined for niche traffic)",
      "charCount": 0,
      "strategy": "该方案侧重：将2-3个中低搜索量但高转化意图的关键词组合，捕获竞争度低的精准长尾流量（中文）",
      "rufusKeywords": ["long-tail phrase 1", "niche keyword 2"],
      "tokenWeights": [
        {"keyword": "long-tail keyword 1", "weightTier": "Secondary（长尾词1）", "searchVolEstimate": "1k-5k/mo", "role": "低竞争高意图词的流量价值"},
        {"keyword": "long-tail keyword 2", "weightTier": "Secondary（长尾词2）", "searchVolEstimate": "2k-8k/mo", "role": "组合覆盖利基搜索场景"}
      ],
      "trafficLogic": "该标题捕获哪类搜索流量的说明（中文，2-3句）"
    }
  ],
  "bulletLogic": {
    "logicFramework": "五点排列逻辑说明：为什么按这个顺序，每条主攻哪个维度（A9/COSMO/Rufus角度分别说明，中文）",
    "bulletThemes": [
      {"num": 1, "theme": "第1条主题（中文）", "goal": "转化目标（中文）", "primaryEngine": "A9/COSMO/Rufus（主攻维度）"},
      {"num": 2, "theme": "第2条主题（中文）", "goal": "转化目标（中文）", "primaryEngine": "主攻维度"},
      {"num": 3, "theme": "第3条主题（中文）", "goal": "转化目标（中文）", "primaryEngine": "主攻维度"},
      {"num": 4, "theme": "第4条主题（中文）", "goal": "转化目标（中文）", "primaryEngine": "主攻维度"},
      {"num": 5, "theme": "第5条主题（中文）", "goal": "转化目标（中文）", "primaryEngine": "主攻维度"}
    ]
  },
  "bulletSets": [
    {
      "setName": "Set A — Feature-Authority",
      "setStrategy": "本套策略定位说明（中文，2句话）",
      "bullets": [
        {
          "num": 1,
          "headline": "ALL-CAPS KEYWORD-ENGINEERED LABEL",
          "body": "Spec-driven, COSMO-activated, Rufus-pre-answering body copy in natural US English. End with transformation outcome.",
          "keySignal": "本条强化的核心算法信号（中文）",
          "engineNotes": {
            "a9": "本条A9关键词布局说明（中文）",
            "cosmo": "本条COSMO语义节点说明（中文）",
            "rufus": "本条预回答的Rufus意图（中文）"
          }
        },
        {"num": 2, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}},
        {"num": 3, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}},
        {"num": 4, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}},
        {"num": 5, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}}
      ],
      "bulletScore": {
        "overallScore": 0,
        "verdict_zh": "Set A整体一句话总结（中文）",
        "verdict_en": "Set A one-sentence overall verdict (English)",
        "dimensions": {
          "a9": {
            "score": 0,
            "summary_zh": "A9维度评价（2句，中文）",
            "summary_en": "A9 dimension assessment (2 sentences, English)",
            "positiveKeywords": ["strength keyword 1"],
            "missingKeywords": ["gap keyword 1"],
            "tips_zh": ["改进建议（中文）"],
            "tips_en": ["improvement tip (English)"]
          },
          "cosmo": {
            "score": 0,
            "summary_zh": "COSMO评价（中文）",
            "summary_en": "COSMO assessment (English)",
            "positiveKeywords": ["semantic entity 1"],
            "missingKeywords": ["missing concept 1"],
            "tips_zh": ["建议"],
            "tips_en": ["tip"]
          },
          "rufus": {
            "score": 0,
            "summary_zh": "Rufus评价（中文）",
            "summary_en": "Rufus assessment (English)",
            "positiveKeywords": ["intent signal 1"],
            "missingKeywords": ["unanswered intent 1"],
            "tips_zh": ["建议"],
            "tips_en": ["tip"]
          }
        },
        "perBulletCritique": [
          {"num": 1, "score": 0, "critique_zh": "一句话点评（中文）", "critique_en": "one-sentence critique (English)"},
          {"num": 2, "score": 0, "critique_zh": "...", "critique_en": "..."},
          {"num": 3, "score": 0, "critique_zh": "...", "critique_en": "..."},
          {"num": 4, "score": 0, "critique_zh": "...", "critique_en": "..."},
          {"num": 5, "score": 0, "critique_zh": "...", "critique_en": "..."}
        ],
        "vsCompetitor": {
          "weWin": ["我方胜出点1（中文，具体说明）", "胜出点2"],
          "theyWin": ["竞品仍领先的地方1（中文，诚实评估）"],
          "recommendation_zh": "推荐使用该套文案的理由，或需要改进后使用（中文）",
          "recommendation_en": "Recommendation in English"
        }
      }
    },
    {
      "setName": "Set B — Scene-Transformation",
      "setStrategy": "本套策略定位说明（中文，2句话）",
      "bullets": [
        {"num": 1, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}},
        {"num": 2, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}},
        {"num": 3, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}},
        {"num": 4, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}},
        {"num": 5, "headline": "...", "body": "...", "keySignal": "...", "engineNotes": {"a9": "...", "cosmo": "...", "rufus": "..."}}
      ],
      "bulletScore": {
        "overallScore": 0,
        "verdict_zh": "Set B整体一句话总结（中文）",
        "verdict_en": "Set B one-sentence overall verdict (English)",
        "dimensions": {
          "a9": {"score": 0, "summary_zh": "...", "summary_en": "...", "positiveKeywords": [], "missingKeywords": [], "tips_zh": [], "tips_en": []},
          "cosmo": {"score": 0, "summary_zh": "...", "summary_en": "...", "positiveKeywords": [], "missingKeywords": [], "tips_zh": [], "tips_en": []},
          "rufus": {"score": 0, "summary_zh": "...", "summary_en": "...", "positiveKeywords": [], "missingKeywords": [], "tips_zh": [], "tips_en": []}
        },
        "perBulletCritique": [
          {"num": 1, "score": 0, "critique_zh": "...", "critique_en": "..."},
          {"num": 2, "score": 0, "critique_zh": "...", "critique_en": "..."},
          {"num": 3, "score": 0, "critique_zh": "...", "critique_en": "..."},
          {"num": 4, "score": 0, "critique_zh": "...", "critique_en": "..."},
          {"num": 5, "score": 0, "critique_zh": "...", "critique_en": "..."}
        ],
        "vsCompetitor": {
          "weWin": ["胜出点1", "胜出点2"],
          "theyWin": ["竞品仍领先的地方1"],
          "recommendation_zh": "推荐说明（中文）",
          "recommendation_en": "Recommendation (English)"
        }
      }
    }
  ],
  "imageRequirements": [
    {
      "imageNum": 1,
      "bulletRef": "对应第1条五点主题（中文）",
      "concept": "画面核心概念（中文，一句话）",
      "designDirection": "拍摄/设计方向（中文）",
      "callouts": ["文字贴片1（中文）", "文字贴片2（中文）"],
      "nanobananaNote": "给设计师的补充说明（中文）",
      "promptEN": "Standalone nanobanana AI image generation prompt in US English.",
      "promptZH": "以上英文Prompt的完整中文翻译"
    },
    {"imageNum": 2, "bulletRef": "...", "concept": "...", "designDirection": "...", "callouts": [], "nanobananaNote": "...", "promptEN": "...", "promptZH": "..."},
    {"imageNum": 3, "bulletRef": "...", "concept": "...", "designDirection": "...", "callouts": [], "nanobananaNote": "...", "promptEN": "...", "promptZH": "..."},
    {"imageNum": 4, "bulletRef": "...", "concept": "...", "designDirection": "...", "callouts": [], "nanobananaNote": "...", "promptEN": "...", "promptZH": "..."},
    {"imageNum": 5, "bulletRef": "...", "concept": "...", "designDirection": "...", "callouts": [], "nanobananaNote": "...", "promptEN": "...", "promptZH": "..."},
    {"imageNum": 6, "bulletRef": "补充图6：场景生活方式", "concept": "...", "designDirection": "...", "callouts": [], "nanobananaNote": "...", "promptEN": "...", "promptZH": "..."},
    {"imageNum": 7, "bulletRef": "补充图7：对比/细节/信任背书", "concept": "...", "designDirection": "...", "callouts": [], "nanobananaNote": "...", "promptEN": "...", "promptZH": "..."},
    {"imageNum": 8, "bulletRef": "补充图8：使用结果/情绪收益/召唤行动", "concept": "...", "designDirection": "...", "callouts": [], "nanobananaNote": "...", "promptEN": "...", "promptZH": "..."}
  ],
  "visualNarrative": "对8张主图整体叙事逻辑的概述（中文）：图1-5如何与五点逐一呼应，图6-8补充了哪些转化维度，整体视觉路径如何引导买家从认知→兴趣→信任→购买。",
  "aplusRequirements": [
    {
      "aplusNum": 1,
      "moduleType": "hero",
      "aspectRatio": "970×300 横幅主视觉",
      "sellPointRef": "对应的核心卖点（中文，一句话）",
      "concept": "画面核心概念（中文，一句话）——用于品牌首屏冲击力",
      "sceneDesc": "场景描述：空间、时间、氛围（中文）",
      "modelDesc": "模特描述：年龄/性别/人种/着装/姿态（中文）",
      "colorPalette": "主色调与情绪色彩方向（中文）",
      "mood": "情绪氛围关键词（中文，3个词）",
      "copyOverlay": "画面上建议叠加的短文案（中文 + 英文）",
      "designNotes": "给设计师的特别说明：构图逻辑、产品放置位置、光线方向等（中文）",
      "promptEN": "Standalone nanobanana AI image prompt in US English for this A+ banner. Specify exact aspect ratio hint, model, scene, lighting, product placement, mood. No text in image.",
      "promptZH": "以上英文Prompt的完整中文翻译"
    },
    {
      "aplusNum": 2,
      "moduleType": "feature",
      "aspectRatio": "970×600 功能深度图",
      "sellPointRef": "...",
      "concept": "...",
      "sceneDesc": "...",
      "modelDesc": "...",
      "colorPalette": "...",
      "mood": "...",
      "copyOverlay": "...",
      "designNotes": "...",
      "promptEN": "...",
      "promptZH": "..."
    },
    {
      "aplusNum": 3,
      "moduleType": "lifestyle",
      "aspectRatio": "970×600 场景沉浸图",
      "sellPointRef": "...",
      "concept": "...",
      "sceneDesc": "...",
      "modelDesc": "...",
      "colorPalette": "...",
      "mood": "...",
      "copyOverlay": "...",
      "designNotes": "...",
      "promptEN": "...",
      "promptZH": "..."
    },
    {
      "aplusNum": 4,
      "moduleType": "comparison",
      "aspectRatio": "970×600 对比/规格图",
      "sellPointRef": "...",
      "concept": "...",
      "sceneDesc": "...",
      "modelDesc": "（无模特或有模特对比操作）",
      "colorPalette": "...",
      "mood": "...",
      "copyOverlay": "...",
      "designNotes": "...",
      "promptEN": "...",
      "promptZH": "..."
    },
    {
      "aplusNum": 5,
      "moduleType": "feature",
      "aspectRatio": "300×300 模块小图（可做2-3格横排）",
      "sellPointRef": "...",
      "concept": "...",
      "sceneDesc": "...",
      "modelDesc": "...",
      "colorPalette": "...",
      "mood": "...",
      "copyOverlay": "...",
      "designNotes": "...",
      "promptEN": "...",
      "promptZH": "..."
    },
    {
      "aplusNum": 6,
      "moduleType": "brand",
      "aspectRatio": "970×300 品牌调性收尾",
      "sellPointRef": "品牌信任/情感收尾",
      "concept": "...",
      "sceneDesc": "...",
      "modelDesc": "...",
      "colorPalette": "...",
      "mood": "...",
      "copyOverlay": "...",
      "designNotes": "...",
      "promptEN": "...",
      "promptZH": "..."
    }
  ],
  "aplusNarrative": "对6张A+套图整体叙事逻辑的概述（中文）：从品牌首屏→功能深挖→场景沉浸→对比信任→品牌收尾，整条视觉动线如何引导买家建立品牌认知并促成购买决策。"
}`;

  return { system, user };
}

function renderReviews(data) {
  const container = document.getElementById('reviewsContent');
  if (!container) return;

  const starRatings = data.starRatings;
  const featureRatings = data.featureRatings;
  const rating = data.rating || data.Ratings;
  const reviewCount = data.reviewCount || data.RatingsCount;

  if (!starRatings && !featureRatings) {
    container.innerHTML = `<p style="color:var(--text-muted);padding:20px 0;">暂无评价数据（需通过 Sorftime 获取）</p>`;
    return;
  }

  let html = '';

  // ---- 总评分 + 星级分布 ----
  if (starRatings) {
    const total = Object.values(starRatings).reduce((a, b) => a + b, 0) || 1;
    const starsHtml = [5, 4, 3, 2, 1].map(star => {
      const count = starRatings[star] || 0;
      const pct = Math.round((count / total) * 100);
      const barColor = star >= 4 ? 'var(--success)' : star === 3 ? 'var(--warning)' : 'var(--danger)';
      return `
        <div class="star-row" style="display:flex;align-items:center;gap:8px;margin-bottom:7px;flex-wrap:nowrap;">
          <span class="star-label" style="width:32px;min-width:32px;font-size:13px;font-weight:600;color:var(--text-secondary);text-align:right;flex-shrink:0;">${star} ★</span>
          <span class="star-bar-wrap" style="flex:1;min-width:80px;height:10px;background:var(--border-default);border-radius:5px;overflow:hidden;display:inline-block;">
            <span class="star-bar" style="display:block;width:${pct}%;height:100%;background:${barColor};border-radius:5px;"></span>
          </span>
          <span class="star-pct" style="width:34px;font-size:12px;font-weight:600;color:var(--text-secondary);text-align:right;flex-shrink:0;">${pct}%</span>
          <span class="star-count" style="width:40px;font-size:11px;color:var(--text-muted);flex-shrink:0;">(${count})</span>
        </div>`;
    }).join('');

    html += `
      <div class="section-block">
        <h3>⭐ 综合评分与分布</h3>
        <div class="reviews-overview">
          <div class="reviews-score-big">
            <div class="score-num">${rating || '—'}</div>
            <div class="score-stars">${rating ? '★'.repeat(Math.round(parseFloat(rating))) + '☆'.repeat(5 - Math.round(parseFloat(rating))) : ''}</div>
            <div class="score-total">${reviewCount ? Number(reviewCount).toLocaleString() + ' 条评价' : ''}</div>
          </div>
          <div class="star-distribution">${starsHtml}</div>
        </div>
      </div>`;
  }

  // ---- Feature 评分 ----
  if (featureRatings && Object.keys(featureRatings).length > 0) {
    const featureItems = Object.entries(featureRatings)
      .sort((a, b) => b[1] - a[1])
      .map(([name, score]) => {
        const pct = Math.round((score / 5) * 100);
        const scoreColor = score >= 4.5 ? 'var(--success)' : score >= 4.0 ? 'var(--accent)' : score >= 3.5 ? 'var(--warning)' : 'var(--danger)';
        return `
          <div class="feature-row">
            <div class="feature-name">${escHtml(name)}</div>
            <div class="feature-bar-wrap">
              <div class="feature-bar" style="width:${pct}%;background:${scoreColor};"></div>
            </div>
            <div class="feature-score" style="color:${scoreColor}">${score.toFixed(1)}</div>
          </div>`;
      }).join('');

    html += `
      <div class="section-block">
        <h3>🔍 用户关注维度评分</h3>
        <div class="feature-ratings">${featureItems}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:8px;">数据来源：Sorftime · 基于买家评论自动提取</div>
      </div>`;
  }

  // ---- AI 评论分析区域 ----
  html += `
    <div class="section-block" id="reviewAISection">
      <div class="review-ai-header">
        <h3>🤖 AI 评论深度分析</h3>
        <button class="btn btn-sm" id="fetchAndAnalyzeReviewsBtn" onclick="triggerReviewAnalysis()">
          <span id="reviewAIBtnIcon">📥</span> 获取评论并分析
        </button>
      </div>
      <div id="reviewAILoading" style="display:none;" class="review-ai-loading">
        <div class="spinner-sm"></div>
        <span id="reviewAILoadingText">正在拉取评论数据...</span>
      </div>
      <div id="reviewAIResult"></div>
    </div>`;

  container.innerHTML = html;

  // 如果已有分析结果，直接渲染
  if (window._reviewAIResult) {
    renderReviewAIResult(window._reviewAIResult);
  }
  // 如果已有评论但还没分析，可选自动触发
  if (fetchedReviewsData && fetchedReviewsData.length > 0 && !window._reviewAIResult) {
    document.getElementById('reviewAIBtnIcon').textContent = '✅';
    document.getElementById('fetchAndAnalyzeReviewsBtn').innerHTML =
      '<span>✅</span> 评论已获取 · 点击 AI 分析';
  }
}

async function triggerReviewAnalysis() {
  const btn = document.getElementById('fetchAndAnalyzeReviewsBtn');
  const loading = document.getElementById('reviewAILoading');
  const loadingText = document.getElementById('reviewAILoadingText');
  if (!btn || !loading) return;

  const s = getSettings();
  if (!s.sorfTimeKey) { showToast('需要 Sorftime Key 才能获取评论', 'error'); return; }
  if (!s.apiKey) { showToast('需要 AI API Key 才能进行分析', 'error'); openModal(); return; }

  const asin = state.asin || extractASIN(document.getElementById('asinInput').value.trim());
  if (!asin) { showToast('请先输入 ASIN', 'error'); return; }

  btn.disabled = true;
  loading.style.display = 'flex';
  document.getElementById('reviewAIResult').innerHTML = '';

  try {
    // Step1: 拉取评论
    if (!fetchedReviewsData || fetchedReviewsData.length === 0) {
      loadingText.textContent = '正在从 Sorftime 拉取评论数据...';
      fetchedReviewsData = await fetchReviewsViaSorftime(asin, s.sorfTimeKey);
      if (fetchedReviewsData.length === 0) throw new Error('未获取到评论数据');
    }

    // Step2: AI 分析
    loadingText.textContent = `已获取 ${fetchedReviewsData.length} 条评论，正在 AI 深度分析...`;
    const result = await analyzeReviewsWithAI(fetchedReviewsData);
    window._reviewAIResult = result;

    loading.style.display = 'none';
    btn.disabled = false;
    btn.innerHTML = '<span>✅</span> 重新分析';

    renderReviewAIResult(result);
    showToast('评论分析完成', 'success');
  } catch (err) {
    loading.style.display = 'none';
    btn.disabled = false;
    btn.innerHTML = '<span>📥</span> 重新获取并分析';
    showToast('评论分析失败：' + err.message, 'error');
  }
}

function renderReviewAIResult(result) {
  const container = document.getElementById('reviewAIResult');
  if (!container || !result) return;

  const freqBadge = (f) => {
    const cls = f === '高' ? 'freq-high' : f === '中' ? 'freq-mid' : 'freq-low';
    return `<span class="freq-badge ${cls}">${f}频</span>`;
  };

  const renderPoints = (points, colorClass) => points.map(p => `
    <div class="review-point-card ${colorClass}">
      <div class="review-point-title">${escHtml(p.point)} ${freqBadge(p.frequency)}</div>
      <div class="review-point-detail">${escHtml(p.detail)}</div>
    </div>`).join('');

  let html = '';

  // 总结
  if (result.summary) {
    html += `<div class="review-summary-bar">${escHtml(result.summary)}</div>`;
  }

  // 三栏分析
  html += `<div class="review-analysis-grid">`;

  if (result.positivePainPoints?.length) {
    html += `<div class="review-col">
      <div class="review-col-header positive-header">✅ 好评核心点</div>
      ${renderPoints(result.positivePainPoints, 'positive-point')}
    </div>`;
  }

  if (result.neutralPainPoints?.length) {
    html += `<div class="review-col">
      <div class="review-col-header neutral-header">➡️ 中评核心点</div>
      ${renderPoints(result.neutralPainPoints, 'neutral-point')}
    </div>`;
  }

  if (result.negativePainPoints?.length) {
    html += `<div class="review-col">
      <div class="review-col-header negative-header">❌ 差评核心痛点</div>
      ${renderPoints(result.negativePainPoints, 'negative-point')}
    </div>`;
  }

  html += `</div>`;

  // 高频投诉
  if (result.topComplaints?.length) {
    const complaints = result.topComplaints.map((c, i) =>
      `<div class="complaint-item"><span class="complaint-num">${i + 1}</span>${escHtml(c)}</div>`
    ).join('');
    html += `<div class="section-block" style="margin-top:16px;">
      <h4 style="font-size:13px;font-weight:700;margin-bottom:10px;">🔥 高频投诉 Top ${result.topComplaints.length}</h4>
      <div class="complaints-list">${complaints}</div>
    </div>`;
  }

  // 期望落差
  if (result.buyerExpectationGap) {
    html += `<div class="section-block expectation-gap">
      <h4 style="font-size:13px;font-weight:700;margin-bottom:8px;">⚡ 买家期望 vs 实际落差</h4>
      <p style="font-size:13px;line-height:1.7;color:var(--text);">${escHtml(result.buyerExpectationGap)}</p>
    </div>`;
  }

  // Listing 优化提示
  if (result.listingOptimizationHints?.length) {
    const hints = result.listingOptimizationHints.map(h =>
      `<div class="hint-item">💡 ${escHtml(h)}</div>`
    ).join('');
    html += `<div class="section-block listing-hints">
      <h4 style="font-size:13px;font-weight:700;margin-bottom:10px;">📝 Listing 可针对性优化点</h4>
      <div class="hints-list">${hints}</div>
    </div>`;
  }

  container.innerHTML = html;
}


function renderSalesHistory(rows) {
  const el = document.getElementById('salesHistoryContent');
  if (!el) return;
  if (!rows || rows.length === 0) {
    el.innerHTML = `<p style="color:var(--text-muted);padding:12px 0;font-size:13px;">暂无子体销量数据</p>`;
    return;
  }

  // 按日期升序，同一天保留最大值
  const dayMap = {};
  rows.forEach(r => {
    if (!dayMap[r.date] || r.sales > dayMap[r.date]) dayMap[r.date] = r.sales;
  });
  const sorted = Object.keys(dayMap).sort().map(d => ({ date: d, sales: dayMap[d] }));
  const maxSales = Math.max(...sorted.map(r => r.sales));
  const minSales = Math.min(...sorted.map(r => r.sales));
  const latest = sorted[sorted.length - 1];
  const oldest = sorted[0];

  // ── SVG 折线图 ──
  const W = 680, H = 160, PL = 60, PR = 16, PT = 16, PB = 36;
  const gW = W - PL - PR, gH = H - PT - PB;
  const n = sorted.length;
  const xStep = n > 1 ? gW / (n - 1) : gW;

  function xPos(i) { return PL + (n > 1 ? i * gW / (n - 1) : gW / 2); }
  function yPos(v) {
    if (maxSales === minSales) return PT + gH / 2;
    return PT + gH - (v - minSales) / (maxSales - minSales) * gH;
  }

  // 折线路径
  const points = sorted.map((r, i) => `${xPos(i).toFixed(1)},${yPos(r.sales).toFixed(1)}`).join(' ');
  const polyline = `<polyline points="${points}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  // 面积填充
  const firstX = xPos(0).toFixed(1), lastX = xPos(n - 1).toFixed(1);
  const baseY = (PT + gH).toFixed(1);
  const areaPath = `M${firstX},${baseY} L${points.split(' ').map(p => p).join(' L')} L${lastX},${baseY} Z`;
  const area = `<path d="${areaPath}" fill="url(#salesGrad)" opacity="0.18"/>`;

  // Y轴刻度（3条）
  const yTicks = [0, 0.5, 1].map(t => {
    const v = Math.round(minSales + t * (maxSales - minSales));
    const y = yPos(v).toFixed(1);
    return `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="#e2e8f0" stroke-width="1"/>
            <text x="${PL - 6}" y="${parseFloat(y) + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v}</text>`;
  }).join('');

  // X轴日期标签（最多显示6个）
  const step = Math.max(1, Math.floor(n / 6));
  const xLabels = sorted.map((r, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    const x = xPos(i).toFixed(1);
    const label = r.date.slice(5); // MM-DD
    return `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#94a3b8">${label}</text>`;
  }).join('');

  // 数据点（最多20个，避免太密）
  const dotStep = Math.max(1, Math.floor(n / 20));
  const dots = sorted.map((r, i) => {
    if (i % dotStep !== 0 && i !== n - 1 && i !== 0) return '';
    return `<circle cx="${xPos(i).toFixed(1)}" cy="${yPos(r.sales).toFixed(1)}" r="3" fill="#3b82f6" stroke="#fff" stroke-width="1.5"/>`;
  }).join('');

  const svg = `
  <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${yTicks}
    ${area}
    ${polyline}
    ${dots}
    ${xLabels}
  </svg>`;

  // ── 汇总统计 ──
  const avgSales = Math.round(sorted.reduce((s, r) => s + r.sales, 0) / sorted.length);
  const statsHtml = `
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;">
    <div class="sales-stat-card"><div class="sales-stat-val">${latest.sales.toLocaleString()}</div><div class="sales-stat-label">最新销量（${latest.date}）</div></div>
    <div class="sales-stat-card"><div class="sales-stat-val">${maxSales.toLocaleString()}</div><div class="sales-stat-label">历史峰值</div></div>
    <div class="sales-stat-card"><div class="sales-stat-val">${avgSales.toLocaleString()}</div><div class="sales-stat-label">区间均值</div></div>
    <div class="sales-stat-card"><div class="sales-stat-val">${sorted.length}</div><div class="sales-stat-label">数据天数</div></div>
  </div>`;

  // ── 明细表格（最近30条） ──
  const tableRows = [...sorted].reverse().slice(0, 30).map(r => `
    <tr>
      <td>${r.date}</td>
      <td style="font-weight:600;color:#1d4ed8">${r.sales.toLocaleString()}</td>
      <td style="color:var(--text-muted)">${r.variants}</td>
    </tr>`).join('');
  const tableHtml = `
  <details style="margin-top:14px;">
    <summary style="cursor:pointer;font-size:13px;font-weight:600;color:#374151;padding:6px 0;user-select:none;">📋 查看明细数据（最近30天）</summary>
    <table class="analysis-table" style="margin-top:8px;">
      <thead><tr><th>日期</th><th>销量</th><th>子体数</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </details>`;

  el.innerHTML = `
  <div style="margin-bottom:8px;font-size:12px;color:var(--text-muted);">数据来源：Sorftime · 官方公布子体月销量 · 共 ${sorted.length} 条记录（${oldest.date} ~ ${latest.date}）</div>
  ${statsHtml}
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 8px 4px;">
    ${svg}
  </div>
  ${tableHtml}`;
}

function renderAnalysis(data) {
  // 更新卡片标题为当前竞品产品名
  const cardTitleEl = document.querySelector('#step2 .card-title');
  if (cardTitleEl) {
    cardTitleEl.innerHTML = `<span class="step-badge">Step 2</span>${escHtml(data.productTitle || '竞品深度分析报告')}`;
  }

  // Info bar
  const url = buildAmazonUrl(data.asin);
  document.getElementById('asinInfoBar').innerHTML = `
    <span style="font-size:18px;">📦</span>
    <div>
      <div style="font-weight:700;font-size:14px;margin-bottom:2px;">${escHtml(data.productTitle)}</div>
      <div style="font-size:12px;opacity:0.8;">ASIN: ${data.asin} · BSR: ${escHtml(data.bsr)} · <a href="${url}" target="_blank">View on Amazon ↗</a></div>
    </div>
  `;

  // Params Table
  let tableHtml = `<table class="analysis-table">
    <thead><tr><th>参数项</th><th>规格 / 数值</th><th>备注</th></tr></thead><tbody>`;
  (data.params || []).forEach(p => {
    tableHtml += `<tr>
      <td><strong>${escHtml(p.attribute)}</strong></td>
      <td>${escHtml(p.value)}</td>
      <td style="color:var(--text-muted);font-size:12px;">${escHtml(p.note || '—')}</td>
    </tr>`;
  });
  tableHtml += '</tbody></table>';
  document.getElementById('paramsTable').innerHTML = tableHtml;

  // Sell Points
  let spHtml = '';
  (data.sellPoints || []).forEach((sp, i) => {
    const isHL = sp.isHighlight;
    spHtml += `<div class="sellpoint-card ${isHL ? 'highlight-card' : ''}">
      <div class="sellpoint-title">
        <span>${i + 1}. ${escHtml(sp.title)}</span>
        ${isHL ? `<span class="highlight-badge">⭐ 客户加分项</span>` : ''}
      </div>
      <div class="sellpoint-en">"${escHtml(sp.englishOriginal)}"</div>
      <div class="sellpoint-insight">${escHtml(sp.insight)}</div>
      ${isHL && sp.highlightReason ? `<div style="margin-top:8px;padding:8px 12px;background:#FFF5F0;border-radius:6px;font-size:12.5px;color:var(--highlight);"><strong>加分原因：</strong>${escHtml(sp.highlightReason)}</div>` : ''}
    </div>`;
  });
  document.getElementById('sellPointsContent').innerHTML = spHtml || '<p style="color:var(--text-muted)">暂无数据</p>';

  // Category Analysis
  const ca = data.categoryAnalysis || {};
  document.getElementById('categoryContent').innerHTML = `
    <div class="section-block">
      <h3>👤 买家画像</h3>
      <div class="md-output"><p>${escHtml(ca.buyerPersona || '')}</p></div>
    </div>
    <div class="section-block">
      <h3>💰 价格定位</h3>
      <div class="md-output"><p>${escHtml(ca.pricePositioning || '')}</p></div>
    </div>
    <div class="section-block">
      <h3>🎯 市场空白与机会</h3>
      <div class="md-output"><p>${escHtml(ca.marketGap || '')}</p></div>
    </div>
  `;

  // Operation Suggestions
  const op = data.operationSuggestions || {};
  const weakHtml = (op.weaknesses || []).map(w => `<li>${escHtml(w)}</li>`).join('');
  const oppHtml = (op.opportunities || []).map(o => `<li>${escHtml(o)}</li>`).join('');
  document.getElementById('opSuggestionContent').innerHTML = `
    <div class="section-block">
      <h3>🔍 A9/A10 算法优化建议</h3>
      <div class="md-output"><p>${escHtml(op.a9Optimization || '')}</p></div>
    </div>
    <div class="section-block">
      <h3>🧠 COSMO 语义实体覆盖建议</h3>
      <div class="md-output"><p>${escHtml(op.cosmosOptimization || '')}</p></div>
    </div>
    <div class="section-block">
      <h3>🤖 Rufus AI 购物助手优化</h3>
      <div class="md-output"><p>${escHtml(op.rufusOptimization || '')}</p></div>
    </div>
    <div class="section-block">
      <h3>🖼️ 现有图片逻辑分析</h3>
      <div class="md-output"><p>${escHtml(op.imageStrategy || '')}</p></div>
    </div>
    <div class="section-block">
      <h3>⚠️ 竞品明显弱点</h3>
      <div class="md-output"><ul>${weakHtml}</ul></div>
    </div>
    <div class="section-block">
      <h3>🚀 超越机会点</h3>
      <div class="md-output"><ul>${oppHtml}</ul></div>
    </div>
  `;
}

function renderFinal(data) {
  // ===== Tab 1: 差异化定位 =====
  const ds = data.differentiationSummary || {};

  // 差异化卖点
  const advItems = (ds.coreAdvantages || []).map((a, i) =>
    `<div class="diff-adv-item"><span class="diff-adv-num">${i + 1}</span><span>${escHtml(a)}</span></div>`
  ).join('');

  // 受众人群
  const audItems = (data.audienceProfiles || []).map((p, i) => `
    <div class="audience-card">
      <div class="audience-tag">${escHtml(p.segment || `人群 ${i+1}`)}</div>
      <div class="audience-row"><span class="aud-label">年龄</span><span>${escHtml(p.age || '')}</span></div>
      <div class="audience-row"><span class="aud-label">场景</span><span>${escHtml(p.scenario || '')}</span></div>
      <div class="audience-row"><span class="aud-label">痛点</span><span class="aud-pain">${escHtml(p.painPoint || '')}</span></div>
      <div class="audience-row"><span class="aud-label">动机</span><span>${escHtml(p.buyingMotivation || '')}</span></div>
      <div class="audience-row"><span class="aud-label">价格</span><span>${escHtml(p.priceAcceptance || '')}</span></div>
    </div>`).join('');

  document.getElementById('positioningContent').innerHTML = `
    <div class="section-block">
      <h3>🎯 差异化卖点总结</h3>
      ${ds.positioning ? `<div class="positioning-tagline">${escHtml(ds.positioning)}</div>` : ''}
      <div class="diff-adv-list">${advItems}</div>
      ${ds.vsCompetitor ? `<div class="vs-competitor-note"><span class="label-cn">对比竞品</span>${escHtml(ds.vsCompetitor)}</div>` : ''}
    </div>
    <div class="section-block">
      <h3>👥 受众人群模拟</h3>
      <div class="audience-grid">${audItems}</div>
    </div>`;

  // ===== Tab 2: 备选标题（5套）=====
  // 竞品标题逻辑 + 关键词优先级
  const ta = data.titleAnalysis || {};
  let titleAnalysisHtml = '';
  if (ta.competitorTitleLogic || ta.ourTitleStrategy) {
    const kwPriority = (ta.keywordPriorityList || []).map((kw, i) => `
      <div class="kw-priority-row">
        <span class="kw-tier-badge kw-tier-${(kw.weightTier||'').toLowerCase().includes('primary') ? 'primary' : (kw.weightTier||'').toLowerCase().includes('secondary') ? 'secondary' : 'tertiary'}">${escHtml(kw.weightTier || '')}</span>
        <span class="kw-priority-word">${escHtml(kw.keyword || '')}</span>
        <span class="kw-priority-reason">${escHtml(kw.reason || '')}</span>
      </div>`).join('');
    titleAnalysisHtml = `
      <div class="section-block title-analysis-section">
        <h3>🔍 竞品标题拆解 & 我方关键词策略</h3>
        <div class="title-analysis-box">
          <div class="ta-item"><div class="ta-label">竞品标题写法分析</div><div class="ta-body">${escHtml(ta.competitorTitleLogic || '')}</div></div>
          <div class="ta-item"><div class="ta-label">我方标题策略方向</div><div class="ta-body ta-ours">${escHtml(ta.ourTitleStrategy || '')}</div></div>
        </div>
        ${kwPriority ? `<div class="kw-priority-list"><div class="kw-priority-title">🏆 关键词优先级排序</div>${kwPriority}</div>` : ''}
      </div>`;
  }

  let titlesHtml = titleAnalysisHtml;
  (data.titles || []).forEach(t => {
    const len = (t.title || '').length;
    const charCls = len <= 200 ? 'char-ok' : 'char-warn';
    const rufusKw = (t.rufusKeywords || []).map(k =>
      `<span class="rufus-tag">${escHtml(k)}</span>`
    ).join('');

    // Token Weights Table
    let tokenWeightsHtml = '';
    if ((t.tokenWeights || []).length > 0) {
      const rows = t.tokenWeights.map(tw => {
        const tier = (tw.weightTier || '').toLowerCase();
        const tierClass = tier.includes('primary') ? 'tw-primary' : tier.includes('secondary') ? 'tw-secondary' : 'tw-tertiary';
        return `<tr>
          <td><span class="tw-keyword">${escHtml(tw.keyword || '')}</span></td>
          <td><span class="tw-tier ${tierClass}">${escHtml(tw.weightTier || '')}</span></td>
          <td class="tw-vol">${escHtml(tw.searchVolEstimate || '—')}</td>
          <td class="tw-role">${escHtml(tw.role || '')}</td>
        </tr>`;
      }).join('');
      tokenWeightsHtml = `
        <div class="token-weights-block">
          <div class="tw-label">📊 词汇权重分析</div>
          <table class="tw-table">
            <thead><tr><th>关键词</th><th>权重等级</th><th>月搜索量估算</th><th>在标题中的作用</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }

    titlesHtml += `<div class="title-card">
      <div class="title-num">
        <span class="title-option-badge">方案 ${t.option}</span>
        ${t.strategy_name ? `<span class="title-strategy-name">${escHtml(t.strategy_name)}</span>` : ''}
        <span class="char-count ${charCls}">${len} / 200 chars</span>
      </div>
      <div class="title-text">${escHtml(t.title)}</div>
      <div class="title-annotation">${escHtml(t.strategy || '')}</div>
      ${rufusKw ? `<div class="rufus-kw-row"><span class="rufus-label">Rufus 关键词：</span>${rufusKw}</div>` : ''}
      ${tokenWeightsHtml}
      ${t.trafficLogic ? `<div class="traffic-logic-block"><span class="tl-label">🚦 流量逻辑：</span>${escHtml(t.trafficLogic)}</div>` : ''}
    </div>`;
  });
  document.getElementById('titlesContent').innerHTML = titlesHtml || '<p style="color:var(--text-muted)">暂无标题数据</p>';

  // ===== Tab 3: 五点文案（含逻辑说明 + 2套 + 评分 + 竞品对比）=====
  const bl = data.bulletLogic || {};
  let bulletLogicHtml = '';
  if (bl.logicFramework) {
    const themeItems = (bl.bulletThemes || []).map(t => {
      const engineBadge = t.primaryEngine ? `<span class="bullet-engine-badge">${escHtml(t.primaryEngine)}</span>` : '';
      return `<div class="bullet-theme-row">
        <span class="bullet-theme-num">Bullet ${t.num}</span>
        ${engineBadge}
        <span class="bullet-theme-name">${escHtml(t.theme)}</span>
        <span class="bullet-theme-goal">${escHtml(t.goal)}</span>
      </div>`;
    }).join('');
    bulletLogicHtml = `
      <div class="section-block bullet-logic-block">
        <h3>📐 五点排列逻辑 <span style="font-size:11px;font-weight:400;color:var(--text-muted)">（A9 × COSMO × Rufus 三维架构）</span></h3>
        <div class="bullet-logic-framework">${escHtml(bl.logicFramework)}</div>
        <div class="bullet-theme-list">${themeItems}</div>
      </div>`;
  }

  // 渲染单套文案的三维评分卡
  const renderBulletSetScore = (score) => {
    if (!score) return '';
    const overall = score.overallScore || 0;
    const scoreColor = overall >= 8 ? '#16A34A' : overall >= 6 ? '#F59E0B' : '#EF4444';
    const scoreLabel = overall >= 8 ? '优秀' : overall >= 6 ? '良好' : overall >= 4 ? '一般' : '较差';
    const dims = score.dimensions || {};

    const dimCard = (key, label, icon, d) => {
      if (!d) return '';
      const sc = d.score || 0;
      const sc2 = sc >= 8 ? '#16A34A' : sc >= 6 ? '#F59E0B' : '#EF4444';
      const posKw = (d.positiveKeywords || []).map(k => `<span class="score-kw score-kw-pos">${escHtml(k)}</span>`).join('');
      const misKw = (d.missingKeywords || []).map(k => `<span class="score-kw score-kw-miss">${escHtml(k)}</span>`).join('');
      const tipsZh = d.tips_zh || [];
      const tipsEn = d.tips_en || [];
      const maxT = Math.max(tipsZh.length, tipsEn.length);
      let tipsHtml = '';
      for (let i = 0; i < maxT; i++) {
        tipsHtml += `<div class="score-tip">${tipsZh[i] ? `<div class="bi-zh">💡 ${escHtml(tipsZh[i])}</div>` : ''}${tipsEn[i] ? `<div class="bi-en">💡 ${escHtml(tipsEn[i])}</div>` : ''}</div>`;
      }
      return `<div class="score-dim-card">
        <div class="score-dim-header">
          <span class="score-dim-icon">${icon}</span>
          <span class="score-dim-label">${label}</span>
          <span class="score-dim-num" style="color:${sc2}">${sc}<span class="score-dim-total"> / 10</span></span>
        </div>
        <div class="score-dim-bar-wrap"><div class="score-dim-bar" style="width:${sc*10}%;background:${sc2};"></div></div>
        <div class="bilingual-block">
          ${d.summary_zh ? `<div class="bi-zh">${escHtml(d.summary_zh)}</div>` : ''}
          ${d.summary_en ? `<div class="bi-en">${escHtml(d.summary_en)}</div>` : ''}
        </div>
        ${posKw ? `<div class="score-kw-row"><span class="score-kw-label">✅ 已覆盖</span>${posKw}</div>` : ''}
        ${misKw ? `<div class="score-kw-row"><span class="score-kw-label score-kw-label-miss">⚠️ 缺失</span>${misKw}</div>` : ''}
        ${tipsHtml ? `<div class="score-tips-list">${tipsHtml}</div>` : ''}
      </div>`;
    };

    const perBullet = (score.perBulletCritique || []).map(b => {
      const bsc = b.score || 0;
      const bc = bsc >= 8 ? '#16A34A' : bsc >= 6 ? '#F59E0B' : '#EF4444';
      return `<div class="per-bullet-row">
        <span class="per-bullet-num">Bullet ${b.num}</span>
        <span class="per-bullet-score" style="color:${bc}">${bsc}</span>
        <div class="per-bullet-critique">
          ${b.critique_zh ? `<div class="bi-zh">${escHtml(b.critique_zh)}</div>` : ''}
          ${b.critique_en ? `<div class="bi-en">${escHtml(b.critique_en)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    const vs = score.vsCompetitor || {};
    const weWinItems = (vs.weWin || []).map(w => `<div class="vs-item vs-win">✅ ${escHtml(w)}</div>`).join('');
    const theyWinItems = (vs.theyWin || []).map(w => `<div class="vs-item vs-lose">⚠️ ${escHtml(w)}</div>`).join('');

    return `<div class="bullet-set-score-panel">
      <div class="bss-title">📊 三维质量评分 · 自评</div>
      <div class="bullet-score-overall">
        <div class="overall-score-circle" style="border-color:${scoreColor}">
          <span class="overall-score-num" style="color:${scoreColor}">${overall}</span>
          <span class="overall-score-label">${scoreLabel}</span>
        </div>
        <div class="overall-verdict">
          <div class="bilingual-block">
            ${score.verdict_zh ? `<div class="bi-zh">${escHtml(score.verdict_zh)}</div>` : ''}
            ${score.verdict_en ? `<div class="bi-en">${escHtml(score.verdict_en)}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="score-dims-grid">
        ${dimCard('a9','A9 算法','🔍',dims.a9)}
        ${dimCard('cosmo','COSMO 语义','🧠',dims.cosmo)}
        ${dimCard('rufus','Rufus 意图','🤖',dims.rufus)}
      </div>
      ${perBullet ? `<div class="per-bullet-section"><div class="per-bullet-title">逐条点评 / Per-Bullet Critique</div>${perBullet}</div>` : ''}
      ${(weWinItems || theyWinItems) ? `
      <div class="vs-competitor-panel">
        <div class="vs-panel-title">⚔️ 与竞品对比</div>
        <div class="vs-cols">
          ${weWinItems ? `<div class="vs-col"><div class="vs-col-title">我方胜出</div>${weWinItems}</div>` : ''}
          ${theyWinItems ? `<div class="vs-col"><div class="vs-col-title">竞品仍领先</div>${theyWinItems}</div>` : ''}
        </div>
        ${vs.recommendation_zh ? `<div class="vs-recommendation">
          <div class="bi-zh">💡 ${escHtml(vs.recommendation_zh)}</div>
          ${vs.recommendation_en ? `<div class="bi-en">💡 ${escHtml(vs.recommendation_en)}</div>` : ''}
        </div>` : ''}
      </div>` : ''}
    </div>`;
  };

  let bulletsHtml = bulletLogicHtml;
  (data.bulletSets || []).forEach((set, idx) => {
    const setLetter = String.fromCharCode(65 + idx);
    const setColor = idx === 0 ? 'var(--primary)' : '#7C3AED';
    let bItems = '';
    (set.bullets || []).forEach((b) => {
      const en = b.engineNotes || {};
      const engineAnnotation = (en.a9 || en.cosmo || en.rufus) ? `
        <div class="bullet-engine-notes">
          ${en.a9 ? `<div class="ben-row"><span class="ben-badge ben-a9">A9</span><span>${escHtml(en.a9)}</span></div>` : ''}
          ${en.cosmo ? `<div class="ben-row"><span class="ben-badge ben-cosmo">COSMO</span><span>${escHtml(en.cosmo)}</span></div>` : ''}
          ${en.rufus ? `<div class="ben-row"><span class="ben-badge ben-rufus">Rufus</span><span>${escHtml(en.rufus)}</span></div>` : ''}
        </div>` : '';
      bItems += `<div class="bullet-item">
        <div class="bullet-num-badge">Bullet ${b.num || ''}</div>
        <div class="bullet-headline">• <strong>${escHtml(b.headline)}</strong></div>
        <div class="bullet-body">${escHtml(b.body)}</div>
        ${b.keySignal ? `<div class="bullet-signal">算法信号：${escHtml(b.keySignal)}</div>` : ''}
        ${engineAnnotation}
      </div>`;
    });
    bulletsHtml += `<div class="bullet-set bullet-set-${setLetter.toLowerCase()}">
      <div class="bullet-set-title" style="border-left-color:${setColor}">
        <span class="bullet-set-letter" style="background:${setColor}">Set ${setLetter}</span>
        ${escHtml(set.setName)}
        ${set.setStrategy ? `<div class="bullet-set-strategy">${escHtml(set.setStrategy)}</div>` : ''}
      </div>
      ${bItems}
      ${renderBulletSetScore(set.bulletScore)}
    </div>`;
  });
  document.getElementById('bulletsContent').innerHTML = bulletsHtml || '<p style="color:var(--text-muted)">暂无五点数据</p>';

  // ===== Tab 4: 主图图需（8张，nanobanana 格式）=====
  let visualHtml = `<div class="visual-intro">共8张图需：图1–5与五点文案逐一对应，图6–8为补充转化场景。每张均含 nanobanana AI Prompt（英文）及中文翻译。</div>`;

  // 图需卡片
  (data.imageRequirements || []).forEach(img => {
    const callouts = (img.callouts || []).map(c =>
      `<span class="img-callout-tag">${escHtml(c)}</span>`
    ).join('');
    const isSupplement = img.imageNum > 5;
    visualHtml += `<div class="visual-image-slot${isSupplement ? ' visual-supplement' : ''}">
      <div class="visual-slot-header">
        <span class="visual-img-num">图 ${img.imageNum}${isSupplement ? ' <em>补充</em>' : ''}</span>
        <span class="visual-bullet-ref">${escHtml(img.bulletRef || '')}</span>
      </div>
      <div class="visual-concept"><strong>📸 画面概念：</strong>${escHtml(img.concept || '')}</div>
      <div class="visual-design-dir"><strong>🎨 设计方向：</strong>${escHtml(img.designDirection || '')}</div>
      ${callouts ? `<div class="visual-callouts-row"><strong>📝 文字贴片：</strong><div class="visual-callouts">${callouts}</div></div>` : ''}
      <div class="visual-nano-note"><strong>💬 给 nanobanana 的说明：</strong>${escHtml(img.nanobananaNote || '')}</div>
      ${img.promptEN ? `<div class="visual-prompt-block">
        <div class="visual-prompt-label">🤖 Nanobanana Prompt（英文）</div>
        <div class="visual-prompt-en">${escHtml(img.promptEN)}</div>
        ${img.promptZH ? `<div class="visual-prompt-label visual-prompt-label-zh">📖 Prompt 中文译文</div>
        <div class="visual-prompt-zh">${escHtml(img.promptZH)}</div>` : ''}
      </div>` : ''}
    </div>`;
  });

  // 整体叙事总述
  if (data.visualNarrative) {
    visualHtml += `<div class="visual-narrative-block">
      <div class="visual-narrative-title">📋 主图整体叙事逻辑概述</div>
      <div class="visual-narrative-body">${escHtml(data.visualNarrative)}</div>
    </div>`;
  }

  document.getElementById('visualContent').innerHTML = visualHtml;

  // ===== Tab 5: A+套图创作思路（6张）=====
  const moduleTypeLabel = { hero: '首屏英雄图', feature: '功能深度图', lifestyle: '场景沉浸图', comparison: '对比/规格图', brand: '品牌调性收尾图' };
  const moduleTypeColor = { hero: '#1d4ed8', feature: '#0369a1', lifestyle: '#065f46', comparison: '#7c3aed', brand: '#9d174d' };

  let aplusHtml = `<div class="aplus-intro">
    <div class="aplus-intro-header">✨ A+ 套图创作思路 · 共 6 张</div>
    <div class="aplus-intro-desc">A+ 图片比例与主图不同（横幅/方块），更适合品牌故事、模特沉浸式场景、功能深挖与情感连接。以下方案基于本品核心卖点定制，覆盖：首屏冲击 → 功能深度 → 场景沉浸 → 对比信任 → 品牌收尾。</div>
  </div>`;

  (data.aplusRequirements || []).forEach(img => {
    const typeLabel = moduleTypeLabel[img.moduleType] || img.moduleType || '';
    const typeColor = moduleTypeColor[img.moduleType] || '#374151';
    aplusHtml += `<div class="aplus-card">
      <div class="aplus-card-header">
        <div class="aplus-card-left">
          <span class="aplus-num">A+ 图 ${img.aplusNum}</span>
          <span class="aplus-type-badge" style="background:${typeColor}15;color:${typeColor};border:1px solid ${typeColor}40">${typeLabel}</span>
          <span class="aplus-ratio">${escHtml(img.aspectRatio || '')}</span>
        </div>
        <div class="aplus-sell-ref">${escHtml(img.sellPointRef || '')}</div>
      </div>
      <div class="aplus-concept"><strong>📸 画面核心概念：</strong>${escHtml(img.concept || '')}</div>
      <div class="aplus-meta-grid">
        <div class="aplus-meta-item"><span class="aplus-meta-label">🏙️ 场景描述</span><span class="aplus-meta-val">${escHtml(img.sceneDesc || '')}</span></div>
        <div class="aplus-meta-item"><span class="aplus-meta-label">👤 模特描述</span><span class="aplus-meta-val">${escHtml(img.modelDesc || '')}</span></div>
        <div class="aplus-meta-item"><span class="aplus-meta-label">🎨 色彩方向</span><span class="aplus-meta-val">${escHtml(img.colorPalette || '')}</span></div>
        <div class="aplus-meta-item"><span class="aplus-meta-label">✨ 情绪氛围</span><span class="aplus-meta-val">${escHtml(img.mood || '')}</span></div>
      </div>
      ${img.copyOverlay ? `<div class="aplus-copy-overlay"><strong>💬 建议叠加文案：</strong>${escHtml(img.copyOverlay)}</div>` : ''}
      ${img.designNotes ? `<div class="aplus-design-notes"><strong>📐 设计说明：</strong>${escHtml(img.designNotes)}</div>` : ''}
      ${img.promptEN ? `<div class="visual-prompt-block">
        <div class="visual-prompt-label">🤖 Nanobanana Prompt（英文）</div>
        <div class="visual-prompt-en">${escHtml(img.promptEN)}</div>
        ${img.promptZH ? `<div class="visual-prompt-label visual-prompt-label-zh">📖 Prompt 中文译文</div>
        <div class="visual-prompt-zh">${escHtml(img.promptZH)}</div>` : ''}
      </div>` : ''}
    </div>`;
  });

  if (data.aplusNarrative) {
    aplusHtml += `<div class="visual-narrative-block">
      <div class="visual-narrative-title">📋 A+ 套图整体叙事逻辑概述</div>
      <div class="visual-narrative-body">${escHtml(data.aplusNarrative)}</div>
    </div>`;
  }

  const aplusEl = document.getElementById('aplusContent');
  if (aplusEl) aplusEl.innerHTML = aplusHtml || '<p style="color:var(--text-muted)">暂无 A+ 套图数据</p>';
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  setTimeout(() => { t.className = 'toast'; }, 3000);
}
function openModal() { document.getElementById('settingsModal').classList.add('open'); }
function closeModal() { document.getElementById('settingsModal').classList.remove('open'); }
function setLoadingStatus(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

// ===== Tab Handling =====
function initTabs() {
  document.querySelectorAll('.tab-nav').forEach(nav => {
    nav.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab;
        const panel = btn.closest('.card') || btn.closest('.step-panel');
        panel.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        panel.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        panel.querySelector(`#tab-${tabId}`)?.classList.add('active');
      });
    });
  });
}

// ===== Copy All =====
function copyTextContent(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const text = el.innerText || el.textContent || '';
  // 优先用现代 Clipboard API（HTTPS 环境）
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('已复制到剪贴板', 'success');
    }).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      showToast('已复制到剪贴板', 'success');
    } else {
      showToast('复制失败，请手动 Ctrl+A 全选后复制', 'error');
    }
  } catch (e) {
    showToast('复制失败，请手动 Ctrl+A 全选后复制', 'error');
  }
}

// ===== Main Analyze Flow =====
async function runAnalysis() {
  const raw = document.getElementById('asinInput').value.trim();
  const listing = document.getElementById('rawListing').value.trim();

  if (!raw) {
    showToast('请输入 ASIN 或亚马逊链接', 'error');
    return;
  }

  const asin = extractASIN(raw);
  if (!asin) {
    showToast('无法识别有效的 ASIN，请检查输入格式', 'error');
    return;
  }

  const s = getSettings();
  if (!s.apiKey) {
    showToast('请先配置 API Key', 'error');
    openModal();
    return;
  }

  state.asin = asin;
  state.asinUrl = buildAmazonUrl(asin);
  state.rawListing = listing;

  goToStep(2);
  document.getElementById('analysisLoading').style.display = 'flex';
  document.getElementById('analysisOutput').style.display = 'none';
  document.getElementById('step2Footer').style.display = 'none';
  document.getElementById('analyzeBtn').disabled = true;

  const steps = [
    '正在解析 ASIN 与品类信息...',
    '正在提取产品核心参数...',
    '正在分析核心卖点与市场定位...',
    '正在生成运营建议（A9/COSMO/Rufus）...',
  ];
  let si = 0;
  const loadingInterval = setInterval(() => {
    si = (si + 1) % steps.length;
    setLoadingStatus('loadingStatus', steps[si]);
  }, 2500);

  try {
    const { system, user } = buildAnalysisPrompt(asin, state.asinUrl, listing);
    const rawJson = await callAI(system, user);
    const parsed = safeParseJSON(rawJson);

    state.analysisResult = parsed;
    clearInterval(loadingInterval);

    document.getElementById('analysisLoading').style.display = 'none';
    document.getElementById('analysisOutput').style.display = 'block';
    document.getElementById('step2Footer').style.display = 'flex';

    renderAnalysis(parsed);

    // 如果有 Sorftime Key，异步拉取子体销量历史
    const _s = getSettings();
    if (_s.sorfTimeKey) {
      fetchSalesHistoryViaSorftime(asin, _s.sorfTimeKey)
        .then(salesData => {
          state.salesHistory = salesData;
          renderSalesHistory(salesData);
        })
        .catch(() => {
          // 销量数据拉取失败不影响主流程，静默忽略
          const el = document.getElementById('salesHistoryContent');
          if (el) el.innerHTML = `<p style="color:var(--text-muted);padding:12px 0;font-size:13px;">⚠️ 暂无子体销量数据（ASIN 未收录或积分不足）</p>`;
        });
    }

    // 如果有 Sorftime 评价数据，直接渲染评价 tab
    if (fetchedListingData && fetchedListingData.source === 'sorftime') {
    renderReviews(fetchedListingData);
  } else {
    const rc = document.getElementById('reviewsContent');
    if (rc) rc.innerHTML = `<p style="color:var(--text-muted);padding:20px 0;">评价数据需通过 Sorftime 自动获取 Listing 后可见</p>`;
  }

  } catch (err) {
    clearInterval(loadingInterval);
    document.getElementById('analysisLoading').style.display = 'none';
    goToStep(1);
    document.getElementById('analyzeBtn').disabled = false;
    showToast('分析失败：' + err.message, 'error');
  }
}

// ===== Collect Step3 Form Data =====
function collectStep3Data() {
  const productName = document.getElementById('s3ProductNameCN')?.value.trim() || '';
  const price = document.getElementById('s3Price')?.value.trim() || '';
  const scene = document.getElementById('s3Scene')?.value.trim() || '';
  const audience = document.getElementById('s3Audience')?.value.trim() || '';
  const diff = document.getElementById('s3Diff')?.value.trim() || '';
  const extra = document.getElementById('s3Extra')?.value.trim() || '';

  // Params
  const paramRows = document.querySelectorAll('.s3-param-row');
  const params = [];
  paramRows.forEach(row => {
    const k = row.querySelector('.s3-param-key')?.value.trim();
    const v = row.querySelector('.s3-param-val')?.value.trim();
    if (k && v) params.push(`${k}：${v}`);
  });

  // Sell points
  const spInputs = document.querySelectorAll('.s3-sp-input');
  const sellPoints = [];
  spInputs.forEach((inp, i) => {
    const v = inp.value.trim();
    if (v) sellPoints.push(`${sellPoints.length + 1}. ${v}`);
  });

  if (!productName) return null;

  const lines = [
    `产品名称：${productName}`,
    price ? `价格区间：${price}` : '',
    scene ? `目标场景：${scene}` : '',
    audience ? `目标人群：${audience}` : '',
    params.length ? `\n核心参数规格：\n${params.join('\n')}` : '',
    sellPoints.length ? `\n核心卖点：\n${sellPoints.join('\n')}` : '',
    diff ? `\n对比竞品差异化优势：\n${diff}` : '',
    extra ? `\n补充信息：\n${extra}` : '',
  ].filter(Boolean);

  return { productName, summary: lines.join('\n') };
}

// ===== Generate Final Output =====
async function runGenerate() {
  const collected = collectStep3Data();
  if (!collected || !collected.productName) {
    showToast('请至少填写产品名称', 'error');
    return;
  }
  if (!state.analysisResult) {
    showToast('请先完成竞品分析', 'error');
    return;
  }

  const focuses = [];
  if (document.getElementById('focusPrice')?.checked) focuses.push('Price Competitiveness');
  if (document.getElementById('focusQuality')?.checked) focuses.push('Quality Upgrade');
  if (document.getElementById('focusFeature')?.checked) focuses.push('Feature Differentiation');
  if (document.getElementById('focusAudience')?.checked) focuses.push('Audience Targeting');
  if (document.getElementById('focusRufus')?.checked) focuses.push('Rufus/COSMO Algorithm Optimization');

  state.ourProductName = collected.productName;
  state.ourSellPoints = collected.summary;
  state.focusAreas = focuses;

  goToStep(4);
  document.getElementById('finalLoading').style.display = 'flex';
  document.getElementById('finalOutput').style.display = 'none';
  document.getElementById('step4Footer').style.display = 'none';
  document.getElementById('generateBtn').disabled = true;

  const steps = [
    '正在对比竞品优劣势...',
    '正在生成 5 个备选标题（含词汇权重+流量逻辑）...',
    '正在撰写 Set A / Set B 两套五点文案...',
    '正在规划主图与 A+ 视觉逻辑...',
  ];
  let si = 0;
  const loadingInterval = setInterval(() => {
    si = (si + 1) % steps.length;
    setLoadingStatus('finalLoadingStatus', steps[si]);
  }, 2800);

  try {
    const { system, user } = buildComparisonPrompt(
      state.analysisResult, state.ourProductName, state.ourSellPoints, focuses, state.rivalListings
    );
    const rawJson = await callAI(system, user);
    const parsed = safeParseJSON(rawJson);

    clearInterval(loadingInterval);

    document.getElementById('finalLoading').style.display = 'none';
    document.getElementById('finalOutput').style.display = 'block';
    document.getElementById('step4Footer').style.display = 'flex';

    renderFinal(parsed);

    // ── 如果有风格参考竞品，额外生成风格参考版 ──
    if (state.styleRefListings && state.styleRefListings.length > 0) {
      generateStyleRefVersion(state.styleRefListings, focuses);
    }

  } catch (err) {
    clearInterval(loadingInterval);
    console.error('[runGenerate] 生成失败:', err);
    document.getElementById('finalLoading').style.display = 'none';
    // 在 Step4 显示详细错误（便于排查）
    document.getElementById('finalOutput').style.display = 'block';
    document.getElementById('finalOutput').innerHTML = `
      <div style="background:#fff1f2;border:2px solid #fca5a5;border-radius:10px;padding:24px 28px;margin:16px 0">
        <div style="font-size:15px;font-weight:700;color:#b91c1c;margin-bottom:10px">⚠️ 生成失败</div>
        <div style="font-size:13px;color:#374151;margin-bottom:8px"><b>错误信息：</b>${escHtml(err.message)}</div>
        <div style="font-size:12px;color:#6b7280;background:#f9fafb;padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-all">${escHtml(err.stack || '')}</div>
        <div style="margin-top:14px;font-size:12.5px;color:#374151">
          常见原因：<br>
          1. 未配置 API Key（点右上角「API 设置」）<br>
          2. API Key 余额不足或已失效<br>
          3. 网络请求被拦截<br>
          4. 请打开浏览器控制台（F12）查看完整错误
        </div>
      </div>`;
    goToStep(4);
    document.getElementById('generateBtn').disabled = false;
    showToast('生成失败：' + err.message, 'error');
  }
}

// ===== 风格参考版生成 =====
async function generateStyleRefVersion(styleRefListings, focuses) {
  const tabBtn = document.getElementById('styleRefTab');
  const contentEl = document.getElementById('styleRefContent');
  if (!tabBtn || !contentEl) return;

  // 显示 Tab（加载中状态）
  tabBtn.style.display = '';
  contentEl.innerHTML = `<div class="styleref-loading"><div class="spinner" style="width:28px;height:28px;margin:0 auto 12px"></div><p style="color:var(--text-muted);text-align:center;font-size:13px">正在根据风格参考竞品生成备选版本...</p></div>`;

  const refNames = styleRefListings.map(r => r.asin).join('、');

  // 构建专用 prompt
  const system = `You are an Amazon listing copywriter expert. Your task is to generate ALTERNATIVE titles, bullet points, and main image briefs that DEEPLY MIMIC the writing style, tone, sentence structure, keyword placement strategy, and headline format of the reference competitor listings provided by the user.

Key requirements:
1. Study the reference listings carefully: their title structure, bullet point format, capitalization style, punctuation use, emphasis patterns.
2. Generate content for OUR product that follows the SAME writing style as the references — not generic Amazon copy.
3. Return ONLY valid JSON, no markdown fences.

JSON schema:
{
  "styleRef": {
    "styleAnalysis": "2-3 sentences describing the writing style patterns observed in the reference listings",
    "titles": [
      { "text": "full title text", "annotation": "how this mirrors the reference style" }
    ],
    "bullets": [
      { "label": "BULLET 1 HEADLINE", "body": "bullet body text" },
      { "label": "BULLET 2 HEADLINE", "body": "..." },
      { "label": "BULLET 3 HEADLINE", "body": "..." },
      { "label": "BULLET 4 HEADLINE", "body": "..." },
      { "label": "BULLET 5 HEADLINE", "body": "..." }
    ],
    "visualBriefs": [
      { "imgNum": 1, "theme": "image theme", "concept": "visual concept", "promptEN": "nanobanana AI prompt in English", "promptCN": "中文翻译" },
      { "imgNum": 2, "theme": "...", "concept": "...", "promptEN": "...", "promptCN": "..." },
      { "imgNum": 3, "theme": "...", "concept": "...", "promptEN": "...", "promptCN": "..." }
    ]
  }
}`;

  // 组装参考竞品内容
  let refBlock = `【风格参考竞品 Listing（请深度学习其写作风格）】\n\n`;
  styleRefListings.forEach((r, i) => {
    refBlock += `参考竞品 ${i+1}：ASIN ${r.asin}\n标题：${r.title}\n`;
    if (r.bullets?.length) {
      refBlock += `五点描述：\n${r.bullets.map((b, j) => `  Bullet ${j+1}: ${b}`).join('\n')}\n`;
    }
    refBlock += '\n';
  });

  const user = `${refBlock}
【我方产品信息】
${state.ourSellPoints}

竞品分析摘要：
- 产品：${state.analysisResult?.productTitle || ''}
- 品类：${state.analysisResult?.category || ''}
- 我方差异化：${state.ourSellPoints?.split('\n').slice(0,3).join(' | ')}
${focuses?.length ? `侧重方向：${focuses.join(', ')}` : ''}

请基于参考竞品的写作风格，为我方产品生成：
1. 3个备选标题（模仿参考竞品的标题结构与关键词布局方式）
2. 完整的5点文案（模仿参考竞品的bullet格式、Headline大小写风格、句式节奏）
3. 3张主图图需（参考竞品的视觉表达思路，结合我方产品特点）`;

  try {
    const rawJson = await callAI(system, user);
    const parsed = safeParseJSON(rawJson);

    if (parsed?.styleRef) {
      renderStyleRefTab(parsed.styleRef, styleRefListings);
      tabBtn.classList.add('tab-btn-styleref-ready');
      showToast('✍️ 风格参考版已生成，点击「风格参考版」Tab 查看', 'success');
    } else {
      contentEl.innerHTML = `<p style="color:var(--text-muted);padding:20px">风格参考版生成失败，请重试</p>`;
    }
  } catch (err) {
    contentEl.innerHTML = `<p style="color:#dc2626;padding:20px">生成失败：${escHtml(err.message)}</p>`;
  }
}

function renderStyleRefTab(data, styleRefListings) {
  const contentEl = document.getElementById('styleRefContent');
  if (!contentEl) return;

  const e = escHtml;
  let html = '';

  // 参考竞品标识
  html += `<div class="styleref-source-bar">`;
  styleRefListings.forEach(r => {
    html += `<span class="styleref-source-badge">${e(r.asin)}</span>`;
  });
  html += `<span class="styleref-source-label">风格参考来源</span></div>`;

  // 风格分析
  if (data.styleAnalysis) {
    html += `<div class="styleref-analysis-block"><span class="styleref-analysis-icon">🔍</span><span>${e(data.styleAnalysis)}</span></div>`;
  }

  // 备选标题
  if (data.titles?.length) {
    html += `<div class="section-block"><h3>📝 风格参考版 · 备选标题</h3>`;
    data.titles.forEach((t, i) => {
      html += `<div class="styleref-title-card">
        <div class="styleref-title-num">方案 ${i+1}</div>
        <div class="styleref-title-text">${e(t.text)}</div>
        ${t.annotation ? `<div class="styleref-title-note">💡 ${e(t.annotation)}</div>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  // 五点文案
  if (data.bullets?.length) {
    html += `<div class="section-block"><h3>📋 风格参考版 · 五点文案</h3>`;
    data.bullets.forEach((b, i) => {
      html += `<div class="bullet-item">
        <div class="bullet-label">BULLET ${i+1}${b.label ? ' · ' + e(b.label) : ''}</div>
        <div class="bullet-body">${e(b.body)}</div>
      </div>`;
    });
    html += `</div>`;
  }

  // 主图图需
  if (data.visualBriefs?.length) {
    html += `<div class="section-block"><h3>🖼️ 风格参考版 · 主图图需</h3>`;
    data.visualBriefs.forEach(v => {
      html += `<div class="image-req-card">
        <div class="image-req-num">图 ${v.imgNum}</div>
        <div class="image-req-theme">${e(v.theme || '')}</div>
        ${v.concept ? `<div style="font-size:12.5px;color:#374151;margin-bottom:6px">${e(v.concept)}</div>` : ''}
        ${v.promptEN ? `<div class="styleref-prompt-en"><span class="styleref-prompt-label">EN Prompt</span>${e(v.promptEN)}</div>` : ''}
        ${v.promptCN ? `<div class="styleref-prompt-cn"><span class="styleref-prompt-label">中文</span>${e(v.promptCN)}</div>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  contentEl.innerHTML = html;
}


function restart() {
  state.currentStep = 1;
  state.analysisResult = null;
  state.rivalListings = [];
  state.rivalAsins = [];
  state.styleRefListings = [];
  document.getElementById('asinInput').value = '';
  document.getElementById('rawListing').value = '';
  // Clear Step 3 fields
  ['s3ProductNameCN','s3Price','s3Scene','s3Audience','s3Diff','s3Extra'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.querySelectorAll('.s3-param-key, .s3-param-val').forEach(el => el.value = '');
  document.querySelectorAll('.s3-sp-input').forEach(el => el.value = '');
  document.querySelectorAll('.rival-asin-input').forEach(el => el.value = '');
  document.querySelectorAll('.rival-status').forEach(el => { el.textContent = ''; el.className = 'rival-status'; });
  const rivalSummaryEl = document.getElementById('rivalFetchedSummary');
  if (rivalSummaryEl) { rivalSummaryEl.style.display = 'none'; rivalSummaryEl.innerHTML = ''; }
  const fetchRivalsBtn = document.getElementById('fetchRivalsBtn');
  if (fetchRivalsBtn) { fetchRivalsBtn.disabled = false; document.getElementById('fetchRivalsBtnText').textContent = '批量拉取竞品 Listing'; }
  // 清空风格参考竞品
  document.querySelectorAll('.styleref-asin-input').forEach(el => el.value = '');
  document.querySelectorAll('.styleref-status').forEach(el => { el.textContent = ''; el.className = 'styleref-status'; });
  const styleRefSummaryEl = document.getElementById('styleRefFetchedSummary');
  if (styleRefSummaryEl) { styleRefSummaryEl.style.display = 'none'; styleRefSummaryEl.innerHTML = ''; }
  const fetchStyleRefBtn = document.getElementById('fetchStyleRefBtn');
  if (fetchStyleRefBtn) { fetchStyleRefBtn.disabled = false; document.getElementById('fetchStyleRefBtnText').textContent = '拉取风格参考 Listing'; }
  const styleRefTab = document.getElementById('styleRefTab');
  if (styleRefTab) { styleRefTab.style.display = 'none'; styleRefTab.classList.remove('tab-btn-styleref-ready'); }
  const styleRefContent = document.getElementById('styleRefContent');
  if (styleRefContent) styleRefContent.innerHTML = '';
  document.getElementById('analyzeBtn').disabled = false;
  document.getElementById('generateBtn').disabled = false;
  document.getElementById('analysisOutput').style.display = 'none';
  document.getElementById('analysisLoading').style.display = 'none';
  document.getElementById('finalOutput').style.display = 'none';
  document.getElementById('finalLoading').style.display = 'none';
  clearFetchedListing();
  goToStep(1);
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  initTabs();

  // Settings — restore saved values
  const s = getSettings();
  document.getElementById('apiProvider').value = s.provider || 'gemini';
  document.getElementById('apiKey').value = s.apiKey || '';
  document.getElementById('customUrl').value = s.customUrl || '';
  document.getElementById('customModel').value = s.customModel || '';
  document.getElementById('geminiModel').value = s.geminiModel || 'gemini-2.5-flash-lite';
  document.getElementById('openaiModel').value = s.openaiModel || 'gpt-4o';
  document.getElementById('sorfTimeKey').value = s.sorfTimeKey || '';

  const MODEL_TIPS = {
    gemini: '使用 Google Gemini API，Key 以 <strong>AIzaSy</strong> 开头，在美国可直接调用。',
    openai: '使用 OpenAI API，Key 以 <strong>sk-</strong> 开头。',
    custom: '填入 OpenAI 兼容的代理接口地址（如 One API / NewAPI 等中转站）。',
  };

  function updateSettingsUI(provider) {
    document.getElementById('geminiModelGroup').style.display = provider === 'gemini' ? '' : 'none';
    document.getElementById('openaiModelGroup').style.display = provider === 'openai' ? '' : 'none';
    document.getElementById('customUrlGroup').style.display = provider === 'custom' ? '' : 'none';
    document.getElementById('customModelGroup').style.display = provider === 'custom' ? '' : 'none';
    const tip = document.getElementById('modelTip');
    tip.innerHTML = MODEL_TIPS[provider] || '';
    tip.className = 'model-tip show';
  }

  updateSettingsUI(s.provider || 'gemini');

  document.getElementById('apiProvider').addEventListener('change', (e) => {
    updateSettingsUI(e.target.value);
  });

  document.getElementById('settingsBtn').addEventListener('click', openModal);
  document.getElementById('closeSettings').addEventListener('click', closeModal);
  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('saveSettings').addEventListener('click', saveSettings);

  // Step 1
  document.getElementById('analyzeBtn').addEventListener('click', runAnalysis);
  document.getElementById('fetchListingBtn').addEventListener('click', autoFetchListing);
  document.getElementById('clearFetchedBtn').addEventListener('click', clearFetchedListing);
  document.getElementById('asinInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runAnalysis();
  });

  // Step 2 actions
  document.getElementById('goStep3Btn').addEventListener('click', () => goToStep(3));
  document.getElementById('copyAnalysis').addEventListener('click', () => {
    window.print();
  });
  document.getElementById('reanalyze').addEventListener('click', () => {
    const titleEl = document.querySelector('#step2 .card-title');
    if (titleEl) titleEl.innerHTML = '<span class="step-badge">Step 2</span>竞品深度分析报告';
    goToStep(1);
    document.getElementById('analyzeBtn').disabled = false;
  });

  // Step 3
  document.getElementById('generateBtn').addEventListener('click', runGenerate);

  // Step 3 — 参考竞品 ASIN 批量拉取
  document.getElementById('fetchRivalsBtn')?.addEventListener('click', fetchRivalListings);

  // Step 3 — 风格参考竞品拉取
  document.getElementById('fetchStyleRefBtn')?.addEventListener('click', fetchStyleRefListings);

  // Step 3 — 添加参考竞品行
  document.getElementById('addRivalBtn')?.addEventListener('click', () => {
    const container = document.getElementById('rivalAsinContainer');
    const existingRows = container.querySelectorAll('.rival-row');
    if (existingRows.length >= 5) { showToast('最多填写 5 个参考竞品', 'error'); return; }
    const num = existingRows.length + 1;
    const row = document.createElement('div');
    row.className = 'rival-row';
    row.innerHTML = `<span class="rival-num">${num}</span><input type="text" class="rival-asin-input" placeholder="ASIN（10位）或亚马逊商品链接" /><span class="rival-status" title="状态"></span>`;
    container.appendChild(row);
    row.querySelector('input').focus();
  });

  // Step 4 actions
  document.getElementById('copyFinal').addEventListener('click', () => {
    copyTextContent('finalOutput');
  });
  document.getElementById('regenerate').addEventListener('click', () => {
    goToStep(3);
    document.getElementById('generateBtn').disabled = false;
  });
  document.getElementById('restartBtn').addEventListener('click', restart);

  // Step 3 — dynamic param rows
  document.getElementById('addParamBtn')?.addEventListener('click', () => {
    const container = document.getElementById('s3ParamsContainer');
    const row = document.createElement('div');
    row.className = 's3-param-row';
    row.innerHTML = `
      <input type="text" class="s3-param-key" placeholder="参数名" />
      <input type="text" class="s3-param-val" placeholder="参数值" />
      <button class="s3-param-del" title="删除">✕</button>`;
    container.appendChild(row);
    row.querySelector('.s3-param-del').addEventListener('click', () => row.remove());
  });
  // Bind existing del buttons
  document.querySelectorAll('.s3-param-del').forEach(btn => {
    btn.addEventListener('click', () => btn.closest('.s3-param-row').remove());
  });

  // Step 3 — dynamic sell point rows
  let spCount = 5;
  document.getElementById('addSpBtn')?.addEventListener('click', () => {
    spCount++;
    const container = document.getElementById('s3SellpointsContainer');
    const row = document.createElement('div');
    row.className = 's3-sp-row';
    row.innerHTML = `
      <div class="s3-sp-num">${spCount}</div>
      <input type="text" class="s3-sp-input" placeholder="继续添加卖点..." />`;
    container.appendChild(row);
    row.querySelector('input').focus();
  });

});

// ===== PDF 下载功能已移除 =====
function downloadFullReport() {
  showToast('PDF 下载功能已移除', 'info');
}

