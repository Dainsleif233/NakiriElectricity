#!/usr/bin/env node
/**
 * 数据质量报告：把 public/data.json 的真实特征打印出来，并对「采集策略是否仍然合适」给出告警。
 *
 * 用法:
 *   node scripts/analyze-data.js            # 人类可读报告
 *   node scripts/analyze-data.js --json     # 机器可读
 *   node scripts/analyze-data.js --tz 480   # 指定时区偏移（分钟，默认 +480 即中国）
 *
 * 在 GitHub Actions 中运行时会同时写入 \$GITHUB_STEP_SUMMARY。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DAY_BOUNDARY_HOUR,
  READ_RESOLUTION,
  compactHistory,
  estimateSettlementHour,
  formatIn,
  summarizeHistory,
  toMs,
} from '../src/lib/electricity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '../public/data.json');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const tzIndex = args.indexOf('--tz');
const TZ = tzIndex >= 0 ? Number(args[tzIndex + 1]) : 480;

const hours = ms => (ms / 3600000).toFixed(1);
const pad = (text, width) => String(text).padEnd(width);

function load() {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  return { raw, history: Array.isArray(raw.history) ? raw.history : [] };
}

function buildReport() {
  const { raw, history } = load();
  const summary = summarizeHistory(history, TZ);

  // 归因口径对比：跳变观测日 vs 结算口径用电日（后者是当前实现）
  const compact = compactHistory(history, { roomId: raw.room_info?.roomId ?? null });
  const steps = summary.consumptionSteps;

  const warnings = [];
  if (summary.nonIntegerReadings > 0) {
    warnings.push(`读数出现 ${summary.nonIntegerReadings} 个小数值，分辨率不再是 ${READ_RESOLUTION} kWh 台阶：可下调 CHANGE_EPSILON 以捕捉更细的消耗。`);
  }
  // 结算小时只有在「采样间隔远小于 24h」时才能被反推出来。
  // history 现在只存变更点（间隔 ~24h），任何时刻都落在每个跳变的观测区间内，
  // 估计值会退化成 0:00，因此这种情况直接跳过而不是误报。
  const canEstimateSettlement = summary.gapMs.p50 !== null && summary.gapMs.p50 <= 12 * 3600000;
  if (canEstimateSettlement && summary.settlement.hour !== null && Math.abs(summary.settlement.hour - DAY_BOUNDARY_HOUR) > 2) {
    warnings.push(`结算小时估计为 ${summary.settlement.hour}:00，与常量 DAY_BOUNDARY_HOUR=${DAY_BOUNDARY_HOUR} 相差 >2h，建议更新 src/lib/electricity.js。`);
  }
  // 采集频率是否合适，看的是「源站每天结算几次」，而不是文件里存了多少条心跳
  if (summary.usageDays > 0) {
    const stepsPerDay = summary.consumptionSteps / summary.usageDays;
    if (stepsPerDay > 1.5) {
      warnings.push(`源站结算频率升到 ${stepsPerDay.toFixed(2)} 次/天：建议把 workflow 的 cron 调密（例如每小时），以免把多次结算观测成一次。`);
    } else if (stepsPerDay < 0.6) {
      warnings.push(`源站结算频率降到 ${stepsPerDay.toFixed(2)} 次/天：可放宽 cron，省去无意义的 Actions 运行与提交。`);
    }
  }

  // 采样链路的健康度看 room_info.lastCheckedAt，而不是 history 的间隔 ——
  // history 只在数值变化时增长，假期连续几天没有新条目是正常的。
  const lastCheckedMs = toMs(raw.room_info?.lastCheckedAt);
  if (Number.isFinite(lastCheckedMs)) {
    const checkAgeHours = (Date.now() - lastCheckedMs) / 3600000;
    if (checkAgeHours > 30) {
      warnings.push(`距上次成功采集已 ${checkAgeHours.toFixed(1)}h（心跳间隔 12h）：采集链路可能已中断，建议检查 Actions 运行记录。`);
    }
  }
  if (summary.totalRecharge > 0 && summary.totalConsumption > 0) {
    const balance = summary.totalConsumption - summary.totalRecharge;
    if (Math.abs(balance) < 1e-6) warnings.push('消耗与充值累计正好抵消：序列自洽性异常，请确认数据未被截断。');
  }

  return { room: raw.room_info ?? null, summary, compactCount: compact.length, steps, warnings, canEstimateSettlement };
}

function render({ room, summary, compactCount, warnings, canEstimateSettlement }) {
  const lines = [];
  const range = summary.readings
    ? `${formatIn(summary.firstMs, 'yyyy-MM-dd HH:mm', TZ)} → ${formatIn(summary.lastMs, 'yyyy-MM-dd HH:mm', TZ)}`
    : '-';
  const days = summary.readings ? (summary.lastMs - summary.firstMs) / 86400000 : 0;

  lines.push('电量数据特征报告');
  lines.push('='.repeat(58));
  lines.push(`房间            ${room?.displayName ?? '-'} (roomId=${room?.roomId ?? '-'})`);
  lines.push(`时区偏移        UTC+${(TZ / 60).toFixed(1)}h`);
  lines.push(`数据区间        ${range}（${days.toFixed(1)} 天）`);
  lines.push('');
  lines.push('读数特征');
  lines.push('-'.repeat(58));
  lines.push(`原始读数        ${summary.readings} 条`);
  lines.push(`不同数值        ${summary.distinctValues} 个（区间 ${summary.minKWh} ~ ${summary.maxKWh} kWh）`);
  lines.push(`非整数读数      ${summary.nonIntegerReadings} 条  → 分辨率 ${READ_RESOLUTION} kWh 台阶`);
  lines.push(`变更点/重复采样 ${summary.changeEntries} 条 / ${summary.redundantReadings} 条`);
  lines.push(compactCount < summary.readings
    ? `压缩后可保留    ${compactCount} 条（只留变更点，-${(100 - (compactCount / summary.readings) * 100).toFixed(1)}%）`
    : '存储格式        只存变更点，无同值重复采样');
  lines.push('');
  lines.push('跳变节奏');
  lines.push('-'.repeat(58));
  lines.push(`消耗跳变        ${summary.consumptionSteps} 次，合计 ${summary.totalConsumption} kWh`);
  lines.push(`充值跳变        ${summary.rechargeSteps} 次，合计 ${summary.totalRecharge} kWh（净跳变，非精确充值额）`);
  lines.push(`用电日          ${summary.usageDays} 天，日均 ${(summary.totalConsumption / Math.max(1, summary.usageDays)).toFixed(2)} kWh`);
  lines.push(`日均跳变次数    ${(summary.consumptionSteps / Math.max(1, summary.usageDays)).toFixed(2)} 次/天  → 源站约每日结算一次`);
  lines.push('');
  lines.push('采样间隔');
  lines.push('-'.repeat(58));
  lines.push(`min ${hours(summary.gapMs.min)}h | p50 ${hours(summary.gapMs.p50)}h | p90 ${hours(summary.gapMs.p90)}h | max ${hours(summary.gapMs.max)}h`);
  if (summary.coarseSteps > 0) {
    lines.push(`>24h 间隔       ${summary.coarseSteps} 次（含「某天没有用电」，不再单独告警；漏采由运行日志与页面横幅反映）`);
  }
  lines.push('');
  lines.push('结算时刻');
  lines.push('-'.repeat(58));
  lines.push(canEstimateSettlement
    ? `估计结算小时    本地 ${summary.settlement.hour}:00（${summary.settlement.support}/${summary.settlement.total} 次下降跳变支持）`
    : `估计结算小时    无法反推（只存变更点，间隔 ~${hours(summary.gapMs.p50)}h）；DAY_BOUNDARY_HOUR=${DAY_BOUNDARY_HOUR} 来自原始逐次采样的统计`);
  lines.push(`用电日边界      本地 ${DAY_BOUNDARY_HOUR}:00（src/lib/electricity.js）`);
  lines.push('');
  lines.push('告警');
  lines.push('-'.repeat(58));
  if (warnings.length === 0) lines.push('无：当前采集与后处理策略与数据特征一致。');
  else warnings.forEach(item => lines.push(`! ${item}`));

  return lines.join('\n');
}

const report = buildReport();
if (asJson) {
  console.log(JSON.stringify({
    room: report.room,
    summary: report.summary,
    compactCount: report.compactCount,
    warnings: report.warnings,
  }, null, 2));
} else {
  const text = render(report);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`\n${text}\n\`\`\`\n`);
  }
}

// 让 CI 能感知「策略已不匹配数据特征」
if (report.warnings.length > 0 && process.env.CI) {
  for (const warning of report.warnings) console.log(`::warning::${warning}`);
}
