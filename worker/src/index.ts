/**
 * A股盘面吐槽大会 · Cloudflare Worker
 *
 * 功能：
 * - 前端静态资源托管（[assets] 绑定 web/static）
 * - 交易日检测（东方财富财经早餐存在性，移植自 scripts/trading_day.py）
 * - GitHub Actions 云端运行触发（repository_dispatch）
 * - Cloudflare R2 存储桶代理（列举、下载、Range 支持）
 * - 云端设置读取（GitHub/R2/LLM 状态）
 *
 * 敏感信息通过 `wrangler secret put` 管理：
 * - GITHUB_PAT
 * - AGNES_API_KEY
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { prettyJSON } from 'hono/pretty-json';

// ─── 类型定义 ─────────────────────────────────────────────

interface Bindings {
  R2: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  GITHUB_REPO_OWNER: string;
  GITHUB_REPO_NAME: string;
  R2_PUBLIC_URL: string;
  R2_BUCKET_NAME: string;
  GITHUB_PAT?: string;
  AGNES_API_KEY?: string;
}

// ─── 工具函数 ─────────────────────────────────────────────

/** 当前日期的 date8 格式（YYYYMMDD） */
function todayDate8(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 从 date8 字符串解析 Date 对象 */
function parseDate8(v: string): Date {
  const s = (v || todayDate8()).replace(/-/g, '');
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

/** date8 → 中文日期 "M月D日" */
function cnDateFrom8(v: string): string {
  const d = parseDate8(v);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 拼接默认文章 URL */
function defaultArticleUrl(date8: string): string {
  const base = 'https://ashare.ldragon.xyz/summary_today/';
  return base + `${date8}_summary_today.docx`;
}

/** date8 → HTML date input 格式 */
function date8ToInput(d: string): string {
  if (!d) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

/**
 * 交易日判定：复用东方财富财经早餐存在性逻辑。
 * 周末直接判非交易日；工作日查东方财富新闻接口。
 * 返回 { status, reason }，status 为 true/false/null（null=接口异常）
 */
async function checkTradingDay(date8: string): Promise<{ status: boolean | null; reason: string }> {
  const dt = parseDate8(date8);
  // 周末直接判定
  if (dt.getDay() === 0 || dt.getDay() === 6) {
    return { status: false, reason: `${dt.getMonth() + 1}月${dt.getDate()}日是周末，非交易日` };
  }

  const cn = `${dt.getMonth() + 1}月${dt.getDate()}日`;
  const target = `东方财富财经早餐 ${cn}`;

  const API =
    'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns' +
    '?client=web&biz=web_news_col&column=1207&order=1&needInteractData=0' +
    '&page_index={page_index}&page_size={page_size}&req_trace={trace}&' +
    'fields=code,showTime,title,mediaName,summary,image,url,uniqueUrl,Np_dst' +
    '&types=1,20&callback=_emcb';

  const PAGE_SIZE = 150;
  const MAX_PAGES = 3;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = API
      .replace('{page_index}', String(page))
      .replace('{page_size}', String(PAGE_SIZE))
      .replace('{trace}', Math.random().toString(36).slice(2));

    let items: any[] | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Referer': 'https://stock.eastmoney.com/a/czpnc.html',
          },
        });
        const text = await resp.text();
        let t = text.trim();
        if (t.startsWith('_emcb(')) t = t.slice(6);
        if (t.endsWith(');')) t = t.slice(0, -2);
        else if (t.endsWith(')')) t = t.slice(0, -1);
        const data = JSON.parse(t);
        items = (data?.data?.list) || [];
        break;
      } catch (e) {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!items) continue;

    // 查找目标标题
    const found = items.find((it: any) => (it?.title || '').includes(target));
    if (found) {
      return { status: true, reason: `命中「${found.title}」，判定为交易日` };
    }
    if (items.length < PAGE_SIZE) break;
  }

  return { status: false, reason: `未命中「东方财富财经早餐 ${cn}」，判定为非交易日` };
}

// ─── Hono App ──────────────────────────────────────────────

const app = new Hono<{ Bindings: Bindings }>();

// CORS
app.use('*', cors({
  origin: (origin) => {
    // 允许所有来源（前端与 Worker 同源，但方便调试）
    return origin || '*';
  },
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Range'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
}));
app.use('*', prettyJSON());

// ─── 健康检查 / 交易日 ────────────────────────────────────

app.get('/api/health', async (c) => {
  const date8 = todayDate8();
  const { status, reason } = await checkTradingDay(date8);

  return c.json({
    ok: true,
    mode: 'cloud',
    date8,
    cn_date: cnDateFrom8(date8),
    trading_day: status,
    trading_reason: reason,
    default_article_url: defaultArticleUrl(date8),
    show_name: '盘面吐槽大会',
    voice: 'zh-CN-YunxiNeural',
    rate: '+6%',
    llm: {
      model: 'agnes-3.0-flash',
      base_url: 'https://apihub.agnes-ai.com/v1',
      has_key: !!c.env.AGNES_API_KEY,
    },
    bilibili: {
      has_cookies: false,
      enabled: false,
    },
    render: { concurrency: 4 },
    article: {
      base_url: 'https://ashare.ldragon.xyz/summary_today/',
      pattern: '{date}_summary_today.docx',
    },
  });
});

app.get('/api/trading-day', async (c) => {
  const date = c.req.query('date') || '';
  const force = c.req.query('force') === 'true';
  const value = date ? date.replace(/-/g, '') : todayDate8();
  const { status, reason } = await checkTradingDay(value);
  return c.json({
    date8: value,
    cn_date: cnDateFrom8(value),
    status,
    reason,
  });
});

// ─── GitHub Actions 云端运行 ───────────────────────────────

app.get('/api/github/status', (c) => {
  const hasPat = !!c.env.GITHUB_PAT;
  const r2Configured = !!c.env.R2;
  return c.json({
    configured: hasPat,
    owner: c.env.GITHUB_REPO_OWNER,
    repo: c.env.GITHUB_REPO_NAME,
    has_pat: hasPat,
    r2_configured: r2Configured,
    r2_bucket: c.env.R2_BUCKET_NAME,
    mode: 'cloud',
  });
});

/** 查询最近一次 GitHub Actions 运行状态（含步骤进度） */
app.get('/api/github/run', async (c) => {
  const pat = c.env.GITHUB_PAT;
  if (!pat) {
    return c.json({ ok: false, error: '未配置 GitHub PAT' }, 400);
  }

  const owner = c.env.GITHUB_REPO_OWNER;
  const repo = c.env.GITHUB_REPO_NAME;
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ashare-tucao-remotion-worker',
  };

  try {
    // 获取最近一次运行
    const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=1`;
    const resp = await fetch(runsUrl, { headers });
    if (!resp.ok) {
      return c.json({ ok: false, error: `GitHub API 失败：${resp.status}` }, 502);
    }
    const data = await resp.json() as any;
    const runs = data?.workflow_runs || [];
    if (runs.length === 0) {
      return c.json({ ok: true, run: null, message: '暂无运行记录' });
    }

    const run = runs[0];
    const runInfo = {
      id: run.id,
      name: run.name,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      created_at: run.created_at,
      updated_at: run.updated_at,
      steps: [] as any[],
    };

    // 获取步骤详情
    const jobsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${run.id}/jobs`;
    const jobsResp = await fetch(jobsUrl, { headers });
    if (jobsResp.ok) {
      const jobsData = await jobsResp.json() as any;
      const jobs = jobsData?.jobs || [];
      for (const job of jobs) {
        for (const step of job.steps || []) {
          runInfo.steps.push({
            name: step.name,
            status: step.status,
            conclusion: step.conclusion,
          });
        }
      }
    }

    return c.json({ ok: true, run: runInfo });
  } catch (e: any) {
    return c.json({ ok: false, error: `查询失败：${e?.message || e}` }, 500);
  }
});

app.post('/api/github/dispatch', async (c) => {
  const pat = c.env.GITHUB_PAT;
  if (!pat) {
    return c.json({ ok: false, error: '未配置 GitHub PAT（请通过 wrangler secret put GITHUB_PAT 设置）' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const date_val = body.date || '';
  const article = body.article || '';
  const video_title = body.video_title || '';
  const concurrency = String(body.concurrency || '4');
  const force = body.force ?? false;
  const upload = body.upload ?? false;
  const skip_llm = body.skip_llm ?? false;

  const payload = {
    event_type: 'ashare-tucao-generation',
    client_payload: {
      date: date_val,
      article,
      video_title,
      concurrency,
      force: String(force).toLowerCase(),
      upload: String(upload).toLowerCase(),
      skip_llm: String(skip_llm).toLowerCase(),
    },
  };

  const url = `https://api.github.com/repos/${c.env.GITHUB_REPO_OWNER}/${c.env.GITHUB_REPO_NAME}/dispatches`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'ashare-tucao-remotion-worker',
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 204) {
      return c.json({
        ok: true,
        message: 'GitHub Actions 已触发',
        dispatch_id: null,
        url: `https://github.com/${c.env.GITHUB_REPO_OWNER}/${c.env.GITHUB_REPO_NAME}/actions`,
      });
    }

    const errText = await resp.text();
    return c.json(
      { ok: false, error: `GitHub API 调用失败：${resp.status} ${errText.slice(0, 500)}` },
      502
    );
  } catch (e: any) {
    return c.json({ ok: false, error: `触发失败：${e?.message || e}` }, 500);
  }
});

// ─── R2 存储桶代理 ────────────────────────────────────────

app.get('/api/r2/list', async (c) => {
  if (!c.env.R2) {
    return c.json({ ok: false, error: 'R2 未绑定', items: [] });
  }
  const prefix = 'ashare-tucao/';
  try {
    const result = await c.env.R2.list({ prefix, limit: 1000 });
    const items = result.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      last_modified: obj.uploaded.toISOString(),
    }));
    items.sort((a, b) => new Date(b.last_modified).getTime() - new Date(a.last_modified).getTime());

    // 按运行前缀分组
    const runs: Record<string, any[]> = {};
    for (const it of items) {
      const prefixPart = it.key.slice(prefix.length).split('/')[0];
      if (!runs[prefixPart]) runs[prefixPart] = [];
      runs[prefixPart].push(it);
    }
    const runList = Object.entries(runs)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([prefix, files]) => ({ prefix, files, count: files.length }));

    return c.json({
      ok: true,
      runs: runList,
      public_url: c.env.R2_PUBLIC_URL,
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e), items: [] });
  }
});

app.get('/api/r2/file', async (c) => {
  if (!c.env.R2) {
    return c.json({ ok: false, error: 'R2 未绑定' }, 400);
  }
  const key = c.req.query('key') || '';
  if (!key) {
    return c.json({ ok: false, error: '缺少 key 参数' }, 400);
  }

  try {
    const range = c.req.header('Range');
    const obj = await c.env.R2.get(key, range ? { range } : undefined);

    if (!obj) {
      return c.json({ ok: false, error: `文件不存在：${key}` }, 404);
    }

    const headers: Record<string, string> = {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };
    if (obj.size != null) {
      headers['X-File-Size'] = String(obj.size);
    }
    if (range) {
      headers['Content-Range'] = range;
    }

    // obj.body is a ReadableStream — return it directly
    return new Response(obj.body, { status: 200, headers });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 404);
  }
});

/**
 * 列出 R2 文件（支持文件夹结构，用于文件浏览器）
 * GET /api/r2/files?prefix=&cursor=
 */
app.get('/api/r2/files', async (c) => {
  if (!c.env.R2) {
    return c.json({ ok: false, error: 'R2 未绑定', files: [], folders: [] });
  }
  const prefix = c.req.query('prefix') || '';
  const delimiter = '/';
  const cursor = c.req.query('cursor') || undefined;
  const limit = 1000;
  const maxPages = 20;

  try {
    const objects: any[] = [];
    const folderSet = new Set<string>();
    let truncated = false;
    let nextCursor: string | undefined = cursor;
    let pages = 0;

    do {
      const options: any = { prefix, limit };
      if (delimiter) options.delimiter = delimiter;
      if (nextCursor) options.cursor = nextCursor;
      const result = await c.env.R2.list(options);
      for (const obj of result.objects || []) objects.push(obj);
      for (const fp of result.delimitedPrefixes || []) folderSet.add(fp);
      truncated = !!result.truncated;
      nextCursor = (result as any).cursor || undefined;
      pages++;
    } while (truncated && nextCursor && pages < maxPages);

    const folders = Array.from(folderSet).map((fp: string) => {
      // 只取最后一段作为显示名，避免把完整路径拼成一串
      const name = fp.replace(/\/+$/, '').split('/').pop() || fp;
      return { key: fp, name, type: 'directory', size: 0, lastModified: null };
    });
    const files = objects.map((obj: any) => {
      const name = obj.key.split('/').pop() || obj.key;
      return {
        key: obj.key,
        name,
        type: 'file',
        size: obj.size,
        lastModified: obj.uploaded,
        contentType: obj.httpMetadata?.contentType,
      };
    });

    return c.json({
      ok: true,
      files,
      folders,
      truncated: truncated && !!nextCursor,
      cursor: truncated ? nextCursor || null : null,
      prefix,
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e), files: [], folders: [] });
  }
});

/** 删除文件或文件夹 */
app.post('/api/r2/delete', async (c) => {
  if (!c.env.R2) return c.json({ ok: false, error: 'R2 未绑定' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const key = body.key || '';
  const isDir = !!body.is_directory;
  if (!key) return c.json({ ok: false, error: '缺少 key' }, 400);

  try {
    if (isDir) {
      let totalDeleted = 0;
      let cursor: string | undefined;
      do {
        const result = await c.env.R2.list({ prefix: key, limit: 1000, cursor });
        const keys = result.objects.map((o: any) => o.key);
        if (keys.length > 0) { await c.env.R2.delete(keys); totalDeleted += keys.length; }
        cursor = result.truncated ? result.cursor : undefined;
      } while (cursor);
      try { await c.env.R2.delete(key.replace(/\/$/, '')); } catch { /* ignore */ }
      return c.json({ ok: true, deleted: totalDeleted });
    }
    await c.env.R2.delete(key);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

/** 批量删除 */
app.post('/api/r2/batch-delete', async (c) => {
  if (!c.env.R2) return c.json({ ok: false, error: 'R2 未绑定' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const keys: string[] = body.keys || [];
  if (keys.length === 0) return c.json({ ok: false, error: '缺少 keys' }, 400);

  let totalDeleted = 0;
  const errors: string[] = [];
  for (const key of keys) {
    try {
      await c.env.R2.delete(key);
      totalDeleted++;
    } catch {
      try {
        let cursor: string | undefined;
        do {
          const result = await c.env.R2.list({ prefix: key, limit: 1000, cursor });
          const objKeys = result.objects.map((o: any) => o.key);
          if (objKeys.length > 0) { await c.env.R2.delete(objKeys); totalDeleted += objKeys.length; }
          cursor = result.truncated ? result.cursor : undefined;
        } while (cursor);
        try { await c.env.R2.delete(key.replace(/\/$/, '')); } catch { /* ignore */ }
      } catch (err: any) {
        errors.push(`${key}: ${err?.message || err}`);
      }
    }
  }
  return c.json({ ok: true, deleted: totalDeleted, errors });
});

/** 新建文件夹 */
app.post('/api/r2/create-folder', async (c) => {
  if (!c.env.R2) return c.json({ ok: false, error: 'R2 未绑定' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const key = body.key || '';
  if (!key) return c.json({ ok: false, error: '缺少 key' }, 400);

  try {
    const folderKey = key.endsWith('/') ? key : `${key}/`;
    await c.env.R2.put(folderKey, '', {
      httpMetadata: { contentType: 'application/x-directory' },
    });
    return c.json({ ok: true, key: folderKey });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

/** 上传文件到 R2（base64） */
app.post('/api/r2/upload', async (c) => {
  if (!c.env.R2) return c.json({ ok: false, error: 'R2 未绑定' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const filename = body.filename || '';
  const content = body.content || '';
  const contentType = body.contentType || '';
  const prefix = body.prefix || '';
  if (!filename || !content) return c.json({ ok: false, error: '缺少 filename 或 content' }, 400);

  try {
    const decoded = Uint8Array.from(atob(content), (b) => b.charCodeAt(0));
    const safeName = filename.replace(/[^\w.\-]/g, '_');
    const key = prefix ? `${prefix.replace(/\/+$/, '')}/${safeName}` : safeName;
    await c.env.R2.put(key, decoded, {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    return c.json({ ok: true, key, size: decoded.byteLength, filename });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

/** 存储统计 */
app.get('/api/r2/stats', async (c) => {
  if (!c.env.R2) return c.json({ ok: false, error: 'R2 未绑定' });
  const prefix = c.req.query('prefix') || '';
  try {
    let totalSize = 0;
    let totalFiles = 0;
    let cursor: string | undefined;
    do {
      const result = await c.env.R2.list({ prefix, limit: 1000, cursor });
      for (const obj of result.objects) { totalSize += obj.size; totalFiles++; }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
    return c.json({ ok: true, totalSize, totalFiles, totalSizeMB: (totalSize / 1024 / 1024).toFixed(2), prefix });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) });
  }
});

/** 下载文件（带 Content-Disposition） */
app.get('/api/r2/download', async (c) => {
  if (!c.env.R2) return c.json({ ok: false, error: 'R2 未绑定' }, 400);
  const key = c.req.query('key') || '';
  if (!key) return c.json({ ok: false, error: '缺少 key 参数' }, 400);
  try {
    const obj = await c.env.R2.get(key);
    if (!obj) return c.json({ ok: false, error: `文件不存在：${key}` }, 404);
    const filename = key.split('/').pop() || key;
    const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
    return new Response(obj.body, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(obj.size),
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 404);
  }
});

// ─── B站上传（云端：触发 GitHub Actions 仅上传模式）────────────────

app.post('/api/bilibili/upload', async (c) => {
  const pat = c.env.GITHUB_PAT;
  if (!pat) {
    return c.json({ ok: false, error: '未配置 GitHub PAT（请通过 wrangler secret put GITHUB_PAT 设置）' }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const date = body.date || '';

  const payload = {
    event_type: 'ashare-tucao-generation',
    client_payload: {
      date,
      upload: 'true',
      upload_only: 'true',
    },
  };

  const url = `https://api.github.com/repos/${c.env.GITHUB_REPO_OWNER}/${c.env.GITHUB_REPO_NAME}/dispatches`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'ashare-tucao-remotion-worker',
      },
      body: JSON.stringify(payload),
    });
    if (resp.status === 204) {
      return c.json({ ok: true, message: 'B站上传任务已触发，请查看运行状态' });
    }
    const errText = await resp.text();
    return c.json({ ok: false, error: `触发失败：${resp.status} ${errText.slice(0, 300)}` }, 502);
  } catch (e: any) {
    return c.json({ ok: false, error: `触发失败：${e?.message || e}` }, 500);
  }
});

// ─── 设置（云端模式：只读）────────────────────────────────

app.get('/api/settings', (c) => {
  const hasPat = !!c.env.GITHUB_PAT;
  const hasKey = !!c.env.AGNES_API_KEY;

  return c.json({
    mode: 'cloud',
    llm: {
      base_url: 'https://apihub.agnes-ai.com/v1',
      model: 'agnes-3.0-flash',
      temperature: 0.9,
      key_masked: hasKey ? '已配置（云端 Secrets）' : '',
      has_key: hasKey,
    },
    bilibili: {
      cookies: '',
      headless: true,
    },
    render: { concurrency: 4 },
    article: {
      base_url: 'https://ashare.ldragon.xyz/summary_today/',
      pattern: '{date}_summary_today.docx',
    },
    github: {
      owner: c.env.GITHUB_REPO_OWNER,
      repo: c.env.GITHUB_REPO_NAME,
      pat: '',
      has_pat: hasPat,
    },
    r2: {
      bucket: c.env.R2_BUCKET_NAME,
      endpoint: '',
      public_url: c.env.R2_PUBLIC_URL,
      configured: !!c.env.R2,
    },
  });
});

app.post('/api/settings', (c) => {
  // 云端模式下配置由 wrangler secret/var 管理，无法通过网页修改
  return c.json({
    ok: false,
    error: '云端模式下配置由 Cloudflare Secrets 管理。请使用 wrangler secret put / wrangler vars 修改。',
  });
});

app.post('/api/settings/test-llm', async (c) => {
  const key = c.env.AGNES_API_KEY;
  if (!key) {
    return c.json({ ok: false, error: '未配置 AGNES_API_KEY（请通过 wrangler secret put AGNES_API_KEY 设置）' }, 400);
  }
  try {
    const resp = await fetch('https://apihub.agnes-ai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'agnes-3.0-flash',
        messages: [
          { role: 'user', content: '只回复两个字：正常' },
        ],
        max_tokens: 20,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return c.json({ ok: false, error: `LLM 连接失败：${resp.status} ${errText.slice(0, 200)}` }, 400);
    }
    const data = await resp.json() as any;
    const reply = data?.choices?.[0]?.message?.content || 'OK';
    return c.json({ ok: true, reply: reply.slice(0, 100) });
  } catch (e: any) {
    return c.json({ ok: false, error: `测试失败：${e?.message || e}` }, 400);
  }
});

// ─── 本地独有功能（云端返回 501）───────────────────────────

app.get('/api/tasks', (c) => c.json({ detail: '云端模式不支持本地任务，请使用「云端运行」' }, 501));
app.post('/api/tasks', (c) => c.json({ detail: '云端模式不支持本地任务，请使用「云端运行」' }, 501));
app.get('/api/tasks/:id', (c) => c.json({ detail: '云端模式不支持本地任务' }, 501));
app.post('/api/tasks/:id/cancel', (c) => c.json({ detail: '云端模式不支持本地任务' }, 501));
app.post('/api/articles/upload', (c) => c.json({ detail: '云端模式不支持文件上传，请使用粘贴或URL' }, 501));
app.post('/api/articles/preview', (c) => c.json({ detail: '云端模式不支持本地预览' }, 501));
app.post('/api/bilibili/login', (c) => c.json({ detail: '云端模式不支持B站扫码登录' }, 501));
app.get('/api/bilibili/login/status', (c) => c.json({ state: 'idle', has_cookies: false, running: false, mode: 'cloud' }));
app.post('/api/bilibili/check', (c) => c.json({ ok: false, message: '云端模式不支持B站Cookie检测', mode: 'cloud' }, 400));

// ─── 静态资源托管 ─────────────────────────────────────────

app.get('*', async (c) => {
  const url = new URL(c.req.url);

  // API 路径返回 JSON 404
  if (url.pathname.startsWith('/api/')) {
    return c.json({ detail: 'Not Found' }, 404);
  }

  // 通过 ASSETS binding 提供静态文件（index.html、app.js、styles.css 等）
  if (c.env.ASSETS) {
    try {
      return await c.env.ASSETS.fetch(c.req.raw);
    } catch (e) {
      // 文件未找到，返回兜底页面
    }
  }

  return c.html('<!DOCTYPE html><html><body><h1>A股盘面吐槽大会</h1><p>前端资源未加载，请检查部署配置。</p></body></html>');
});

app.notFound((c) => {
  return c.json({ detail: 'Not Found' }, 404);
});

export default app;
