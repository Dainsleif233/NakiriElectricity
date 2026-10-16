#!/usr/bin/env node
/**
 * 一次性／可重复运行的迁移工具：把 data.json 压缩为「只保留数值发生变化的读数」并统一为逐行格式。
 * 同值重复采样一律删除（采集链路是否存活由 room_info.lastCheckedAt 单独记录，不占用 history）。
 *
 * 安全性：压缩只删除重复采样，不改变数值序列。脚本会在写入前强制校验
 * 「压缩前后 buildSteps() 完全一致」，不一致就中止，绝不写盘。
 *
 * 用法：
 *   node scripts/compact-data.js                  # 预览（默认不写）
 *   node scripts/compact-data.js --write          # 写入（自动备份 .bak）
 *   node scripts/compact-data.js --tz 480 --write
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSteps, compactHistory, normalizeHistory, serializeData } from '../src/lib/electricity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = {
    dataFile: path.join(__dirname, '../public/data.json'),
    write: false,
    tz: 480,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i += 1];
    if (arg === '--write') opts.write = true;
    else if (arg === '--data-file') opts.dataFile = path.resolve(next());
    else if (arg === '--tz') opts.tz = Number(next());
  }
  return opts;
}

const ARGS = parseArgs(process.argv.slice(2));

function main() {
  const original = fs.readFileSync(ARGS.dataFile, 'utf8');
  const data = JSON.parse(original);
  const history = Array.isArray(data.history) ? data.history : [];
  if (history.length === 0) {
    console.error('✗ history 为空，无需迁移');
    process.exitCode = 1;
    return;
  }

  const roomId = data.room_info?.roomId ?? null;
  const before = normalizeHistory(history, roomId);
  const compacted = compactHistory(history, { roomId });

  // 硬校验：压缩前后跳变序列必须逐条一致
  const beforeSteps = buildSteps(before, ARGS.tz);
  const afterSteps = buildSteps(compacted, ARGS.tz);
  const sameLength = beforeSteps.length === afterSteps.length;
  const sameContent = sameLength && beforeSteps.every((step, index) => {
    const other = afterSteps[index];
    return step.ts === other.ts && step.amount === other.amount && step.type === other.type && step.day === other.day;
  });
  if (!sameContent) {
    console.error('✗ 校验失败：压缩改变了跳变序列，已中止（未写入任何文件）');
    console.error(`  before ${beforeSteps.length} 条 / after ${afterSteps.length} 条`);
    process.exitCode = 1;
    return;
  }

  const counts = {};
  for (const entry of compacted) counts[entry.src] = (counts[entry.src] || 0) + 1;

  // 存活标记不能丢：被删掉的最新同值采样正是「最后一次成功采集」的证据
  const latestSeen = [...before, ...compacted].reduce((max, e) => Math.max(max, e.ms), 0);
  const lastCheckedAt = new Date(Math.max(
    Date.parse(data.room_info?.lastCheckedAt || '') || 0,
    Date.parse(data.room_info?.updatedAt || '') || 0,
    latestSeen,
  )).toISOString();

  const next = {
    room_info: {
      ...data.room_info,
      // updatedAt = 最后一次数值变化；history 的语义与之一致
      updatedAt: compacted[compacted.length - 1].timestamp,
      // lastCheckedAt = 最后一次成功采集（含数值未变的采样）
      lastCheckedAt,
    },
    history: compacted.map(({ timestamp, room_id, kWh, src }) => ({ timestamp, room_id, kWh, src })),
  };
  const nextText = serializeData(next);

  const sizeBefore = Buffer.byteLength(original, 'utf8');
  const sizeAfter = Buffer.byteLength(nextText, 'utf8');
  console.log('数据压缩预览');
  console.log('='.repeat(50));
  console.log(`读数        ${before.length} → ${compacted.length} 条（-${(100 - (compacted.length / before.length) * 100).toFixed(1)}%）`);
  console.log(`体积        ${(sizeBefore / 1024).toFixed(1)} KB → ${(sizeAfter / 1024).toFixed(1)} KB`);
  console.log(`记录类型    ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`跳变校验    ${beforeSteps.length} 条跳变逐条一致 ✓`);
  console.log(`存活标记    lastCheckedAt = ${lastCheckedAt}`);
  console.log(`文件行数    ${original.split('\n').length} → ${nextText.split('\n').length}`);

  if (!ARGS.write) {
    console.log('\n（预览模式，未写入；加 --write 生效）');
    return;
  }

  const backup = `${ARGS.dataFile}.bak`;
  fs.writeFileSync(backup, original, 'utf8');
  const tmp = `${ARGS.dataFile}.tmp`;
  fs.writeFileSync(tmp, nextText, 'utf8');
  fs.renameSync(tmp, ARGS.dataFile);
  console.log(`\n✓ 已写入 ${path.relative(process.cwd(), ARGS.dataFile)}（备份：${path.basename(backup)}）`);
}

main();
