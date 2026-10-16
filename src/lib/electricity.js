/**
 * 电量数据领域模型 —— 采集脚本 / 前端 / 数据质量报告 / 单元测试 共用。
 *
 * 纯 ESM，无副作用，不依赖浏览器或 Node 专有 API。
 * 所有规则与常量都来自对 public/data.json 中真实读数（2026-05-29 ~ 2026-10-16，
 * 680 条）的统计结果，详见 scripts/analyze-data.js 的输出与 README「数据特征」一节。
 */

// ---------------------------------------------------------------------------
// 常量：来自真实数据的实测特征
// ---------------------------------------------------------------------------

/** 读数分辨率：源站 lastSd 在 680/680 条样本中小数部分均为 0，即 1 kWh 台阶。 */
export const READ_RESOLUTION = 1;

/** 判定「读数发生跳变」的最小变化量。小于该值视为同一次结算，不产生新信息。 */
export const CHANGE_EPSILON = 0.05;

/**
 * 心跳间隔：读数长时间不变时，只刷新 room_info.lastCheckedAt（链路存活标记），
 * **不往 history 里塞同值记录**。
 *
 * 原因：history 的语义是「读数发生变化的时刻」，塞同值记录会让图表出现一段段水平线
 * （实测 7 天窗口里有 49% 的横轴长度是这么来的），而且它并不是真的采样到了新信息。
 */
export const HEARTBEAT_MS = 12 * 60 * 60 * 1000;

/**
 * 前端判定「数据陈旧」的阈值。
 * 依据：心跳间隔 12h + 采样间隔（p90 8h）→ 正常情况下 lastCheckedAt 至少每 20h 刷新一次，
 * 取 24h 既能及时暴露断流，又不会在 Actions 被延迟时误报。
 */
export const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * 用电日边界（本地时区小时）。
 * 实测 137 次下降跳变的观测区间 (上次读数, 本次读数] 几乎都覆盖本地 04:00~06:00，
 * 说明源站按「本地凌晨 5 点左右」批量结算一次；因此在 05:00 换日比在 00:00 换日
 * 更接近真实用电日。estimateSettlementHour() 会持续校验这个假设是否漂移。
 */
export const DAY_BOUNDARY_HOUR = 5;

/** 统计窗口：近 24 小时消耗 / 预测用的 7 天日均。 */
export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PROJECTION_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// 时区工具：统一用「固定偏移的 UTC 位移」计算，保证 Node(UTC runner) 与浏览器一致
// ---------------------------------------------------------------------------

/** 运行环境本地时区偏移（分钟，东为正）。中国为 480。 */
export function runtimeTzOffsetMinutes(date = new Date()) {
  return -date.getTimezoneOffset();
}

/** 任意时间输入 → epoch 毫秒；非法输入返回 NaN。 */
export function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

export function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 把绝对时间平移到「目标时区」，之后只用 getUTC* 读取。 */
function shiftedDate(ms, tzOffsetMinutes) {
  return new Date(ms + tzOffsetMinutes * 60000);
}

/** 本地日历日键 yyyy-MM-dd。 */
export function dayKey(ts, tzOffsetMinutes = runtimeTzOffsetMinutes()) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return '-';
  return shiftedDate(ms, tzOffsetMinutes).toISOString().slice(0, 10);
}

/** 本地小时 0-23。 */
export function hourOf(ts, tzOffsetMinutes = runtimeTzOffsetMinutes()) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return NaN;
  return shiftedDate(ms, tzOffsetMinutes).getUTCHours();
}

/** 日键加减天数。 */
export function shiftDay(key, days) {
  const base = Date.parse(`${key}T00:00:00Z`);
  if (!Number.isFinite(base)) return key;
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

/** 某个本地日键 + 小时 → epoch 毫秒。 */
export function boundaryMs(key, hour, tzOffsetMinutes) {
  return Date.parse(`${key}T${pad2(hour)}:00:00Z`) - tzOffsetMinutes * 60000;
}

/** 按模式格式化本地时间（替代 App 里原先的 formatDate，语义不变，但可指定时区）。 */
export function formatIn(ts, pattern, tzOffsetMinutes = runtimeTzOffsetMinutes()) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return '-';
  const d = shiftedDate(ms, tzOffsetMinutes);
  const tokens = {
    yyyy: String(d.getUTCFullYear()),
    MM: pad2(d.getUTCMonth() + 1),
    dd: pad2(d.getUTCDate()),
    HH: pad2(d.getUTCHours()),
    mm: pad2(d.getUTCMinutes()),
  };
  return pattern.replace(/yyyy|MM|dd|HH|mm/g, token => tokens[token]);
}

// ---------------------------------------------------------------------------
// 读数序列
// ---------------------------------------------------------------------------

/**
 * 清洗读数：剔除非法项、按时间排序、丢弃「同一时刻同一数值」的完全重复项。
 * 缺失 room_id 的条目沿用 roomId 参数，兼容历史的精简格式。
 */
export function normalizeHistory(history, roomId = null) {
  if (!Array.isArray(history)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of history) {
    if (!raw || typeof raw !== 'object') continue;
    const ms = toMs(raw.timestamp);
    const kWh = Number(raw.kWh);
    if (!Number.isFinite(ms) || !Number.isFinite(kWh) || kWh < 0) continue;
    const key = `${ms}|${kWh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      timestamp: new Date(ms).toISOString(),
      ms,
      kWh,
      room_id: raw.room_id ?? roomId ?? null,
      src: raw.src || 'change',
    });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

/**
 * 压缩为「只保留数值发生变化的读数」。
 * 实测 680 条原始采样里只有 152 条携带新信息（78% 是同一结算值的重复采样），
 * 压缩后数值序列完全等价（buildSteps 逐条一致），只是不再记录没变化的时刻。
 */
export function compactHistory(history, { roomId = null } = {}) {
  const list = normalizeHistory(history, roomId);
  if (list.length === 0) return [];

  const kept = [{ ...list[0], src: 'start' }];
  for (let i = 1; i < list.length; i += 1) {
    const cur = list[i];
    if (Math.abs(cur.kWh - kept[kept.length - 1].kWh) >= CHANGE_EPSILON) {
      kept.push({ ...cur, src: 'change' });
    }
  }
  return kept;
}

/**
 * 把连续等值读数折叠成「每段只保留第一个点」。
 *
 * 这是给**图表**用的：即使拿到的是旧格式（含同值心跳）或未经压缩的原始数据，
 * 折叠后相邻两点的数值一定不同，因此不会画出水平线 —— 而水平线会让人误以为
 * 电量在两次结算之间是缓慢变化的。保留每段第一个点，是因为数值正是在那一刻变成该值的。
 */
export function collapseValueRuns(entries, valueOf = entry => entry.kWh) {
  const list = Array.isArray(entries) ? entries : normalizeHistory(entries);
  const out = [];
  for (const entry of list) {
    const last = out[out.length - 1];
    const value = valueOf(entry);
    if (last !== undefined && last !== null && Math.abs(valueOf(last) - value) < CHANGE_EPSILON) continue;
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 跳变事件（消耗 / 充值）
// ---------------------------------------------------------------------------

/**
 * 计算 (prev, cur] 内最后一次「本地 boundaryHour 时刻」。
 * 返回 epoch 毫秒；区间内没有边界时刻则返回 null。
 */
export function lastBoundaryIn(prevMs, curMs, tzOffsetMinutes, boundaryHour = DAY_BOUNDARY_HOUR) {
  let key = shiftDay(dayKey(prevMs, tzOffsetMinutes), -1);
  let found = null;
  for (let i = 0; i < 5; i += 1) {
    const t = boundaryMs(key, boundaryHour, tzOffsetMinutes);
    if (t > prevMs) {
      if (t <= curMs) found = t;
      else break;
    }
    key = shiftDay(key, 1);
  }
  return found;
}

/**
 * 把一次下降跳变归属到「用电日」。
 *
 * 读数只在结算后才变化，所以我们只知道跳变发生在 (prevMs, curMs] 区间内。
 * 源站按本地凌晨 5 点前后批量结算，05:00 之后的这次结算扣的是**前一个**用电日的电量，
 * 因此用电日 = 结算时刻所在日期的前一天。
 *
 * 两种情形：
 *  1) 区间内跨过 05:00 边界 → 取该边界所在日 - 1 天；
 *  2) 区间内没有边界（两次采样都落在 05:00 之后的同一天，例如 05:30 采样未变、06:00 采样已变）
 *     → 结算发生在本次读数前不久，同样属于前一个用电日，取本次读数所在日 - 1 天。
 *
 * 实测：旧的「上次读数所在日」回退会在 137 次跳变中制造 10 个双跳变日（最大 45 kWh 假峰），
 * 改用本规则后日分布与实际结算节奏一致（137 天、单日最大 27 kWh）。
 */
export function usageDayFor(prevMs, curMs, tzOffsetMinutes, boundaryHour = DAY_BOUNDARY_HOUR) {
  const boundary = lastBoundaryIn(prevMs, curMs, tzOffsetMinutes, boundaryHour);
  const anchor = boundary === null ? curMs : boundary;
  return shiftDay(dayKey(anchor, tzOffsetMinutes), -1);
}

/**
 * 把读数序列拆成跳变事件。
 * type=consumption 表示余额下降（用电），type=recharge 表示余额上升（充值）。
 */
export function buildSteps(entries, tzOffsetMinutes = runtimeTzOffsetMinutes()) {
  const list = Array.isArray(entries) ? entries : normalizeHistory(entries);
  const steps = [];
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1];
    const cur = list[i];
    const delta = cur.kWh - prev.kWh;
    if (Math.abs(delta) < CHANGE_EPSILON) continue;
    const type = delta < 0 ? 'consumption' : 'recharge';
    const boundary = lastBoundaryIn(prev.ms, cur.ms, tzOffsetMinutes);
    steps.push({
      type,
      delta,
      amount: Math.abs(delta),
      ts: cur.ms,
      prevTs: prev.ms,
      gapMs: cur.ms - prev.ms,
      // 区间跨越了多个结算边界（采样断档 >24h），数值无法再拆分
      coarse: boundary !== null && cur.ms - prev.ms > 25 * 60 * 60 * 1000,
      day: type === 'consumption'
        ? usageDayFor(prev.ms, cur.ms, tzOffsetMinutes)
        : dayKey(cur.ms, tzOffsetMinutes),
    });
  }
  return steps;
}

/** 消耗事件按用电日聚合。 */
export function aggregateDailyConsumption(steps) {
  const daily = {};
  for (const step of steps) {
    if (step.type !== 'consumption') continue;
    daily[step.day] = (daily[step.day] || 0) + step.amount;
  }
  return daily;
}

/** 区间 (fromMs, toMs] 内的消耗合计；充值不计入。 */
export function consumptionInWindow(steps, fromMs, toMs) {
  return steps
    .filter(step => step.type === 'consumption' && step.ts > fromMs && step.ts <= toMs)
    .reduce((sum, step) => sum + step.amount, 0);
}

// ---------------------------------------------------------------------------
// 页面指标
// ---------------------------------------------------------------------------

/**
 * 由真实读数推导页面所需的全部指标。
 * @param {object} options
 * @param {Array} options.history 原始 history 数组
 * @param {string|null} options.roomId 目标房间
 * @param {number} [options.now] 当前时间（便于测试注入）
 * @param {number} [options.tzOffsetMinutes] 时区偏移
 */
export function computeStats({ history, roomId = null, now = Date.now(), tzOffsetMinutes = runtimeTzOffsetMinutes(), lastCheckedAt = null } = {}) {
  const all = normalizeHistory(history, roomId);
  const roomData = roomId == null
    ? all
    : all.filter(item => item.room_id == null || String(item.room_id) === String(roomId));

  if (roomData.length === 0) return null;

  const latest = roomData[roomData.length - 1];
  const first = roomData[0];
  const steps = buildSteps(roomData, tzOffsetMinutes);
  const consumptionSteps = steps.filter(step => step.type === 'consumption');
  const rechargeSteps = steps.filter(step => step.type === 'recharge');
  const daily = aggregateDailyConsumption(steps);

  // 滚动窗口的锚点是「最后一次成功采集」，而不是「最后一次数值变化」：
  // history 只存变更点时两者可能相差十几小时，用变更点当锚会把前一天的跳变也圈进 24h 窗口
  // （实测 8 kWh 会被算成 17 kWh）。同时锚点跟随采集时间，数据停滞时也不会把空窗口算进来。
  const checkedMs = toMs(lastCheckedAt);
  const anchorMs = Math.max(latest.ms, Number.isFinite(checkedMs) ? checkedMs : 0);

  const windowFrom = anchorMs - ROLLING_WINDOW_MS;
  const consLast24h = consumptionInWindow(steps, windowFrom, anchorMs);

  // 最近一个「已完整观测到」的用电日。
  const lastConsumption = consumptionSteps[consumptionSteps.length - 1] || null;
  const dailyDay = lastConsumption ? lastConsumption.day : null;
  const consDaily = dailyDay ? (daily[dailyDay] || 0) : 0;

  // 单日最大 / 最小：只统计真实观测到消耗的用电日，并跳过采样断档造成的粗粒度事件。
  let maxDaily = { val: 0, date: '-' };
  let minDaily = { val: Infinity, date: '-' };
  for (const step of consumptionSteps) {
    const value = daily[step.day] || 0;
    if (value > maxDaily.val) maxDaily = { val: value, date: step.day.slice(5) };
    if (value < minDaily.val) minDaily = { val: value, date: step.day.slice(5) };
  }
  if (!Number.isFinite(minDaily.val)) minDaily = { val: 0, date: '-' };

  const cons30d = consumptionInWindow(steps, anchorMs - 30 * 86400000, anchorMs);
  const cons7d = consumptionInWindow(steps, anchorMs - PROJECTION_WINDOW_DAYS * 86400000, anchorMs);

  // 7 天日均：数据不足 7 天时按实际覆盖天数折算，避免高估可用天数。
  const spanDays = Math.max(1, Math.min(PROJECTION_WINDOW_DAYS, (anchorMs - first.ms) / 86400000));
  const dailyAvg = cons7d / spanDays;
  const estimateDays = dailyAvg > 0 ? Math.max(0, Math.floor(latest.kWh / dailyAvg)) : 0;

  const lastRechargeStep = rechargeSteps[rechargeSteps.length - 1] || null;

  // 陈旧判断同样以最后一次成功采集为准：假期可能好几天不跳变，但采集本身是正常的。
  const ageMs = now - anchorMs;

  return {
    current: latest.kWh,
    latestMs: latest.ms,
    latestTimestamp: latest.timestamp,
    firstMs: first.ms,
    readings: roomData.length,
    steps,
    consumptionSteps,
    rechargeSteps,
    daily,
    consLast24h: {
      value: consLast24h,
      fromMs: windowFrom,
      toMs: anchorMs,
    },
    consDaily: {
      value: consDaily,
      day: dailyDay,
    },
    maxDaily,
    minDaily,
    cons30d,
    cons7d,
    dailyAvg,
    estimateDays,
    lastRecharge: lastRechargeStep
      ? {
        ts: lastRechargeStep.ts,
        // 观测到的只是「充值 − 期间消耗」的净跳变，无法还原精确充值额
        amount: lastRechargeStep.amount,
        approximate: true,
        daysAgo: Math.floor((now - lastRechargeStep.ts) / 86400000),
      }
      : null,
    staleness: {
      ageMs,
      stale: ageMs > STALE_MS,
      lastCheckedMs: anchorMs,
      // 与「采集是否存活」分开：最后一次数值跳变过去了多久
      sinceLastStepMs: steps.length ? now - steps[steps.length - 1].ts : null,
    },
  };
}

// ---------------------------------------------------------------------------
// 采集侧：增量判定与文件序列化
// ---------------------------------------------------------------------------

/**
 * 判断一次新读数应当如何写盘。
 *
 * 三种结果：
 *  - `append-change`：数值变了 → 往 history 追加一条（这是唯一会让 history 增长的路径）；
 *  - `touch`：数值没变、但距上次写盘已超过心跳间隔 → 只刷新 room_info.lastCheckedAt，
 *    history 保持不变（链路存活标记与数据本身分开存放）；
 *  - `none`：没变化也没到心跳 → 完全不写盘，因此不会产生任何提交。
 *
 * @returns {{action: 'append-change'|'touch'|'none', src: string|null, delta: number|null, previousKWh: number|null}}
 */
export function planUpdate(entries, kWh, nowMs = Date.now(), { heartbeatMs = HEARTBEAT_MS, roomId = null, lastCheckedAt = null } = {}) {
  const list = normalizeHistory(entries, roomId);
  const last = list[list.length - 1] || null;
  if (last === null) return { action: 'append-change', src: 'start', delta: null, previousKWh: null };

  const delta = kWh - last.kWh;
  if (Math.abs(delta) >= CHANGE_EPSILON) {
    return { action: 'append-change', src: 'change', delta, previousKWh: last.kWh };
  }

  // 心跳按「距上次写盘」计时：history 最后一条太老、但刚刚 touch 过时不应重复写盘
  const checkedMs = toMs(lastCheckedAt);
  const lastWriteMs = Math.max(last.ms, Number.isFinite(checkedMs) ? checkedMs : 0);
  if (nowMs - lastWriteMs >= heartbeatMs) {
    return { action: 'touch', src: null, delta: 0, previousKWh: last.kWh };
  }
  return { action: 'none', src: null, delta, previousKWh: last.kWh };
}

/**
 * 序列化 data.json：history 每条读数占一行。
 * 这样每次采集在 git diff 中只增加一行，既省体积又便于回溯；
 * 输出仍是合法且向后兼容的 JSON（前端的读取逻辑无需区分格式）。
 */
export function serializeData(data = {}) {
  const info = data.room_info || {};
  const infoText = Object.keys(info)
    .map(key => `    ${JSON.stringify(key)}: ${JSON.stringify(info[key])}`)
    .join(',\n');
  const history = Array.isArray(data.history) ? data.history : [];
  const entryText = history
    .map(entry => `    ${JSON.stringify({
      timestamp: entry.timestamp,
      room_id: entry.room_id ?? null,
      kWh: entry.kWh,
      src: entry.src || 'change',
    })}`)
    .join(',\n');

  return `{\n  "room_info": {\n${infoText}\n  },\n  "history": [\n${entryText}\n  ]\n}\n`;
}

// ---------------------------------------------------------------------------
// 数据质量诊断（scripts/analyze-data.js 使用）
// ---------------------------------------------------------------------------

/**
 * 估计源站的每日结算小时（本地时间）。
 * 对每个下降跳变的观测区间 (prev, cur] 统计哪些整点落在其中，取支持度最高的小时。
 */
export function estimateSettlementHour(entries, tzOffsetMinutes = runtimeTzOffsetMinutes()) {
  const list = normalizeHistory(entries);
  const steps = buildSteps(list, tzOffsetMinutes).filter(step => step.type === 'consumption');
  if (steps.length === 0) return { hour: null, support: 0, total: 0 };

  const supportByHour = new Array(24).fill(0);
  for (let hour = 0; hour < 24; hour += 1) {
    for (const step of steps) {
      // 该整点落在观测区间 (prev, cur] 内即为一次支持
      if (lastBoundaryIn(step.prevTs, step.ts, tzOffsetMinutes, hour) !== null) supportByHour[hour] += 1;
    }
  }
  let hour = 0;
  for (let h = 1; h < 24; h += 1) if (supportByHour[h] > supportByHour[hour]) hour = h;
  return { hour, support: supportByHour[hour], total: steps.length, supportByHour };
}

/** 数据质量摘要，供报告与回归测试使用。 */
export function summarizeHistory(history, tzOffsetMinutes = runtimeTzOffsetMinutes()) {
  const list = normalizeHistory(history);
  const steps = buildSteps(list, tzOffsetMinutes);
  const gaps = [];
  for (let i = 1; i < list.length; i += 1) gaps.push(list[i].ms - list[i - 1].ms);
  gaps.sort((a, b) => a - b);
  const pct = p => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] : 0);

  const values = list.map(item => item.kWh);
  const fractional = values.filter(v => Math.abs(v - Math.round(v)) > 1e-9).length;

  const compact = compactHistory(list);
  const daily = aggregateDailyConsumption(steps);
  const days = Object.keys(daily);

  return {
    readings: list.length,
    distinctValues: new Set(values).size,
    firstMs: list.length ? list[0].ms : null,
    lastMs: list.length ? list[list.length - 1].ms : null,
    minKWh: values.length ? Math.min(...values) : null,
    maxKWh: values.length ? Math.max(...values) : null,
    nonIntegerReadings: fractional,
    consumptionSteps: steps.filter(s => s.type === 'consumption').length,
    rechargeSteps: steps.filter(s => s.type === 'recharge').length,
    totalConsumption: steps.filter(s => s.type === 'consumption').reduce((a, s) => a + s.amount, 0),
    totalRecharge: steps.filter(s => s.type === 'recharge').reduce((a, s) => a + s.amount, 0),
    // 只有变更点携带新信息，其余都是同一结算值的重复采样
    changeEntries: steps.length + 1,
    redundantReadings: Math.max(0, list.length - (steps.length + 1)),
    compactedReadings: compact.length,
    gapMs: { min: gaps.length ? gaps[0] : 0, p50: pct(0.5), p90: pct(0.9), max: gaps.length ? gaps[gaps.length - 1] : 0 },
    usageDays: days.length,
    coarseSteps: steps.filter(s => s.coarse).length,
    settlement: estimateSettlementHour(list, tzOffsetMinutes),
  };
}
