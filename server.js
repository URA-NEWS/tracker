const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3943;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ===== Supabase 設定（未設定ならローカルファイルにフォールバック） =====
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const USE_SB = !!(SB_URL && SB_KEY);

const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATS_FILE  = path.join(__dirname, 'stats.json');

let config = { broadcasters: [] };
let broadcasterStats = {};

// ---------- ローカルファイル ----------
function loadJson(file, fb) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { console.error(e); }
  }
  return fb;
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

// ---------- Supabase REST ----------
async function sb(method, table, { query = '', body = null, prefer = '' } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${method} ${table}: ${res.status} ${t}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// ---------- 起動時ロード ----------
async function bootstrap() {
  if (!USE_SB) {
    config = loadJson(CONFIG_FILE, { broadcasters: [] });
    broadcasterStats = loadJson(STATS_FILE, {});
    console.log('[storage] local files');
    return;
  }
  console.log('[storage] supabase');
  try {
    const bcs = await sb('GET', 'tw_broadcasters', { query: '?select=user_id,name,image&order=created_at.asc' });
    config = { broadcasters: bcs || [] };

    const brs = await sb('GET', 'tw_broadcasts', { query: '?select=id,user_id,started_at,ended_at&order=started_at.asc' });
    const smp = await sb('GET', 'tw_samples', { query: '?select=broadcast_id,concurrent,total,ts&order=ts.asc&limit=100000' });

    const byBc = {};
    (smp || []).forEach(s => {
      (byBc[s.broadcast_id] = byBc[s.broadcast_id] || []).push({
        concurrent: s.concurrent, total: s.total, timestamp: s.ts
      });
    });

    broadcasterStats = {};
    config.broadcasters.forEach(b => {
      broadcasterStats[b.user_id] = { user_id: b.user_id, current_broadcast: null, history: [] };
    });
    (brs || []).forEach(b => {
      if (!broadcasterStats[b.user_id]) {
        broadcasterStats[b.user_id] = { user_id: b.user_id, current_broadcast: null, history: [] };
      }
      const obj = {
        broadcast_id: b.id,
        started_at: b.started_at,
        ended_at: b.ended_at || undefined,
        samples: byBc[b.id] || []
      };
      if (b.ended_at) broadcasterStats[b.user_id].history.push(obj);
      else broadcasterStats[b.user_id].current_broadcast = obj;
    });
  } catch (e) {
    console.error('[bootstrap] Supabase読み込み失敗、ローカルにフォールバック:', e.message);
    config = loadJson(CONFIG_FILE, { broadcasters: [] });
    broadcasterStats = loadJson(STATS_FILE, {});
  }
}

// ---------- 永続化 ----------
async function persistBroadcasterAdd(b) {
  if (!USE_SB) { saveJson(CONFIG_FILE, config); return; }
  await sb('POST', 'tw_broadcasters', { body: [b], prefer: 'resolution=merge-duplicates' });
}
async function persistBroadcasterDelete(uid) {
  if (!USE_SB) { saveJson(CONFIG_FILE, config); saveJson(STATS_FILE, broadcasterStats); return; }
  const q = `?user_id=eq.${encodeURIComponent(uid)}`;
  await sb('DELETE', 'tw_samples', { query: q });
  await sb('DELETE', 'tw_broadcasts', { query: q });
  await sb('DELETE', 'tw_broadcasters', { query: q });
}
async function persistBroadcastStart(uid, b) {
  if (!USE_SB) { saveJson(STATS_FILE, broadcasterStats); return; }
  await sb('POST', 'tw_broadcasts', {
    body: [{ id: b.broadcast_id, user_id: uid, started_at: b.started_at }],
    prefer: 'resolution=merge-duplicates'
  });
}
async function persistBroadcastEnd(bid, endedAt) {
  if (!USE_SB) { saveJson(STATS_FILE, broadcasterStats); return; }
  await sb('PATCH', 'tw_broadcasts', {
    query: `?id=eq.${encodeURIComponent(bid)}`,
    body: { ended_at: endedAt }
  });
}
async function persistSample(uid, bid, s) {
  if (!USE_SB) { saveJson(STATS_FILE, broadcasterStats); return; }
  await sb('POST', 'tw_samples', {
    body: [{ broadcast_id: bid, user_id: uid, concurrent: s.concurrent, total: s.total, ts: s.timestamp }]
  });
}

// ---------- ツイキャス: 名前・アイコン ----------
async function fetchUserInfo(userId) {
  try {
    const res = await fetch(`https://twitcasting.tv/${encodeURIComponent(userId)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
    if (!res.ok) return null;
    const html = await res.text();
    if (html.includes('お探しのページは見つかりません') || html.includes('Page Not Found')) return null;

    let name = null, image = null;

    // 配信者名: <title> の "○○ (@id) 's Live" から取る（og:title は配信タイトルなので使わない）
    const t = html.match(/<title>([\s\S]*?)<\/title>/i);
    if (t) {
      let raw = t[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();
      const byAt = raw.match(/^(.*?)\s*\(@[^)]+\)/);
      if (byAt) name = byAt[1].trim();
      if (!name) name = raw.split(/\s*[-|｜]\s*/)[0].trim();
    }

    // アイコン: プロフィール画像（image3s のパス）。og:image は配信サムネなので使わない
    let m = html.match(/https?:\/\/imagegw\d*\.twitcasting\.tv\/image3s\/[^"'\s\\)]+/);
    if (m) image = m[0];
    if (!image) {
      m = html.match(/https?:\/\/[^"'\s\\)]*pbs\.twimg\.com\/profile_images\/[^"'\s\\)]+/);
      if (m) image = m[0];
    }
    if (!image) {
      m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      if (m) image = m[1];
    }
    if (image) image = image.replace(/^http:/, 'https:').replace(/_bigger\.(jpg|png)/, '_400x400.$1');

    return { name: name || userId, image: image || null };
  } catch (e) {
    console.error(`fetchUserInfo (${userId}):`, e.message);
    return null;
  }
}

// 起動時に既存配信者の名前・アイコンを更新
async function refreshAllUserInfo() {
  for (const b of config.broadcasters) {
    try {
      const info = await fetchUserInfo(b.user_id);
      if (!info) continue;
      if (info.name !== b.name || info.image !== b.image) {
        b.name = info.name; b.image = info.image;
        await persistBroadcasterAdd(b);
        console.log(`[${b.user_id}] プロフィール更新: ${b.name}`);
      }
    } catch (e) { console.error('refresh:', e.message); }
  }
  if (!USE_SB) saveJson(CONFIG_FILE, config);
}

// ---------- ツイキャス: 配信状態・視聴数 ----------

// 1) 配信中か & movie_id を取得（yt-dlp/streamlink と同じ確実な経路）
async function fetchLiveInfo(userId) {
  try {
    const res = await fetch(
      `https://twitcasting.tv/streamserver.php?target=${encodeURIComponent(userId)}&mode=client&player=pc_web`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!res.ok) return { live: false, movie_id: null, status: res.status };
    const j = await res.json();
    const m = j && j.movie;
    return { live: !!(m && m.live), movie_id: m && m.id ? String(m.id) : null, status: res.status };
  } catch (e) {
    return { live: false, movie_id: null, error: e.message };
  }
}

// 2) 視聴数を取得（複数経路をフォールバック）
async function fetchViewCounts(userId, movieId) {
  // 2-a) 公式風JSON（movie_id 指定）
  if (movieId) {
    try {
      const r = await fetch(`https://frontendapi.twitcasting.tv/movies/${movieId}/status/viewer`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }
      });
      if (r.ok) {
        const j = await r.json();
        const c = j?.viewers?.current ?? j?.current_view_count ?? j?.current;
        const t = j?.viewers?.total ?? j?.total_view_count ?? j?.total;
        if (c != null && t != null) return { concurrent: Number(c), total: Number(t), src: 'viewerapi' };
      }
    } catch (e) { /* next */ }
  }

  // 2-b) 配信ページHTMLから抽出
  const pageUrl = movieId
    ? `https://twitcasting.tv/${encodeURIComponent(userId)}/movie/${movieId}`
    : `https://twitcasting.tv/${encodeURIComponent(userId)}`;
  try {
    const r = await fetch(pageUrl, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
    if (r.ok) {
      const h = await r.text();
      const got = parseCountsFromHtml(h);
      if (got) return { ...got, src: 'html' };
    }
  } catch (e) { /* next */ }

  // 2-c) プロフィールページHTML
  if (movieId) {
    try {
      const r = await fetch(`https://twitcasting.tv/${encodeURIComponent(userId)}`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }
      });
      if (r.ok) {
        const got = parseCountsFromHtml(await r.text());
        if (got) return { ...got, src: 'profile-html' };
      }
    } catch (e) { /* give up */ }
  }
  return null;
}

function parseCountsFromHtml(h) {
  let c = null, t = null;

  let m = h.match(/"current_view_count"\s*:\s*"?(\d+)"?/);
  if (m) c = parseInt(m[1], 10);
  m = h.match(/"total_view_count"\s*:\s*"?(\d+)"?/);
  if (m) t = parseInt(m[1], 10);
  if (c != null && t != null) return { concurrent: c, total: t };

  m = h.match(/data-viewer-count=["'](\d+)["']/);
  if (m) c = parseInt(m[1], 10);
  m = h.match(/data-total-viewer-count=["'](\d+)["']/);
  if (m) t = parseInt(m[1], 10);
  if (c != null && t != null) return { concurrent: c, total: t };

  // タグを除去したテキストから「856 / 1251」を拾う
  const txt = h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const re = /(?<![\d:.])(\d{1,7})\s*\/\s*(\d{1,7})(?![\d:.])/g;
  let mm;
  while ((mm = re.exec(txt))) {
    const a = parseInt(mm[1], 10), b = parseInt(mm[2], 10);
    if (b >= a && b > 0 && b < 10000000) return { concurrent: a, total: b };
  }
  return null;
}

async function fetchBroadcastStats(userId) {
  const info = await fetchLiveInfo(userId);
  if (!info.live) return null;
  const v = await fetchViewCounts(userId, info.movie_id);
  if (!v) return { concurrent: 0, total: 0, timestamp: new Date().toISOString() };
  return { concurrent: v.concurrent, total: v.total, timestamp: new Date().toISOString() };
}

// ---------- 監視ループ ----------
let monitoring = false;
async function monitorBroadcasters() {
  if (monitoring) return;
  if (!config.broadcasters || !config.broadcasters.length) return;
  monitoring = true;
  try {
    for (const bc of config.broadcasters) {
      const uid = bc.user_id;
      if (!broadcasterStats[uid]) broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };

      const s = await fetchBroadcastStats(uid);

      if (s) {
        if (!broadcasterStats[uid].current_broadcast) {
          const b = { broadcast_id: `${uid}_${Date.now()}`, started_at: s.timestamp, samples: [s] };
          broadcasterStats[uid].current_broadcast = b;
          console.log(`[${uid}] 配信開始 ${s.concurrent}/${s.total}`);
          try { await persistBroadcastStart(uid, b); await persistSample(uid, b.broadcast_id, s); }
          catch (e) { console.error('persist start:', e.message); }
        } else {
          const b = broadcasterStats[uid].current_broadcast;
          b.samples.push(s);
          try { await persistSample(uid, b.broadcast_id, s); }
          catch (e) { console.error('persist sample:', e.message); }
        }
        if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
      } else {
        if (broadcasterStats[uid].current_broadcast) {
          const b = broadcasterStats[uid].current_broadcast;
          b.ended_at = new Date().toISOString();
          broadcasterStats[uid].history.push(b);
          broadcasterStats[uid].current_broadcast = null;
          console.log(`[${uid}] 配信終了 samples=${b.samples.length}`);
          try { await persistBroadcastEnd(b.broadcast_id, b.ended_at); }
          catch (e) { console.error('persist end:', e.message); }
          if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
        }
      }
    }
  } finally {
    monitoring = false;
  }
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url, true).pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      storage: USE_SB ? 'supabase' : 'local',
      broadcasters: config.broadcasters.length,
      live: config.broadcasters.filter(b => broadcasterStats[b.user_id]?.current_broadcast).length,
      time: new Date().toISOString()
    }));
    return;
  }


  // 生データ確認用: /api/debug/<user_id>
  if (pathname.startsWith('/api/debug/')) {
    (async () => {
      const uid = decodeURIComponent(pathname.replace('/api/debug/', ''));
      const out = { user_id: uid };
      out.liveInfo = await fetchLiveInfo(uid);
      if (out.liveInfo.movie_id) {
        try {
          const r = await fetch(`https://frontendapi.twitcasting.tv/movies/${out.liveInfo.movie_id}/status/viewer`, {
            headers: { 'User-Agent': UA, Accept: 'application/json' }
          });
          out.viewerapi_status = r.status;
          out.viewerapi_body = (await r.text()).slice(0, 600);
        } catch (e) { out.viewerapi_error = e.message; }

        try {
          const r2 = await fetch(`https://twitcasting.tv/${encodeURIComponent(uid)}/movie/${out.liveInfo.movie_id}`, {
            headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }
          });
          const h = await r2.text();
          out.movie_page_status = r2.status;
          out.movie_page_len = h.length;
          out.parsed_from_movie_page = parseCountsFromHtml(h);
          const txt = h
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ');
          const hits = [];
          const re2 = /.{0,50}\d{1,7}\s*\/\s*\d{1,7}.{0,50}/g;
          let mm2, n2 = 0;
          while ((mm2 = re2.exec(txt)) && n2 < 10) { hits.push(mm2[0]); n2++; }
          out.slash_snippets = hits;
          out.text_len = txt.length;
        } catch (e) { out.movie_page_error = e.message; }
      }
      out.parsed = await fetchBroadcastStats(uid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out, null, 2));
    })();
    return;
  }

  if (pathname === '/api/twitcas/stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(broadcasterStats));
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (pathname === '/api/config/broadcasters' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const uid = String(data.user_id || '').trim();
        if (!uid) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'user_id が空です' })); return; }
        if (config.broadcasters.some(b => b.user_id === uid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'すでに追加済みです' })); return;
        }
        const info = await fetchUserInfo(uid);
        if (!info) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `ユーザーが見つかりません: ${uid}` })); return; }

        const b = { user_id: uid, name: info.name, image: info.image };
        config.broadcasters.push(b);
        broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };
        await persistBroadcasterAdd(b);

        monitorBroadcasters();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(b));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname.startsWith('/api/config/broadcasters/') && req.method === 'DELETE') {
    (async () => {
      const uid = decodeURIComponent(pathname.replace('/api/config/broadcasters/', ''));
      config.broadcasters = config.broadcasters.filter(b => b.user_id !== uid);
      delete broadcasterStats[uid];
      try { await persistBroadcasterDelete(uid); } catch (e) { console.error(e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    })();
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

// ---------- 起動 ----------
bootstrap().then(() => {
  server.listen(PORT, () => {
    console.log(`Twitcas Tracker on :${PORT} / storage=${USE_SB ? 'supabase' : 'local'} / broadcasters=${config.broadcasters.length}`);
  });
  refreshAllUserInfo();
  setInterval(refreshAllUserInfo, 6 * 60 * 60 * 1000);
  setInterval(monitorBroadcasters, 15000);
  monitorBroadcasters();

  // Render無料プランのスリープ防止（自分の公開URLを10分ごとに叩く）
  const SELF = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (SELF) {
    setInterval(() => {
      fetch(`${SELF.replace(/\/+$/, '')}/healthz`).catch(() => {});
    }, 10 * 60 * 1000);
    console.log(`[keepalive] ${SELF}/healthz を10分ごとにping`);
  }
});
