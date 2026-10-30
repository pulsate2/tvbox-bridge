#!/usr/bin/env node
/**
 * tvbox-bridge — 简易 TVBox Web 桥
 *
 * 解析路径（TVBox / CatVod 生态）：
 *   1) 拉取 TVBox 配置（支持 JSON / Base64 / <pre> / 多仓 urls）
 *   2) CMS(type 0/1) 站点直接 HTTP 拉取；Spider(type 3 / csp_ / .js) 站点交给
 *      由 companion-build 从 Java 解析层源码构建的 companion-service.jar（本地 CatVod 运行时）
 *   3) 浏览器端展示分类/列表/详情/搜索，并把播放地址经 /api/stream 代理播放
 *
 * 默认只监听 127.0.0.1；容器内用 HOST=0.0.0.0 暴露端口。
 * 设置 BRIDGE_TOKEN / BRIDGE_TOKENS 后所有 /api/* 接口需要鉴权。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const COMPANION_DIST = path.join(ROOT, 'companion', 'dist');
const COMPANION_JAR = path.join(COMPANION_DIST, 'companion-service.jar');
const JAR_CACHE = process.env.JAR_CACHE_DIR || path.join(ROOT, 'companion', 'jars');
/**
 * companion 的用户目录（载荷解密缓存 `~/.tvbox_bridge` 的父目录）。
 * Java 在 Linux 上从 passwd 取 user.home 而不是 $HOME，所以必须显式 -Duser.home，
 * 否则容器里缓存会落到 /home/node 而不是挂载卷上。
 */
const COMPANION_HOME = process.env.COMPANION_HOME || '';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
/** 反向代理/公网部署时用于拼绝对地址；不设则按请求 Host 推断。 */
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const VERSION = '1.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 tvbox-bridge/1.0.0';

/* ------------------------------------------------------------------ */
/* 出站 HTTP：尊重 HTTPS_PROXY/HTTP_PROXY（Node 自带 fetch 默认不读）      */
/* ------------------------------------------------------------------ */
let externalFetch = fetch;
let proxyMode = '';
try {
  const { ProxyAgent, fetch: undiciFetch } = require('undici');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    const dispatcher = new ProxyAgent(proxy);
    externalFetch = (url, opts = {}) => undiciFetch(url, { ...opts, dispatcher });
    proxyMode = proxy;
  }
} catch (e) {
  console.warn('[net] undici 不可用，外网请求将直连:', e.message);
}

function isLocal(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch { return false; }
}

async function attemptFetch(fn, url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const outer = opts.signal;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) throw new Error('aborted');
    outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    return await fn(url, { ...opts, signal: ctrl.signal });
  } finally {
    if (timer) clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

/**
 * 外网请求 + 代理回退。
 * 本机代理对部分国内直连站点会 TLS 失败（如 mv.gzlcl.com），而 GitHub 又必须走代理；
 * 因此按场景选择顺序：配置/载荷下载 proxy-first，媒体/解析 direct-first。
 */
async function fetchWithFallback(url, opts = {}, mode = 'proxy-first') {
  if (isLocal(String(url)) || externalFetch === fetch) return fetch(url, opts);
  const order = mode === 'proxy-first' ? [externalFetch, fetch] : [fetch, externalFetch];
  let lastErr;
  for (const fn of order) {
    try {
      return await attemptFetch(fn, url, opts, opts.timeoutMs);
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) break;
    }
  }
  throw lastErr || new Error('fetch failed');
}

/** 配置 / jar 等墙外资源：优先代理。 */
function fetchOut(url, opts = {}) {
  return fetchWithFallback(url, opts, 'proxy-first');
}

/** 媒体 / CMS / 解析等国内资源：优先直连。 */
function fetchDirect(url, opts = {}) {
  return fetchWithFallback(url, opts, 'direct-first');
}

/* ------------------------------------------------------------------ */
/* 鉴权（环境变量 BRIDGE_TOKEN / BRIDGE_TOKENS）                         */
/* ------------------------------------------------------------------ */
//
// 未设置时接口开放（仅适合本机）；设置后所有 /api/* 需携带 token，
// 支持三种传递方式（按优先级）：
//   1. Authorization: Bearer <token>
//   2. X-API-Key: <token>
//   3. 查询参数 ?token=<token>（或简写 ?t=，用于 <video>/hls.js 这类无法加头的场景）
const AUTH_TOKENS = String(process.env.BRIDGE_TOKENS || process.env.BRIDGE_TOKEN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const AUTH_ENABLED = AUTH_TOKENS.length > 0;
if (!AUTH_ENABLED) {
  console.warn('[auth] 未设置 BRIDGE_TOKEN(S)，接口无需鉴权（建议仅本机使用）');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function extractToken(req, urlObj) {
  const auth = String(req.headers['authorization'] || '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return String(apiKey).trim();
  return urlObj.searchParams.get('token') || urlObj.searchParams.get('t') || '';
}

function authOk(token) {
  if (!AUTH_ENABLED) return true;
  if (!token) return false;
  return AUTH_TOKENS.some((t) => safeEqual(t, token));
}

/** 仅允许本机回环访问（companion 通过 127.0.0.1 拉取预下载的 jar）。 */
function isLoopback(req) {
  const addr = String(req.socket?.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 生成绝对地址：优先 PUBLIC_BASE_URL，其次按请求头推断。 */
function absoluteUrl(req, p) {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const base = PUBLIC_BASE_URL || `${proto}://${req.headers.host || `${HOST}:${PORT}`}`;
  return base + p;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  const buf = Buffer.from(String(body), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*' });
  res.end(buf);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new Error('invalid JSON body'); }
}

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64u(str) { return Buffer.from(String(str || ''), 'base64url').toString('utf8'); }
function encodeHeaders(h) { try { return b64u(JSON.stringify(h || {})); } catch { return ''; } }
function decodeHeaders(s) { try { return JSON.parse(unb64u(s)); } catch { return {}; } }

function asInt(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function firstString(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 配置解码（JSON / Base64 / <pre> / 多仓）                              */
/* ------------------------------------------------------------------ */

const PRE_RE = /<pre[^>]*>([\s\S]*?)<\/pre>/i;
const MARKER_RE = /[A-Za-z0-9]{8}\*\*/;

function tryJson(s) { try { return JSON.parse(s); } catch { return undefined; } }
function isStructure(v) { return v && typeof v === 'object'; }

function decodeConfig(raw) {
  let t = String(raw || '').trim();
  if (!t) return null;
  const pre = t.match(PRE_RE);
  if (pre && pre[1].trim()) t = pre[1].trim();

  let v = tryJson(t);
  if (isStructure(v)) return v;

  const marker = t.match(MARKER_RE);
  if (marker) {
    const payload = t.slice(marker.index + marker[0].length).replace(/\s+/g, '');
    try {
      const decoded = Buffer.from(payload, 'base64').toString('utf8');
      v = tryJson(decoded);
      if (isStructure(v)) return v;
    } catch {}
  }

  const compact = t.replace(/[\r\n\s]+/g, '');
  try {
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    v = tryJson(decoded);
    if (isStructure(v)) return v;
  } catch {}

  return null;
}

function resolveAsset(baseUrl, value) {
  if (value === undefined || value === null) return value;
  const raw = String(value).trim();
  if (!raw) return raw;
  if (raw.startsWith('{') || raw.startsWith('[')) return raw; // JSON ext
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(raw)) return raw; // 绝对地址
  if (!baseUrl) return raw;
  try {
    const base = new URL(baseUrl);
    if (raw.startsWith('//')) return `${base.protocol}${raw}`;
    if (raw.startsWith('./') || raw.startsWith('../') || raw.includes('/')) {
      return new URL(raw, base).toString();
    }
  } catch {}
  return raw;
}

/** 站点 jar: `./jar/fan.txt;md5;xxxx` 拆出路径并还原，保留 md5 后缀。 */
function normalizeJar(baseUrl, jar) {
  if (!jar) return undefined;
  const raw = String(jar);
  if (raw.startsWith('{') || raw.startsWith('[')) return raw;
  const idx = raw.indexOf(';md5;');
  const urlPart = idx >= 0 ? raw.slice(0, idx) : raw;
  const suffix = idx >= 0 ? raw.slice(idx) : '';
  return resolveAsset(baseUrl, urlPart) + suffix;
}

function normalizeSites(obj, configUrl) {
  const spider = normalizeJar(configUrl, obj.spider);
  const sites = Array.isArray(obj.sites) ? obj.sites : [];
  return sites.map((s) => {
    if (!s || typeof s !== 'object') return null;
    let ext = s.ext;
    if (ext && typeof ext === 'object') ext = JSON.stringify(ext);
    else if (ext !== undefined) ext = String(ext);
    let jar = s.jar ? normalizeJar(configUrl, s.jar) : spider;
    return {
      key: String(s.key ?? ''),
      name: String(s.name ?? s.key ?? ''),
      type: asInt(s.type, 0),
      api: String(s.api ?? ''),
      ext,
      jar,
      searchable: asInt(s.searchable, 1),
      quickSearch: asInt(s.quickSearch, 1),
      filterable: asInt(s.filterable, 1),
      playUrl: s.playUrl ? String(s.playUrl) : undefined,
      categories: Array.isArray(s.categories) ? s.categories.map(String) : undefined,
      header: s.header && typeof s.header === 'object' ? s.header : undefined,
      usesCompanion: false,
      unsupported: false,
    };
  }).filter(Boolean).map((s) => {
    const api = s.api;
    const isJs = api.includes('.js');
    const isPy = api.includes('.py');
    const isJar = api.startsWith('csp_');
    s.usesCompanion = s.type === 3 || isJs || isPy || isJar;
    s.unsupported = isPy;
    return s;
  });
}

function normalizeConfig(obj, configUrl) {
  return {
    configUrl,
    spider: normalizeJar(configUrl, obj.spider),
    wallpaper: obj.wallpaper,
    warning: obj.warning,
    sites: normalizeSites(obj, configUrl),
    parses: Array.isArray(obj.parses) ? obj.parses.map((p) => ({
      name: String(p?.name ?? ''),
      type: asInt(p?.type, 0),
      url: String(p?.url ?? ''),
      ext: p?.ext !== undefined ? String(p.ext) : undefined,
      header: p?.header && typeof p.header === 'object' ? p.header : undefined,
    })) : [],
    lives: Array.isArray(obj.lives) ? obj.lives : [],
    flags: Array.isArray(obj.flags) ? obj.flags : [],
  };
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const state = {
  config: null,           // normalizeConfig 结果
  depotEntries: null,     // 多仓条目
  companion: null,        // { proc, port, ready, logs[] }
  loadedSites: new Map(), // key -> {ok, error, at}
  loadChain: Promise.resolve(),
};

/* ------------------------------------------------------------------ */
/* Companion 进程                                                      */
/* ------------------------------------------------------------------ */

function companionLog(line) {
  const c = state.companion;
  if (!c) return;
  c.logs.push(`${new Date().toISOString()} ${line}`);
  if (c.logs.length > 500) c.logs.splice(0, c.logs.length - 500);
}

function startCompanion() {
  const c = state.companion;
  if (c && c.port) return Promise.resolve(c.port);
  if (c && c.ready) return c.ready;
  if (!fs.existsSync(COMPANION_JAR)) {
    return Promise.reject(new Error(`companion jar 不存在: ${COMPANION_JAR}，请先运行 companion-build/build.sh`));
  }
  const proc = spawn('java', [
    '-Xms16m', '-Xmx256m', '-XX:MaxMetaspaceSize=128m', '-XX:+UseSerialGC',
    ...(COMPANION_HOME ? [`-Duser.home=${COMPANION_HOME}`] : []),
    '-jar', COMPANION_JAR, '--port=0',
  ], { cwd: COMPANION_DIST, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const comp = { proc, port: 0, ready: null, logs: [], startedAt: Date.now(), lastError: '' };
  state.companion = comp;

  comp.ready = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      comp.lastError = 'companion 启动超时';
      reject(new Error(comp.lastError));
    }, 30000);
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      buf += s;
      s.split(/\r?\n/).forEach((l) => { if (l.trim()) companionLog(l.trim()); });
      const m = buf.match(/\[COMPANION_READY\] PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        comp.port = Number(m[1]);
        resolve(comp.port);
      }
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      s.split(/\r?\n/).forEach((l) => { if (l.trim()) companionLog('[err] ' + l.trim()); });
      const meaningful = s.split(/\r?\n/).filter(Boolean).pop();
      if (meaningful) comp.lastError = meaningful.slice(0, 400);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      comp.port = 0;
      comp.lastError = comp.lastError || `companion exited (${code})`;
      companionLog(`[exit] code=${code}`);
      reject(new Error(comp.lastError));
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      comp.lastError = String(e.message || e);
      reject(e);
    });
  });
  // 防止未处理的 rejection 打印
  comp.ready.catch(() => {});
  return comp.ready;
}

function stopCompanion() {
  const c = state.companion;
  if (!c || !c.proc) return;
  const proc = c.proc;
  try { proc.kill(); } catch {}
}

function companionCall(urlPath, body, timeoutMs = 150000) {
  if (!state.companion || !state.companion.port) throw new Error('companion 未运行');
  const base = `http://127.0.0.1:${state.companion.port}`;
  return fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (r) => {
    const txt = await r.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { code: -99, error: txt.slice(0, 500) }; }
    return { status: r.status, data };
  });
}

/* ------------------------------------------------------------------ */
/* Spider 站点                                                          */
/* ------------------------------------------------------------------ */

function siteByKey(key) {
  if (!state.config) return null;
  return state.config.sites.find((s) => s.key === key) || null;
}

async function loadSpiderSite(site) {
  if (!site.usesCompanion) return { ok: true };
  if (site.unsupported) return { ok: false, error: 'Python 源暂不支持' };
  const prev = state.loadedSites.get(site.key);
  if (prev && prev.ok) return prev;

  // 首次加固载荷需要解密 + dex2jar，耗时较长；串行化避免并发重复解密。
  state.loadChain = state.loadChain.catch(() => {}).then(async () => {
    await startCompanion();
    let jarSpec = site.jar;
    try {
      jarSpec = await materializeJar(site);
    } catch (e) {
      console.warn('[jar] 预下载失败，交回 companion 直连:', e.message);
      companionLog('[jar] pre-download failed: ' + e.message);
    }
    const res = await companionCall('/spider/load', {
      key: site.key, api: site.api, ext: site.ext ?? '', jar: jarSpec ?? '',
      timeoutMs: '180000',
    }, 190000);
    const ok = res.status === 200 && res.data && res.data.code === 0;
    const out = { ok, error: ok ? '' : (res.data?.error || res.data?.detail || `HTTP ${res.status}`), at: Date.now() };
    state.loadedSites.set(site.key, out);
    return out;
  });
  return state.loadChain;
}

/** 把远程 spider jar 预下载到本地，再以 localhost URL 交给 companion（走系统代理）。 */
async function materializeJar(site) {
  const spec = site.jar;
  if (!spec || !/^https?:\/\//i.test(spec.split(';md5;')[0])) return spec;
  const idx = spec.indexOf(';md5;');
  const url = idx >= 0 ? spec.slice(0, idx) : spec;
  const md5 = idx >= 0 ? spec.slice(idx + 5).trim().toLowerCase() : '';
  fs.mkdirSync(JAR_CACHE, { recursive: true });
  const name = (md5 || crypto.createHash('md5').update(url).digest('hex')) + '.jar';
  const file = path.join(JAR_CACHE, name);

  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    const res = await fetchOut(url, { timeoutMs: 120000 });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = crypto.createHash('md5').update(buf).digest('hex');
    if (md5 && actual !== md5) throw new Error(`md5 不符（期望 ${md5}，实际 ${actual}）`);
    fs.writeFileSync(file, buf);
    companionLog(`[jar] downloaded ${name} (${buf.length} bytes)`);
  }
  // companion 与本进程同机，固定用回环地址（HOST 可能是 0.0.0.0）
  return `http://127.0.0.1:${PORT}/local/jar/${name}${md5 ? `;md5;${md5}` : ''}`;
}

async function spiderCall(site, method, params = {}, timeoutMs = 120000) {
  const load = await loadSpiderSite(site);
  if (!load.ok) throw new Error(`站点加载失败: ${load.error || 'unknown'}`);
  const body = {
    siteKey: site.key, api: site.api, ext: site.ext ?? '', jar: site.jar ?? '',
    method, timeoutMs: String(timeoutMs), ...params,
  };
  const res = await companionCall('/spider/call', body, timeoutMs + 15000);
  if (!res.data || res.data.code !== 0) {
    const msg = res.data?.error || res.data?.detail || `HTTP ${res.status}`;
    throw new Error(`${msg}${res.data?.stage ? ` (stage=${res.data.stage})` : ''}`);
  }
  const data = res.data.data;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return data; }
  }
  return data ?? {};
}

/* ------------------------------------------------------------------ */
/* CMS 站点                                                             */
/* ------------------------------------------------------------------ */

function cmsEndpoint(site) {
  const api = (site.api || '').trim();
  if (/^https?:\/\//i.test(api)) return api;
  const ext = (site.ext || '').trim();
  if (/^https?:\/\//i.test(ext)) return ext;
  if (ext.startsWith('{')) {
    try {
      const m = JSON.parse(ext);
      const c = m.url || m.api || m.site;
      if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
    } catch {}
  }
  return null;
}

function cmsExtend(site) {
  const ext = (site.ext || '').trim();
  if (ext && !/^https?:\/\//i.test(ext) && !ext.startsWith('{')) return ext;
  return null;
}

async function httpGet(url, { query, headers = {}, timeout = 25000 } = {}) {
  const u = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }
  const res = await fetchDirect(u, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/xml, application/xml, text/html, */*', ...headers },
    timeoutMs: timeout,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
  return res.text();
}

function xmlTag(content, tag) {
  const m = content.match(new RegExp(`<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseXmlPage(xml) {
  const categories = [];
  const cm = xml.match(/<class>([\s\S]*?)<\/class>/i);
  if (cm) {
    for (const m of cm[1].matchAll(/<ty\s+id="([^"]+)">([^<]+)<\/ty>/gi)) {
      categories.push({ id: m[1].trim(), name: m[2].trim() });
    }
  }
  const list = [];
  for (const vm of xml.matchAll(/<video>([\s\S]*?)<\/video>/gi)) {
    const c = vm[1];
    const id = xmlTag(c, 'id');
    const name = xmlTag(c, 'name');
    if (!id && !name) continue;
    list.push({
      id, name,
      pic: xmlTag(c, 'pic'),
      remarks: xmlTag(c, 'note') || xmlTag(c, 'state'),
      typeName: xmlTag(c, 'type'),
      content: xmlTag(c, 'des'),
      year: xmlTag(c, 'year'),
      area: xmlTag(c, 'area'),
      actor: xmlTag(c, 'actor'),
      director: xmlTag(c, 'director'),
    });
  }
  return { page: 1, pagecount: 1, limit: list.length, total: list.length, class: categories, list };
}

function parseJsonPage(obj) {
  const m = obj && typeof obj === 'object' ? obj : {};
  const pickList = [m.list, m.data, m.items, m.results].find(Array.isArray) || [];
  const pickClass = [m.class, m.types, m.classes, m.categories].find(Array.isArray) || [];
  return {
    page: asInt(m.page, 1),
    pagecount: asInt(m.pagecount, 1),
    limit: asInt(m.limit, pickList.length || 20),
    total: asInt(m.total, pickList.length),
    class: pickClass.map((c) => ({
      id: firstString(c.type_id, c.id, c.class_id, c.tid),
      name: firstString(c.type_name, c.name, c.class_name, c.tname),
    })).filter((c) => c.id && c.name),
    list: pickList.map((item) => ({
      id: firstString(item.vod_id, item.id),
      name: firstString(item.vod_name, item.name),
      pic: firstString(item.vod_pic, item.pic),
      remarks: firstString(item.vod_remarks, item.remarks, item.note),
      typeName: firstString(item.vod_class, item.type_name, item.type),
      content: firstString(item.vod_content, item.content, item.des),
      year: firstString(item.vod_year, item.year),
      area: firstString(item.vod_area, item.area),
      actor: firstString(item.vod_actor, item.actor),
      director: firstString(item.vod_director, item.director),
      score: firstString(item.vod_score, item.score, item.rating),
    })).filter((i) => i.id || i.name),
  };
}

function parseCmsContent(raw) {
  const t = String(raw || '').trim();
  if (!t) return { page: 1, pagecount: 1, limit: 0, total: 0, class: [], list: [] };
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return parseJsonPage(JSON.parse(t)); } catch {}
  }
  if (t.startsWith('<')) return parseXmlPage(t);
  try { return parseJsonPage(JSON.parse(t)); } catch {}
  return { page: 1, pagecount: 1, limit: 0, total: 0, class: [], list: [] };
}

async function cmsFetch(site, query) {
  const endpoint = cmsEndpoint(site);
  if (!endpoint) throw new Error('该站点不是 HTTP CMS 源');
  const extend = cmsExtend(site);
  const q = { ...query };
  if (extend) q.extend = extend;
  const raw = await httpGet(endpoint, { query: q, headers: site.header || {} });
  return parseCmsContent(raw);
}

async function cmsHome(site) {
  let page = await cmsFetch(site, {});
  if (!page.class.length && !page.list.length) {
    page = await cmsFetch(site, { ac: 'videolist', pg: '1' });
  }
  if (!page.class.length && !page.list.length) {
    page = await cmsFetch(site, { ac: 'detail', pg: '1' });
  }
  return page;
}

async function cmsCategory(site, tid, pg) {
  let page = await cmsFetch(site, { ac: site.type === 0 ? 'videolist' : 'detail', t: tid, pg: String(pg) });
  if (!page.list.length) page = await cmsFetch(site, { ac: 'videolist', t: tid, pg: String(pg) });
  return page;
}

function parsePlaySources(obj) {
  const from = firstString(obj.vod_play_from);
  const url = firstString(obj.vod_play_url);
  const sources = [];
  if (!from || !url) return sources;
  const fromNames = from.split('$$$');
  const urlGroups = url.split('$$$');
  fromNames.forEach((name, i) => {
    const group = urlGroups[i] || '';
    const episodes = [];
    for (const ep of group.split('#')) {
      const s = ep.trim();
      if (!s) continue;
      const idx = s.indexOf('$');
      if (idx >= 0) {
        const epName = s.slice(0, idx).trim();
        const epUrl = s.slice(idx + 1).trim();
        if (epUrl) episodes.push({ name: epName || '正片', url: epUrl });
      } else {
        episodes.push({ name: '正片', url: s });
      }
    }
    if (episodes.length) sources.push({ name: name.trim() || '默认线路', episodes });
  });
  return sources;
}

async function cmsDetail(site, id) {
  const endpoint = cmsEndpoint(site);
  if (!endpoint) throw new Error('该站点不是 HTTP CMS 源');
  const ac = site.type === 0 ? 'videolist' : 'detail';
  let raw = await httpGet(endpoint, { query: { ac, ids: id, extend: cmsExtend(site) || undefined }, headers: site.header || {} });
  let item = null;
  const t = raw.trim();
  if (t.startsWith('<')) {
    const v = t.match(/<video>([\s\S]*?)<\/video>/i)?.[1] || t;
    const dd = [];
    for (const m of v.matchAll(/<dd\s+flag="([^"]*)">(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dd>/gi)) {
      dd.push({ from: m[1], url: m[2].trim() });
    }
    const fake = { vod_play_from: dd.map((d) => d.from).join('$$$'), vod_play_url: dd.map((d) => d.url).join('$$$') };
    item = {
      id: xmlTag(v, 'id'), name: xmlTag(v, 'name'), pic: xmlTag(v, 'pic'),
      remarks: xmlTag(v, 'note') || xmlTag(v, 'state'), content: xmlTag(v, 'des'),
      year: xmlTag(v, 'year'), area: xmlTag(v, 'area'), actor: xmlTag(v, 'actor'), director: xmlTag(v, 'director'),
      ...fake,
    };
  } else {
    try {
      const obj = JSON.parse(t);
      const list = obj.list || obj.data || [];
      item = Array.isArray(list) ? list[0] : null;
    } catch {}
  }
  if (!item) throw new Error('未找到详情');
  return { item, sources: parsePlaySources(item) };
}

async function cmsSearch(site, wd, pg) {
  let page = await cmsFetch(site, { wd, pg: String(pg) });
  if (!page.list.length) page = await cmsFetch(site, { ac: site.type === 0 ? 'videolist' : 'detail', wd, pg: String(pg) });
  return page;
}

/* ------------------------------------------------------------------ */
/* 播放解析                                                             */
/* ------------------------------------------------------------------ */

function isDirectMedia(url) {
  const l = url.toLowerCase();
  return /\.(m3u8|mp4|flv|ts|mkv)(\?|$)/.test(l) || l.startsWith('rtmp://') || l.startsWith('rtsp://');
}

/**
 * 加固载荷会把真实播放地址包成 `http://127.0.0.1:9978/proxy?do=m3u8&url=...`
 * 或 `/proxy/<base64url>`（本应由载荷侧的 GuardProxyServer 改写）。
 * Web 端没有该本地服务，这里直接把内层 url 取出来。
 */
function unwrapLocalProxy(raw) {
  let url = String(raw || '');
  for (let depth = 0; depth < 3; depth++) {
    let u;
    try { u = new URL(url); } catch { return url; }
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return url;
    if (!u.pathname.startsWith('/proxy')) return url;
    let inner = u.searchParams.get('url');
    if (inner) return decodeURIComponent(inner);
    const tail = u.pathname.replace(/^\/proxy\/?/, '');
    if (!tail) return url;
    try {
      const decoded = Buffer.from(tail, 'base64url').toString('utf8').replace(/^\?/, '');
      const params = new URLSearchParams(decoded);
      inner = params.get('url');
      if (inner) return decodeURIComponent(inner);
    } catch { return url; }
    return url;
  }
  return url;
}

async function runParser(parses, rawUrl, headers = {}) {
  for (const p of parses) {
    if (p.type !== 1 || !p.url) continue;
    try {
      const target = p.url + rawUrl;
      const res = await fetchDirect(target, {
        headers: { 'User-Agent': UA, ...(p.header || {}), ...headers },
        timeoutMs: 15000,
      });
      if (!res.ok) continue;
      const t = await res.text();
      let obj;
      try { obj = JSON.parse(t); } catch { continue; }
      const url = firstString(obj.url, obj?.data?.url);
      if (url) return { url, headers: p.header || {} };
    } catch {}
  }
  return null;
}

async function spiderPlay(site, flag, id) {
  const data = await spiderCall(site, 'playerContent', { flag, id }, 120000);
  let rawUrl = firstString(data.url);
  if (!rawUrl) throw new Error('Spider 未返回播放地址');
  rawUrl = unwrapLocalProxy(rawUrl);
  const parse = asInt(data.parse, 0);
  const jx = asInt(data.jx, 0);
  if (firstString(data.playUrl)) throw new Error('暂不支持 Spider 网页解析前缀(playUrl)');
  let headers = {};
  if (typeof data.header === 'string' && data.header.trim()) {
    try { headers = JSON.parse(data.header); } catch {}
  } else if (data.header && typeof data.header === 'object') {
    headers = data.header;
  }
  if (parse === 1 || jx === 1) {
    const resolved = await runParser(state.config?.parses || [], rawUrl, headers);
    if (!resolved) throw new Error('解析接口均未返回可播放地址');
    return { url: resolved.url, headers: { ...headers, ...resolved.headers }, needsParse: true };
  }
  return { url: rawUrl, headers, needsParse: false };
}

async function cmsPlay(site, url) {
  if (isDirectMedia(url)) return { url, headers: site.header || {}, needsParse: false };
  const resolved = await runParser(state.config?.parses || [], url, site.header || {});
  if (resolved) return { url: resolved.url, headers: { ...(site.header || {}), ...resolved.headers }, needsParse: true };
  return { url, headers: site.header || {}, needsParse: false };
}

/* ------------------------------------------------------------------ */
/* 媒体代理                                                             */
/* ------------------------------------------------------------------ */

/**
 * 生成代理播放地址。开启鉴权时把调用方的 token 一并写进 URL，
 * 这样 hls.js / <video> 这类无法自定义请求头的客户端也能通过鉴权，
 * 且子清单、分片、AES key 的改写会沿用同一个 token。
 */
function proxyStreamUrl(url, headers = {}, token = '') {
  if (!url) return '';
  const parts = [`u=${encodeURIComponent(b64u(url))}`];
  if (headers && Object.keys(headers).length) parts.push(`h=${encodeURIComponent(encodeHeaders(headers))}`);
  if (AUTH_ENABLED && token) parts.push(`t=${encodeURIComponent(token)}`);
  return `/api/stream?${parts.join('&')}`;
}

function rewritePlaylist(body, baseUrl, headers, token) {
  const replace = (u) => {
    try {
      const abs = new URL(u, baseUrl).toString();
      return proxyStreamUrl(abs, headers, token);
    } catch { return u; }
  };
  return body.split(/\r?\n/).map((line) => {
    const s = line.trim();
    if (!s) return line;
    if (s.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${replace(u)}"`);
    }
    return replace(s);
  }).join('\n');
}

async function handleStream(req, res, urlObj) {
  const target = unb64u(urlObj.searchParams.get('u'));
  if (!target || !/^https?:\/\//i.test(target)) return json(res, 400, { error: '缺少有效 url' });
  const extra = decodeHeaders(urlObj.searchParams.get('h'));
  const headers = { 'User-Agent': UA, ...extra };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetchDirect(target, { headers, redirect: 'follow' });
  } catch (e) {
    return json(res, 502, { error: '拉流失败: ' + e.message });
  }
  if (!upstream.ok && upstream.status !== 206) {
    const body = await upstream.text().catch(() => '');
    return json(res, upstream.status, { error: `上游 ${upstream.status}`, detail: body.slice(0, 300), url: target });
  }

  const ct = (upstream.headers.get('content-type') || '').toLowerCase();
  const finalUrl = upstream.url || target;
  const isPlaylist = /mpegurl|x-mpegurl/i.test(ct) || new URL(finalUrl).pathname.toLowerCase().endsWith('.m3u8');

  if (isPlaylist) {
    let body = await upstream.text();
    body = rewritePlaylist(body, finalUrl, extra, req.authToken || '');
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  const passHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  const out = { 'Access-Control-Allow-Origin': '*' };
  for (const h of passHeaders) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  if (!out['content-type']) out['content-type'] = 'application/octet-stream';
  res.writeHead(upstream.status, out);
  if (req.method === 'HEAD') return res.end();
  const { Readable } = require('stream');
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

async function handleImage(req, res, urlObj) {
  const target = unb64u(urlObj.searchParams.get('u'));
  if (!target || !/^https?:\/\//i.test(target)) return json(res, 400, { error: '缺少有效 url' });
  try {
    const upstream = await fetchDirect(target, {
      headers: { 'User-Agent': UA, Referer: urlObj.searchParams.get('r') || '' },
      timeoutMs: 20000,
    });
    if (!upstream.ok) return json(res, upstream.status, { error: '图片拉取失败' });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch (e) {
    json(res, 502, { error: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* 业务路由                                                             */
/* ------------------------------------------------------------------ */

async function setConfigFromUrl(configUrl) {
  const res = await fetchOut(configUrl, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    timeoutMs: 30000,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`配置拉取失败 HTTP ${res.status}`);
  const raw = await res.text();
  const decoded = decodeConfig(raw);
  if (!decoded) throw new Error('配置无法解码（不是有效的 TVBox JSON/Base64/<pre>）');

  // 多仓：{"urls":[{"name","url"}]}
  if (decoded && !Array.isArray(decoded) && Array.isArray(decoded.urls)) {
    const entries = decoded.urls.map((e) => {
      const name = String(e?.name ?? '').trim();
      const u = String(e?.url ?? '').trim();
      return { name: name || u, url: resolveAsset(configUrl, u) };
    }).filter((e) => /^https?:\/\//i.test(e.url));
    if (!entries.length) throw new Error('多仓清单为空');
    state.depotEntries = entries;
    state.config = null;
    state.loadedSites.clear();
    return { kind: 'depot', entries, configUrl };
  }
  if (Array.isArray(decoded)) throw new Error('配置顶层是数组，当前仅支持对象配置');

  const config = normalizeConfig(decoded, configUrl);
  state.config = config;
  state.depotEntries = null;
  state.loadedSites.clear();
  return {
    kind: 'config',
    configUrl,
    siteCount: config.sites.length,
    parseCount: config.parses.length,
    liveCount: config.lives.length,
    spider: config.spider,
    sites: config.sites.map((s) => ({
      key: s.key, name: s.name, type: s.type, api: s.api,
      usesCompanion: s.usesCompanion, unsupported: s.unsupported,
      searchable: s.searchable,
    })),
  };
}

async function getPage(site, kind, params) {
  if (site.usesCompanion) {
    if (kind === 'home') return await spiderCall(site, 'homeContent', { filter: String(params.filter ?? true) });
    if (kind === 'category') return await spiderCall(site, 'categoryContent', {
      tid: params.tid, pg: String(params.pg ?? 1), filter: String(params.filter ?? true),
    });
    if (kind === 'search') return await spiderCall(site, 'searchContent', {
      wd: params.wd, quick: String(params.quick ?? false), pg: String(params.pg ?? 1),
    });
  }
  if (kind === 'home') return await cmsHome(site);
  if (kind === 'category') return await cmsCategory(site, params.tid, params.pg ?? 1);
  if (kind === 'search') return await cmsSearch(site, params.wd, params.pg ?? 1);
  throw new Error('未知请求');
}

function normalizePage(data) {
  const d = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(d.list) ? d.list : [];
  const cls = Array.isArray(d.class) ? d.class : [];
  return {
    page: asInt(d.page, 1),
    pagecount: asInt(d.pagecount, 1),
    total: asInt(d.total, list.length),
    limit: asInt(d.limit, list.length || 20),
    categories: cls.map((c) => ({
      id: firstString(c.type_id, c.id, c.class_id, c.tid),
      name: firstString(c.type_name, c.name, c.class_name, c.tname),
    })).filter((c) => c.id && c.name),
    list: list.map((item) => ({
      id: firstString(item.vod_id, item.id),
      name: firstString(item.vod_name, item.name),
      pic: firstString(item.vod_pic, item.pic),
      remarks: firstString(item.vod_remarks, item.remarks, item.note),
      typeName: firstString(item.type_name, item.type),
      year: firstString(item.vod_year, item.year),
      area: firstString(item.vod_area, item.area),
      score: firstString(item.vod_score, item.score, item.rating),
      tag: firstString(item.vod_tag, item.tag),
    })).filter((i) => i.id || i.name),
  };
}

function normalizeDetail(data) {
  const list = data?.list;
  const raw = Array.isArray(list) ? list[0] : (data && typeof data === 'object' ? data : null);
  if (!raw) throw new Error('详情为空');
  const sources = parsePlaySources(raw);
  return {
    item: {
      id: firstString(raw.vod_id, raw.id),
      name: firstString(raw.vod_name, raw.name),
      pic: firstString(raw.vod_pic, raw.pic),
      remarks: firstString(raw.vod_remarks, raw.remarks, raw.note),
      typeName: firstString(raw.type_name, raw.type),
      year: firstString(raw.vod_year, raw.year),
      area: firstString(raw.vod_area, raw.area),
      actor: firstString(raw.vod_actor, raw.actor),
      director: firstString(raw.vod_director, raw.director),
      content: firstString(raw.vod_content, raw.content, raw.des),
      score: firstString(raw.vod_score, raw.score, raw.rating),
    },
    sources,
  };
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function mediaType(url) {
  const l = String(url || '').toLowerCase();
  if (l.includes('.m3u8')) return 'hls';
  if (l.includes('.mp4')) return 'mp4';
  if (l.includes('.flv')) return 'flv';
  if (/\.ts(\?|$)/.test(l)) return 'ts';
  if (l.startsWith('rtmp://')) return 'rtmp';
  if (l.startsWith('rtsp://')) return 'rtsp';
  return 'other';
}

function requireConfig() {
  if (!state.config) throw new HttpError(400, '尚未加载配置，请先调用 POST /api/config');
}

function findSite(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return siteByKey(k) || state.config?.sites.find((s) => s.name === k)
    || state.config?.sites.find((s) => s.name.includes(k)) || null;
}

async function fetchDetail(site, id) {
  if (site.usesCompanion) return normalizeDetail(await spiderCall(site, 'detailContent', { id: String(id) }));
  return await cmsDetail(site, String(id));
}

async function playByFlag(site, flag, id) {
  return site.usesCompanion ? await spiderPlay(site, flag, id) : await cmsPlay(site, id);
}

/**
 * 一步解析：片名（或 id）→ 详情 → 选线路/选集 → playerContent → 可直接播放的地址。
 * 第三方只需一次调用即可拿到 stream。
 */
async function resolvePlayback(req, body) {
  requireConfig();
  const t0 = Date.now();
  const site = findSite(firstString(body.site, body.key, body.siteKey));
  if (!site) throw new HttpError(404, `站点不存在: ${firstString(body.site, body.key, body.siteKey) || '(空)'}`);

  let item = null;
  let detail;
  const vid = firstString(body.id, body.vodId, body.vod_id);
  if (vid) {
    detail = await fetchDetail(site, vid);
  } else {
    const wd = firstString(body.name, body.wd, body.keyword, body.q);
    if (!wd) throw new HttpError(400, '缺少 name（片名）或 id（影片 ID）');
    let list = normalizePage(await getPage(site, 'search', { wd, pg: 1, quick: false })).list;
    if (!list.length) {
      // 部分源不支持搜索（searchContent 恒空），退回首页 + 首个分类里按片名匹配
      list = await findByName(site, wd);
    }
    if (!list.length) throw new HttpError(404, `站点「${site.name}」未搜索到「${wd}」`);
    item = list[asInt(body.pick, 0)] || list[0];
    detail = await fetchDetail(site, item.id);
  }

  const sources = detail.sources || [];
  if (!sources.length) throw new HttpError(502, `「${detail.item?.name || vid}」没有可播放线路`);

  const wantSource = firstString(body.source, body.flag, body.line);
  let si = body.sourceIndex !== undefined ? asInt(body.sourceIndex, 0) : -1;
  if (si < 0) {
    si = wantSource ? sources.findIndex((s) => s.name === wantSource || s.name.includes(wantSource)) : 0;
  }
  if (si < 0 || si >= sources.length) si = 0;
  const source = sources[si];
  const episodes = source.episodes || [];
  if (!episodes.length) throw new HttpError(502, `线路「${source.name}」没有选集`);

  const wantEpUrl = firstString(body.episodeUrl, body.epUrl);
  const wantEp = firstString(body.episode, body.ep, body.index);
  let ei = -1;
  if (wantEpUrl) ei = episodes.findIndex((e) => e.url === wantEpUrl);
  else if (wantEp) {
    ei = episodes.findIndex((e) => e.name === wantEp);
    if (ei < 0) {
      const n = asInt(wantEp, -1);
      if (n >= 0) ei = n;
    }
  }
  if (ei < 0) ei = 0;
  const episode = episodes[ei];

  const play = await playByFlag(site, source.name, episode.url);
  const stream = proxyStreamUrl(play.url, play.headers || {}, req.authToken || '');

  return {
    site: { key: site.key, name: site.name, type: site.type, api: site.api },
    item: detail.item || item,
    source: { index: si, name: source.name, episodeCount: episodes.length },
    episode: { index: ei, name: episode.name, url: episode.url },
    url: play.url,
    type: mediaType(play.url),
    headers: play.headers || {},
    needsParse: !!play.needsParse,
    stream,
    streamUrl: absoluteUrl(req, stream),
    alternatives: sources.map((s, i) => ({ index: i, name: s.name, episodeCount: s.episodes.length })),
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 片名兜底：搜索接口不可用时，用首页 + 首个分类的列表做子串匹配。
 * 只做精确/包含匹配，避免把不相干的片子当成结果。
 */
async function findByName(site, wd) {
  const kw = String(wd).toLowerCase();
  const seen = new Set();
  const out = [];
  const collect = (list) => {
    for (const it of list || []) {
      const name = String(it.name || '').toLowerCase();
      if (!name || seen.has(it.id)) continue;
      if (name === kw || name.includes(kw) || kw.includes(name)) {
        seen.add(it.id);
        out.push(it);
      }
    }
  };
  try {
    const home = normalizePage(await getPage(site, 'home', {}));
    collect(home.list);
    if (!out.length && home.categories?.length) {
      const cat = normalizePage(await getPage(site, 'category', { tid: home.categories[0].id, pg: 1 }));
      collect(cat.list);
    }
  } catch {}
  return out;
}

async function handleApi(req, res, urlObj) {
  const p = urlObj.pathname;
  const body = req.method === 'POST' ? await readJsonBody(req) : {};
  // GET 允许用查询参数调用同一批接口，方便 curl / 第三方快速集成
  if (req.method === 'GET') {
    for (const [k, v] of urlObj.searchParams) {
      if (k !== 'token' && k !== 't' && !(k in body)) body[k] = v;
    }
  }

  if (p === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      status: 'ok',
      version: VERSION,
      auth: AUTH_ENABLED,
      companion: { running: !!state.companion?.port },
      configLoaded: !!state.config,
      sites: state.config?.sites.length || 0,
    });
  }

  if (p === '/api/status' && req.method === 'GET') {
    return json(res, 200, {
      version: VERSION,
      auth: AUTH_ENABLED,
      companion: state.companion ? {
        running: !!state.companion.port,
        port: state.companion.port,
        startedAt: state.companion.startedAt,
        lastError: state.companion.lastError,
      } : null,
      configLoaded: !!state.config,
      configUrl: state.config?.configUrl || null,
      sites: state.config?.sites.length || 0,
      loadedSites: [...state.loadedSites.entries()].map(([key, v]) => ({ key, ...v })),
    });
  }

  if (p === '/api/logs' && req.method === 'GET') {
    return json(res, 200, { logs: state.companion?.logs || [] });
  }

  if (p === '/api/config' && req.method === 'POST') {
    const configUrl = String(body.url || '').trim();
    if (!configUrl) return json(res, 400, { error: '缺少配置地址' });
    try {
      const out = await setConfigFromUrl(configUrl);
      return json(res, 200, out);
    } catch (e) {
      return json(res, 502, { error: e.message });
    }
  }

  if (p === '/api/sites' && req.method === 'GET') {
    if (!state.config) return json(res, 400, { error: '尚未加载配置' });
    return json(res, 200, {
      configUrl: state.config.configUrl,
      sites: state.config.sites.map((s) => ({
        key: s.key, name: s.name, type: s.type, api: s.api,
        usesCompanion: s.usesCompanion, unsupported: s.unsupported,
        searchable: s.searchable,
        loaded: !!state.loadedSites.get(s.key)?.ok,
      })),
    });
  }

  if (p === '/api/resolve') {
    try {
      return json(res, 200, await resolvePlayback(req, body));
    } catch (e) {
      const status = e.status || 500;
      return json(res, status, { error: e.message || String(e), ...(e.extra || {}) });
    }
  }

  const needsSite = ['/api/site/load', '/api/home', '/api/category', '/api/detail', '/api/search', '/api/play'];
  if (needsSite.includes(p)) {
    if (!state.config) return json(res, 400, { error: '尚未加载配置' });
    const site = findSite(body.key || body.site);
    if (!site) return json(res, 404, { error: '站点不存在: ' + (body.key || body.site) });
    try {
      if (p === '/api/site/load') {
        const r = await loadSpiderSite(site);
        return json(res, 200, { ...r, site: site.key });
      }
      if (p === '/api/home') {
        const r = normalizePage(await getPage(site, 'home', body));
        return json(res, 200, r);
      }
      if (p === '/api/category') {
        const r = normalizePage(await getPage(site, 'category', body));
        return json(res, 200, r);
      }
      if (p === '/api/search') {
        const r = normalizePage(await getPage(site, 'search', body));
        return json(res, 200, r);
      }
      if (p === '/api/detail') {
        const r = await fetchDetail(site, body.id || body.vodId);
        return json(res, 200, { ...r, site: { key: site.key, name: site.name } });
      }
      if (p === '/api/play') {
        const r = await playByFlag(site, String(body.flag || ''), String(body.id || ''));
        const stream = proxyStreamUrl(r.url, r.headers || {}, req.authToken || '');
        return json(res, 200, {
          ...r,
          type: mediaType(r.url),
          stream,
          streamUrl: absoluteUrl(req, stream),
        });
      }
    } catch (e) {
      return json(res, 500, { error: e.message || String(e), site: site.key });
    }
  }

  return json(res, 404, { error: '未知接口: ' + p });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                             */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlObj) {
  let rel = decodeURIComponent(urlObj.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[\\/])+/, ''));
  if (!file.startsWith(PUBLIC)) return text(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return text(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || HOST}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    const token = extractToken(req, urlObj);
    req.authToken = token;

    // 鉴权：静态页面与 /api/health 公开；其余 /api/* 必须带有效 token。
    const isApi = urlObj.pathname.startsWith('/api/');
    const isPublicApi = urlObj.pathname === '/api/health';
    if (isApi && !isPublicApi && !authOk(token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="tvbox-bridge"');
      return json(res, 401, {
        error: token ? 'token 无效' : '缺少鉴权信息',
        hint: '使用 Authorization: Bearer <token>、X-API-Key: <token> 或 ?token=<token>',
      });
    }

    if (urlObj.pathname === '/api/stream') return await handleStream(req, res, urlObj);
    if (urlObj.pathname === '/api/img') return await handleImage(req, res, urlObj);
    if (urlObj.pathname.startsWith('/local/jar/')) {
      // 仅供本机 companion 拉取预下载 jar，不对外暴露
      if (!isLoopback(req)) return json(res, 403, { error: 'forbidden' });
      const name = path.basename(decodeURIComponent(urlObj.pathname.slice('/local/jar/'.length)));
      const file = path.join(JAR_CACHE, name);
      if (!file.startsWith(JAR_CACHE) || !fs.existsSync(file)) return json(res, 404, { error: 'jar 不存在' });
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
      return res.end(data);
    }
    if (isApi) return await handleApi(req, res, urlObj);
    return serveStatic(req, res, urlObj);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) json(res, 500, { error: e.message || String(e) });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`[tvbox-bridge] http://${shown}:${PORT} (listen ${HOST}:${PORT})`);
  console.log(`[tvbox-bridge] 鉴权: ${AUTH_ENABLED ? `已开启（${AUTH_TOKENS.length} 个 token）` : '未开启'}`);
  console.log(`[tvbox-bridge] 出站代理: ${proxyMode || '直连'}`);
  console.log(`[tvbox-bridge] companion: ${fs.existsSync(COMPANION_JAR) ? COMPANION_JAR : '未构建（先运行 companion-build/build.sh）'}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n[tvbox-bridge] shutdown');
  stopCompanion();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', stopCompanion);