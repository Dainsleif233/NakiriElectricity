import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 配置与常量 ---
const DATA_FILE = path.join(__dirname, '../public/data.json');
const BASE_URL = "https://ykt.ujs.edu.cn/charge/feeitem/getThirdData";
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds
const MAX_HISTORY_ITEMS = 2000; // 保留最近2000条记录，约2-3个月数据

// 从环境变量获取配置
const ENV = {
    TOKEN: process.env.TOKEN,
    CAMPUS: process.env.CAMPUS,
    BUILDING: process.env.BUILDING,
    FLOOR: process.env.FLOOR,
    ROOM: process.env.ROOM
};

// --- 辅助函数 ---
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function autoGenerateParams() {
    const { CAMPUS, BUILDING, FLOOR, ROOM } = ENV;
    if (!CAMPUS || !BUILDING || !FLOOR || !ROOM) return null;

    const params = new URLSearchParams();
    params.append('type', 'IEC');
    params.append('level', '4');
    params.append('feeitemid', '408');
    params.append('campus', CAMPUS);
    params.append('building', BUILDING);
    params.append('floor', FLOOR);
    params.append('room', ROOM);

    return params;
}

function getDisplayName() {
    const { CAMPUS, BUILDING, ROOM } = ENV;
    if (!CAMPUS || !BUILDING || !ROOM) return null;

    return `${CAMPUS}-${BUILDING}-${ROOM}`;
}

// --- 主逻辑 ---
async function fetchWithRetry(url, params, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`Attempt ${i + 1}/${retries}...`);
            const response = await fetch(url, {
                method: 'POST',
                body: params,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Synjones-Auth": `bearer ${ENV.TOKEN}`
                },
                timeout: 10000 // 10s timeout
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (!data.code || data.code !== 200) {
                throw new Error(`HTTP ${data.message}`);
            }

            return data.map;
        } catch (error) {
            console.warn(`Attempt ${i + 1} failed:`, error.message);
            if (i < retries - 1) {
                console.log(`Retrying in ${RETRY_DELAY/1000}s...`);
                await sleep(RETRY_DELAY);
            } else {
                throw error;
            }
        }
    }
}

async function main() {
    console.log("Starting scrape job...");
    
    // 1. 准备请求参数
    const params = autoGenerateParams();
    if (!params) {
        console.error("Error: Could not generate params. Check environment variables (CAMPUS, BUILDING, FLOOR, ROOM).");
        process.exit(1);
    }
    console.log(`Target params generated for Room ${ENV.ROOM}`);

    // 2. 读取现有数据
    let data = { room_info: {}, history: [] };
    if (fs.existsSync(DATA_FILE)) {
        try {
            data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        } catch (e) {
            console.warn("Could not parse existing data.json, starting fresh.");
        }
    }

    // 3. 抓取数据
    try {
        const eleData = await fetchWithRetry(BASE_URL, params);

        if (eleData.showData && eleData.data) {
            const kwh = Number(eleData.data.lastSd);
            const now = new Date();
            const timestamp = now.toISOString();

            console.log(`✓ Successfully fetched: ${kwh} kWh`);

            // 更新基本信息
            data.room_info = {
                roomId: ENV.ROOM,
                displayName: getDisplayName(),
                updatedAt: timestamp
            };

            // 智能去重：如果最后一条记录在同一小时内且电量变化小于0.01kWh，跳过
            const lastEntry = data.history[data.history.length - 1];
            let shouldAdd = true;
            
            if (lastEntry) {
                const lastTime = new Date(lastEntry.timestamp);
                const timeDiff = now - lastTime;
                const kwhDiff = Math.abs(lastEntry.kWh - kwh);
                
                // 同一小时内 且 电量变化小于0.01kWh = 跳过
                if (timeDiff < 3600000 && kwhDiff < 0.01) {
                    shouldAdd = false;
                    console.log('⊘ Skipping duplicate entry (same hour, minimal change)');
                }
            }
            
            if (shouldAdd) {
                data.history.push({
                    timestamp: timestamp,
                    room_id: ENV.ROOM,
                    kWh: kwh
                });
                console.log(`✓ Added new entry to history (${data.history.length} total)`);
            }

            // 数据清理：保留最近的记录
            if (data.history.length > MAX_HISTORY_ITEMS) {
                const removed = data.history.length - MAX_HISTORY_ITEMS;
                data.history = data.history.slice(-MAX_HISTORY_ITEMS);
                console.log(`🗑️  Trimmed ${removed} old entries (keeping last ${MAX_HISTORY_ITEMS})`);
            }

            // 4. 写入文件
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
            console.log("✓ Data saved to public/data.json");
            console.log(`📊 Total history entries: ${data.history.length}`);
        } else {
            console.error("✗ Error: Regex match failed. Content might have changed.");
            console.log("Response text preview:", text.substring(0, 200));
            process.exit(1);
        }
    } catch (e) {
        console.error("✗ Fetch failed after retries:", e.message);
        process.exit(1);
    }
}

main();
