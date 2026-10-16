import { useState, useEffect, useMemo, useCallback } from 'react';
import { collapseValueRuns, computeStats, formatIn, runtimeTzOffsetMinutes } from './lib/electricity.js';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { Moon, Sun, Zap, Activity, RefreshCw, TrendingDown, TrendingUp, BatteryCharging, CalendarClock, CalendarDays, Home, Github, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// --- Utility ---
function cn(...inputs) {
  return inputs.filter(Boolean).join(' ');
}

// 时区与日历口径统一交给 src/lib/electricity.js（与采集脚本、数据报告共用一套规则）
const formatDate = formatIn;

function subDays(value, days) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * 读数格式化：源站读数是 1 kWh 台阶（680/680 条样本小数位为 0），
 * 因此整数直接显示；若将来出现小数（scripts/analyze-data.js 会告警）则保留一位。
 */
function formatKWh(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '-';
  return Number.isInteger(numericValue) ? String(numericValue) : numericValue.toFixed(1);
}

const TIME_RANGES = [
  { label: '7天', days: 7 },
  { label: '14天', days: 14 },
  { label: '30天', days: 30 },
  { label: '60天', days: 60 },
];

// --- Components ---

const Card = ({ children, className }) => (
  <motion.div 
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    className={cn("bg-white dark:bg-zinc-900/80 backdrop-blur-md border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-xl overflow-hidden", className)}
  >
    {children}
  </motion.div>
);

const StatCard = ({ title, value, subtext, icon: Icon, delay, highlight, compact }) => (
  <motion.div 
    initial={{ opacity: 0, x: -20 }}
    animate={{ opacity: 1, x: 0 }}
    transition={{ delay: delay * 0.1 }}
    className={cn(
      "flex flex-col rounded-xl border transition-all",
      compact ? "p-3" : "p-4", 
      highlight 
        ? "bg-blue-50/50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800" 
        : "bg-zinc-50 dark:bg-zinc-800/50 border-zinc-100 dark:border-zinc-800/50"
    )}
  >
    <div className={cn("flex items-center justify-between", compact ? "mb-1.5" : "mb-2")}>
        <div className={cn("flex items-center gap-2", highlight ? "text-blue-600 dark:text-blue-400" : "text-zinc-500 dark:text-zinc-400")}>
            <Icon size={compact ? 16 : 18} />
            <span className={cn("font-medium", compact ? "text-xs" : "text-sm")}>{title}</span>
        </div>
    </div>
    <div className={cn("font-bold truncate", compact ? "text-xl" : "text-2xl", highlight ? "text-blue-700 dark:text-blue-300" : "text-zinc-900 dark:text-zinc-100")}>
      {value}
    </div>
    <div className={cn("truncate", compact ? "text-[10px] mt-0.5" : "text-xs mt-1", highlight ? "text-blue-500/70 dark:text-blue-400/70" : "text-zinc-400")}>
      {subtext}
    </div>
  </motion.div>
);

const ErrorAlert = ({ message, onRetry }) => (
  <motion.div
    initial={{ opacity: 0, y: -10 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -10 }}
    className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl flex items-center gap-3"
  >
    <AlertCircle size={20} className="text-red-600 dark:text-red-400 flex-shrink-0" />
    <div className="flex-1">
      <div className="text-sm font-medium text-red-800 dark:text-red-200">加载失败</div>
      <div className="text-xs text-red-600 dark:text-red-400 mt-0.5">{message}</div>
    </div>
    {onRetry && (
      <button 
        onClick={onRetry}
        className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
      >
        重试
      </button>
    )}
  </motion.div>
);

// --- Main App ---

export default function App() {
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return true; 
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => setDarkMode(e.matches);
    
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
    } else {
      mediaQuery.addListener(handleChange);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleChange);
      } else {
        mediaQuery.removeListener(handleChange);
      }
    };
  }, []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [rawData, setRawData] = useState([]);
  const [targetRoom, setTargetRoom] = useState(null); 
  const [roomDisplayName, setRoomDisplayName] = useState('Loading...'); 
  const [timeRange, setTimeRange] = useState(7);
  const [lastUpdate, setLastUpdate] = useState(null);
  // 最后一次「成功采集」的时刻（room_info.lastCheckedAt）：
  // 它与「最后一次数值变化」是两件事 —— 假期可能几天不跳变，但采集本身是正常的
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  // 用于计算「数据停滞了多久」；每次拉取数据时刷新，避免长时间挂着的页面显示过期判断
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [darkMode]);

  // 将数据获取逻辑抽离，方便复用
  const fetchData = useCallback(async (isInitial = false) => {
      if (isInitial) {
        setLoading(true);
        setError(null);
      }
      try {
          // Fetch from local JSON file (generated by GitHub Actions)
          const res = await fetch('./data.json?t=' + Date.now()); // 添加时间戳防止缓存
          if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load data`);
          
          const data = await res.json();
          
          // Validate data structure
          if (!data || typeof data !== 'object') {
            throw new Error('Invalid data format');
          }
          
          // Update State
          if (data.room_info) {
            setTargetRoom(data.room_info.roomId);
            setRoomDisplayName(data.room_info.displayName || 'Unknown Room');
            setLastUpdate(data.room_info.updatedAt);
            setLastCheckedAt(data.room_info.lastCheckedAt ?? data.room_info.updatedAt ?? null);
          }
          setNow(Date.now());
          
          if (data.history && Array.isArray(data.history)) {
             // Filter out invalid entries and sort by timestamp
             const validData = data.history
               .filter(item => item.timestamp && typeof item.kWh === 'number')
               .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
             setRawData(validData);
          } else {
            setRawData([]);
          }
          
          setError(null);
      } catch (e) {
          console.error("Fetch failed:", e);
          setError(e.message);
          setRoomDisplayName("数据加载失败");
      } finally {
          if (isInitial) setLoading(false);
      }
  }, []);

  // Initial Config & Data Fetch
  useEffect(() => {
      fetchData(true);

      // Refresh data every 5 minutes
      const interval = setInterval(() => {
          fetchData(false);
      }, 60000 * 5); 
      return () => clearInterval(interval);
  }, [fetchData]);

  // 1. Prepare Chart Data with better performance
  const chartData = useMemo(() => {
    if (!rawData.length || !targetRoom) return [];

    const now = new Date();
    const cutoff = subDays(now, timeRange);
    
    // Filter data within range
    const filtered = rawData.filter(d => {
      try {
        const timestamp = new Date(d.timestamp);
        return timestamp > cutoff && !isNaN(timestamp.getTime());
      } catch {
        return false;
      }
    });
    
    // Group by time and deduplicate
    const groupedMap = new Map();
    filtered.forEach(item => {
      try {
        const dateObj = new Date(item.timestamp);
        const key = formatDate(dateObj, "yyyy-MM-dd HH:mm");
        
        if (!groupedMap.has(key)) {
          groupedMap.set(key, { 
            timestamp: dateObj.getTime(), 
            displayTime: formatDate(dateObj, "MM-dd HH:mm"),
            fullDate: dateObj,
            val: null
          });
        }
        
        if (String(item.room_id) === String(targetRoom)) {
          groupedMap.get(key).val = item.kWh;
        }
      } catch (err) {
        console.warn('Invalid data item:', item, err);
      }
    });

    const points = Array.from(groupedMap.values())
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter(d => d.val !== null && d.val !== undefined);

    // 折叠「数值相同」的连续点：否则图上会出现一段段水平线，看起来像电量在缓慢变化。
    // 旧格式数据（含同值心跳）和未压缩的原始数据都能靠这一步得到正确观感。
    return collapseValueRuns(points, point => point.val);
  }, [rawData, timeRange, targetRoom]);

  // 2. Calculate Stats
  // 后处理规则集中在 src/lib/electricity.js，与采集脚本、数据质量报告共用同一套领域逻辑。
  // 实测数据特征（2026-05-29 ~ 2026-10-16，680 条读数）：
  //   • kWh 是「剩余电量」，1 kWh 台阶，源站每天只结算一次（137 次下降跳变 / 137 个用电日）；
  //   • 下降 = 用电，上升 = 充值；观测到的上升是「充值 − 期间消耗」的净跳变，只能标成 ≈；
  //   • 结算发生在本地凌晨 5 点前后，因此「用电日」按 05:00 换日，而不是按观测时刻的日历日；
  //   • 近 24 小时消耗以最新读数为锚，不做日历归因，任何时刻都有定义。
  const stats = useMemo(() => computeStats({
    history: rawData,
    roomId: targetRoom,
    now,
    tzOffsetMinutes: runtimeTzOffsetMinutes(),
    lastCheckedAt,
  }), [rawData, targetRoom, now, lastCheckedAt]);

  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-black text-zinc-900 dark:text-zinc-100 font-sans selection:bg-red-500/30 transition-colors duration-300">
      
      <nav className="sticky top-0 z-50 backdrop-blur-lg border-b border-zinc-200/50 dark:border-zinc-800/50 bg-white/70 dark:bg-black/70">
        <div className="w-full px-6 md:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-red-600 to-rose-500 flex items-center justify-center text-white font-bold shadow-lg shadow-red-500/20">
              N
            </div>
            <h1 className="text-lg font-bold tracking-tight">Nakiri <span className="text-zinc-400 font-normal">Electricity</span></h1>
          </div>
          <div className="flex items-center gap-2">
             {/* 打开项目按钮 */}
             <button 
              onClick={() => window.open('https://github.com/Dainsleif233/NakiriElectricity', '_blank')}
              className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500 group relative"
              title="GitHub 项目"
            >
              <Github size={20} className="group-hover:text-yellow-500 transition-colors" />
            </button>

            {/* 本地刷新按钮 */}
            <button 
              onClick={() => fetchData(false)}
              className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500"
              title={lastCheckedAt ? `刷新数据（上次采集: ${formatDate(new Date(lastCheckedAt), 'MM-dd HH:mm')}）` : "刷新数据"}
            >
              <RefreshCw size={20} className={cn(loading && "animate-spin")} />
            </button>
            
            {/* 黑暗模式切换 */}
            <button 
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500"
              title={darkMode ? "切换到浅色模式" : "切换到深色模式"}
            >
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>
      </nav>

      <main className="w-full px-6 md:px-8 py-6 md:py-8">
        
        <AnimatePresence>
          {error && <ErrorAlert message={error} onRetry={() => fetchData(true)} />}
        </AnimatePresence>

        {/* 数据断流提示：心跳间隔 12h、阈值 24h，超过即说明 Actions 没在跑或接口挂了 */}
        {!error && stats?.staleness.stale && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl flex items-center gap-3"
          >
            <CalendarClock size={20} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                数据已 {Math.floor(stats.staleness.ageMs / 3600000)} 小时未更新
              </div>
              <div className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                最后一次成功采集是 {formatDate(stats.staleness.lastCheckedMs, 'yyyy-MM-dd HH:mm')}
                {stats.staleness.sinceLastStepMs !== null && (
                  <> ，读数最后一次变化已是 {Math.floor(stats.staleness.sinceLastStepMs / 86400000)} 天前</>
                )}
                。请检查 GitHub Actions 的 Daily Electricity Check 是否仍在运行。
              </div>
            </div>
          </motion.div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6 md:gap-8">
          
          {/* Left Column */}
          <div className="xl:col-span-1 space-y-6">
            
            {/* 1. Room Info */}
            <section>
                <div className="flex items-center gap-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 shadow-sm">
                    <div className="p-2.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg text-blue-600 dark:text-blue-400">
                        <Home size={20} />
                    </div>
                    <div className="overflow-hidden">
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">当前监控房间</div>
                        <div className="text-xl font-bold text-zinc-900 dark:text-zinc-100 truncate" title={roomDisplayName}>
                            {roomDisplayName}
                        </div>
                    </div>
                </div>
            </section>

            {/* 2. Primary Stats */}
            <section>
              <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">核心指标</h2>
              <div className="grid grid-cols-2 gap-3">
                {stats ? (
                  <>
                    <StatCard 
                        title="当前电量" 
                        value={`${formatKWh(stats.current)} kWh`} 
                        subtext={stats.staleness.stale
                          ? `数据 ${Math.floor(stats.staleness.ageMs / 3600000)}h 未更新`
                          : '实时剩余'} 
                        icon={Zap} 
                        delay={1} 
                        highlight={true}
                    />
                    <StatCard 
                        title="24小时消耗" 
                        value={`${formatKWh(stats.consLast24h.value)} kWh`} 
                        subtext={stats.consDaily.day
                          ? `昨日(${stats.consDaily.day.slice(5)}) ${formatKWh(stats.consDaily.value)} kWh`
                          : '最近波动'} 
                        icon={Activity} 
                        delay={2} 
                    />
                    <StatCard 
                        title="单日最大消耗" 
                        value={`${formatKWh(stats.maxDaily.val)} kWh`} 
                        subtext={stats.maxDaily.date} 
                        icon={TrendingUp} 
                        delay={3} 
                    />
                    <StatCard 
                        title="单日最小消耗" 
                        value={`${formatKWh(stats.minDaily.val)} kWh`} 
                        subtext={stats.minDaily.date} 
                        icon={TrendingDown} 
                        delay={4} 
                    />
                  </>
                ) : (
                    <div className="col-span-2 text-center text-zinc-500 py-8 bg-zinc-50 dark:bg-zinc-900/50 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800">
                        数据加载中...
                    </div>
                )}
              </div>
            </section>

            {/* 3. Time Range */}
            <section>
               <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">趋势范围</h2>
               <div className="bg-zinc-200 dark:bg-zinc-900 p-1 rounded-lg flex">
                 {TIME_RANGES.map(range => (
                   <button
                    key={range.days}
                    onClick={() => setTimeRange(range.days)}
                    className={cn(
                      "flex-1 py-1.5 text-sm font-medium rounded-md transition-all",
                      timeRange === range.days 
                        ? "bg-white dark:bg-zinc-800 text-black dark:text-white shadow-sm" 
                        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    )}
                   >
                     {range.label}
                   </button>
                 ))}
               </div>
            </section>

            {/* 4. Detailed Analysis */}
            {stats && (
                <section className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
                  <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">深度分析</h2>
                  
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <StatCard 
                        title="30天消耗" 
                        value={stats.cons30d} 
                        subtext="kWh" 
                        icon={CalendarDays} 
                        delay={8}
                        compact={true} 
                    />
                    <StatCard 
                        title="上次充值" 
                        value={stats.lastRecharge ? formatDate(stats.lastRecharge.ts, 'MM-dd') : '-'} 
                        // 观测到的上升是「充值 − 期间消耗」的净跳变，因此只能标 ≈
                        subtext={stats.lastRecharge ? `≈${formatKWh(stats.lastRecharge.amount)} kWh` : '-'}
                        icon={BatteryCharging} 
                        delay={6}
                        compact={true}
                    />
                    <StatCard 
                        title="预计可用" 
                        value={`${stats.estimateDays} 天`} 
                        subtext={`${stats.dailyAvg.toFixed(1)} kWh/天`}
                        icon={CalendarClock} 
                        delay={7}
                        compact={true}
                    />
                  </div>
                </section>
            )}

          </div>

          <div className="xl:col-span-3 space-y-6">
            <Card className="p-6 flex flex-col h-full">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                    电量趋势
                    <span className="text-sm font-normal text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-md">
                        {roomDisplayName}
                    </span>
                </h2>
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  {/* 心跳间隔 12h，超过 18h 说明采集链路断了（scripts/analyze-data.js 会给出同样判断） */}
                  {stats?.staleness.stale ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                      数据 {Math.floor(stats.staleness.ageMs / 3600000)}h 未更新
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                      Live
                    </>
                  )}
                </div>
              </div>

              <div className="w-full flex-1 min-h-[500px]">
                {loading ? (
                  <div className="h-full w-full flex items-center justify-center text-zinc-400">
                    Loading data...
                  </div>
                ) : chartData.length === 0 ? (
                  <div className="h-full w-full flex items-center justify-center text-zinc-400">
                    暂无数据
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gradient-room" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? "#333" : "#eee"} vertical={false} />
                      <XAxis 
                        dataKey="timestamp"
                        type="number"
                        scale="time"
                        domain={['dataMin', 'dataMax']}
                        stroke={darkMode ? "#666" : "#999"} 
                        fontSize={12} 
                        tickMargin={10}
                        minTickGap={40}
                        tickFormatter={(value) => formatDate(new Date(value), timeRange <= 7 ? "MM-dd HH:mm" : "MM-dd")}
                      />
                      <YAxis 
                        width={45}
                        stroke={darkMode ? "#666" : "#999"} 
                        fontSize={12} 
                        domain={['auto', 'auto']}
                        tickFormatter={(value) => formatKWh(value)}
                        allowDataOverflow={false} 
                      />
                      <Tooltip 
                        labelFormatter={(value) => formatDate(new Date(value), "yyyy-MM-dd HH:mm")}
                        formatter={(value) => [`${formatKWh(value)} kWh`, '剩余电量']}
                        contentStyle={{ 
                          backgroundColor: darkMode ? 'rgba(24, 24, 27, 0.9)' : 'rgba(255, 255, 255, 0.9)',
                          borderColor: darkMode ? '#333' : '#eee',
                          borderRadius: '12px',
                          boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                          backdropFilter: 'blur(8px)'
                        }}
                        itemStyle={{ fontSize: '12px', padding: '2px 0' }}
                        labelStyle={{ color: darkMode ? '#ccc' : '#666', marginBottom: '8px' }}
                      />
                       <Area 
                          type="monotone"
                          dataKey="val"
                          name="剩余电量"
                          stroke="#3b82f6"
                          strokeWidth={2}
                          fill="url(#gradient-room)"
                          connectNulls={true}
                          isAnimationActive={true}
                          animationDuration={1500}
                          activeDot={{ r: 6, strokeWidth: 0 }}
                       />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
