/* A股盘面吐槽大会 · 前端逻辑（原生 JS，无构建） */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  health: null,
  tasks: [],
  taskId: null,
  task: null,
  logOffset: 0,
  sourceMode: 'auto',
  articlePath: null,
  articleChars: 0,
  logTimer: null,
  listTimer: null,
  detailTimer: null,
  view: 'create',
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
  if (!ts) return '';
  return ts.replace('T', ' ').slice(5, 16);
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
  if (name === 'tasks') { loadTasks(); startListPoll(); }
  else stopListPoll();
  if (name !== 'detail') { stopDetailPoll(); }
}

function startListPoll() {
  stopListPoll();
  state.listTimer = setInterval(() => { if (state.view === 'tasks') loadTasks(true); }, 5000);
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

async function loadHealth(force = false) {
  try {
    const h = await api('/api/health');
    state.health = h;
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

/* ── 任务列表 ───────────────────────────────────────────── */

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
  empty.hidden = state.tasks.length > 0;
  for (const t of state.tasks) {
    const div = document.createElement('div');
    div.className = 'task-item';
    const prog = t.progress || {};
    const pct = prog.total ? Math.round((prog.current / prog.total) * 100) : (t.status === 'success' ? 100 : 0);
    div.innerHTML = `
      <div>
        <h3>${escapeHtml(t.title)}</h3>
        <div class="task-meta">
          <span>${fmtDate8(t.date8)}</span>
          <span>${escapeHtml(t.status_label || t.status)}</span>
          <span>${escapeHtml(t.step || '')}</span>
          <span>${escapeHtml(fmtTime(t.created_at))}</span>
          ${t.bvid ? `<span>BV：${escapeHtml(t.bvid)}</span>` : ''}
        </div>
        <div class="progress" style="margin-top:10px">
          <div class="progress-bar" style="width:${pct}%"></div>
        </div>
      </div>
      <div class="task-actions">
        <span class="badge ${badgeClass(t.status)}">${escapeHtml(t.status_label || t.status)}</span>
        <button class="btn btn-ghost btn-sm" data-action="open">查看</button>
        ${t.status === 'running' || t.status === 'queued'
          ? '<button class="btn btn-danger btn-sm" data-action="cancel">取消</button>' : ''}
        ${t.status !== 'running' && t.status !== 'queued'
          ? '<button class="btn btn-ghost btn-sm" data-action="delete">删除</button>' : ''}
      </div>`;
    div.addEventListener('click', (ev) => {
      const action = ev.target.dataset.action;
      if (action === 'cancel') { ev.stopPropagation(); cancelTask(t.id); return; }
      if (action === 'delete') { ev.stopPropagation(); deleteTask(t.id); return; }
      openDetail(t.id);
    });
    list.appendChild(div);
  }
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
  state.task = null;
  state.logOffset = 0;
  $('#logBox').textContent = '';
  $('#mediaArea').innerHTML = '<p class="hint">任务完成后可在此预览视频与封面。</p>';
  delete $('#mediaArea').dataset.rendered;
  $('#detailError').hidden = true;
  $('#biliResult').hidden = true;
  showView('detail');
  refreshDetail();
  startDetailPoll();
}

async function refreshDetail(silent = false) {
  if (!state.taskId) return;
  try {
    const t = await api(`/api/tasks/${state.taskId}`);
    state.task = t;
    renderDetail(t);
    await pullLogs();
    const finished = ['success', 'failed', 'skipped', 'cancelled'].includes(t.status);
    if (finished && t.upload_status !== 'uploading') {
      stopDetailPoll();
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
    $('#biliCookies').value = s.bilibili.cookies || '';
    $('#biliHeadless').checked = !!s.bilibili.headless;
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

/* ── B站 扫码登录 ───────────────────────────────────────── */

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
  $('#backBtn').addEventListener('click', () => showView('tasks'));
  $('#cancelBtn').addEventListener('click', () => state.taskId && cancelTask(state.taskId));
  $('#uploadBtn').addEventListener('click', manualUpload);
  $('#saveSettingsBtn').addEventListener('click', saveSettings);
  $('#testLlmBtn').addEventListener('click', testLlm);
  $('#biliLoginBtn').addEventListener('click', biliLogin);
  $('#biliCheckBtn').addEventListener('click', biliCheck);

  await loadHealth();
  setupCreate();
  const d = state.health ? state.health.date8 : inputToDate8($('#taskDate').value);
  $('#taskDate').value = date8ToInput(d);
  $('#defaultArticleUrl').textContent = articleUrlFor(d);
  $('#defaultArticleUrl').href = articleUrlFor(d);
  await loadSettings();
  await refreshBiliLoginStatus(true);
  await loadTasks(true);
  if (state.health && state.health.trading_day !== undefined) {
    setTradingBadge(state.health.trading_day, state.health.trading_reason);
  }
}

init();
