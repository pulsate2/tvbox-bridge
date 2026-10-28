#!/usr/bin/env node
/**
 * 饭太硬源可用性测试（需先启动 server.js）
 *
 * 测试链路与 xiugou-tv 一致：
 *   配置 → Spider 加载 → homeContent → detailContent → playerContent → 媒体可拉取
 *
 * 用法：
 *   node scripts/test-fty.js
 *   node scripts/test-fty.js --sites 光影,瓜子,荐片
 */
'use strict';

const BASE = process.env.BRIDGE_BASE || 'http://127.0.0.1:8787';
const TOKEN = process.env.BRIDGE_TOKEN || process.env.BRIDGE_TOKENS || '';
const CONFIG_URL = process.env.FTY_CONFIG || 'https://raw.githubusercontent.com/qist/tvbox/master/fty.json';
const DEFAULT_SITES = ['光影', '瓜子', '荐片', '热播', '厂长', '立播', '海绵'];

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

function arg(names, fallback) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    for (const n of names) {
      if (a === n && process.argv[i + 1]) return process.argv[i + 1];
      if (a.startsWith(n + '=')) return a.slice(n.length + 1);
    }
  }
  return fallback;
}

async function post(path, body, timeoutMs = 200000) {
  const t = Date.now();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, ms: Date.now() - t };
}

async function fetchText(url, timeoutMs = 30000) {
  const r = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
}

/** 跟随最多 2 层 m3u8，拉取首个分片，确认媒体真的可达。 */
async function checkStream(streamPath) {
  let url = streamPath.startsWith('http') ? streamPath : BASE + streamPath;
  for (let depth = 0; depth < 3; depth++) {
    const res = await fetchText(url, 40000);
    const isPlaylist = /mpegurl/i.test(res.type) || res.text.startsWith('#EXTM3U');
    if (!isPlaylist) {
      return { kind: 'media', status: res.status, type: res.type, bytes: res.text.length };
    }
    const uris = res.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (!uris.length) return { kind: 'playlist-empty', status: res.status };
    const next = uris[0].startsWith('http') ? uris[0] : BASE + uris[0];
    if (depth === 2) return { kind: 'playlist-deep', status: res.status };
    url = next;
  }
  return { kind: 'unknown' };
}

async function testSite(key) {
  const out = { key, steps: [], ok: false, level: 'none' };
  try {
    const home = await post('/api/home', { key, filter: true });
    out.steps.push(`home HTTP ${home.status} in ${home.ms}ms`);
    if (!home.data.list?.length && home.data.error) throw new Error('home: ' + home.data.error);
    let item = home.data.list?.[0];
    if (!item && home.data.categories?.length) {
      const cat = await post('/api/category', { key, tid: home.data.categories[0].id, pg: 1 });
      out.steps.push(`category HTTP ${cat.status} in ${cat.ms}ms`);
      item = cat.data.list?.[0];
    }
    if (!item) throw new Error('首页/分类没有内容');
    out.level = 'data';
    out.steps.push(`item=${item.name}`);

    const detail = await post('/api/detail', { key, id: item.id });
    out.steps.push(`detail HTTP ${detail.status} in ${detail.ms}ms`);
    const source = detail.data.sources?.[0];
    const episode = source?.episodes?.[0];
    if (!episode) throw new Error('没有播放线路/选集');
    out.level = 'detail';
    out.steps.push(`source=${source.name} episodes=${source.episodes.length}`);

    const play = await post('/api/play', { key, flag: source.name, id: episode.url });
    out.steps.push(`play HTTP ${play.status} in ${play.ms}ms`);
    if (!play.data.stream) throw new Error('play: ' + (play.data.error || 'no stream'));
    out.level = 'play';
    out.steps.push(`url=${String(play.data.url).slice(0, 100)}${play.data.url.length > 100 ? '…' : ''}`);

    const media = await checkStream(play.data.stream);
    out.steps.push(`media=${JSON.stringify(media)}`);
    if (media.kind === 'media' && media.status >= 200 && media.status < 300) {
      out.ok = true;
      out.level = 'media';
    } else {
      out.error = `媒体不可达: ${JSON.stringify(media)}`;
    }

    // 一步解析（第三方最常用的入口）：用片名再走一遍
    if (out.ok && item.name) {
      const one = await post('/api/resolve', { site: key, name: item.name });
      if (one.status === 200 && one.data.stream) {
        const oneMedia = await checkStream(one.data.stream);
        const oneOk = oneMedia.kind === 'media' && oneMedia.status >= 200 && oneMedia.status < 300;
        out.steps.push(`resolve "${item.name}" → ${one.data.type} in ${one.ms}ms, media=${oneMedia.kind}/${oneMedia.status}`);
        if (!oneOk) out.steps.push('  ! /api/resolve 返回的 stream 不可达');
      } else {
        out.steps.push(`resolve "${item.name}" → HTTP ${one.status} ${one.data.error || ''}`);
      }
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

(async () => {
  const sites = (arg(['--sites'], '') || DEFAULT_SITES.join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);

  console.log(`[test] bridge: ${BASE}`);
  console.log(`[test] 鉴权: ${TOKEN ? '已提供 token' : '未提供 token（服务端开启鉴权时会 401）'}`);
  console.log(`[test] 饭太硬配置: ${CONFIG_URL}`);
  const cfg = await post('/api/config', { url: CONFIG_URL }, 60000);
  if (cfg.status !== 200) {
    console.error('[test] 配置加载失败:', cfg.data.error || cfg.status);
    process.exit(2);
  }
  console.log(`[test] 配置 OK: ${cfg.data.siteCount} 站点 / ${cfg.data.parseCount} 解析 (${cfg.ms}ms)\n`);

  const results = [];
  for (const key of sites) {
    const t = Date.now();
    process.stdout.write(`[test] ${key} ... `);
    const r = await testSite(key);
    r.ms = Date.now() - t;
    results.push(r);
    console.log(`${r.ok ? '✅' : '❌'} ${r.level} (${r.ms}ms)`);
    for (const step of r.steps) console.log(`        · ${step}`);
    if (r.error) console.log(`        ! ${r.error}`);
  }

  const ok = results.filter((r) => r.ok).length;
  console.log('\n===== 汇总 =====');
  for (const r of results) {
    const mark = r.ok ? '✅ 可播放' : r.level === 'play' ? '⚠️ 有播放地址但媒体不可达' : r.level === 'detail' ? '⚠️ 详情可出，播放失败' : '❌ 数据不可用';
    console.log(`${mark}  ${r.key}  (${r.level}, ${r.ms}ms)${r.error ? '  — ' + r.error : ''}`);
  }
  console.log(`\n可播放站点: ${ok}/${results.length}`);
  process.exit(ok > 0 ? 0 : 1);
})().catch((e) => {
  console.error('[test] FATAL', e);
  process.exit(1);
});