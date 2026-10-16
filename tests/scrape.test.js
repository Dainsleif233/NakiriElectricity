import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPER = path.join(__dirname, '../scripts/scrape.js');

/**
 * 启动一个假的校园接口，按 `responses` 队列依次返回。
 * 注意：调用方必须用异步 spawn 启动子进程 —— spawnSync 会阻塞事件循环，
 * 让同进程内的假服务器永远无法响应，从而形成死锁。
 */
function startFakeApi(responses) {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    state.calls += 1;
    const body = responses[Math.min(state.calls - 1, responses.length - 1)];
    res.writeHead(body.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(typeof body.raw === 'string' ? body.raw : JSON.stringify(body.payload));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      state,
      url: `http://127.0.0.1:${server.address().port}/`,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

const okPayload = kWh => ({ payload: { code: 200, map: { showData: true, data: { lastSd: String(kWh) } } } });

function runScraper({ url, dataFile, outputFile, extraArgs = [], extraEnv = {} }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      SCRAPER,
      '--data-file', dataFile,
      '--timeout-ms', '5000',
      '--retries', '2',
      ...extraArgs,
    ], {
      env: {
        ...process.env,
        ENDPOINT: url,
        TOKEN: 'test-token',
        CAMPUS: '校本部',
        BUILDING: 'C区',
        FLOOR: '1',
        ROOM: '1-1-101',
        GITHUB_OUTPUT: outputFile,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function readOutputs(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) map[line.slice(0, index)] = line.slice(index + 1);
  }
  return map;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nakiri-'));
}

test('首次采集：创建 data.json 并写入 start 记录', async t => {
  const api = await startFakeApi([okPayload(348)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const outputFile = path.join(dir, 'out.txt');

  const result = await runScraper({ url: api.url, dataFile, outputFile });
  assert.equal(result.status, 0, result.stderr);

  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(data.history.length, 1);
  assert.equal(data.history[0].kWh, 348);
  assert.equal(data.history[0].src, 'start');
  assert.equal(data.room_info.displayName, '校本部-C区-1-1-101');

  const outputs = readOutputs(outputFile);
  assert.equal(outputs.scrape_status, 'success');
  assert.equal(outputs.changed, 'true');
  assert.equal(outputs.current_kwh, '348');
});

test('读数未变化：不落盘、不产生空提交', async t => {
  const api = await startFakeApi([okPayload(348), okPayload(348)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const outputFile = path.join(dir, 'out.txt');

  assert.equal((await runScraper({ url: api.url, dataFile, outputFile })).status, 0);
  const before = fs.readFileSync(dataFile, 'utf8');
  const beforeStat = fs.statSync(dataFile).mtimeMs;

  const second = await runScraper({ url: api.url, dataFile, outputFile });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before, '文件内容必须保持不变');
  assert.equal(fs.statSync(dataFile).mtimeMs, beforeStat, '不应重写文件');
  assert.equal(readOutputs(outputFile).changed, 'false');
  assert.match(second.stdout, /跳过写入/);
});

test('数值下降：追加 change 记录并保持逐行格式', async t => {
  const api = await startFakeApi([okPayload(348), okPayload(340)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const outputFile = path.join(dir, 'out.txt');

  await runScraper({ url: api.url, dataFile, outputFile });
  const second = await runScraper({ url: api.url, dataFile, outputFile });
  assert.equal(second.status, 0, second.stderr);

  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(data.history.length, 2);
  assert.equal(data.history[1].kWh, 340);
  assert.equal(data.history[1].src, 'change');
  assert.equal(readOutputs(outputFile).delta, '-8');

  // 每条读数应当是独立一行，避免 git diff 大段重排
  const lines = fs.readFileSync(dataFile, 'utf8').split('\n');
  assert.equal(lines.filter(line => line.includes('"kWh"')).length, 2);
});

test('长时间未变：超过心跳间隔后只刷新 lastCheckedAt，history 不变长', async t => {
  const api = await startFakeApi([okPayload(100)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const outputFile = path.join(dir, 'out.txt');

  const stale = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  fs.writeFileSync(dataFile, JSON.stringify({
    room_info: { roomId: '1-1-101', displayName: '校本部-C区-1-1-101', updatedAt: stale },
    history: [{ timestamp: stale, room_id: '1-1-101', kWh: 100, src: 'start' }],
  }));

  const result = await runScraper({ url: api.url, dataFile, outputFile });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(data.history.length, 1, '同值读数不应写进 history');
  assert.equal(data.room_info.updatedAt, stale, 'updatedAt 应保持「最后一次数值变化」');
  assert.ok(Date.parse(data.room_info.lastCheckedAt) > Date.now() - 60000, 'lastCheckedAt 应刷新到本次采集');

  const outputs = readOutputs(outputFile);
  assert.equal(outputs.changed, 'false', '值没变 → changed=false');
  assert.equal(outputs.updated, 'true', '但文件需要重写 → updated=true');
});

test('数值未变且未到心跳间隔：完全不写盘，不产生提交', async t => {
  const api = await startFakeApi([okPayload(100)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const outputFile = path.join(dir, 'out.txt');

  const recent = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const original = JSON.stringify({
    room_info: { roomId: '1-1-101', displayName: '校本部-C区-1-1-101', updatedAt: recent, lastCheckedAt: recent },
    history: [{ timestamp: recent, room_id: '1-1-101', kWh: 100, src: 'start' }],
  });
  fs.writeFileSync(dataFile, original);

  const result = await runScraper({ url: api.url, dataFile, outputFile });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), original, '文件必须逐字节不变');
  assert.equal(readOutputs(outputFile).updated, 'false');
});

test('--dry-run：只判定不写盘', async t => {
  const api = await startFakeApi([okPayload(200)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const outputFile = path.join(dir, 'out.txt');

  fs.writeFileSync(dataFile, JSON.stringify({
    room_info: { roomId: '1-1-101' },
    history: [{ timestamp: new Date(Date.now() - 3600000).toISOString(), room_id: '1-1-101', kWh: 100 }],
  }));
  const before = fs.readFileSync(dataFile, 'utf8');

  const result = await runScraper({ url: api.url, dataFile, outputFile, extraArgs: ['--dry-run'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), before);
  assert.match(result.stdout, /dry-run/);
});

test('接口返回非 200：失败退出且不破坏已有数据', async t => {
  const api = await startFakeApi([{ payload: { code: 401, message: 'token expired' } }]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const outputFile = path.join(dir, 'out.txt');

  const original = JSON.stringify({
    room_info: { roomId: '1-1-101' },
    history: [{ timestamp: '2026-01-01T00:00:00.000Z', room_id: '1-1-101', kWh: 100 }],
  });
  fs.writeFileSync(dataFile, original);

  const result = await runScraper({ url: api.url, dataFile, outputFile });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), original, '数据文件必须保持原样');
  assert.equal(readOutputs(outputFile).scrape_status, 'failed');
  assert.equal(api.state.calls, 1, '令牌失效不应重试');
});

test('响应不是 JSON（网关页面）：重试后失败退出', async t => {
  const api = await startFakeApi([{ raw: '<html>502 Bad Gateway</html>' }]);
  t.after(() => api.close());
  const dir = tmpDir();
  const result = await runScraper({ url: api.url, dataFile: path.join(dir, 'data.json'), outputFile: path.join(dir, 'out.txt') });
  assert.equal(result.status, 1);
  assert.equal(api.state.calls, 2, 'HTTP 层可重试的错误应当重试');
});

test('服务端 5xx：重试后成功', async t => {
  const api = await startFakeApi([{ status: 500, raw: 'oops' }, okPayload(77)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');
  const result = await runScraper({ url: api.url, dataFile, outputFile: path.join(dir, 'out.txt') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(api.state.calls, 2);
  assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).history[0].kWh, 77);
});

test('showData=false：房间参数错误，不重试', async t => {
  const api = await startFakeApi([{ payload: { code: 200, map: { showData: false, data: null } } }]);
  t.after(() => api.close());
  const dir = tmpDir();
  const result = await runScraper({ url: api.url, dataFile: path.join(dir, 'data.json'), outputFile: path.join(dir, 'out.txt') });
  assert.equal(result.status, 1);
  assert.equal(api.state.calls, 1);
});

test('data.json 解析失败：中止而不是清空历史', async t => {
  const api = await startFakeApi([okPayload(50)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const dataFile = path.join(dir, 'data.json');

  fs.writeFileSync(dataFile, '{ this is not json');
  const result = await runScraper({ url: api.url, dataFile, outputFile: path.join(dir, 'out.txt') });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), '{ this is not json');
  assert.match(result.stderr, /解析失败/);
});

test('缺少环境变量：立即失败并说明缺了什么', async t => {
  const api = await startFakeApi([okPayload(50)]);
  t.after(() => api.close());
  const dir = tmpDir();
  const result = await runScraper({
    url: api.url,
    dataFile: path.join(dir, 'data.json'),
    outputFile: path.join(dir, 'out.txt'),
    extraEnv: { TOKEN: '', CAMPUS: '', BUILDING: '', FLOOR: '', ROOM: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺少环境变量/);
});
