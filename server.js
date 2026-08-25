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

// ツイキャス公式API（アプリケーションのみアクセス / Basic認証）
const TC_ID = process.env.TWITCASTING_CLIENT_ID || '';
const TC_SECRET = process.env.TWITCASTING_CLIENT_SECRET || '';
const TC_BASIC = (TC_ID && TC_SECRET) ? Buffer.from(`${TC_ID}:${TC_SECRET}`).toString('base64') : '';
const USE_TC_API = !!TC_BASIC;

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
    const bcs = await sb('GET', 'tw_broadcasters', { query: '?select=user_id,name,image,pinned,auto,last_live_at,best_peak,dormant,dormant_at&order=created_at.asc' });
    config = { broadcasters: bcs || [] };

    const brs = await sb('GET', 'tw_broadcasts', { query: '?select=id,user_id,started_at,ended_at,peak,total,duration,source&order=started_at.asc' });
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
        source: b.source || 'live',
        peak: b.peak ?? null,
        total_final: b.total ?? null,
        duration: b.duration ?? null,
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
  // 公式APIが使える場合はそちらを優先（正確な配信者名・アイコン）
  if (USE_TC_API) {
    try {
      const r = await fetch(`https://apiv2.twitcasting.tv/users/${encodeURIComponent(userId)}`, {
        headers: { 'X-Api-Version': '2.0', Authorization: `Basic ${TC_BASIC}`, Accept: 'application/json' }
      });
      if (r.ok) {
        const j = await r.json();
        if (j && j.user) {
          return {
            name: j.user.name || j.user.screen_id || userId,
            image: (j.user.image || '').replace(/^http:/, 'https:').replace(/_normal\.(jpg|png)/, '_400x400.$1') || null
          };
        }
      }
      if (r.status === 404) return null;
    } catch (e) { /* HTMLへフォールバック */ }
  }
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
    if (b.dormant) continue;
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

// 2) 公式API（apiv2）で現在の配信情報を取得
async function fetchCurrentLiveApi(userId) {
  if (!USE_TC_API) return { ok: false, reason: 'no_credentials' };
  try {
    const r = await fetch(`https://apiv2.twitcasting.tv/users/${encodeURIComponent(userId)}/current_live`, {
      headers: {
        'X-Api-Version': '2.0',
        Authorization: `Basic ${TC_BASIC}`,
        Accept: 'application/json'
      }
    });
    if (r.status === 404) return { ok: true, live: false };
    if (!r.ok) return { ok: false, reason: `status_${r.status}`, body: (await r.text()).slice(0, 300) };
    const j = await r.json();
    const m = j && j.movie;
    if (!m || !m.is_live) return { ok: true, live: false };
    return {
      ok: true,
      live: true,
      movie_id: String(m.id),
      concurrent: Number(m.current_view_count ?? 0),
      total: Number(m.total_view_count ?? 0),
      broadcaster: j.broadcaster || null
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function fetchBroadcastStats(userId) {
  // 公式APIが使えるならそれが最も正確
  const api = await fetchCurrentLiveApi(userId);
  if (api.ok) {
    if (!api.live) return null;
    return { concurrent: api.concurrent, total: api.total, timestamp: new Date().toISOString() };
  }

  // フォールバック: 配信中かどうかだけ判定（視聴数は0）
  const info = await fetchLiveInfo(userId);
  if (!info.live) return null;
  return { concurrent: 0, total: 0, timestamp: new Date().toISOString() };
}

// ---------- 過去配信の取り込み ----------
async function backfillUser(userId, maxMovies = 500) {
  if (!USE_TC_API) return { ok: false, reason: 'no_credentials' };
  let offset = 0, imported = 0, scanned = 0, totalCount = null;

  while (scanned < maxMovies) {
    let j;
    try {
      const r = await fetch(
        `https://apiv2.twitcasting.tv/users/${encodeURIComponent(userId)}/movies?offset=${offset}&limit=50`,
        { headers: { 'X-Api-Version': '2.0', Authorization: `Basic ${TC_BASIC}`, Accept: 'application/json' } }
      );
      if (!r.ok) return { ok: false, reason: `status_${r.status}`, imported };
      j = await r.json();
    } catch (e) { return { ok: false, reason: e.message, imported }; }

    const movies = (j && j.movies) || [];
    if (totalCount === null) totalCount = j.total_count ?? null;
    if (!movies.length) break;

    if (!broadcasterStats[userId]) broadcasterStats[userId] = { user_id: userId, current_broadcast: null, history: [] };

    const rows = [];
    for (const m of movies) {
      scanned++;
      if (m.is_live) continue;
      const startedMs = Number(m.created) * 1000;
      if (!startedMs) continue;
      const dur = Number(m.duration || 0);
      const peak = Number(m.max_view_count ?? 0);
      const total = Number(m.total_view_count ?? m.current_view_count ?? 0);
      if (!peak && !total) continue;

      const id = `arc_${userId}_${m.id}`;
      if (broadcasterStats[userId].history.some(h => h.broadcast_id === id)) continue;

      const obj = {
        broadcast_id: id,
        started_at: new Date(startedMs).toISOString(),
        ended_at: new Date(startedMs + dur * 1000).toISOString(),
        source: 'archive',
        peak, total_final: total, duration: dur,
        samples: []
      };
      broadcasterStats[userId].history.push(obj);
      rows.push({
        id, user_id: userId,
        started_at: obj.started_at, ended_at: obj.ended_at,
        peak, total, duration: dur, source: 'archive'
      });
      imported++;
    }

    if (rows.length && USE_SB) {
      try { await sb('POST', 'tw_broadcasts', { body: rows, prefer: 'resolution=merge-duplicates' }); }
      catch (e) { console.error('backfill upsert:', e.message); }
    }

    offset += movies.length;
    if (totalCount !== null && offset >= totalCount) break;
  }

  broadcasterStats[userId].history.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
  if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
  return { ok: true, imported, scanned };
}

// ---------- 自動収集（同接上位50人） ----------
const AUTO_LIMIT = 50;

async function discoverTopLives() {
  if (!USE_TC_API) return { ok: false, reason: 'no_credentials' };
  let movies = [];
  try {
    const r = await fetch('https://apiv2.twitcasting.tv/search/lives?limit=100&type=recommend&lang=ja', {
      headers: { 'X-Api-Version': '2.0', Authorization: `Basic ${TC_BASIC}`, Accept: 'application/json' }
    });
    if (!r.ok) return { ok: false, reason: `status_${r.status}` };
    const j = await r.json();
    movies = (j && j.movies) || [];
  } catch (e) { return { ok: false, reason: e.message }; }

  const cands = movies
    .map(x => ({
      user_id: (x.broadcaster && x.broadcaster.screen_id) || null,
      name: (x.broadcaster && x.broadcaster.name) || null,
      image: (x.broadcaster && x.broadcaster.image) || null,
      viewers: Number((x.movie && x.movie.current_view_count) || 0)
    }))
    .filter(c => c.user_id)
    .sort((a, b) => b.viewers - a.viewers);

  const byId = new Map(config.broadcasters.map(b => [b.user_id, b]));
  const added = [], revived = [], slept = [];
  const now = new Date().toISOString();

  // 実力スコア = これまでの最高同接（今回の値で更新）
  const scoreOf = b => Number(b.best_peak || 0);
  const activeAutos = () => config.broadcasters.filter(b => b.auto && !b.dormant);

  for (const c of cands) {
    const ex = byId.get(c.user_id);

    // 既存: 実績更新＋休止からの復帰判定
    if (ex) {
      let changed = false;
      if (c.viewers > (ex.best_peak || 0)) { ex.best_peak = c.viewers; changed = true; }
      ex.last_live_at = now;
      if (ex.dormant && ex.auto) {
        const autos = activeAutos();
        if (autos.length < AUTO_LIMIT) {
          ex.dormant = false; ex.dormant_at = null; changed = true; revived.push(ex.user_id);
        } else {
          const weakest = autos.reduce((m, b) => scoreOf(b) < scoreOf(m) ? b : m, autos[0]);
          if (c.viewers > scoreOf(weakest)) {
            weakest.dormant = true; weakest.dormant_at = now;
            ex.dormant = false; ex.dormant_at = null;
            slept.push(weakest.user_id); revived.push(ex.user_id); changed = true;
            try { await persistBroadcasterAdd(weakest); } catch (e) {}
          }
        }
      }
      if (changed) { try { await persistBroadcasterAdd(ex); } catch (e) {} }
      continue;
    }

    // 新規
    const autos = activeAutos();
    let makeRoom = true;
    if (autos.length >= AUTO_LIMIT) {
      const weakest = autos.reduce((m, b) => scoreOf(b) < scoreOf(m) ? b : m, autos[0]);
      if (c.viewers > scoreOf(weakest)) {
        weakest.dormant = true; weakest.dormant_at = now;
        slept.push(weakest.user_id);
        try { await persistBroadcasterAdd(weakest); } catch (e) {}
      } else {
        makeRoom = false;   // 実績が下回るなら入れ替えない
      }
    }
    if (!makeRoom) continue;

    const b = {
      user_id: c.user_id,
      name: c.name || c.user_id,
      image: (c.image || '').replace(/^http:/, 'https:').replace(/_normal\.(jpg|png)/, '_400x400.$1') || null,
      pinned: false, auto: true, dormant: false,
      best_peak: c.viewers, last_live_at: now
    };
    config.broadcasters.push(b);
    byId.set(b.user_id, b);
    if (!broadcasterStats[b.user_id]) broadcasterStats[b.user_id] = { user_id: b.user_id, current_broadcast: null, history: [] };
    added.push({ user_id: b.user_id, name: b.name, viewers: c.viewers });
    try { await persistBroadcasterAdd(b); } catch (e) { console.error('auto add:', e.message); }
  }

  if (!USE_SB) saveJson(CONFIG_FILE, config);
  const act = activeAutos().length;
  if (added.length || slept.length || revived.length) {
    console.log(`[auto] +${added.length} 休止${slept.length} 復帰${revived.length} (稼働 ${act}/${AUTO_LIMIT})`);
  }
  return { ok: true, added, slept, revived, auto_slots: `${act}/${AUTO_LIMIT}`, candidates: cands.length };
}

// 自動枠の整理: 実績下位を「休止」にする（データは消さない）
async function pruneAuto(keep = AUTO_LIMIT) {
  const autos = config.broadcasters.filter(b => b.auto && !b.dormant);
  if (autos.length <= keep) return { slept: 0 };
  autos.sort((a, b) => (a.best_peak || 0) - (b.best_peak || 0));
  const drop = autos.slice(0, autos.length - keep);
  const now = new Date().toISOString();
  for (const b of drop) {
    b.dormant = true; b.dormant_at = now;
    try { await persistBroadcasterAdd(b); } catch (e) { console.error('prune:', e.message); }
  }
  if (!USE_SB) saveJson(CONFIG_FILE, config);
  return { slept: drop.length };
}

// ---------- 監視ループ ----------
let monitoring = false;
const offlineCheckedAt = {};   // user_id -> ms
const OFFLINE_INTERVAL = 5 * 60 * 1000; // オフラインの人は5分に1回だけ確認

async function monitorBroadcasters() {
  if (monitoring) return;
  if (!config.broadcasters || !config.broadcasters.length) return;
  monitoring = true;
  const now = Date.now();
  try {
    for (const bc of config.broadcasters) {
      const uid = bc.user_id;
      if (bc.dormant) continue;   // 休止中は監視しない（データは保持）
      if (!broadcasterStats[uid]) broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };

      const wasLive = !!broadcasterStats[uid].current_broadcast;
      if (!wasLive) {
        const last = offlineCheckedAt[uid] || 0;
        if (now - last < OFFLINE_INTERVAL) continue;
        offlineCheckedAt[uid] = now;
      }

      const s = await fetchBroadcastStats(uid);

      if (s) {
        if (!wasLive) {
          const b = { broadcast_id: `${uid}_${Date.now()}`, started_at: s.timestamp, samples: [s], source: 'live' };
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
        // 実績更新
        if (s.concurrent > (bc.best_peak || 0)) {
          bc.best_peak = s.concurrent;
          bc.last_live_at = s.timestamp;
          try { await persistBroadcasterAdd(bc); } catch (e) {}
        }
        if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
      } else if (wasLive) {
        const b = broadcasterStats[uid].current_broadcast;
        b.ended_at = new Date().toISOString();
        broadcasterStats[uid].history.push(b);
        broadcasterStats[uid].current_broadcast = null;
        offlineCheckedAt[uid] = now;
        console.log(`[${uid}] 配信終了 samples=${b.samples.length}`);
        try { await persistBroadcastEnd(b.broadcast_id, b.ended_at); }
        catch (e) { console.error('persist end:', e.message); }
        if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
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
      official_api: USE_TC_API,
      auto_slots: `${config.broadcasters.filter(b => b.auto && !b.dormant).length}/${AUTO_LIMIT}`,
      dormant: config.broadcasters.filter(b => b.dormant).length,
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
      const out = { user_id: uid, official_api_enabled: USE_TC_API };
      out.currentLiveApi = await fetchCurrentLiveApi(uid);
      out.streamserver = await fetchLiveInfo(uid);
      out.parsed = await fetchBroadcastStats(uid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out, null, 2));
    })();
    return;
  }

  // 全体の日別サマリー: GET /api/overall
  if (pathname === '/api/overall' && req.method === 'GET') {
    (async () => {
      try {
        if (USE_SB) {
          const rows = await sb('GET', 'tw_daily_overall', { query: '?select=*&order=day.asc' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rows || []));
          return;
        }
        // ローカル時はメモリから集計
        const byDay = {};
        for (const uid of Object.keys(broadcasterStats)) {
          const st = broadcasterStats[uid];
          const list = [...(st.history || [])];
          if (st.current_broadcast) list.push(st.current_broadcast);
          for (const b of list) {
            const sm = (b.samples || []).filter(x => x.concurrent > 0);
            let avg = null, peak = null, total = null;
            if (sm.length) {
              avg = Math.round(sm.reduce((t, x) => t + x.concurrent, 0) / sm.length);
              peak = Math.max(...sm.map(x => x.concurrent));
              total = sm[sm.length - 1].total;
            } else if (b.source === 'archive') {
              avg = b.peak; peak = b.peak; total = b.total_final;
            }
            if (avg == null) continue;
            const d = new Date(b.started_at);
            const key = new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
            (byDay[key] = byDay[key] || []).push({ uid, avg, peak, total });
          }
        }
        const out = Object.keys(byDay).sort().map(day => {
          const a = byDay[day];
          return {
            day,
            broadcasts: a.length,
            broadcasters: new Set(a.map(x => x.uid)).size,
            overall_avg: Math.round(a.reduce((t, x) => t + x.avg, 0) / a.length),
            overall_avg_peak: Math.round(a.reduce((t, x) => t + (x.peak || 0), 0) / a.length),
            overall_total_viewers: a.reduce((t, x) => t + (x.total || 0), 0),
            day_max_peak: Math.max(...a.map(x => x.peak || 0))
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // 自動収集を今すぐ実行: POST /api/discover
  if (pathname === '/api/discover' && req.method === 'POST') {
    (async () => {
      const r = await discoverTopLives();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r, null, 2));
    })();
    return;
  }

  // 休止解除: POST /api/wake/<user_id>
  if (pathname.startsWith('/api/wake/') && req.method === 'POST') {
    (async () => {
      const uid = decodeURIComponent(pathname.replace('/api/wake/', ''));
      const b = config.broadcasters.find(x => x.user_id === uid);
      if (b) {
        b.dormant = false; b.dormant_at = null;
        try { await persistBroadcasterAdd(b); } catch (e) {}
        if (!USE_SB) saveJson(CONFIG_FILE, config);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: !!b }));
    })();
    return;
  }

  // 自動枠の整理: POST /api/prune
  if (pathname === '/api/prune' && req.method === 'POST') {
    (async () => {
      const r = await pruneAuto();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r, null, 2));
    })();
    return;
  }

  // 過去配信の取り込み: POST /api/backfill  または /api/backfill/<user_id>
  if (pathname.startsWith('/api/backfill') && req.method === 'POST') {
    (async () => {
      const spec = pathname.replace('/api/backfill', '').replace(/^\//, '');
      const targets = spec ? [decodeURIComponent(spec)] : config.broadcasters.map(b => b.user_id);
      const result = {};
      for (const uid of targets) result[uid] = await backfillUser(uid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    })();
    return;
  }

  // 0サンプル一括削除: POST /api/cleanup
  if (pathname === '/api/cleanup' && req.method === 'POST') {
    (async () => {
      let removed = 0;
      const strip = (arr) => {
        const before = arr.length;
        const out = arr.filter(x => !(Number(x.concurrent) === 0 && Number(x.total) === 0));
        removed += before - out.length;
        return out;
      };
      for (const uid of Object.keys(broadcasterStats)) {
        const st = broadcasterStats[uid];
        if (st.current_broadcast) st.current_broadcast.samples = strip(st.current_broadcast.samples || []);
        st.history = (st.history || []).map(b => ({ ...b, samples: strip(b.samples || []) }));
      }
      if (USE_SB) {
        try { await sb('DELETE', 'tw_samples', { query: '?concurrent=eq.0&total=eq.0' }); }
        catch (e) { console.error('cleanup:', e.message); }
      } else {
        saveJson(STATS_FILE, broadcasterStats);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ removed }));
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

        const b = { user_id: uid, name: info.name, image: info.image, pinned: true, auto: false, dormant: false, best_peak: 0 };
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
    console.log(`Twitcas Tracker on :${PORT} / storage=${USE_SB ? 'supabase' : 'local'} / officialAPI=${USE_TC_API} / broadcasters=${config.broadcasters.length}`);
  });
  refreshAllUserInfo();
  discoverTopLives();
  setInterval(discoverTopLives, 5 * 60 * 1000);
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
