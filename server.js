const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3943;

// 設定ファイルパス
const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

// 設定ファイルを読み込む
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
      console.error('Error loading config:', e);
    }
  }
  return { broadcasters: [] };
}

// 設定ファイルを保存
function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// 統計ファイルを読み込む
function loadStats() {
  if (fs.existsSync(STATS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    } catch (e) {
      console.error('Error loading stats:', e);
    }
  }
  return {};
}

// 統計ファイルを保存
function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

let config = loadConfig();
let broadcasterStats = loadStats();

// ツイキャス API でユーザー情報を取得
async function fetchUserInfo(username) {
  try {
    const response = await fetch(`https://twitcasting.tv/api/v2/users/${username}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.user || null;
  } catch (e) {
    console.error(`Error fetching user info for ${username}:`, e.message);
    return null;
  }
}

// ツイキャスのプロフィールページから配信情報を抽出
async function fetchBroadcastStats(username) {
  try {
    const response = await fetch(`https://twitcasting.tv/${username}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    if (!response.ok) return null;
    
    const html = await response.text();
    
    const statsMatch = html.match(/(\d+)\/(\d+)/);
    if (!statsMatch) return null;
    
    const concurrent = parseInt(statsMatch[1], 10);
    const total = parseInt(statsMatch[2], 10);
    
    const isLive = html.includes('配信中') || html.includes('class="live-badge"');
    
    if (!isLive) return null;
    
    return {
      concurrent,
      total,
      timestamp: new Date().toISOString()
    };
  } catch (e) {
    console.error(`Error fetching broadcast stats for ${username}:`, e.message);
    return null;
  }
}

// 監視ループ（30秒ごと）
async function monitorBroadcasters() {
  if (config.broadcasters.length === 0) return;

  for (const broadcaster of config.broadcasters) {
    const username = broadcaster.user_id.replace('c:', '');
    const stats = await fetchBroadcastStats(username);
    
    if (!broadcasterStats[broadcaster.user_id]) {
      broadcasterStats[broadcaster.user_id] = {
        user_id: broadcaster.user_id,
        current_broadcast: null,
        history: []
      };
    }
    
    if (stats) {
      if (!broadcasterStats[broadcaster.user_id].current_broadcast) {
        broadcasterStats[broadcaster.user_id].current_broadcast = {
          broadcast_id: `${broadcaster.user_id}_${Date.now()}`,
          started_at: stats.timestamp,
          samples: [stats]
        };
        console.log(`[${broadcaster.user_id}] 配信開始: concurrent=${stats.concurrent}, total=${stats.total}`);
      } else {
        broadcasterStats[broadcaster.user_id].current_broadcast.samples.push(stats);
      }
    } else {
      if (broadcasterStats[broadcaster.user_id].current_broadcast) {
        const broadcast = broadcasterStats[broadcaster.user_id].current_broadcast;
        broadcast.ended_at = new Date().toISOString();
        broadcasterStats[broadcaster.user_id].history.push(broadcast);
        console.log(`[${broadcaster.user_id}] 配信終了: サンプル数=${broadcast.samples.length}`);
        broadcasterStats[broadcaster.user_id].current_broadcast = null;
        saveStats(broadcasterStats);
      }
    }
  }
}

// HTTP サーバー
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (pathname === '/api/twitcas/stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(broadcasterStats, null, 2));
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config, null, 2));
    return;
  }

  if (pathname === '/api/config/broadcasters' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const username = data.user_id.replace('c:', '');
        
        const userInfo = await fetchUserInfo(username);
        if (!userInfo) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User not found' }));
          return;
        }
        
        if (config.broadcasters.some(b => b.user_id === data.user_id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Broadcaster already added' }));
          return;
        }
        
        const broadcaster = {
          user_id: data.user_id,
          name: userInfo.name || username,
          image: userInfo.image || null
        };
        
        config.broadcasters.push(broadcaster);
        saveConfig(config);
        
        broadcasterStats[broadcaster.user_id] = {
          user_id: broadcaster.user_id,
          current_broadcast: null,
          history: []
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(broadcaster));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname.match(/^\/api\/config\/broadcasters\/(.+)$/) && req.method === 'DELETE') {
    const userId = decodeURIComponent(pathname.split('/').pop());
    config.broadcasters = config.broadcasters.filter(b => b.user_id !== userId);
    saveConfig(config);
    delete broadcasterStats[userId];
    saveStats(broadcasterStats);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Twitcas Tracker Server running on http://localhost:${PORT}`);
  console.log(`Monitoring ${config.broadcasters.length} broadcasters`);
});

setInterval(monitorBroadcasters, 30000);
monitorBroadcasters();
