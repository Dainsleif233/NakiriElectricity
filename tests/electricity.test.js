import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGE_EPSILON,
  DAY_BOUNDARY_HOUR,
  buildSteps,
  collapseValueRuns,
  compactHistory,
  computeStats,
  estimateSettlementHour,
  formatIn,
  normalizeHistory,
  planUpdate,
  serializeData,
  summarizeHistory,
  usageDayFor,
} from '../src/lib/electricity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TZ = 480; // 项目面向中国校园，报告统一用 UTC+8
const REAL_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data.json'), 'utf8'));

const ts = text => Date.parse(text); // 传入 UTC ISO 字符串

test('usageDayFor: 05:00 之后的结算归属到前一个用电日', () => {
  // 实测样本：2026-10-16 07:38 (UTC+8) 观察到 59→51，上次读数 04:59
  const prev = ts('2026-10-15T20:59:49.615Z'); // 本地 10-16 04:59
  const cur = ts('2026-10-15T23:38:32.059Z');  // 本地 10-16 07:38
  assert.equal(usageDayFor(prev, cur, TZ), '2026-10-15');
});

test('usageDayFor: 区间内未跨边界（两次采样都在 05:00 之后）仍归属前一日', () => {
  // 实测样本：2026-07-12 本地 10:49 → 14:04，旧规则会错误地算成 07-12 并制造 45 kWh 假峰
  const prev = ts('2026-07-12T02:49:44.846Z'); // 本地 10:49
  const cur = ts('2026-07-12T06:04:37.293Z');  // 本地 14:04
  assert.equal(usageDayFor(prev, cur, TZ), '2026-07-11');
});

test('usageDayFor: 凌晨采样跨过前一天的边界时归属更早的用电日', () => {
  const prev = ts('2026-07-10T18:00:00.000Z'); // 本地 07-11 02:00
  const cur = ts('2026-07-10T20:30:00.000Z');  // 本地 07-11 04:30 → 未到 05:00
  // 区间内唯一边界是 07-11 05:00？不，04:30 < 05:00，因此区间内边界为 07-11 05:00 之外的 07-10 05:00（早于 prev）
  // 结论：区间内没有边界，回退到「本次读数所在日 - 1 天」= 07-10
  assert.equal(usageDayFor(prev, cur, TZ), '2026-07-10');
});

test('planUpdate: 未变化且未到心跳 → none（不产生空提交）', () => {
  const history = [{ timestamp: '2026-10-16T03:00:00.000Z', room_id: 'r', kWh: 51 }];
  const now = ts('2026-10-16T06:00:00.000Z');
  assert.equal(planUpdate(history, 51, now).action, 'none');
});

test('planUpdate: 数值变化 → append-change，并给出 delta', () => {
  const history = [{ timestamp: '2026-10-16T03:00:00.000Z', room_id: 'r', kWh: 59 }];
  const plan = planUpdate(history, 51, ts('2026-10-16T06:00:00.000Z'));
  assert.equal(plan.action, 'append-change');
  assert.equal(plan.delta, -8);
  assert.equal(plan.previousKWh, 59);
});

test('planUpdate: 数值未变但超过心跳间隔 → touch（只刷新存活标记，历史不增长）', () => {
  const history = [{ timestamp: '2026-10-16T03:00:00.000Z', room_id: 'r', kWh: 51 }];
  const plan = planUpdate(history, 51, ts('2026-10-16T16:00:00.000Z'));
  assert.equal(plan.action, 'touch');
  assert.equal(plan.src, null, 'touch 不应产生历史条目');
});

test('planUpdate: 刚 touch 过就不重复写盘（心跳按「距上次写盘」计时）', () => {
  const history = [{ timestamp: '2026-10-16T03:00:00.000Z', room_id: 'r', kWh: 51 }];
  // 历史最后一条已经 20h 前，但 2h 前刚 touch 过 → 本次不应再写
  const plan = planUpdate(history, 51, ts('2026-10-16T12:00:00.000Z'), {
    lastCheckedAt: '2026-10-16T10:00:00.000Z',
  });
  assert.equal(plan.action, 'none');
});

test('compactHistory / collapseValueRuns: 同值记录一律不保留', () => {
  const history = [
    { timestamp: '2026-01-01T00:00:00.000Z', room_id: 'r', kWh: 10 },
    { timestamp: '2026-01-01T12:00:00.000Z', room_id: 'r', kWh: 10 },
    { timestamp: '2026-01-02T00:00:00.000Z', room_id: 'r', kWh: 9 },
    { timestamp: '2026-01-02T12:00:00.000Z', room_id: 'r', kWh: 9 },
    { timestamp: '2026-01-03T00:00:00.000Z', room_id: 'r', kWh: 9 },
  ];
  const compacted = compactHistory(history, { roomId: 'r' });
  assert.deepEqual(compacted.map(entry => entry.kWh), [10, 9]);

  // 图表用的折叠：每段只留第一个点，因此相邻两点数值必不相同 → 图上不会出现水平线
  const points = history.map(entry => ({ val: entry.kWh }));
  const collapsed = collapseValueRuns(points, point => point.val);
  assert.deepEqual(collapsed.map(point => point.val), [10, 9]);
});

test('planUpdate: 空历史 → 首条 start', () => {
  assert.equal(planUpdate([], 100, Date.now()).src, 'start');
});

test('serializeData: 逐行 history 且可无损解析', () => {
  const data = {
    room_info: { roomId: 'r', displayName: 'a-b-c', updatedAt: '2026-01-01T00:00:00.000Z' },
    history: [
      { timestamp: '2026-01-01T00:00:00.000Z', room_id: 'r', kWh: 1, src: 'start' },
      { timestamp: '2026-01-02T00:00:00.000Z', room_id: 'r', kWh: 2, src: 'change' },
    ],
  };
  const text = serializeData(data);
  // 每条读数是独立一行，git diff 只会新增一行
  assert.equal(text.split('\n').filter(line => line.includes('"kWh"')).length, 2);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), data);
});

test('normalizeHistory: 过滤非法项、去重、按时间排序', () => {
  const cleaned = normalizeHistory([
    { timestamp: '2026-01-02T00:00:00.000Z', kWh: 2 },
    { timestamp: 'bad', kWh: 5 },
    { timestamp: '2026-01-01T00:00:00.000Z', kWh: 1 },
    { timestamp: '2026-01-02T00:00:00.000Z', kWh: 2 },
    { timestamp: '2026-01-03T00:00:00.000Z', kWh: -1 },
    null,
  ], 'r');
  assert.deepEqual(cleaned.map(e => e.kWh), [1, 2]);
  assert.equal(cleaned[0].room_id, 'r');
});

test('真实数据：读数是 1 kWh 台阶，且源站每个用电日只结算一次', () => {
  const summary = summarizeHistory(REAL_DATA.history, TZ);
  assert.equal(summary.nonIntegerReadings, 0, '源站读数应当都是整数');
  assert.equal(summary.redundantReadings, 0, '迁移后的 history 不应再有同值重复采样');

  // 日均跳变 ≈ 1 次/天：这正是「采集再密也只是重复采样」的依据
  const stepsPerDay = summary.consumptionSteps / summary.usageDays;
  assert.ok(stepsPerDay > 0.9 && stepsPerDay < 1.1, `日均消耗跳变应当接近 1 次，实际 ${stepsPerDay.toFixed(2)}`);

  // 只存变更点后，相邻条目的间隔本来就有 ~24h，结算小时因此无法再从历史里反推；
  // 该常量来自原始逐次采样的统计，由 estimateSettlementHour 的合成数据测试守护。
  assert.ok(summary.gapMs.p50 > 20 * 3600000, '变更点之间的间隔应接近一天');
  assert.equal(DAY_BOUNDARY_HOUR, 5, '用电日边界常量不应被误改');
});

test('compactHistory：在冗余采样序列上压缩 >50% 且跳变逐条保留', () => {
  // 构造：每天 8 次 3 小时采样（旧版 cron 的节奏），其中只有 1 次携带新信息
  const history = [];
  let kWh = 500;
  for (let day = 0; day < 20; day += 1) {
    for (let hour = 0; hour < 24; hour += 3) {
      const at = Date.UTC(2026, 0, 1 + day, hour, 0, 0);
      // 每天本地 06:00（UTC 22:00）之后才出现新的结算值
      const value = kWh - (hour >= 21 ? 0 : 10);
      history.push({ timestamp: new Date(at).toISOString(), room_id: 'r', kWh: value });
    }
    kWh -= 10;
  }

  const original = buildSteps(normalizeHistory(history), TZ);
  const compacted = compactHistory(history, { roomId: 'r' });
  const afterCompact = buildSteps(compacted, TZ);

  assert.ok(compacted.length < history.length * 0.5, `压缩率应当超过 50%，实际 ${history.length} → ${compacted.length}`);
  assert.deepEqual(
    afterCompact.map(s => [s.ts, s.amount, s.type, s.day]),
    original.map(s => [s.ts, s.amount, s.type, s.day]),
    '压缩前后跳变序列必须完全一致',
  );
});

test('真实数据：data.json 已是规范的紧凑格式（压缩具备幂等性）', () => {
  const recomputed = serializeData({
    room_info: REAL_DATA.room_info,
    history: compactHistory(REAL_DATA.history, { roomId: REAL_DATA.room_info.roomId }),
  });
  assert.equal(recomputed, fs.readFileSync(path.join(__dirname, '../public/data.json'), 'utf8'));
});


test('真实数据：账目自洽（消耗 - 充值 = 首末读数差）', () => {
  const list = normalizeHistory(REAL_DATA.history);
  const steps = buildSteps(list, TZ);
  const consumption = steps.filter(s => s.type === 'consumption').reduce((a, s) => a + s.amount, 0);
  const recharge = steps.filter(s => s.type === 'recharge').reduce((a, s) => a + s.amount, 0);
  assert.equal(consumption - recharge, list[0].kWh - list[list.length - 1].kWh);
});

test('真实数据：用电日不再出现双结算假峰（旧规则最大 45 kWh）', () => {
  const stats = computeStats({ history: REAL_DATA.history, roomId: REAL_DATA.room_info.roomId, now: ts('2026-10-16T03:28:00Z'), tzOffsetMinutes: TZ });
  const dailyValues = Object.values(stats.daily);
  assert.equal(dailyValues.length, stats.consumptionSteps.length, '每个用电日恰好一次结算');
  assert.ok(Math.max(...dailyValues) <= 30, '单日消耗不应出现双结算假峰');
});

test('computeStats: 以最新读数为锚给出近 24h 消耗与预测', () => {
  const now = ts('2026-10-16T03:28:00.807Z');
  const stats = computeStats({ history: REAL_DATA.history, roomId: REAL_DATA.room_info.roomId, now, tzOffsetMinutes: TZ });
  assert.equal(stats.current, 51);
  assert.equal(stats.consDaily.day, '2026-10-15');
  assert.equal(stats.consDaily.value, 8);
  assert.ok(stats.consLast24h.value > 0);
  assert.ok(stats.dailyAvg > 0);
  assert.ok(stats.estimateDays >= 0);
  assert.equal(stats.staleness.stale, false);
});

test('computeStats: 数据断流时标记陈旧', () => {
  const stats = computeStats({
    history: REAL_DATA.history,
    roomId: REAL_DATA.room_info.roomId,
    now: ts('2026-10-20T00:00:00Z'), // 最新读数之后 4 天
    tzOffsetMinutes: TZ,
  });
  assert.equal(stats.staleness.stale, true);
});

test('computeStats: 空数据返回 null，非法读数被忽略', () => {
  assert.equal(computeStats({ history: [], roomId: 'r' }), null);
  const stats = computeStats({
    history: [{ timestamp: '2026-01-01T00:00:00.000Z', room_id: 'r', kWh: 10 }],
    roomId: 'r',
    now: ts('2026-01-01T00:00:00Z'),
    tzOffsetMinutes: TZ,
  });
  assert.equal(stats.current, 10);
  assert.equal(stats.consumptionSteps.length, 0);
  assert.equal(stats.consLast24h.value, 0);
});

test('estimateSettlementHour: 在合成数据上能反推出结算小时', () => {
  // 构造：每天本地 04:30 读数未变、05:30 读数已完成结算 →
  // 观测区间 (04:30, 05:30] 只包含 05:00 这一个整点
  const history = [];
  let kWh = 500;
  for (let day = 0; day < 20; day += 1) {
    // UTC 20:30 == 本地(+8) 次日 04:30；再往后的 05:00 / 06:00 边界都由此推导
    const before = Date.UTC(2026, 0, 1, 20, 30, 0) + day * 86400000;
    history.push({ timestamp: new Date(before).toISOString(), room_id: 'r', kWh });
    history.push({ timestamp: new Date(before + 3600000).toISOString(), room_id: 'r', kWh: kWh - 10 });
    kWh -= 10;
  }
  const { hour, support, total, supportByHour } = estimateSettlementHour(history, TZ);
  assert.equal(hour, DAY_BOUNDARY_HOUR);
  assert.equal(support, total, '每次跳变都应当支持 05:00 边界');
  assert.equal(Math.max(...supportByHour), support);
});

test('formatIn/dayKey: 时区偏移计算与本地时间一致', () => {
  const t = ts('2026-10-15T20:59:49.615Z'); // 本地 10-16 04:59
  assert.equal(formatIn(t, 'yyyy-MM-dd HH:mm', TZ), '2026-10-16 04:59');
  assert.equal(CHANGE_EPSILON > 0, true);
});
