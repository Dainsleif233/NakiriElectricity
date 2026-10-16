#!/usr/bin/env node
/**
 * 电量采集脚本（GitHub Actions / 本地均可运行）。
 *
 * 与旧版的差异（都来自对 public/data.json 真实读数特征的分析）：
 *  1. 真正生效的超时：旧版 fetch 的 `timeout` 选项在 Node 中被忽略，已改为 AbortSignal.timeout。
 *  2. 按「数值变更」去重：实测读数分辨率是 1 kWh、源站每天只结算一次，
 *     旧版「同小时且变化 <0.01」的判定永远不会命中，680 条读数里 528 条（78%）是重复采样。
 *  3. history 只记录「数值发生变化」的读数；数值没变时不写历史（只按心跳刷新 room_info.lastCheckedAt），
 *     从根上消除 `chore: update electricity data` 空提交（抽样统计：近 80 次数据提交里 68% 只新增了重复值）。
 *  4. 原子写入：先写临时文件再 rename，避免写坏 data.json 导致前端白屏。
 *  5. 校验与护栏：非法/异常读数直接失败退出，绝不写入污染历史；data.json 解析失败也不再「当作空文件重来」。
 *  6. 逐行 JSON：history 每条占一行，git diff 只增加一行，便于回溯。
 *
 * 用法：
 *   TOKEN=... CAMPUS=... BUILDING=... FLOOR=... ROOM=... node scripts/scrape.js
 *   node scripts/scrape.js --dry-run          # 只抓取与判定，不写文件
 *   node scripts/scrape.js --data-file x.json # 指定数据文件（测试用）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CHANGE_EPSILON,
  HEARTBEAT_MS,
  normalizeHistory,
  planUpdate,
  serializeData,
} from '../src/lib/electricity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 参数与配置
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dataFile: path.join(__dirname, '../public/data.json'),
    dryRun: false,
    timeoutMs: 15000,
    retries: 3,
    backoffMs: 1500,
    maxEntries: 20000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i += 1];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--data-file') opts.dataFile = path.resolve(next());
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (arg === '--retries') opts.retries = Number(next());
    else if (arg === '--max-entries') opts.maxEntries = Number(next());
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/scrape.js [--dry-run] [--data-file <path>] [--timeout-ms N] [--retries N]');
      process.exit(0); // 此时还没有任何网络句柄，安全
    }
  }
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));

const ENDPOINT = process.env.ENDPOINT || 'https://ykt.ujs.edu.cn/charge/feeitem/getThirdData';
const ENV = {
  TOKEN: process.env.TOKEN,
  CAMPUS: process.env.CAMPUS,
  BUILDING: process.env.BUILDING,
  FLOOR: process.env.FLOOR,
  ROOM: process.env.ROOM,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(...args) {
  console.log(...args);
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

/** 致命错误：已经打印并写好退出码，不需要再打堆栈。 */
class FatalError extends Error {}

function fail(message) {
  console.error(`✗ ${message}`);
  output('scrape_status', 'failed');
  output('error', String(message).replace(/\n/g, ' '));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### 采集失败\n\n\`${message}\`\n`);
  }
  // 必须用 exitCode 而不是 process.exit()：在 Windows 上，若 fetch 的连接仍在关闭中，
  // process.exit() 会触发 libuv 断言崩溃（退出码 3221226505）而不是干净的 1。
  // 抛异常是为了让调用点立刻停止执行（fail 不是「可继续」的错误处理）。
  process.exitCode = 1;
  throw new FatalError(message);
}

// ---------------------------------------------------------------------------
// 请求参数
// ---------------------------------------------------------------------------

function buildParams() {
  const missing = ['TOKEN', 'CAMPUS', 'BUILDING', 'FLOOR', 'ROOM'].filter(key => !ENV[key]);
  if (missing.length) fail(`缺少环境变量: ${missing.join(', ')}`);

  const params = new URLSearchParams({
    type: 'IEC',
    level: '4',
    feeitemid: '408',
    campus: ENV.CAMPUS,
    building: ENV.BUILDING,
    floor: ENV.FLOOR,
    room: ENV.ROOM,
  });
  return params;
}

function displayName() {
  return [ENV.CAMPUS, ENV.BUILDING, ENV.ROOM].filter(Boolean).join('-');
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(message, { status = null, retryable = true } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = retryable;
  }
}

async function requestOnce(params) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    body: params,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Synjones-Auth': `bearer ${ENV.TOKEN}`,
      // 让服务端在响应后关闭连接：避免 keep-alive 套接字把事件循环多留几秒，
      // 也避免退出时与 undici 的句柄回收竞争
      Connection: 'close',
    },
    // Node 的 fetch 不支持 `timeout` 选项，必须用 AbortSignal，否则请求可能永久挂起
    signal: AbortSignal.timeout(ARGS.timeoutMs),
  });

  const text = await response.text();

  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw new HttpError(`HTTP ${response.status}: ${text.slice(0, 180)}`, { status: response.status, retryable });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError(`响应不是合法 JSON（可能是网关页面）: ${text.slice(0, 180)}`, { retryable: true });
  }

  if (Number(payload.code) !== 200) {
    const authIssue = [401, 403].includes(Number(payload.code));
    throw new HttpError(`接口返回 code=${payload.code} message=${payload.message ?? '(空)'}`, {
      status: Number(payload.code),
      // 令牌失效重试也没用，直接失败让人去换 TOKEN
      retryable: !authIssue,
    });
  }

  const map = payload.map;
  if (!map || typeof map !== 'object') throw new HttpError('响应缺少 map 字段', { retryable: true });
  if (map.showData !== true) throw new HttpError(`showData=${map.showData}，房间参数可能不正确`, { retryable: false });

  return map;
}

async function fetchReading(params) {
  let lastError;
  for (let attempt = 1; attempt <= ARGS.retries; attempt += 1) {
    try {
      log(`→ 第 ${attempt}/${ARGS.retries} 次请求`);
      return await requestOnce(params);
    } catch (error) {
      lastError = error;
      const retryable = !(error instanceof HttpError) || error.retryable;
      log(`  失败: ${error.message}`);
      if (!retryable || attempt === ARGS.retries) break;
      const wait = ARGS.backoffMs * 2 ** (attempt - 1) + Math.random() * 500;
      log(`  ${(wait / 1000).toFixed(1)}s 后重试`);
      await sleep(wait);
    }
  }
  throw lastError;
}

/** 从接口返回中取出剩余电量，并做合理性校验。 */
function extractKWh(map) {
  const raw = map?.data?.lastSd;
  const kWh = Number(raw);
  if (raw === undefined || raw === null || raw === '') throw new Error('响应中缺少 data.lastSd');
  if (!Number.isFinite(kWh)) throw new Error(`data.lastSd 不是数字: ${JSON.stringify(raw)}`);
  if (kWh < 0) throw new Error(`剩余电量为负数: ${kWh}`);
  if (kWh > 100000) throw new Error(`剩余电量异常偏大: ${kWh}`);
  return kWh;
}

// ---------------------------------------------------------------------------
// 数据文件
// ---------------------------------------------------------------------------

function readDataFile() {
  if (!fs.existsSync(ARGS.dataFile)) {
    log('• 数据文件不存在，将创建新文件');
    return { room_info: {}, history: [] };
  }
  const text = fs.readFileSync(ARGS.dataFile, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // 旧版遇到解析失败会「当作空数据重来」，会静默丢掉全部历史，这里必须中止
    fail(`data.json 解析失败（已中止，避免覆盖历史）: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.history)) {
    fail('data.json 结构异常：history 不是数组');
  }
  return parsed;
}

function writeDataFile(data) {
  const tmp = `${ARGS.dataFile}.tmp`;
  fs.writeFileSync(tmp, serializeData(data), 'utf8');
  fs.renameSync(tmp, ARGS.dataFile); // 同目录 rename 是原子操作
}

/**
 * 保留策略：优先保留「变更点」，最后才裁掉最老的重复采样。
 * 实测每天只有 1 次左右的变更，20000 条上限足够几十年。
 */
function trimHistory(entries, maxEntries) {
  if (entries.length <= maxEntries) return { entries, removed: 0 };

  const isChange = entry => entry.src !== 'heartbeat';
  const keep = entries.slice(-maxEntries);
  // 被裁掉的前缀里如果还有变更点，把变更点补回来（数量不会多，因为变更点本就稀疏）
  const dropped = entries.slice(0, entries.length - maxEntries);
  const rescued = dropped.filter(isChange);
  const merged = [...rescued, ...keep];
  return { entries: merged, removed: dropped.length - rescued.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  log(`开始采集 ${displayName()} …`);

  const params = buildParams();
  const data = readDataFile();
  const previousEntries = normalizeHistory(data.history, ENV.ROOM);

  let map;
  try {
    map = await fetchReading(params);
  } catch (error) {
    fail(`抓取失败: ${error.message}`);
  }

  let kWh;
  try {
    kWh = extractKWh(map);
  } catch (error) {
    console.error('原始响应片段:', JSON.stringify(map).slice(0, 400));
    fail(`读数校验失败: ${error.message}`);
  }

  const now = Date.now();
  const previousCheckedAt = data.room_info?.lastCheckedAt ?? null;
  const plan = planUpdate(previousEntries, kWh, now, {
    roomId: ENV.ROOM,
    lastCheckedAt: previousCheckedAt,
  });
  const previousKWh = plan.previousKWh;

  log(`• 本次读数: ${kWh} kWh（上次 ${previousKWh ?? '-'} kWh，变化 ${plan.delta === null ? '-' : plan.delta}）`);
  log(`• 判定结果: ${plan.action}`);

  // 采集间隔本身就是数据质量指标：间隔 > 24h 意味着这段时间里可能有结算没被观测到，
  // 该用电日的消耗会被并进下一天。history 里只存变更点，这个判断只能在采集时做。
  const previousCheckedMs = Date.parse(previousCheckedAt || '') || 0;
  if (previousCheckedMs > 0 && now - previousCheckedMs > 24 * 3600000) {
    const gapHours = ((now - previousCheckedMs) / 3600000).toFixed(1);
    log(`⚠ 距上次成功采集 ${gapHours}h（>24h）：这段时间可能漏掉了一次结算，涉及用电日的统计会偏大`);
    if (process.env.CI) console.log(`::warning::距上次成功采集 ${gapHours}h，可能漏掉一次结算`);
  }

  output('scrape_status', 'success');
  output('current_kwh', kWh);
  output('delta', plan.delta === null ? '' : plan.delta);
  // changed = 读数的值变了（history 增长）；updated = 文件需要重写（含只刷新存活标记的情况）
  output('changed', plan.action === 'append-change' ? 'true' : 'false');
  output('updated', plan.action === 'none' ? 'false' : 'true');

  if (plan.action === 'none') {
    // 关键：数值未变且未到心跳间隔 → 完全不动文件 → 不产生任何提交
    const lastWriteMs = Math.max(
      previousEntries.length ? previousEntries[previousEntries.length - 1].ms : 0,
      Date.parse(previousCheckedAt || '') || 0,
    );
    const ageHours = lastWriteMs ? ((now - lastWriteMs) / 3600000).toFixed(1) : '-';
    log(`⊘ 与上次读数一致（距上次写盘 ${ageHours}h，心跳阈值 ${HEARTBEAT_MS / 3600000}h），跳过写入`);
    log(`✓ 共 ${previousEntries.length} 条历史记录，未改动 ${path.relative(process.cwd(), ARGS.dataFile)}`);
    return;
  }

  const isChange = plan.action === 'append-change';
  const entry = {
    timestamp: new Date(now).toISOString(),
    room_id: ENV.ROOM,
    kWh,
    src: plan.src,
  };

  let history = previousEntries;
  if (isChange) {
    const { entries: trimmed, removed } = trimHistory([...previousEntries, { ...entry, ms: now }], ARGS.maxEntries);
    if (removed > 0) log(`🗑️  裁掉 ${removed} 条最老的记录（上限 ${ARGS.maxEntries}）`);
    history = trimmed;
  }

  const nextData = {
    room_info: {
      roomId: ENV.ROOM,
      displayName: displayName(),
      // updatedAt = 读数最后一次「发生变化」的时刻（history 的语义与之对齐）
      updatedAt: isChange ? entry.timestamp : data.room_info?.updatedAt ?? previousEntries[previousEntries.length - 1]?.timestamp ?? entry.timestamp,
      // lastCheckedAt = 最后一次成功采集的时刻：数值没变时也会刷新它，
      // 前端据此区分「真的没用电」与「采集链路断了」
      lastCheckedAt: new Date(now).toISOString(),
    },
    history: history.map(({ timestamp, room_id, kWh: value, src }) => ({ timestamp, room_id, kWh: value, src })),
  };

  if (ARGS.dryRun) {
    log(isChange
      ? `⊘ --dry-run：将新增 1 条变更记录，共 ${nextData.history.length} 条，未写入文件`
      : `⊘ --dry-run：只刷新 lastCheckedAt，history 保持 ${nextData.history.length} 条，未写入文件`);
    return;
  }

  writeDataFile(nextData);
  log(isChange
    ? `✓ 已写入 ${path.relative(process.cwd(), ARGS.dataFile)}：新增 1 条变更记录，共 ${nextData.history.length} 条`
    : `✓ 已写入 ${path.relative(process.cwd(), ARGS.dataFile)}：数值未变，仅刷新 lastCheckedAt（history 仍为 ${nextData.history.length} 条）`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### 电量采集\n\n- 房间: ${displayName()}\n- 本次读数: **${kWh} kWh**${isChange ? `（${plan.delta > 0 ? '+' : ''}${plan.delta}）` : '（与上次相同）'}\n- ${isChange ? `新增变更记录，共 ${nextData.history.length} 条` : '仅刷新存活标记，history 未增长'}\n`,
    );
  }
}

main().catch(error => {
  if (error instanceof FatalError) return; // 已在 fail() 中打印并设置退出码
  console.error(`✗ 未捕获异常: ${error?.stack || error}`);
  process.exitCode = 1;
});
