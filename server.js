const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3943;

const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function loadJson(file, fallback) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { console.error(e); }
  }
  return fallback;
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

let config = loadJson(CONFIG_FILE, { broadcasters: [] });
let broadcasterStats = loadJson(STATS_FILE, {});

// ---- ツイキャス: プロフィールページから名前・アイコンを取得（認証不要） ----
async function fetchUserInfo(userId) {
  try {
    const res = await fetch(`https://twitcasting.tv/${encodeURIComponent(userId)}`, {
      headers: { 'User-Agent': UA }
    });
    if (!res.ok) return null;
    const html = await res.text();

    // ページが存在しない場合
    if (html.includes('お探しのページは見つかりません') || html.includes('Page Not Found')) return null;

    let name = null;
    let image = null;

    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitle) name = ogTitle[1].replace(/\s*のライブ配信.*$/, '').replace(/\s*\(@.*$/, '').trim();

    if (!name) {
      const t = html.match(/<title>([^<]+)<\/title>/i);
      if (t) name = t[1].split(/[-|｜]/)[0].trim();
    }

    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (ogImage) image = ogImage[1];

    if (!image) {
      const img = html.match(/https:\/\/imagegw\d*\.twitcasting\.tv\/image\d*\/[^"'\s]+/);
      if (img) image = img[0];
    }

    return { name: name || userId, image: image || null };
  } catch (e) {
    console.error(`fetchUserInfo error (${userId}):`, e.message);
    return null;
  }
}

// ---- 配信状態と視聴数を取得 ----
async function fetchBroadcastStats(userId) {
  // 1) frontendapi（認証不要・JSON）
  try {
    const res = await fetch(`https://frontendapi.twitcasting.tv/users/${encodeURIComponent(userId)}/latest-movie`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      const m = data && data.movie;
      if (m && m.is_on_live) {
        const concurrent = Number(m.current_view_count ?? m.viewers ?? 0);
        const total = Number(m.total_view_count ?? m.total_viewers ?? 0);
        if (!isNaN(concurrent) && !isNaN(total)) {
          return { concurrent, total, timestamp: new Date().toISOString() };
        }
      } else if (m && !m.is_on_live) {
        return null; // オフライン確定
      }
    }
  } catch (e) { /* fallback へ */ }

  // 2) HTMLスクレイピング（フォールバック）
  try {
    const res = await fetch(`https://twitcasting.tv/${encodeURIComponent(userId)}`, {
      headers: { 'User-Agent': UA }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const liveNow = /data-is-onlive=["']true["']/i.test(html) || /"is_on_live"\s*:\s*true/i.test(html);
    if (!liveNow) return null;

    let concurrent = null, total = null;

    const cur = html.match(/"current_view_count"\s*:\s*(\d+)/) || html.match(/data-viewer-count=["'](\d+)["']/);
    const tot = html.match(/"total_view_count"\s*:\s*(\d+)/) || html.match(/data-total-viewer-count=["'](\d+)["']/);
    if (cur) concurrent = parseInt(cur[1], 10);
    if (tot) total = parseInt(tot[1], 10);

    if (concurrent === null || total === null) {
      const pair = html.match(/>\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*</);
      if (pair) {
        concurrent = parseInt(pair[1].replace(/,/g, ''), 10);
        total = parseInt(pair[2].replace(/,/g, ''), 10);
      }
    }

    if (concurrent === null || total === null) return null;
    return { concurrent, total, timestamp: new Date().toISOString() };
  } catch (e) {
    console.error(`fetchBroadcastStats error (${userId}):`, e.message);
    return null;
  }
}

// ---- 監視ループ ----
async function monitorBroadcasters() {
  if (!config.broadcasters || config.broadcasters.length === 0) return;

  for (const bc of config.broadcasters) {
    const uid = bc.user_id;
    if (!broadcasterStats[uid]) {
      broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };
    }

    const stats = await fetchBroadcastStats(uid);

    if (stats) {
      if (!broadcasterStats[uid].current_broadcast) {
        broadcasterStats[uid].current_broadcast = {
          broadcast_id: `${uid}_${Date.now()}`,
          started_at: stats.timestamp,
          samples: [stats]
        };
        console.log(`[${uid}] 配信開始 concurrent=${stats.concurrent} total=${stats.total}`);
      } else {
        broadcasterStats[uid].current_broadcast.samples.push(stats);
      }
      saveJson(STATS_FILE, broadcasterStats);
    } else {
      if (broadcasterStats[uid].current_broadcast) {
        const b = broadcasterStats[uid].current_broadcast;
        b.ended_at = new Date().toISOString();
        broadcasterStats[uid].history.push(b);
        broadcasterStats[uid].current_broadcast = null;
        console.log(`[${uid}] 配信終了 samples=${b.samples.length}`);
        saveJson(STATS_FILE, broadcasterStats);
      }
    }
  }
}

// ---- HTTP サーバー ----
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url, true).pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

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
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const uid = String(data.user_id || '').trim();
        if (!uid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'user_id が空です' }));
          return;
        }

        if (config.broadcasters.some(b => b.user_id === uid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'すでに追加済みです' }));
          return;
        }

        const info = await fetchUserInfo(uid);
        if (!info) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `ユーザーが見つかりません: ${uid}` }));
          return;
        }

        const broadcaster = { user_id: uid, name: info.name, image: info.image };
        config.broadcasters.push(broadcaster);
        saveJson(CONFIG_FILE, config);

        broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };
        saveJson(STATS_FILE, broadcasterStats);

        monitorBroadcasters();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(broadcaster));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname.startsWith('/api/config/broadcasters/') && req.method === 'DELETE') {
    const uid = decodeURIComponent(pathname.replace('/api/config/broadcasters/', ''));
    config.broadcasters = config.broadcasters.filter(b => b.user_id !== uid);
    saveJson(CONFIG_FILE, config);
    delete broadcasterStats[uid];
    saveJson(STATS_FILE, broadcasterStats);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf-8', (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Twitcas Tracker Server running on port ${PORT}`);
  console.log(`Monitoring ${config.broadcasters.length} broadcasters`);
});

setInterval(monitorBroadcasters, 15000);
monitorBroadcasters();
