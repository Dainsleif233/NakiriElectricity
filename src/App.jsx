import { useState, useEffect, useMemo, useCallback } from 'react';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { format, subDays, differenceInDays } from 'date-fns';
import { Moon, Sun, Zap, Activity, RefreshCw, TrendingDown, TrendingUp, BatteryCharging, CalendarClock, CalendarDays, Home, CloudLightning, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utility ---
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

function formatInteger(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(0) : '-';
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
          }
          
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

  // 核心功能：手动触发爬虫 (GitHub Pages 版本) - 提示用户手动触发 GitHub Actions
  const handleManualScrape = () => {
      window.open(
        'https://github.com/' + 
        (window.location.hostname.split('.')[0] || 'Dainsleif233') + 
        '/NakiriElectricity/actions',
        '_blank'
      );
  };

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
        const key = format(dateObj, "yyyy-MM-dd HH:mm");
        
        if (!groupedMap.has(key)) {
          groupedMap.set(key, { 
            timestamp: dateObj.getTime(), 
            displayTime: format(dateObj, "MM-dd HH:mm"),
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

    return Array.from(groupedMap.values())
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter(d => d.val !== null && d.val !== undefined);
  }, [rawData, timeRange, targetRoom]);

  // 2. Calculate Stats
  const stats = useMemo(() => {
    if (!rawData.length || !targetRoom) return null;
    
    const roomData = rawData
        .filter(d => String(d.room_id) === String(targetRoom))
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (roomData.length === 0) return null;

    const now = new Date();
    const currentKWh = roomData[roomData.length - 1].kWh;

    const getConsumption = (sinceDate) => {
        const recent = roomData.filter(d => new Date(d.timestamp) >= sinceDate);
        let sum = 0;
        for (let i = 1; i < recent.length; i++) {
            const diff = recent[i-1].kWh - recent[i].kWh;
            if (diff > 0) sum += diff; 
        }
        return sum;
    };

    const getLatestPointConsumption = (days) => {
        const latestRecord = roomData[roomData.length - 1];
        const targetTime = subDays(new Date(latestRecord.timestamp), days);

        for (let i = roomData.length - 2; i >= 0; i--) {
            const recordTime = new Date(roomData[i].timestamp);
            if (recordTime <= targetTime) {
                const diff = roomData[i].kWh - latestRecord.kWh;
                return diff > 0 ? diff : 0;
            }
        }

        return 0;
    };

    const consumptionDaily = getLatestPointConsumption(1);

    const dailyMap = {};
    roomData.forEach(d => {
        const day = format(new Date(d.timestamp), 'yyyy-MM-dd');
        if (!dailyMap[day]) dailyMap[day] = [];
        dailyMap[day].push(d.kWh);
    });

    const sortedDates = Object.keys(dailyMap).sort();
    const getDayLastKWh = (date) => {
        const values = dailyMap[date];
        return values && values.length > 0 ? values[values.length - 1] : null;
    };
    const getNextDayFirstKWh = (date) => {
        const idx = sortedDates.indexOf(date);
        return idx >= 0 && idx < sortedDates.length - 1 ? dailyMap[sortedDates[idx + 1]][0] : null;
    };

    let maxDaily = { val: 0, date: '-' };
    let minDaily = { val: 9999, date: '-' };

    sortedDates.forEach(date => {
        const lastKWh = getDayLastKWh(date);
        const nextFirstKWh = getNextDayFirstKWh(date);
        if (lastKWh === null || nextFirstKWh === null) return;

        let dailySum = 0;
        if (lastKWh > nextFirstKWh) {
            dailySum = lastKWh - nextFirstKWh;
        }

        if (dailySum > 0.1) {
            if (dailySum > maxDaily.val) maxDaily = { val: dailySum, date: date.slice(5) };
            if (dailySum < minDaily.val) minDaily = { val: dailySum, date: date.slice(5) };
        }
    });
    if (minDaily.val === 9999) minDaily.val = 0;

    const consumption24h = getConsumption(subDays(now, 1));
    const consumption7d = getConsumption(subDays(now, 7));

    let lastRechargeTime = null;
    let lastRechargeAmount = 0;
    for (let i = roomData.length - 1; i > 0; i--) {
        const curr = roomData[i].kWh;
        const prev = roomData[i-1].kWh;
        if (curr > prev + 1.0) { 
            lastRechargeTime = roomData[i].timestamp;
            lastRechargeAmount = curr - prev;
            break;
        }
    }

    let daysRemaining = '0';
    const dailyAvg = consumption7d / 7;
    if (dailyAvg > 0) daysRemaining = (currentKWh / dailyAvg).toFixed(0);

    const daysSinceRecharge = lastRechargeTime 
        ? differenceInDays(now, new Date(lastRechargeTime)) 
        : '-';

    return {
        current: formatInteger(currentKWh),
        consDaily: formatInteger(consumptionDaily),
        maxDaily: {
            ...maxDaily,
            val: formatInteger(maxDaily.val)
        },
        minDaily: {
            ...minDaily,
            val: formatInteger(minDaily.val)
        },
        cons30d: formatInteger(getConsumption(subDays(now, 30))),
        lastRecharge: {
            date: lastRechargeTime ? format(new Date(lastRechargeTime), 'MM-dd') : '-',
            time: lastRechargeTime ? format(new Date(lastRechargeTime), 'HH:mm') : '',
            amount: lastRechargeAmount > 0 ? formatInteger(lastRechargeAmount) : '-',
            daysAgo: daysSinceRecharge
        },
        estimateDays: daysRemaining
    };

  }, [rawData, targetRoom]);

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
             {/* 远程更新按钮 */}
             <button 
              onClick={handleManualScrape}
              className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500 group relative"
              title="打开 GitHub Actions（手动触发更新）"
            >
              <CloudLightning size={20} className="group-hover:text-yellow-500 transition-colors" />
            </button>

            {/* 本地刷新按钮 */}
            <button 
              onClick={() => fetchData(false)}
              className="p-2 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors text-zinc-500"
              title={lastUpdate ? `刷新数据（上次更新: ${format(new Date(lastUpdate), 'MM-dd HH:mm')}）` : "刷新数据"}
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
                        value={`${stats.current} kWh`} 
                        subtext="实时剩余" 
                        icon={Zap} 
                        delay={1} 
                        highlight={true}
                    />
                    <StatCard 
                        title="昨日消耗" 
                        value={`${stats.consDaily} kWh`} 
                        subtext="最近波动" 
                        icon={Activity} 
                        delay={2} 
                    />
                    <StatCard 
                        title="单日最大消耗" 
                        value={`${stats.maxDaily.val} kWh`} 
                        subtext={stats.maxDaily.date} 
                        icon={TrendingUp} 
                        delay={3} 
                    />
                    <StatCard 
                        title="单日最小消耗" 
                        value={`${stats.minDaily.val} kWh`} 
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
                        value={stats.lastRecharge.date} 
                        subtext={stats.lastRecharge.time}
                        icon={BatteryCharging} 
                        delay={6}
                        compact={true}
                    />
                    <StatCard 
                        title="预计可用" 
                        value={`${stats.estimateDays}`} 
                        subtext="天" 
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
                  <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                  Live
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
                        tickFormatter={(value) => format(new Date(value), timeRange <= 7 ? "MM-dd HH:mm" : "MM-dd")}
                      />
                      <YAxis 
                        width={45}
                        stroke={darkMode ? "#666" : "#999"} 
                        fontSize={12} 
                        domain={['auto', 'auto']}
                        tickFormatter={(value) => formatInteger(value)}
                        allowDataOverflow={false} 
                      />
                      <Tooltip 
                        labelFormatter={(value) => format(new Date(value), "yyyy-MM-dd HH:mm")}
                        formatter={(value) => [`${formatInteger(value)} kWh`, '剩余电量']}
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
