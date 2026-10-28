'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const state = {
    configUrl: '',
    token: localStorage.getItem('tvbox.token') || '',
    authRequired: false,
    sites: [],
    sitesById: new Map(),
    site: null,
    categories: [],
    mode: 'home',
    tid: '',
    wd: '',
    pg: 1,
    pagecount: 1,
    detail: null,
    activeSource: 0,
    hls: null,
    logs: [],
  };

  /* ---------------- 日志 ---------------- */
  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.logs.push(line);
    if (state.logs.length > 300) state.logs.shift();
    $('logs').textContent = state.logs.join('\n');
    $('logs').scrollTop = $('logs').scrollHeight;
    $('logCount').textContent = `(${state.logs.length})`;
  }

  function toast(msg, ms = 4200) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function setStatus(text, kind = '', detail = '') {
    const s = $('statusLine');
    s.className = 'status-line' + (kind === 'error' ? ' error' : '');
    s.replaceChildren();
    if (kind) {
      const dot = el('span', `dot ${kind}`);
      s.append(dot);
    }
    s.append(document.createTextNode(text));
    if (detail) {
      const d = el('div', 'muted', detail);
      d.style.marginTop = '4px';
      d.style.fontSize = '12px';
      s.append(d);
    }
  }

  /* ---------------- API ---------------- */
  async function api(path, body) {
    const started = performance.now();
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      log(`✗ ${path} fetch 失败: ${e.message}`);
      throw e;
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 400) }; }
    const ms = Math.round(performance.now() - started);
    log(`${res.ok ? '✓' : '✗'} ${path} ${res.status} ${ms}ms ${res.ok ? '' : (data.error || '')}`);
    if (res.status === 401) {
      state.authRequired = true;
      toast('需要 API Token：请在右上角填写后重试');
      setStatus('未通过鉴权', 'fail', '服务端已开启 BRIDGE_TOKEN，请在右上角填写 API Token');
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------------- 配置 ---------------- */
  async function loadConfig(url) {
    const btn = $('loadConfig');
    btn.disabled = true;
    setStatus('正在拉取配置…', 'loading');
    try {
      const data = await api('/api/config', { url });
      state.configUrl = data.configUrl || url;
      if (data.kind === 'depot') {
        renderDepot(data.entries);
        setStatus(`多仓清单：${data.entries.length} 个仓库，请选择后加载`, 'ok');
        log(`多仓: ${data.entries.map((e) => e.name).join(' | ')}`);
      } else {
        $('depotBar').classList.add('hidden');
        applySites(data.sites || []);
        setStatus(`已加载配置：${data.siteCount} 个站点 / ${data.parseCount} 条解析`, 'ok',
          data.spider ? `spider: ${data.spider}` : '');
        log(`配置站点类型: ${summarizeTypes(data.sites)}`);
      }
    } catch (e) {
      setStatus('配置加载失败', 'fail', e.message);
      toast('配置加载失败：' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function summarizeTypes(sites) {
    const c = {};
    (sites || []).forEach((s) => { const k = s.usesCompanion ? (s.unsupported ? 'python' : 'spider') : 'cms'; c[k] = (c[k] || 0) + 1; });
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join(', ');
  }

  function renderDepot(entries) {
    state.depotEntries = entries;
    const bar = $('depotBar');
    const sel = $('depotSelect');
    sel.replaceChildren();
    entries.forEach((e, i) => {
      const o = el('option', '', `${e.name} — ${e.url}`);
      o.value = String(i);
      sel.append(o);
    });
    bar.classList.remove('hidden');
    log(`多仓条目: ${entries.map((e) => e.name).join(' | ')}`);
    // 自动加载第一个仓库，减少一步操作
    loadDepot(entries[0].url);
  }

  async function loadDepot(url) {
    if (!url) return;
    const btn = $('loadDepot');
    btn.disabled = true;
    try {
      const data = await api('/api/config', { url });
      if (data.kind === 'depot') { renderDepot(data.entries); return; }
      $('depotBar').classList.add('hidden');
      applySites(data.sites || []);
      setStatus(`已加载仓库：${data.siteCount} 个站点 / ${data.parseCount} 条解析`, 'ok');
    } catch (e) {
      setStatus('仓库加载失败', 'fail', e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function applySites(sites) {
    state.sites = sites;
    state.sitesById = new Map(sites.map((s) => [s.key, s]));
    state.site = null;
    $('siteTitle').textContent = '请选择站点';
    $('siteMeta').textContent = '';
    $('grid').replaceChildren(el('div', 'empty', '选择左侧站点后加载首页'));
    $('categoryBar').replaceChildren();
    $('pager').classList.add('hidden');
    renderSiteList();
  }

  function renderSiteList() {
    const filter = $('siteFilter').value.trim().toLowerCase();
    const list = $('siteList');
    list.replaceChildren();
    const sites = state.sites.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.key.toLowerCase().includes(filter));
    if (!sites.length) { list.append(el('div', 'hint', '没有匹配的站点')); return; }
    for (const s of sites) {
      const item = el('div', 'site-item');
      if (state.site && state.site.key === s.key) item.classList.add('active');
      const name = el('span', 'name', s.name || s.key);
      const badge = el('span', 'badge', s.unsupported ? 'PY' : (s.usesCompanion ? 'Spider' : 'CMS'));
      badge.classList.add(s.unsupported ? 'py' : (s.usesCompanion ? 'spider' : 'cms'));
      item.append(name, badge);
      item.title = `${s.name}\napi: ${s.api}\ntype: ${s.type}`;
      item.addEventListener('click', () => selectSite(s));
      list.append(item);
    }
  }

  /* ---------------- 站点内容 ---------------- */
  async function selectSite(site) {
    state.site = site;
    state.categories = [];
    state.mode = 'home';
    state.tid = '';
    state.wd = '';
    state.pg = 1;
    $('siteFilter').value = '';
    renderSiteList();
    $('siteTitle').textContent = site.name || site.key;
    $('siteMeta').textContent = `${site.usesCompanion ? (site.unsupported ? 'Python（不支持）' : 'Spider / JVM') : 'CMS'} · ${site.api}`;
    $('searchInput').value = '';
    $('categoryBar').replaceChildren();
    $('pager').classList.add('hidden');
    showSkeletons();

    if (!site.usesCompanion || site.unsupported) {
      // CMS 直接拉取
      await loadHome();
      return;
    }

    setStatus('正在启动 companion 并加载 Spider 载荷…首次加固载荷需解密 + dex2jar，约 1-2 分钟', 'loading');
    try {
      await api('/api/site/load', { key: site.key });
      log(`Spider 站点已加载: ${site.name}`);
      await loadHome();
    } catch (e) {
      setStatus('Spider 加载失败', 'fail', e.message);
      $('grid').replaceChildren(el('div', 'empty', '加载失败：' + e.message));
      toast('Spider 加载失败：' + e.message);
    }
  }

  function showSkeletons() {
    const grid = $('grid');
    grid.replaceChildren();
    for (let i = 0; i < 10; i++) grid.append(el('div', 'skeleton'));
  }

  async function loadHome() {
    const site = state.site;
    if (!site) return;
    state.mode = 'home';
    state.tid = '';
    state.pg = 1;
    setStatus('正在加载首页…', 'loading');
    showSkeletons();
    try {
      const page = await api('/api/home', { key: site.key, filter: true });
      renderPage(page, { home: true });
      const cats = page.categories || [];
      if (!page.list.length && cats.length) {
        log(`首页无内容，自动加载首个分类: ${cats[0].name}`);
        await loadCategory(cats[0].id, cats[0].name, 1);
      } else {
        setStatus(`首页：${page.list.length} 条内容${cats.length ? ` · ${cats.length} 个分类` : ''}`, 'ok');
      }
    } catch (e) {
      setStatus('首页加载失败', 'fail', e.message);
      $('grid').replaceChildren(el('div', 'empty', '首页加载失败：' + e.message));
    }
  }

  async function loadCategory(tid, name, pg = 1) {
    const site = state.site;
    if (!site) return;
    state.mode = 'category';
    state.tid = tid;
    state.pg = pg;
    setStatus(`正在加载分类「${name}」第 ${pg} 页…`, 'loading');
    showSkeletons();
    try {
      const page = await api('/api/category', { key: site.key, tid, pg, filter: true });
      renderPage(page);
      setStatus(`分类「${name}」第 ${page.page}/${page.pagecount} 页 · ${page.list.length} 条`, 'ok');
    } catch (e) {
      setStatus('分类加载失败', 'fail', e.message);
      $('grid').replaceChildren(el('div', 'empty', '分类加载失败：' + e.message));
    }
  }

  async function doSearch() {
    const site = state.site;
    if (!site) return toast('请先选择站点');
    const wd = $('searchInput').value.trim();
    if (!wd) return;
    state.mode = 'search';
    state.wd = wd;
    state.pg = 1;
    setStatus(`正在搜索「${wd}」…`, 'loading');
    showSkeletons();
    try {
      const page = await api('/api/search', { key: site.key, wd, quick: false, pg: 1 });
      renderPage(page);
      setStatus(`搜索「${wd}」：${page.list.length} 条结果`, 'ok');
    } catch (e) {
      setStatus('搜索失败', 'fail', e.message);
      $('grid').replaceChildren(el('div', 'empty', '搜索失败：' + e.message));
    }
  }

  function renderPage(page, { home = false } = {}) {
    state.pagecount = Math.max(1, page.pagecount || 1);
    state.pg = page.page || 1;

    const bar = $('categoryBar');
    bar.replaceChildren();
    if (page.categories && page.categories.length) {
      state.categories = page.categories;
      if (home) {
        const all = el('button', 'chip active', '首页');
        all.addEventListener('click', () => loadHome());
        bar.append(all);
      }
      page.categories.forEach((c) => {
        const chip = el('button', 'chip', c.name);
        if (state.mode === 'category' && state.tid === c.id) chip.classList.add('active');
        chip.addEventListener('click', () => loadCategory(c.id, c.name, 1));
        bar.append(chip);
      });
    }

    const grid = $('grid');
    grid.replaceChildren();
    if (!page.list.length) {
      grid.append(el('div', 'empty', '没有内容'));
    } else {
      for (const item of page.list) grid.append(renderCard(item));
    }

    const pager = $('pager');
    if (page.pagecount > 1) {
      pager.classList.remove('hidden');
      $('pageInfo').textContent = `第 ${page.page} / ${page.pagecount} 页`;
      $('prevPage').disabled = page.page <= 1;
      $('nextPage').disabled = page.page >= page.pagecount;
    } else {
      pager.classList.add('hidden');
    }
  }

  function imgSrc(url) {
    if (!url) return '';
    const b64 = btoa(unescape(encodeURIComponent(url))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `/api/img?u=${encodeURIComponent(b64)}${state.token ? `&t=${encodeURIComponent(state.token)}` : ''}`;
  }

  function renderCard(item) {
    const card = el('div', 'card');
    const poster = el('div', 'poster');
    if (item.pic) {
      const img = el('img');
      img.loading = 'lazy';
      img.src = imgSrc(item.pic);
      img.alt = item.name || '';
      img.onerror = () => { img.style.display = 'none'; };
      poster.append(img);
    } else {
      poster.style.display = 'grid';
      poster.style.placeItems = 'center';
      poster.style.color = 'var(--muted)';
      poster.textContent = '无海报';
    }
    if (item.remarks) poster.append(el('span', 'remark', item.remarks));
    const body = el('div', 'card-body');
    body.append(el('div', 'card-title', item.name || item.id));
    body.append(el('div', 'card-sub', [item.typeName, item.year, item.score].filter(Boolean).join(' · ')));
    card.append(poster, body);
    card.addEventListener('click', () => openDetail(item));
    return card;
  }

  /* ---------------- 详情 ---------------- */
  async function openDetail(item) {
    const site = state.site;
    if (!site) return;
    const overlay = $('detailOverlay');
    overlay.classList.remove('hidden');
    $('detailName').textContent = item.name || '';
    $('detailMeta').textContent = '加载详情…';
    $('detailPic').removeAttribute('src');
    $('detailContent').textContent = '';
    $('sourceTabs').replaceChildren();
    $('episodes').replaceChildren(el('div', 'hint', '加载中…'));
    try {
      const data = await api('/api/detail', { key: site.key, id: item.id });
      state.detail = data;
      state.activeSource = 0;
      renderDetail(data, item);
    } catch (e) {
      $('detailMeta').textContent = '';
      $('episodes').replaceChildren(el('div', 'hint', '详情加载失败：' + e.message));
      toast('详情加载失败：' + e.message);
    }
  }

  function renderDetail(data, fallback) {
    const it = data.item || {};
    $('detailName').textContent = it.name || fallback.name || '';
    $('detailMeta').textContent = [it.typeName, it.year, it.area, it.score ? `评分 ${it.score}` : '', it.remarks]
      .filter(Boolean).join(' · ');
    if (it.pic || fallback.pic) $('detailPic').src = imgSrc(it.pic || fallback.pic);
    $('detailContent').textContent = it.content || '暂无简介';

    const tabs = $('sourceTabs');
    tabs.replaceChildren();
    const sources = data.sources || [];
    if (!sources.length) {
      $('episodes').replaceChildren(el('div', 'hint', '没有可播放线路'));
      return;
    }
    sources.forEach((src, i) => {
      const tab = el('button', 'tab', `${src.name} (${src.episodes.length})`);
      if (i === state.activeSource) tab.classList.add('active');
      tab.addEventListener('click', () => { state.activeSource = i; renderDetail(data, fallback); });
      tabs.append(tab);
    });
    const src = sources[Math.min(state.activeSource, sources.length - 1)];
    const eps = $('episodes');
    eps.replaceChildren();
    src.episodes.forEach((ep) => {
      const b = el('button', 'ep', ep.name);
      b.title = ep.url;
      b.addEventListener('click', () => playEpisode(src.name, ep));
      eps.append(b);
    });
  }

  /* ---------------- 播放 ---------------- */
  async function playEpisode(flag, ep) {
    const site = state.site;
    if (!site) return;
    const overlay = $('playerOverlay');
    overlay.classList.remove('hidden');
    $('playerTitle').textContent = `${state.detail?.item?.name || ''} · ${ep.name}`;
    $('playerStatus').textContent = '正在获取播放地址…';
    $('directLink').removeAttribute('href');
    const video = $('video');
    destroyHls();
    video.removeAttribute('src');
    video.load();

    try {
      const r = await api('/api/play', { key: site.key, flag, id: ep.url });
      log(`播放地址: ${r.url}${r.needsParse ? ' (已解析)' : ''}`);
      $('directLink').href = r.url;
      startPlayback(r);
    } catch (e) {
      $('playerStatus').textContent = '播放失败：' + e.message;
      toast('播放失败：' + e.message);
    }
  }

  function startPlayback(r) {
    const video = $('video');
    const url = r.stream;
    const raw = r.url || '';
    const status = $('playerStatus');
    const isMp4 = /\.(mp4|flv)(\?|$)/i.test(raw);
    const isHls = /\.m3u8/i.test(raw) || (!isMp4 && window.Hls && window.Hls.isSupported());

    if (isHls && window.Hls && window.Hls.isSupported()) {
      destroyHls();
      const hls = new window.Hls({ maxBufferLength: 30, enableWorker: true });
      state.hls = hls;
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        status.textContent = '已加载 HLS，开始播放…';
        video.play().catch(() => {});
      });
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) {
          status.textContent = `HLS 错误: ${data.type} / ${data.details}`;
          log(`HLS fatal: ${data.type} ${data.details} ${data.url || ''}`);
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      status.textContent = '正在加载 HLS…';
    } else {
      video.src = url;
      video.play().catch(() => {});
      status.textContent = '已设置直链，点击播放';
    }
  }

  function destroyHls() {
    if (state.hls) {
      try { state.hls.destroy(); } catch {}
      state.hls = null;
    }
  }

  /* ---------------- 事件绑定 ---------------- */
  $('loadConfig').addEventListener('click', () => loadConfig($('configUrl').value.trim()));
  $('configUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadConfig($('configUrl').value.trim()); });
  $('loadDepot').addEventListener('click', () => {
    const entries = state.depotEntries || [];
    const idx = Number($('depotSelect').value || 0);
    const entry = entries[idx];
    if (entry) loadDepot(entry.url);
  });
  $('depotSelect').addEventListener('change', () => {
    const entries = (state.depotEntries = state.depotEntries || []);
    if (entries.length) loadDepot(entries[Number($('depotSelect').value)].url);
  });
  $('siteFilter').addEventListener('input', renderSiteList);
  $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  $('searchBtn').addEventListener('click', doSearch);
  $('refreshSites').addEventListener('click', () => { if (state.sites.length) renderSiteList(); });
  $('prevPage').addEventListener('click', () => gotoPage(state.pg - 1));
  $('nextPage').addEventListener('click', () => gotoPage(state.pg + 1));

  function gotoPage(pg) {
    if (pg < 1 || pg > state.pagecount) return;
    if (state.mode === 'category') {
      const cat = state.categories.find((c) => c.id === state.tid);
      loadCategory(state.tid, cat ? cat.name : state.tid, pg);
    } else if (state.mode === 'search') {
      state.pg = pg;
      $('statusLine').textContent = `搜索结果第 ${pg} 页暂只支持第一页`;
    }
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.close === 'detail') $('detailOverlay').classList.add('hidden');
      if (btn.dataset.close === 'player') {
        $('playerOverlay').classList.add('hidden');
        destroyHls();
        const v = $('video');
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
    });
  });

  $('logToggle').addEventListener('click', () => $('logPanel').classList.toggle('expanded'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('playerOverlay').classList.contains('hidden')) document.querySelector('[data-close="player"]').click();
      else if (!$('detailOverlay').classList.contains('hidden')) $('detailOverlay').classList.add('hidden');
    }
  });

  // 初始提示
  log('就绪。默认配置为饭太硬镜像（qist/tvbox fty.json），点击“加载配置”。');
  setStatus('提示：首次加载 Spider 站点需要启动 JVM 并解密加固载荷，请耐心等待。', '');

  /* ---------------- 鉴权 Token ---------------- */
  const tokenInput = $('apiToken');
  tokenInput.value = state.token;
  tokenInput.addEventListener('change', () => {
    state.token = tokenInput.value.trim();
    localStorage.setItem('tvbox.token', state.token);
    log(state.token ? '已保存 API Token（仅存本机 localStorage）' : '已清除 API Token');
  });

  (async function init() {
    try {
      const h = await (await fetch('/api/health')).json();
      state.authRequired = !!h.auth;
      log(`服务 v${h.version || '?'} · 鉴权${h.auth ? '已开启' : '未开启'} · companion ${h.companion?.running ? '运行中' : '未启动'}`);
      if (h.auth && !state.token) {
        setStatus('服务端已开启鉴权，请在右上角填写 API Token', '');
        toast('服务端已开启鉴权，请填写 API Token');
      }
    } catch (e) {
      log('健康检查失败: ' + e.message);
    }
  })();
})();