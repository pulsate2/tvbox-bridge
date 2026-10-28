// 冒烟测试：启动 companion，加载饭太硬载荷并调用 homeContent
const { spawn } = require('child_process');
const path = require('path');

const DIST = path.resolve(__dirname, '../companion/dist');
const JAR = 'https://raw.githubusercontent.com/qist/tvbox/master/jar/fan.txt;md5;b55978c4fe6d12e2fea9075f17c8a67a';
const SITE = { key: '厂长', api: 'csp_NewCzGuard', ext: '', jar: JAR };

(async () => {
  const proc = spawn('java', ['-Xms16m', '-Xmx256m', '-XX:MaxMetaspaceSize=128m', '-XX:+UseSerialGC',
    '-jar', path.join(DIST, 'companion-service.jar'), '--port=0'], { cwd: DIST, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write('[companion:err] ' + d));
  let buf = '';
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ready timeout')), 15000);
    proc.stdout.on('data', d => {
      buf += d.toString();
      process.stdout.write('[companion] ' + d);
      const m = buf.match(/\[COMPANION_READY\] PORT=(\d+)/);
      if (m) { clearTimeout(t); resolve(+m[1]); }
    });
    proc.on('exit', c => reject(new Error('companion exited ' + c)));
  });
  const base = `http://127.0.0.1:${port}`;
  console.log('port', port);

  async function post(url, body, timeout = 60000) {
    const started = Date.now();
    const res = await fetch(base + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    console.log(`\n==> ${url} ${res.status} ${Date.now() - started}ms\n${text.slice(0, 2000)}`);
    return text;
  }

  await post('/spider/load', { ...SITE, timeoutMs: '180000' }, 190000);
  await post('/spider/call', { ...SITE, method: 'homeContent', filter: 'false', timeoutMs: '120000' }, 130000);
  await post('/spider/call', { ...SITE, method: 'categoryContent', tid: '1', pg: '1', filter: 'false', timeoutMs: '120000' }, 130000);
  await post('/spider/call', { ...SITE, method: 'searchContent', wd: '哪吒', quick: 'false', pg: '1', timeoutMs: '120000' }, 130000);

  await fetch(base + '/shutdown', { method: 'POST' }).catch(() => {});
  setTimeout(() => { try { proc.kill(); } catch {} process.exit(0); }, 1500);
})().catch(e => { console.error('FAIL', e); process.exit(1); });