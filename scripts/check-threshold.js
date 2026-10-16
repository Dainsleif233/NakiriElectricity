#!/usr/bin/env node
/**
 * 阈值检查：判断当前电量是否低于 THRESHOLD，以及本次是否「刚刚跌破」。
 *
 * 相比旧版内联的一行 node -e：
 *  1. 还能算出「上一次跳变后的读数」，因此可以区分「刚刚跌破」和「一直低于阈值」；
 *  2. 复用 computeStats 给出预计可用天数，提醒内容更有用；
 *  3. 逐项写入 GITHUB_OUTPUT，便于后续步骤引用。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSteps, normalizeHistory, computeStats } from '../src/lib/electricity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '../public/data.json');
const THRESHOLD = Number(process.env.THRESHOLD || 30);

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function main() {
  if (!Number.isFinite(THRESHOLD)) {
    console.error(`✗ THRESHOLD 不是数字: ${process.env.THRESHOLD}`);
    process.exitCode = 1;
    return;
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const roomId = data.room_info?.roomId ?? null;
  const entries = normalizeHistory(data.history, roomId);
  if (entries.length === 0) {
    console.log('没有读数，按「未低于阈值」处理');
    output('current_kwh', '');
    output('previous_kwh', '');
    output('threshold', THRESHOLD);
    output('is_below_threshold', 'false');
    output('crossed_below', 'false');
    output('estimate_days', '');
    return;
  }

  const current = entries[entries.length - 1].kWh;
  // 上一次「不同的」读数：历史里有大量重复采样，直接取倒数第二条会拿到同一个值
  let previous = null;
  for (let i = entries.length - 2; i >= 0; i -= 1) {
    if (Math.abs(entries[i].kWh - current) >= 0.05) { previous = entries[i].kWh; break; }
  }

  const isBelow = current < THRESHOLD;
  const crossed = isBelow && (previous === null || previous >= THRESHOLD);
  // 锚点要与页面一致（room_info.lastCheckedAt），否则「预计可用天数」会和仪表盘对不上
  const stats = computeStats({ history: data.history, roomId, lastCheckedAt: data.room_info?.lastCheckedAt ?? null });
  const steps = buildSteps(entries);

  console.log(`当前电量 ${current} kWh / 阈值 ${THRESHOLD} kWh`);
  console.log(`上一次不同读数: ${previous ?? '(无)'} kWh → 是否刚刚跌破: ${crossed}`);
  if (stats) console.log(`预计可用 ${stats.estimateDays} 天（7 天日均 ${stats.dailyAvg.toFixed(2)} kWh/天，共 ${steps.length} 次跳变）`);

  output('current_kwh', current);
  output('previous_kwh', previous === null ? '' : previous);
  output('threshold', THRESHOLD);
  output('is_below_threshold', String(isBelow));
  output('crossed_below', String(crossed));
  output('estimate_days', stats ? stats.estimateDays : '');

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n### 阈值检查\n\n- 当前: **${current} kWh**（阈值 ${THRESHOLD}）\n- 低于阈值: ${isBelow ? '是' : '否'}${crossed ? '（刚刚跌破）' : ''}\n- 预计可用: ${stats ? `${stats.estimateDays} 天` : '-'}\n`,
    );
  }
}

main();
