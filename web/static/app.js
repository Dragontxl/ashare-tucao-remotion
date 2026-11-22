/* A股盘面吐槽大会 · 前端逻辑（原生 JS，无构建） */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  health: null,
  cloudMode: false,
  tasks: [],
  taskFilter: '',
  taskId: null,
  task: null,
  cloudDetail: false,
  cloudUploading: false,
  logOffset: 0,
  sourceMode: 'auto',
  articlePath: null,
  articleChars: 0,
  uploadedText: '',
  logTimer: null,
  listTimer: null,
  detailTimer: null,
  cloudRunTimer: null,
  view: 'create',
  // 文件管理
  filePrefix: '',
  fileItems: [],
  selectedFiles: new Set(),
  // 云端运行结果
  cloudRunResult: null,
  cloudRunDate: '',
};

/* ── 基础工具 ───────────────────────────────────────────── */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { detail: text }; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message || data.error)) || `请求失败 (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function date8ToInput(d) {
  if (!d) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function inputToDate8(v) {
  return (v || '').replaceAll('-', '');
}

function fmtDate8(d) {
  if (!d || d.length !== 8) return d || '';
  return `${d.slice(0, 4)}年${Number(d.slice(4, 6))}月${Number(d.slice(6, 8))}日`;
}

function fmtTime(ts) {
  const p = bjParts(ts);
  if (!p) return ts ? String(ts).replace('T', ' ').slice(5, 16) : '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// 解析时间：带时区（如 GitHub 的 ...Z）统一换算为北京时间 UTC+8；无时区（本地任务）原样按本地展示
function bjParts(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  const hasZone = /[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  if (hasZone) {
    const bj = new Date(d.getTime() + 8 * 3600 * 1000);
    return {
      year: bj.getUTCFullYear(), month: bj.getUTCMonth() + 1, day: bj.getUTCDate(),
      hour: bj.getUTCHours(), minute: bj.getUTCMinutes(), second: bj.getUTCSeconds(),
    };
  }
  return {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function badgeClass(status) {
  if (status === 'success') return 'badge-ok';
  if (status === 'running' || status === 'queued') return 'badge-run';
  if (status === 'failed') return 'badge-err';
  return 'badge-muted';
}

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ── 视图切换 ───────────────────────────────────────────── */

function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'tasks') {
    if (state.cloudMode) loadCloudTasks(); else loadTasks();
    startListPoll();
  } else stopListPoll();
  if (name !== 'detail') { stopDetailPoll(); }
  if (name === 'settings') { loadGithubConfig(); }
  if (name === 'files') { loadFiles(); loadR2Stats(); }
}

function startListPoll() {
  stopListPoll();
  state.listTimer = setInterval(() => {
    if (state.view !== 'tasks') return;
    if (state.cloudMode) loadCloudTasks(true); else loadTasks(true);
  }, 5000);
}
function stopListPoll() {
  if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null; }
}
function startDetailPoll() {
  stopDetailPoll();
  state.detailTimer = setInterval(() => {
    if (state.view === 'detail' && state.taskId) refreshDetail(true);
  }, 1500);
}
function stopDetailPoll() {
  if (state.detailTimer) { clearInterval(state.detailTimer); state.detailTimer = null; }
}

/* ── 健康状态 / 交易日 ──────────────────────────────────── */

function articleUrlFor(date8) {
  const h = state.health || {};
  const art = h.article || {};
  const base = (art.base_url || 'https://ashare.ldragon.xyz/summary_today/').replace(/\/+$/, '') + '/';
  const pattern = art.pattern || '{date}_summary_today.docx';
  return base + pattern.replace('{date}', date8);
}

function setTradingBadge(status, reason) {
  const el = $('#tradingBadge');
  if (status === true) {
    el.className = 'badge badge-ok';
    el.textContent = '交易日 · 可运行';
  } else if (status === false) {
    el.className = 'badge badge-muted';
    el.textContent = '非交易日 · 将停止';
  } else {
    el.className = 'badge badge-info';
    el.textContent = '交易日无法判定';
  }
  el.title = reason || '';
}

/* ── 云端模式适配 ───────────────────────────────────────── */

function applyCloudMode() {
  const cloud = state.cloudMode;

  // 顶部添加云端模式标识
  const badge = $('#cloudModeBadge');
  if (badge) {
    badge.hidden = !cloud;
  }

  // 「任务列表」tab 始终保留：云端模式展示 GitHub Actions 运行记录
  const tasksTab = $$('.tab').find((t) => t.dataset.view === 'tasks');
  if (tasksTab) tasksTab.textContent = cloud ? '运行记录' : '任务列表';

  // 新建任务页：隐藏本地独有功能
  const createBtn = $('#createBtn');
  if (createBtn) createBtn.hidden = cloud;

  const previewBtn = $('#previewBtn');
  if (previewBtn) previewBtn.hidden = cloud;

  // 云端模式保留「上传文件」选项：浏览器端读取文本，随 dispatch 传至 GitHub

  // 云端模式下更新上传提示文案
  const uploadInfo = $('#uploadInfo');
  if (uploadInfo) {
    uploadInfo.textContent = cloud
      ? '支持 .md / .txt，浏览器端读取文本后随云端运行一起提交（docx 请改用粘贴或URL）'
      : '支持 docx / md / txt，上传后自动提取文本';
  }

  // 设置页：B站 Cookie 卡片整体隐藏（云端由 wrangler 管理）
  const biliCard = $('.card-bili');
  if (biliCard) biliCard.hidden = cloud;

  // 设置页：GitHub/R2 卡片只读，隐藏保存按钮和 PAT 输入
  const saveGithubBtn = $('#saveGithubBtn');
  if (saveGithubBtn) saveGithubBtn.hidden = cloud;

  const ghPatInput = $('#ghPat');
  if (ghPatInput) ghPatInput.disabled = cloud;

  const ghOwnerInput = $('#ghOwner');
  if (ghOwnerInput) ghOwnerInput.disabled = cloud;

  const ghRepoInput = $('#ghRepo');
  if (ghRepoInput) ghRepoInput.disabled = cloud;

  const r2Inputs = ['#r2Bucket', '#r2Endpoint', '#r2AccessKey', '#r2SecretKey', '#r2PublicUrl'];
  r2Inputs.forEach((sel) => {
    const el = $(sel);
    if (el) el.disabled = cloud;
  });

  // LLM 设置页：隐藏 API Key 输入（云端由 wrangler secret 管理）
  const llmKeyInput = $('#llmKey');
  if (llmKeyInput) llmKeyInput.disabled = cloud;

  // 保存设置按钮隐藏（云端无法保存）
  const saveSettingsBtn = $('#saveSettingsBtn');
  if (saveSettingsBtn) saveSettingsBtn.hidden = cloud;

  // 显示云端模式提示
  const ghHint = $('#ghCloudHint');
  if (ghHint) ghHint.hidden = !cloud;
}

async function loadHealth(force = false) {
  try {
    const h = await api('/api/health');
    state.health = h;
    state.cloudMode = h.mode === 'cloud';
    applyCloudMode();
    $('#todayLabel').textContent = `${h.cn_date} · ${h.date8}`;
    setTradingBadge(h.trading_day, h.trading_reason);
    const d = $('#taskDate').value ? inputToDate8($('#taskDate').value) : h.date8;
    $('#defaultArticleUrl').textContent = articleUrlFor(d);
    $('#defaultArticleUrl').href = articleUrlFor(d);
    if (!force && h.voice) $('#voice').value = h.voice;
    if (!force && h.rate) {
      const opt = Array.from($('#rate').options).find((o) => o.value === h.rate);
      if (opt) $('#rate').value = h.rate;
    }
    if (h.render && h.render.concurrency) $('#concurrency').value = h.render.concurrency;
  } catch (e) {
    setTradingBadge(null, e.message);
  }
}

async function checkTrading(date8) {
  const el = $('#tradingBadge');
  el.className = 'badge badge-muted';
  el.textContent = '检测中…';
  try {
    const r = await api(`/api/trading-day?date=${date8}`);
    setTradingBadge(r.status, r.reason);
  } catch (e) {
    setTradingBadge(null, e.message);
  }
}

/* ── 新建任务 ───────────────────────────────────────────── */

function setupCreate() {
  const dateInput = $('#taskDate');
  dateInput.value = date8ToInput(state.health ? state.health.date8 : new Date().toISOString().slice(0, 10).replaceAll('-', ''));
  dateInput.addEventListener('change', () => {
    const d = inputToDate8(dateInput.value);
    const url = articleUrlFor(d);
    $('#defaultArticleUrl').textContent = url;
    $('#defaultArticleUrl').href = url;
    checkTrading(d);
  });

  $$('#sourceTabs .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sourceMode = btn.dataset.mode;
      $$('#sourceTabs .seg').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.source-panel').forEach((p) => { p.hidden = p.dataset.panel !== state.sourceMode; });
    });
  });

  $('#articleText').addEventListener('input', (e) => {
    $('#pasteCount').textContent = e.target.value.trim().length;
  });

  $('#articleFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const info = $('#uploadInfo');

    if (state.cloudMode) {
      // 云端模式：浏览器端读取文件文本，随 dispatch 传至 GitHub
      info.textContent = `正在读取 ${file.name} …`;
      const ext = file.name.split('.').pop().toLowerCase();
      if (ext === 'docx') {
        info.textContent = '⚠️ docx 为二进制格式，浏览器无法直接解析。请改用 .md 或 .txt，或使用「粘贴文本」「自定义URL」。';
        state.uploadedText = '';
        state.articlePath = null;
        return;
      }
      try {
        const text = await fileToText(file);
        state.uploadedText = text;
        state.articlePath = null;
        const preview = text.slice(0, 1200);
        showPreview(preview, `来源：${file.name} · ${text.trim().length} 字（浏览器端读取）`);
        info.textContent = `已读取：${file.name}（${text.trim().length} 字）`;
        toast('文件内容已读取，将随云端运行一起提交');
      } catch (err) {
        info.textContent = `读取失败：${err.message}`;
        toast(err.message, true);
      }
      return;
    }

    info.textContent = `正在上传 ${file.name} …`;
    try {
      const base64 = await fileToBase64(file);
      const r = await api('/api/articles/upload', {
        method: 'POST',
        body: JSON.stringify({ filename: file.name, content: base64 }),
      });
      state.articlePath = r.path;
      state.articleChars = r.chars;
      info.textContent = `已上传：${file.name}（${r.chars} 字）`;
      showPreview(r.preview, `来源：${file.name} · ${r.chars} 字`);
      toast('原文上传成功');
    } catch (err) {
      info.textContent = `上传失败：${err.message}`;
      toast(err.message, true);
    }
  });

  $('#previewBtn').addEventListener('click', async () => {
    const btn = $('#previewBtn');
    btn.disabled = true;
    btn.textContent = '获取中…';
    try {
      const payload = {
        article_mode: state.sourceMode,
        date: inputToDate8(dateInput.value),
        article_text: $('#articleText').value,
        article_url: $('#articleUrl').value,
        article_path: state.articlePath,
      };
      const r = await api('/api/articles/preview', { method: 'POST', body: JSON.stringify(payload) });
      showPreview(r.preview, `来源：${r.origin} · ${r.chars} 字`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '预览原文';
    }
  });

  $('#createBtn').addEventListener('click', createTask);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

function showPreview(text, meta) {
  const box = $('#previewBox');
  box.textContent = text || '（无内容）';
  box.hidden = false;
  $('#previewMeta').textContent = meta || '';
}

async function createTask() {
  const btn = $('#createBtn');
  const errEl = $('#createError');
  errEl.textContent = '';
  const mode = state.sourceMode;
  if (mode === 'paste' && $('#articleText').value.trim().length < 50) {
    errEl.textContent = '请至少粘贴 50 字原文';
    return;
  }
  if (mode === 'upload' && !state.articlePath) {
    errEl.textContent = '请先上传原文文件';
    return;
  }
  if (mode === 'url' && !$('#articleUrl').value.trim()) {
    errEl.textContent = '请填写原文 URL';
    return;
  }
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const body = {
      date: inputToDate8($('#taskDate').value),
      title: $('#taskTitle').value.trim(),
      article_mode: mode,
      article_text: $('#articleText').value,
      article_url: $('#articleUrl').value.trim(),
      article_path: state.articlePath,
      voice: $('#voice').value,
      rate: $('#rate').value,
      concurrency: Number($('#concurrency').value) || 4,
      upload: $('#optUpload').checked,
      force: $('#optForce').checked,
      skip_llm: $('#optSkipLlm').checked,
    };
    const task = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    toast('任务已创建，开始执行');
    openDetail(task.id);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '创建并开始';
  }
}

/* ── 云端运行（GitHub Actions）──────────────────────────── */

function collectCloudPayload() {
  const mode = state.sourceMode;
  let article = '';
  if (mode === 'paste') {
    article = $('#articleText').value.trim();
  } else if (mode === 'url') {
    article = $('#articleUrl').value.trim();
  } else if (mode === 'upload') {
    // 云端模式：浏览器端读取的文本直接传入
    article = state.uploadedText || '';
  }
  return {
    date: inputToDate8($('#taskDate').value),
    article: article,
    video_title: $('#taskTitle').value.trim(),
    concurrency: String($('#concurrency').value || '4'),
    force: $('#optForce').checked,
    upload: $('#optUpload').checked,
    skip_llm: $('#optSkipLlm').checked,
  };
}

async function cloudRun() {
  const btn = $('#cloudRunBtn');
  const statusEl = $('#cloudRunStatus');
  btn.disabled = true;
  btn.textContent = '触发中…';
  statusEl.textContent = '';
  $('#cloudRunProgress').innerHTML = '';
  $('#cloudRunProgress').hidden = true;
  try {
    // 上传模式下提醒用户
    if (state.sourceMode === 'upload' && !state.uploadedText) {
      statusEl.textContent = '⚠️ 请先选择要上传的文章文件（支持 .md / .txt）。';
    }
    const payload = collectCloudPayload();
    state.cloudRunDate = payload.date;
    const r = await api('/api/github/dispatch', { method: 'POST', body: JSON.stringify(payload) });
    statusEl.textContent = `✅ ${r.message}，正在查询运行状态……`;
    toast('GitHub Actions 已触发');
    // 开始轮询运行进度
    startCloudRunPoll();
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '云端运行 (GitHub Actions)';
  }
}

function startCloudRunPoll() {
  stopCloudRunPoll();
  state.cloudRunTimer = setInterval(async () => {
    await refreshCloudRunProgress();
  }, 5000);
}

function stopCloudRunPoll() {
  if (state.cloudRunTimer) {
    clearInterval(state.cloudRunTimer);
    state.cloudRunTimer = null;
  }
}

async function refreshCloudRunProgress() {
  try {
    const r = await api('/api/github/run');
    if (!r.ok || !r.run) {
      if (state.cloudRunTimer) stopCloudRunPoll();
      return;
    }
    renderCloudRunProgress(r.run);
    const finished = ['completed'].includes(r.run.status);
    if (finished) {
      stopCloudRunPoll();
      if (r.run.conclusion === 'success') {
        $('#cloudRunStatus').textContent = '✅ 云端运行完成，产物已上传到 R2。';
        toast('云端运行完成');
        // 加载最新 R2 产物用于预览
        await loadCloudResult();
      } else {
        $('#cloudRunStatus').textContent = `❌ 云端运行结束（${r.run.conclusion}），请查看 GitHub 日志。`;
        toast(`云端运行${r.run.conclusion}`, true);
      }
    } else {
      $('#cloudRunStatus').textContent = `⏳ 运行中：${r.run.status}，正在执行步骤…`;
    }
  } catch (e) {
    // 静默失败，继续轮询
  }
}

function renderCloudRunProgress(run) {
  const box = $('#cloudRunProgress');
  box.hidden = false;

  const stepIcons = {
    completed: '✓',
    in_progress: '●',
    queued: '○',
    waiting: '○',
    not_started: '○',
  };
  const stepClass = {
    completed: 'step-done',
    in_progress: 'step-active',
    queued: 'step-pending',
    waiting: 'step-pending',
    not_started: 'step-pending',
  };

  const parts = [];
  // 头部：运行名 + 状态 + 日志链接
  const statusBadge = run.conclusion === 'success' ? 'badge-ok'
    : run.conclusion === 'failure' ? 'badge-err'
    : run.status === 'in_progress' ? 'badge-run' : 'badge-muted';
  parts.push(`<div class="cloud-run-head">
    <b>${escapeHtml(run.name || 'GitHub Actions')}</b>
    <span class="badge ${statusBadge}">${escapeHtml(run.status)}${run.conclusion ? ' · ' + run.conclusion : ''}</span>
    <a class="link" href="${escapeHtml(run.html_url)}" target="_blank" rel="noreferrer">查看日志 →</a>
  </div>`);

  // 步骤列表：分阶段展示
  if (run.steps && run.steps.length > 0) {
    const doneCount = run.steps.filter((s) => s.status === 'completed').length;
    const totalCount = run.steps.length;
    const pct = Math.round((doneCount / totalCount) * 100);
    parts.push(`<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>`);
    parts.push(`<div class="cloud-steps">`);
    for (const step of run.steps) {
      const icon = stepIcons[step.status] || '·';
      const cls = stepClass[step.status] || '';
      parts.push(`<div class="cloud-step ${cls}"><span class="step-icon">${icon}</span> <span class="step-name">${escapeHtml(step.name)}</span></div>`);
    }
    parts.push(`</div>`);
    parts.push(`<div class="cloud-progress-text">${doneCount}/${totalCount} 步骤完成 · ${pct}%</div>`);
  }

  box.innerHTML = parts.join('');
}

/** 云端运行成功后，加载最新 R2 产物用于预览、下载、上传B站 */
/** 从 R2 顶层运行目录中挑出与日期匹配的最新目录（无匹配则取最新） */
async function pickRunPrefix(date8) {
  const r = await api('/api/r2/files?prefix=ashare-tucao/');
  if (!r.ok) throw new Error(r.error || 'R2 列表读取失败');
  // 顶部列表带 Delimiter，运行目录在 folders 里而非 files
  const folders = (r.folders || [])
    .map((f) => String(f.key || '').replace(/\/+$/, ''))
    .filter((k) => k.startsWith('ashare-tucao/'));
  if (folders.length === 0) return null;
  const matching = date8 ? folders.filter((p) => p.startsWith(`ashare-tucao/${date8}_`)) : [];
  return (matching.sort().reverse()[0]) || folders.sort().reverse()[0];
}

async function loadCloudResult() {
  try {
    const latestPrefix = await pickRunPrefix('');
    if (!latestPrefix) {
      $('#cloudResultArea').hidden = true;
      return;
    }
    // 获取该前缀下的所有文件
    const detail = await api(`/api/r2/files?prefix=${encodeURIComponent(latestPrefix + '/')}`);
    if (!detail.ok || !detail.files) {
      $('#cloudResultArea').hidden = true;
      return;
    }
    const files = detail.files;
    const videoFile = files.find((f) => f.key.endsWith('video_final.mp4'));
    const coverFile = files.find((f) => f.key.endsWith('cover.png'));

    const box = $('#cloudResultArea');
    box.hidden = false;
    box.innerHTML = '';
    const parts = [];
    parts.push(`<h3 class="sub-title">云端运行产物</h3>`);
    parts.push(`<p class="hint">运行目录：${escapeHtml(latestPrefix)}</p>`);

    if (videoFile) {
      const videoUrl = `/api/r2/file?key=${encodeURIComponent(videoFile.key)}`;
      parts.push(`<video controls preload="metadata" src="${videoUrl}" class="cloud-video"></video>`);
      parts.push(`<div class="media-actions">
        <a class="btn btn-primary btn-sm" href="${videoUrl}" download>下载视频</a>
        <button class="btn btn-secondary btn-sm" id="cloudUploadBiliBtn">上传至 B站</button>
      </div>`);
    }
    if (coverFile) {
      const coverUrl = `/api/r2/file?key=${encodeURIComponent(coverFile.key)}`;
      parts.push(`<img src="${coverUrl}" alt="视频封面" class="cloud-cover" />`);
      parts.push(`<div class="media-actions"><a class="btn btn-ghost btn-sm" href="${coverUrl}" download>下载封面</a></div>`);
    }
    if (!videoFile && !coverFile) {
      parts.push('<p class="hint">未找到视频/封面产物，请检查 R2 存储桶。</p>');
    }

    box.innerHTML = parts.join('');

    // 绑定上传B站按钮
    const uploadBtn = $('#cloudUploadBiliBtn');
    if (uploadBtn) {
      uploadBtn.addEventListener('click', cloudUploadBili);
    }
  } catch (e) {
    console.error('加载云端结果失败:', e);
  }
}

async function cloudUploadBili() {
  const btn = $('#cloudUploadBiliBtn');
  if (btn) { btn.disabled = true; btn.textContent = '触发中…'; }
  try {
    const date = state.cloudRunDate || inputToDate8($('#taskDate').value);
    const r = await api('/api/bilibili/upload', {
      method: 'POST',
      body: JSON.stringify({ date }),
    });
    toast(r.message || 'B站上传任务已触发');
    // 开始轮询运行状态
    startCloudRunPoll();
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = '上传至 B站'; }
  }
}

/* ── 任务列表 ───────────────────────────────────────────── */

// 云端运行记录：把 GitHub Actions run 归一化为与本地任务同构的结构
function cloudStatus(run) {
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return 'success';
    if (run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out') return 'failed';
    return 'completed';
  }
  if (run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting') return 'running';
  return 'queued';
}

function cloudStatusLabel(run) {
  if (run.status === 'completed') return run.conclusion || '已完成';
  if (run.status === 'in_progress') return '运行中';
  if (run.status === 'queued') return '排队中';
  return run.status || '—';
}

function fmtDateTime(ts) {
  const p = bjParts(ts);
  if (!p) return ts || '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

async function loadCloudTasks(silent = false) {
  try {
    const r = await api('/api/github/runs');
    // 安全过滤：只保留视频生成工作流
    const GEN_WORKFLOW = '生成A股吐槽视频';
    state.tasks = (r.runs || [])
      .filter((run) => run.name === GEN_WORKFLOW)
      .map((run) => ({
      id: 'gh-' + run.id,
      cloud: true,
      run_id: run.id,
      title: run.name || 'GitHub Actions 运行',
      date8: (run.created_at || '').slice(0, 10).replaceAll('-', ''),
      status: cloudStatus(run),
      status_label: cloudStatusLabel(run),
      step: run.status === 'completed' ? (run.conclusion || '已完成') : run.status,
      created_at: fmtDateTime(run.created_at),
      html_url: run.html_url,
      progress: { current: 0, total: 0 },
    }));
    renderTasks();
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

async function loadTasks(silent = false) {
  try {
    state.tasks = await api('/api/tasks');
    renderTasks();
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

function renderTasks() {
  const list = $('#taskList');
  const empty = $('#taskEmpty');
  list.innerHTML = '';

  // 状态筛选
  const filter = state.taskFilter;
  const filtered = filter
    ? state.tasks.filter((t) => {
        if (filter === 'running') return t.status === 'running' || t.status === 'queued';
        return t.status === filter;
      })
    : state.tasks;

  empty.hidden = filtered.length > 0;
  for (const t of filtered) {
    const div = document.createElement('div');
    div.className = 'task-item';
    const prog = t.progress || {};
    const pct = prog.total ? Math.round((prog.current / prog.total) * 100) : (t.status === 'success' ? 100 : 0);
    const statusText = t.status_label || t.status;
    const isActive = t.status === 'running' || t.status === 'queued';
    const isFailed = t.status === 'failed';
    const isCloud = !!t.cloud;

    div.innerHTML = `
      <div class="task-item-header">
        <h3>${escapeHtml(t.title || '未命名任务')}</h3>
        <span class="status-badge ${badgeClass(t.status)}">${escapeHtml(statusText)}</span>
      </div>
      <div class="task-meta">
        ${isCloud ? `<span>🕐 ${escapeHtml(t.created_at || '')} · 北京时间</span>` : `<span>📅 ${fmtDate8(t.date8)}</span>`}
        ${t.step ? `<span>📍 ${escapeHtml(t.step)}</span>` : ''}
        ${t.created_at && !isCloud ? `<span>🕐 ${escapeHtml(fmtTime(t.created_at))}</span>` : ''}
        ${t.bvid ? `<span>BV：${escapeHtml(t.bvid)}</span>` : ''}
        ${t.error ? `<span class="meta-error">⚠ ${escapeHtml(t.error)}</span>` : ''}
      </div>
      <div class="task-progress">
        <div class="mini-progress-bar">
          <div class="mini-progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="progress-text">${pct}%</span>
      </div>
      <div class="task-actions">
        ${isCloud && t.html_url ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(t.html_url)}" target="_blank" rel="noreferrer" data-action="logs">查看日志</a>` : ''}
        ${isFailed ? '<button class="btn btn-secondary btn-sm" data-action="retry">重试</button>' : ''}
        ${isActive ? '<button class="btn btn-danger btn-sm" data-action="cancel">取消</button>' : ''}
        ${!isCloud ? '<button class="btn btn-ghost btn-sm" data-action="delete">删除</button>' : ''}
      </div>`;
    div.addEventListener('click', (ev) => {
      const action = ev.target.dataset.action;
      if (action === 'logs') { ev.stopPropagation(); return; }
      if (action === 'retry') { ev.stopPropagation(); retryTask(t.id); return; }
      if (action === 'cancel') { ev.stopPropagation(); cancelTask(t.id); return; }
      if (action === 'delete') { ev.stopPropagation(); deleteTask(t.id); return; }
      if (isCloud) openCloudDetail(t.run_id, t.date8); else openDetail(t.id);
    });
    list.appendChild(div);
  }
}

async function retryTask(id) {
  try {
    await api(`/api/tasks/${id}/retry`, { method: 'POST' });
    toast('任务已重新加入队列');
    loadTasks(true);
    if (state.taskId === id) refreshDetail();
  } catch (e) { toast(e.message, true); }
}

async function cancelTask(id) {
  if (!confirm('确定取消该任务？')) return;
  try {
    await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
    toast('任务已取消');
    loadTasks(true);
    if (state.taskId === id) refreshDetail();
  } catch (e) { toast(e.message, true); }
}

async function deleteTask(id) {
  if (!confirm('删除任务记录？（不会删除已生成的视频文件）')) return;
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    toast('已删除');
    loadTasks(true);
  } catch (e) { toast(e.message, true); }
}

/* ── 任务详情 ───────────────────────────────────────────── */

function openDetail(id) {
  state.taskId = id;
  state.cloudDetail = false;
  state.task = null;
  state.logOffset = 0;
  $('#logBox').textContent = '';
  $('#mediaArea').innerHTML = '<p class="hint">任务完成后可在此预览视频与封面。</p>';
  delete $('#mediaArea').dataset.rendered;
  $('#detailError').hidden = true;
  $('#biliResult').hidden = true;
  $('#detailLogsLink').hidden = true;
  $('#cloudSteps').innerHTML = '';
  $('#cloudSteps').hidden = true;
  $('#detailStep').textContent = '等待执行';
  $('#detailProgressText').textContent = '';
  $('#detailProgress').style.width = '0%';
  showView('detail');
  refreshDetail();
  startDetailPoll();
}

async function refreshDetail(silent = false) {
  if (!state.taskId) return;
  try {
    if (state.cloudDetail) {
      const r = await api(`/api/github/run?id=${encodeURIComponent(state.taskId)}`);
      if (!r.ok || !r.run) {
        if (!silent) toast(r.error || '查询运行失败', true);
        return;
      }
      renderCloudDetail(r.run);
      const finished = r.run.status === 'completed';
      if (finished) stopDetailPoll();
    } else {
      const t = await api(`/api/tasks/${state.taskId}`);
      state.task = t;
      renderDetail(t);
      await pullLogs();
      const finished = ['success', 'failed', 'skipped', 'cancelled'].includes(t.status);
      if (finished && t.upload_status !== 'uploading') {
        stopDetailPoll();
      }
    }
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

function renderDetail(t) {
  $('#detailTitle').textContent = t.title || '任务详情';
  const badge = $('#detailStatus');
  badge.className = `badge ${badgeClass(t.status)}`;
  badge.textContent = t.status_label || t.status;

  const prog = t.progress || {};
  const pct = prog.total ? Math.round((prog.current / prog.total) * 100) : (t.status === 'success' ? 100 : 0);
  $('#detailProgress').style.width = `${pct}%`;
  $('#detailStep').textContent = t.step || '等待执行';
  $('#detailProgressText').textContent = prog.total ? `${prog.current}/${prog.total} · ${pct}%` : `${pct}%`;

  const errEl = $('#detailError');
  if (t.error) { errEl.hidden = false; errEl.textContent = t.error; } else { errEl.hidden = true; }

  // 本地任务详情：隐藏云端专属元素
  $('#cloudSteps').hidden = true;
  $('#detailLogsLink').hidden = true;
  $('#cancelBtn').hidden = !(t.status === 'running' || t.status === 'queued');
  $('#uploadBtn').hidden = t.status !== 'success';
  $('#uploadBtn').disabled = t.upload_status === 'uploading';
  $('#uploadBtn').textContent = t.upload_status === 'uploading' ? '上传中…' : '上传B站';

  const bili = $('#biliResult');
  if (t.bvid || t.bili_url) {
    bili.hidden = false;
    bili.innerHTML = `已上传B站：${t.bili_url ? `<a href="${escapeHtml(t.bili_url)}" target="_blank" rel="noreferrer">${escapeHtml(t.bvid || t.bili_url)}</a>` : escapeHtml(t.bvid)}`;
  } else if (t.upload_status === 'uploading') {
    bili.hidden = false;
    bili.textContent = '正在上传B站，请查看日志……';
  } else if (t.upload_status === 'failed') {
    bili.hidden = false;
    bili.textContent = 'B站上传失败，请检查 Cookie 或查看日志。';
  } else {
    bili.hidden = true;
  }

  if (t.status === 'success' && !$('#mediaArea').dataset.rendered) {
    renderMedia(t);
    $('#mediaArea').dataset.rendered = '1';
  }
}

function renderMedia(t) {
  const area = $('#mediaArea');
  area.dataset.rendered = '1';
  const parts = [];
  if (t.video_url) {
    parts.push(`<video controls preload="metadata" src="${t.video_url}?t=${Date.now()}"></video>`);
    parts.push(`<div class="media-actions">
      <a class="btn btn-ghost btn-sm" href="${t.video_url}" download>下载视频</a>
      ${t.cover_url ? `<a class="btn btn-ghost btn-sm" href="${t.cover_url}" download>下载封面</a>` : ''}
    </div>`);
  }
  if (t.cover_url) {
    parts.push(`<img src="${t.cover_url}?t=${Date.now()}" alt="视频封面" />`);
  }
  if (!parts.length) {
    parts.push('<p class="hint">未找到视频产物，请查看日志。</p>');
  }
  area.innerHTML = parts.join('');
}

/* ── 云端运行详情 ───────────────────────────────────────── */

function openCloudDetail(runId, date8) {
  state.taskId = String(runId);
  state.cloudDetail = true;
  state.task = null;
  state.cloudRunDate = date8 || '';
  state.logOffset = 0;
  $('#logBox').textContent = '云端运行的完整日志请在 GitHub Actions 查看（点击右上角「查看日志 ↗」）。';
  $('#mediaArea').innerHTML = '<p class="hint">运行完成后可在此预览视频与封面。</p>';
  delete $('#mediaArea').dataset.rendered;
  $('#detailError').hidden = true;
  $('#biliResult').hidden = true;
  $('#detailLogsLink').hidden = true;
  $('#cloudSteps').innerHTML = '';
  $('#cloudSteps').hidden = true;
  $('#detailStep').textContent = '等待执行';
  $('#detailProgressText').textContent = '';
  $('#detailProgress').style.width = '0%';
  showView('detail');
  refreshDetail();
  startDetailPoll();
}

function renderCloudDetail(run) {
  $('#detailTitle').textContent = run.name || '云端运行详情';
  // 记录运行日期，供「上传B站」直接使用，避免再发一次慢查询
  const createdDate = (run.created_at || '').slice(0, 10).replaceAll('-', '');
  if (createdDate) state.cloudRunDate = createdDate;
  const badge = $('#detailStatus');
  const status = cloudStatus(run);
  badge.className = `badge ${badgeClass(status)}`;
  badge.textContent = cloudStatusLabel(run);

  // 步骤列表
  const stepsBox = $('#cloudSteps');
  const steps = run.steps || [];
  if (steps.length > 0) {
    // 跳过的步骤不计入进度分母
    const runnable = steps.filter((s) => s.conclusion !== 'skipped');
    const totalCount = runnable.length || steps.length;
    const doneCount = runnable.filter((s) => s.status === 'completed' && s.conclusion !== 'skipped').length;
    const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
    $('#detailProgress').style.width = `${pct}%`;
    $('#detailStep').textContent = `${doneCount}/${totalCount} 步骤完成`;
    $('#detailProgressText').textContent = `${doneCount}/${totalCount} · ${pct}%`;

    const stepDisplay = (step) => {
      if (step.conclusion === 'skipped') return { icon: '–', cls: 'step-skipped' };
      if (step.conclusion === 'failure' || step.conclusion === 'timed_out') return { icon: '✗', cls: 'step-fail' };
      if (step.conclusion === 'cancelled') return { icon: '⊘', cls: 'step-skipped' };
      if (step.status === 'completed') return { icon: '✓', cls: 'step-done' };
      if (step.status === 'in_progress') return { icon: '●', cls: 'step-active' };
      return { icon: '○', cls: 'step-pending' };
    };
    const parts = [];
    for (const step of steps) {
      const { icon, cls } = stepDisplay(step);
      parts.push(`<div class="cloud-step ${cls}"><span class="step-icon">${icon}</span> <span class="step-name">${escapeHtml(step.name)}</span></div>`);
    }
    stepsBox.innerHTML = parts.join('');
    stepsBox.hidden = false;
  } else {
    stepsBox.hidden = true;
    const pct = run.status === 'completed' ? (run.conclusion === 'success' ? 100 : 0) : 0;
    $('#detailProgress').style.width = `${pct}%`;
    $('#detailStep').textContent = run.status === 'completed' ? (run.conclusion || '已完成') : run.status;
    $('#detailProgressText').textContent = '';
  }

  // 日志链接
  const logsLink = $('#detailLogsLink');
  if (run.html_url) {
    logsLink.hidden = false;
    logsLink.href = run.html_url;
  } else {
    logsLink.hidden = true;
  }

  // 错误
  const errEl = $('#detailError');
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'cancelled') {
    errEl.hidden = false;
    errEl.textContent = `运行结束（${run.conclusion}），请查看 GitHub 日志了解详情。`;
  } else {
    errEl.hidden = true;
  }

  // 云端模式无取消按钮
  $('#cancelBtn').hidden = true;

  // 上传B站按钮：仅成功时显示
  $('#uploadBtn').hidden = !(run.status === 'completed' && run.conclusion === 'success');
  $('#uploadBtn').disabled = state.cloudUploading;
  $('#uploadBtn').textContent = state.cloudUploading ? '触发中…' : '上传B站';

  // B站结果区隐藏（云端在媒体区展示）
  $('#biliResult').hidden = true;

  // 成功后加载产物
  if (run.status === 'completed' && run.conclusion === 'success' && !$('#mediaArea').dataset.rendered) {
    renderCloudMedia(run);
    $('#mediaArea').dataset.rendered = '1';
  }
}

/** 从 R2 加载指定运行的产物用于预览、下载 */
async function renderCloudMedia(run) {
  const area = $('#mediaArea');
  area.innerHTML = '<p class="hint">正在加载云端产物……</p>';
  try {
    // 从 run.created_at 提取日期，匹配 R2 中的运行目录
    const createdAt = run.created_at || '';
    const date8 = createdAt.slice(0, 10).replaceAll('-', ''); // YYYYMMDD
    const latestPrefix = await pickRunPrefix(date8);
    if (!latestPrefix) {
      area.innerHTML = '<p class="hint">R2 中未找到产物文件。</p>';
      return;
    }

    const detail = await api(`/api/r2/files?prefix=${encodeURIComponent(latestPrefix + '/')}`);
    if (!detail.ok || !detail.files) {
      area.innerHTML = `<p class="hint">未找到运行目录 ${escapeHtml(latestPrefix)} 下的产物。</p>`;
      return;
    }
    const files = detail.files;
    const videoFile = files.find((f) => f.key.endsWith('video_final.mp4'));
    const coverFile = files.find((f) => f.key.endsWith('cover.png'));

    const parts = [];
    if (videoFile) {
      const videoUrl = `/api/r2/file?key=${encodeURIComponent(videoFile.key)}`;
      parts.push(`<video controls preload="metadata" src="${videoUrl}"></video>`);
      parts.push(`<div class="media-actions">
        <a class="btn btn-ghost btn-sm" href="${videoUrl}" download>下载视频</a>
      </div>`);
    }
    if (coverFile) {
      const coverUrl = `/api/r2/file?key=${encodeURIComponent(coverFile.key)}`;
      parts.push(`<img src="${coverUrl}" alt="视频封面" />`);
      parts.push(`<div class="media-actions"><a class="btn btn-ghost btn-sm" href="${coverUrl}" download>下载封面</a></div>`);
    }
    if (!videoFile && !coverFile) {
      parts.push('<p class="hint">未找到视频/封面产物。</p>');
    }
    area.innerHTML = parts.join('');
  } catch (e) {
    area.innerHTML = `<p class="hint error-text">加载产物失败：${escapeHtml(e.message)}</p>`;
  }
}

/** 从云端运行详情触发 B站上传（upload_only 模式） */
async function cloudUploadBiliFromDetail() {
  const btn = $('#uploadBtn');
  if (!state.taskId) return;
  const date8 = state.cloudRunDate || '';
  if (!date8) {
    toast('未获取到运行日期，无法上传，请刷新后重试', true);
    return;
  }
  btn.disabled = true;
  btn.textContent = '触发中…';
  state.cloudUploading = true;
  try {
    const resp = await api('/api/bilibili/upload', {
      method: 'POST',
      body: JSON.stringify({ date: date8 }),
    });
    toast(resp.message || 'B站上传任务已触发');
    state.cloudUploading = false;
    btn.disabled = false;
    btn.textContent = '上传B站';
    // 跳回运行记录，直接看到新触发的上传工作流
    showView('tasks');
    loadCloudTasks(true);
    setTimeout(() => { if (state.view === 'tasks') loadCloudTasks(true); }, 3000);
  } catch (e) {
    toast(e.message, true);
    state.cloudUploading = false;
    btn.disabled = false;
    btn.textContent = '上传B站';
  }
}

async function pullLogs() {
  if (!state.taskId) return;
  try {
    const r = await api(`/api/tasks/${state.taskId}/logs?offset=${state.logOffset}`);
    if (r.content) {
      const box = $('#logBox');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      box.textContent += r.content;
      if (nearBottom) box.scrollTop = box.scrollHeight;
    }
    state.logOffset = r.next || state.logOffset;
  } catch (_) { /* 忽略日志读取错误 */ }
}

async function manualUpload() {
  if (!state.taskId) return;
  try {
    await api(`/api/tasks/${state.taskId}/upload`, { method: 'POST' });
    toast('已开始上传B站，请查看日志');
    state.logOffset = 0;
    $('#logBox').textContent = '';
    refreshDetail();
    startDetailPoll();
  } catch (e) { toast(e.message, true); }
}

/* ── 设置 ───────────────────────────────────────────────── */

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('#llmBaseUrl').value = s.llm.base_url || '';
    $('#llmModel').value = s.llm.model || '';
    $('#llmKeyState').textContent = s.llm.has_key ? `（当前：${s.llm.key_masked}）` : '（未配置）';
    $('#llmKey').value = '';
    if (!state.cloudMode) {
      $('#biliCookies').value = s.bilibili.cookies || '';
      $('#biliHeadless').checked = !!s.bilibili.headless;
    }
    if (s.render && s.render.concurrency) $('#concurrency').value = s.render.concurrency;
  } catch (e) { toast(e.message, true); }
}

async function saveSettings() {
  const btn = $('#saveSettingsBtn');
  btn.disabled = true;
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        llm: {
          base_url: $('#llmBaseUrl').value.trim(),
          model: $('#llmModel').value.trim(),
          api_key: $('#llmKey').value.trim(),
        },
        bilibili: {
          cookies: $('#biliCookies').value,
          headless: $('#biliHeadless').checked,
        },
        render: { concurrency: Number($('#concurrency').value) || 4 },
      }),
    });
    $('#settingsResult').textContent = '已保存';
    $('#llmKey').value = '';
    toast('设置已保存');
    await loadSettings();
    await loadHealth(true);
  } catch (e) {
    $('#settingsResult').textContent = e.message;
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function testLlm() {
  const el = $('#llmTestResult');
  el.textContent = '测试中…';
  try {
    const r = await api('/api/settings/test-llm', { method: 'POST' });
    el.textContent = `连接正常：${r.reply || 'OK'}`;
  } catch (e) {
    el.textContent = `失败：${e.message}`;
  }
}

/* ── GitHub Actions 与 R2 配置 ─────────────────────────── */

async function loadGithubConfig() {
  try {
    const s = await api('/api/settings');
    const gh = s.github || {};
    const r2 = s.r2 || {};
    $('#ghOwner').value = gh.owner || '';
    $('#ghRepo').value = gh.repo || '';
    $('#ghPat').value = '';
    $('#ghPatState').textContent = gh.has_pat ? '（已配置）' : '（未配置）';
    $('#r2Bucket').value = r2.bucket || '';
    $('#r2Endpoint').value = r2.endpoint || '';
    $('#r2AccessKey').value = '';
    $('#r2SecretKey').value = '';
    $('#r2PublicUrl').value = r2.public_url || '';
  } catch (e) { toast(e.message, true); }
}

async function saveGithubConfig() {
  const btn = $('#saveGithubBtn');
  btn.disabled = true;
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        github: {
          owner: $('#ghOwner').value.trim(),
          repo: $('#ghRepo').value.trim(),
          pat: $('#ghPat').value.trim(),
        },
        r2: {
          bucket: $('#r2Bucket').value.trim(),
          endpoint: $('#r2Endpoint').value.trim(),
          access_key_id: $('#r2AccessKey').value.trim(),
          secret_access_key: $('#r2SecretKey').value.trim(),
          public_url: $('#r2PublicUrl').value.trim(),
        },
      }),
    });
    $('#githubResult').textContent = '✅ 云端配置已保存';
    toast('云端配置已保存');
    await loadGithubConfig();
  } catch (e) {
    $('#githubResult').textContent = `❌ ${e.message}`;
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function listR2Files() {
  const btn = $('#r2ListBtn');
  const listEl = $('#r2FileList');
  btn.disabled = true;
  btn.textContent = '加载中…';
  listEl.hidden = true;
  try {
    const r = await api('/api/r2/list');
    if (!r.ok) {
      listEl.innerHTML = `<p class="error-text">${escapeHtml(r.error || 'R2 未配置')}</p>`;
      listEl.hidden = false;
      return;
    }
    if (!r.runs || r.runs.length === 0) {
      listEl.innerHTML = '<p class="hint">暂无云端运行产物。触发一次云端运行后，产物会自动上传到这里。</p>';
      listEl.hidden = false;
      return;
    }
    const parts = ['<div class="r2-runs">'];
    for (const run of r.runs) {
      parts.push(`<div class="r2-run">`);
      parts.push(`<div class="r2-run-head"><b>运行 ${escapeHtml(run.prefix)}</b><span class="hint">${run.count} 个文件</span></div>`);
      parts.push('<ul class="r2-files">');
      for (const f of run.files) {
        const size = f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : `${(f.size / 1024).toFixed(1)} KB`;
        const fileUrl = `/api/r2/file?key=${encodeURIComponent(f.key)}`;
        const isVideo = f.key.endsWith('.mp4');
        const isImg = f.key.endsWith('.png') || f.key.endsWith('.jpg');
        let action = `<a class="btn btn-ghost btn-sm" href="${fileUrl}" download>下载</a>`;
        if (isVideo) {
          action += ` <a class="btn btn-primary btn-sm" href="${fileUrl}" target="_blank" rel="noreferrer">播放</a>`;
        } else if (isImg) {
          action += ` <a class="btn btn-primary btn-sm" href="${fileUrl}" target="_blank" rel="noreferrer">预览</a>`;
        }
        parts.push(`<li><span class="r2-filename">${escapeHtml(f.key)}</span><span class="r2-size">${size}</span>${action}</li>`);
      }
      parts.push('</ul></div>');
    }
    parts.push('</div>');
    listEl.innerHTML = parts.join('');
    listEl.hidden = false;
  } catch (e) {
    listEl.innerHTML = `<p class="error-text">${escapeHtml(e.message)}</p>`;
    listEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '查看 R2 产物';
  }
}

/* ── 文件管理（R2 文件浏览器）─────────────────────────── */

function formatFileSize(size) {
  if (!size) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function getFileIcon(file) {
  if (file.type === 'directory') return '📁';
  const name = file.name.toLowerCase();
  if (name.endsWith('.mp4')) return '🎬';
  if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.gif')) return '🖼';
  if (name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.json')) return '📄';
  if (name.endsWith('.mp3') || name.endsWith('.wav')) return '🎵';
  return '📄';
}

async function loadFiles(silent = false) {
  const errEl = $('#fileError');
  errEl.hidden = true;
  try {
    const prefix = state.filePrefix || '';
    const url = `/api/r2/files?prefix=${encodeURIComponent(prefix)}`;
    const r = await api(url);
    if (!r.ok) {
      errEl.hidden = false;
      errEl.textContent = r.error || 'R2 未配置';
      $('#fileTableBody').innerHTML = '';
      $('#fileEmpty').hidden = true;
      return;
    }
    state.fileItems = [
      ...r.folders.map((f) => ({ ...f, type: 'directory' })),
      ...r.files.map((f) => ({ ...f, type: 'file' })),
    ];
    // 排序：文件夹在前，文件在后
    state.fileItems.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    renderFiles();
    renderBreadcrumb();
  } catch (e) {
    if (!silent) toast(e.message, true);
  }
}

function renderBreadcrumb() {
  const bc = $('#fileBreadcrumb');
  const parts = [`<button class="crumb" data-path="">根目录</button>`];
  const segments = state.filePrefix ? state.filePrefix.replace(/\/$/, '').split('/') : [];
  let acc = '';
  for (const seg of segments) {
    acc += `${seg}/`;
    parts.push(`<span class="crumb-sep">/</span>`);
    parts.push(`<button class="crumb" data-path="${escapeHtml(acc)}">${escapeHtml(seg)}</button>`);
  }
  bc.innerHTML = parts.join('');
  bc.querySelectorAll('.crumb').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filePrefix = btn.dataset.path;
      state.selectedFiles.clear();
      updateDeleteBtn();
      loadFiles(true);
    });
  });
}

function renderFiles() {
  const body = $('#fileTableBody');
  const empty = $('#fileEmpty');
  body.innerHTML = '';
  empty.hidden = state.fileItems.length > 0;

  for (const item of state.fileItems) {
    const tr = document.createElement('tr');
    const isDir = item.type === 'directory';
    const checked = state.selectedFiles.has(item.key) ? 'checked' : '';
    const mtime = item.lastModified ? fmtTime(item.lastModified) : '—';
    const sizeText = isDir ? '—' : formatFileSize(item.size);

    tr.innerHTML = `
      <td><input type="checkbox" class="file-check" data-key="${escapeHtml(item.key)}" ${checked} /></td>
      <td class="file-name-cell">
        <span class="file-icon">${getFileIcon(item)}</span>
        <button class="file-name-btn ${isDir ? 'dir-btn' : ''}" data-action="${isDir ? 'open' : 'preview'}" data-key="${escapeHtml(item.key)}">${escapeHtml(item.name)}</button>
      </td>
      <td class="muted">${sizeText}</td>
      <td class="muted">${mtime}</td>
      <td>
        ${isDir ? `<button class="btn btn-ghost btn-sm" data-action="open" data-key="${escapeHtml(item.key)}">打开</button>` : ''}
        ${!isDir ? `<button class="btn btn-ghost btn-sm" data-action="preview" data-key="${escapeHtml(item.key)}">预览</button>` : ''}
        ${!isDir ? `<a class="btn btn-ghost btn-sm" href="/api/r2/download?key=${encodeURIComponent(item.key)}" download>下载</a>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete" data-key="${escapeHtml(item.key)}" data-isdir="${isDir}">删除</button>
      </td>`;

    // 绑定事件
    tr.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const action = btn.dataset.action;
        const key = btn.dataset.key;
        const isDir = btn.dataset.isdir === 'true';
        if (action === 'open') {
          state.filePrefix = key.endsWith('/') ? key : `${key}/`;
          state.selectedFiles.clear();
          updateDeleteBtn();
          loadFiles(true);
        } else if (action === 'preview') {
          previewFile(key);
        } else if (action === 'delete') {
          deleteFile(key, isDir);
        }
      });
    });

    tr.querySelector('.file-check')?.addEventListener('change', (ev) => {
      const key = ev.target.dataset.key;
      if (ev.target.checked) {
        state.selectedFiles.add(key);
      } else {
        state.selectedFiles.delete(key);
      }
      updateDeleteBtn();
    });

    body.appendChild(tr);
  }
}

function updateDeleteBtn() {
  const btn = $('#deleteSelectedBtn');
  const count = state.selectedFiles.size;
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `🗑 删除选中 (${count})` : '🗑 删除选中';
}

async function loadR2Stats() {
  try {
    const r = await api('/api/r2/stats');
    if (r.ok) {
      $('#r2Stats').textContent = `${r.totalFiles} 个文件 · ${r.totalSizeMB} MB`;
    } else {
      $('#r2Stats').textContent = '';
    }
  } catch (_) { /* ignore */ }
}

async function deleteFile(key, isDir) {
  const label = isDir ? '文件夹及其所有内容' : '文件';
  if (!confirm(`确定删除${label}：${key}？`)) return;
  try {
    await api('/api/r2/delete', {
      method: 'POST',
      body: JSON.stringify({ key, is_directory: isDir }),
    });
    toast('已删除');
    state.selectedFiles.delete(key);
    updateDeleteBtn();
    loadFiles(true);
    loadR2Stats();
  } catch (e) { toast(e.message, true); }
}

async function batchDeleteSelected() {
  const keys = Array.from(state.selectedFiles);
  if (keys.length === 0) return;
  if (!confirm(`确定删除选中的 ${keys.length} 个项目？`)) return;
  try {
    const r = await api('/api/r2/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ keys }),
    });
    toast(`已删除 ${r.deleted} 个项目`);
    state.selectedFiles.clear();
    updateDeleteBtn();
    loadFiles(true);
    loadR2Stats();
  } catch (e) { toast(e.message, true); }
}

async function createFolder() {
  const name = await prompt('请输入文件夹名称：');
  if (!name) return;
  const folderName = name.trim().replace(/[/\\]/g, '');
  if (!folderName) return;
  const key = state.filePrefix ? `${state.filePrefix.replace(/\/$/, '')}/${folderName}/` : `${folderName}/`;
  try {
    await api('/api/r2/create-folder', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    toast('文件夹已创建');
    loadFiles(true);
  } catch (e) { toast(e.message, true); }
}

async function uploadFilesToR2() {
  const input = $('#fileUploadInput');
  const files = input.files;
  if (!files || files.length === 0) return;
  for (const file of files) {
    const base64 = await fileToBase64(file);
    const contentType = file.type || 'application/octet-stream';
    try {
      await api('/api/r2/upload', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          content: base64,
          contentType,
          prefix: state.filePrefix || '',
        }),
      });
      toast(`已上传：${file.name}`);
    } catch (e) {
      toast(`上传失败：${file.name} - ${e.message}`, true);
    }
  }
  input.value = '';
  loadFiles(true);
  loadR2Stats();
}

function previewFile(key) {
  const item = state.fileItems.find((f) => f.key === key);
  if (!item) return;
  const modal = $('#previewModal');
  const title = $('#previewTitle');
  const body = $('#previewBody');
  title.textContent = item.name;
  body.innerHTML = '';
  modal.hidden = false;

  const name = key.toLowerCase();
  const fileUrl = `/api/r2/file?key=${encodeURIComponent(key)}`;

  if (name.endsWith('.mp4')) {
    body.innerHTML = `<video controls autoplay preload="metadata" src="${fileUrl}" style="max-width:100%;max-height:70vh"></video>`;
  } else if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.gif')) {
    body.innerHTML = `<img src="${fileUrl}" alt="预览" style="max-width:100%;max-height:70vh;display:block;margin:0 auto" />`;
  } else if (name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.json')) {
    body.innerHTML = `<pre class="preview-box" style="max-height:70vh;overflow:auto">正在加载…</pre>`;
    fetch(fileUrl)
      .then((r) => r.text())
      .then((text) => {
        const pre = body.querySelector('pre');
        if (pre) pre.textContent = text || '（空文件）';
      })
      .catch(() => {
        const pre = body.querySelector('pre');
        if (pre) pre.textContent = '加载失败';
      });
  } else {
    body.innerHTML = `<p class="hint">该文件类型不支持预览，请下载查看。</p>
      <a class="btn btn-primary btn-sm" href="/api/r2/download?key=${encodeURIComponent(key)}" download>下载</a>`;
  }
}

function closePreview() {
  $('#previewModal').hidden = true;
}

let biliPollTimer = null;

function setBiliStatus(text, kind) {
  const el = $('#biliLoginStatus');
  el.textContent = text || '';
  el.dataset.kind = kind || '';
}

function startBiliPolling() {
  if (biliPollTimer) return;
  biliPollTimer = setInterval(() => refreshBiliLoginStatus(true), 2000);
}

function stopBiliPolling() {
  if (biliPollTimer) {
    clearInterval(biliPollTimer);
    biliPollTimer = null;
  }
}

async function refreshBiliLoginStatus(silent) {
  if (state.cloudMode) return; // 云端模式无 B站登录功能
  try {
    const s = await api('/api/bilibili/login/status');
    if (s.running) {
      setBiliStatus(s.message || '等待扫码…', 'running');
      startBiliPolling();
    } else if (s.state === 'ok') {
      stopBiliPolling();
      setBiliStatus(s.message || '登录成功', 'ok');
      await loadSettings();
    } else if (s.state === 'failed') {
      stopBiliPolling();
      setBiliStatus(s.message || '登录失败', 'error');
    } else if (!silent) {
      setBiliStatus('', '');
    }
  } catch (e) {
    if (!silent) setBiliStatus(e.message, 'error');
  }
}

async function biliLogin() {
  const btn = $('#biliLoginBtn');
  btn.disabled = true;
  try {
    await api('/api/bilibili/login', { method: 'POST' });
    setBiliStatus('浏览器已启动，请用 B站 App 扫码…', 'running');
    startBiliPolling();
    toast('已打开浏览器，请扫码登录');
  } catch (e) {
    setBiliStatus(e.message, 'error');
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function biliCheck() {
  setBiliStatus('检测中…', 'running');
  try {
    const r = await api('/api/bilibili/check', { method: 'POST' });
    setBiliStatus(r.message || 'Cookie 有效', 'ok');
  } catch (e) {
    setBiliStatus(e.message, 'error');
  }
}

/* ── 启动 ───────────────────────────────────────────────── */

async function init() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
  $('#refreshStatusBtn').addEventListener('click', async () => {
    await loadHealth(true);
    await checkTrading(inputToDate8($('#taskDate').value) || (state.health && state.health.date8));
  });
  $('#refreshTasksBtn').addEventListener('click', () => loadTasks());
  $$('#taskFilters .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('#taskFilters .filter-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.taskFilter = tab.dataset.filter;
      renderTasks();
    });
  });
  $('#backBtn').addEventListener('click', () => showView('tasks'));
  $('#cancelBtn').addEventListener('click', () => state.taskId && cancelTask(state.taskId));
  $('#uploadBtn').addEventListener('click', () => {
    if (state.cloudDetail) cloudUploadBiliFromDetail();
    else manualUpload();
  });
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#testLlmBtn').addEventListener('click', testLlm);
  $('#biliLoginBtn').addEventListener('click', biliLogin);
  $('#biliCheckBtn').addEventListener('click', biliCheck);
  $('#cloudRunBtn').addEventListener('click', cloudRun);
  $('#saveGithubBtn').addEventListener('click', saveGithubConfig);
  $('#r2ListBtn').addEventListener('click', listR2Files);

  // 文件管理事件
  $('#refreshFilesBtn').addEventListener('click', () => { loadFiles(); loadR2Stats(); });
  $('#newFolderBtn').addEventListener('click', createFolder);
  $('#uploadFileBtn').addEventListener('click', () => $('#fileUploadInput').click());
  $('#fileUploadInput').addEventListener('change', uploadFilesToR2);
  $('#deleteSelectedBtn').addEventListener('click', batchDeleteSelected);
  $('#fileCheckAll').addEventListener('change', (e) => {
    const checked = e.target.checked;
    if (checked) {
      state.fileItems.forEach((item) => {
        if (item.type === 'file') state.selectedFiles.add(item.key);
      });
    } else {
      state.selectedFiles.clear();
    }
    renderFiles();
    updateDeleteBtn();
  });
  $('#closePreviewBtn').addEventListener('click', closePreview);
  $('#previewModal').addEventListener('click', (e) => {
    if (e.target === $('#previewModal')) closePreview();
  });

  await loadHealth();
  setupCreate();
  const d = state.health ? state.health.date8 : inputToDate8($('#taskDate').value);
  $('#taskDate').value = date8ToInput(d);
  $('#defaultArticleUrl').textContent = articleUrlFor(d);
  $('#defaultArticleUrl').href = articleUrlFor(d);
  await loadSettings();
  await refreshBiliLoginStatus(true);
  if (!state.cloudMode) {
    await loadTasks(true);
  }
  if (state.health && state.health.trading_day !== undefined) {
    setTradingBadge(state.health.trading_day, state.health.trading_reason);
  }
}

init();
