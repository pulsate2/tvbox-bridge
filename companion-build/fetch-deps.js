'use strict';

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function matches(file, entry) {
  if (!fs.existsSync(file)) return false;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== entry.bytes) return false;
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return hash === entry.sha256;
}

function main() {
  const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '../companion-src'));
  const lock = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'deps.lock.json'), 'utf8'));
  if (lock.version !== 1 || !Array.isArray(lock.files) || lock.files.length === 0) {
    throw new Error('Invalid companion dependency lock file');
  }

  // Validate all destinations before creating files or starting a download.
  const seen = new Set();
  for (const entry of lock.files) {
    if (!/^companion\/(lib|libs|lib-unidbg)\/[A-Za-z0-9_.-]+\.jar$/.test(entry.path)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || typeof entry.url !== 'string'
        || !entry.url.startsWith('https://repo.maven.apache.org/maven2/')
        || seen.has(entry.path)) {
      throw new Error(`Invalid dependency entry: ${entry.path}`);
    }
    seen.add(entry.path);
  }

  let downloaded = 0;
  for (const entry of lock.files) {
    const destination = path.join(sourceRoot, entry.path);
    if (matches(destination, entry)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.part-${process.pid}`;
    console.log(`[deps] Downloading ${path.basename(destination)}`);
    try {
      // curl also honors HTTP(S)_PROXY on Node 18, without npm dependencies.
      execFileSync('curl', [
        '--fail', '--location', '--silent', '--show-error', '--retry', '2',
        '--connect-timeout', '20', '--max-time', '180',
        '--output', temporary, entry.url,
      ], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      if (!matches(temporary, entry)) {
        throw new Error(`Size or SHA-256 mismatch: ${entry.path}`);
      }
      fs.renameSync(temporary, destination);
      downloaded++;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  console.log(`[deps] Verified ${lock.files.length} jars (${downloaded} downloaded)`);
}

try {
  main();
} catch (error) {
  console.error(`[deps] ${error.message}`);
  process.exitCode = 1;
}
