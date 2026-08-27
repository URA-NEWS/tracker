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

// Kick 公式API（アプリアクセストークン）
const KICK_ID = process.env.KICK_CLIENT_ID || '';
const KICK_SECRET = process.env.KICK_CLIENT_SECRET || '';
const USE_KICK = !!(KICK_ID && KICK_SECRET);
const KICK_LIMIT = 50;
let kickToken = null, kickTokenExp = 0;

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
    const bcs = await sb('GET', 'tw_broadcasters', { query: '?select=user_id,name,image,pinned,auto,last_live_at,best_peak,dormant,dormant_at,platform,kick_slug,kick_user_id&order=created_at.asc' });
    config = { broadcasters: bcs || [] };

    const brs = await sb('GET', 'tw_broadcasts', { query: '?select=id,user_id,started_at,ended_at,peak,total,duration,source,platform&order=started_at.asc' });
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
        platform: b.platform || 'twitcasting',
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
  const row = {
    user_id: b.user_id, name: b.name ?? null, image: b.image ?? null,
    pinned: !!b.pinned, auto: !!b.auto, dormant: !!b.dormant,
    dormant_at: b.dormant_at ?? null, last_live_at: b.last_live_at ?? null,
    best_peak: Number(b.best_peak || 0), platform: b.platform || 'twitcasting',
    kick_slug: b.kick_slug ?? null, kick_user_id: b.kick_user_id ?? null
  };
  await sb('POST', 'tw_broadcasters', { body: [row], prefer: 'resolution=merge-duplicates' });
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
  const plat = (config.broadcasters.find(x => x.user_id === uid) || {}).platform || 'twitcasting';
  await sb('POST', 'tw_broadcasts', {
    body: [{ id: b.broadcast_id, user_id: uid, started_at: b.started_at, platform: plat }],
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
    if (b.dormant || b.platform === 'kick') continue;
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
const backfillJob = { running: false, done: 0, totalTargets: 0, imported: 0, current: null, finishedAt: null, error: null };

function findMissingArchive() {
  return config.broadcasters
    .filter(b => {
      const st = broadcasterStats[b.user_id];
      if (!st) return true;
      return !(st.history || []).some(h => h.source === 'archive');
    })
    .map(b => b.user_id);
}

async function autoBackfillMissing() {
  if (backfillJob.running) return;
  const targets = findMissingArchive();
  if (!targets.length) return;
  console.log(`[backfill] 未取込 ${targets.length}人を自動補完`);
  await runBackfillJob(targets);
}

async function runBackfillJob(targets) {
  if (backfillJob.running) return;
  backfillJob.running = true;
  backfillJob.done = 0; backfillJob.imported = 0; backfillJob.error = null;
  backfillJob.totalTargets = targets.length; backfillJob.finishedAt = null;
  console.log(`[backfill] 開始 ${targets.length}人`);
  for (const uid of targets) {
    backfillJob.current = uid;
    try {
      const r = await backfillUser(uid);
      if (r.ok) backfillJob.imported += r.imported || 0;
    } catch (e) { backfillJob.error = e.message; }
    backfillJob.done++;
  }
  backfillJob.current = null;
  backfillJob.running = false;
  backfillJob.finishedAt = new Date().toISOString();
  console.log(`[backfill] 完了 ${backfillJob.imported}件`);
}

async function backfillUser(userId, maxMovies = 500) {
  if (isKick(userId)) {
    const b = config.broadcasters.find(x => x.user_id === userId);
    return b ? await backfillKick(b) : { ok: false, reason: 'not_found', imported: 0 };
  }
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
        peak, total, duration: dur, source: 'archive', platform: 'twitcasting'
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

// ---------- Kick ----------
const KICK_PREFIX = 'kick:';
const isKick = uid => String(uid).startsWith(KICK_PREFIX);
const kickSlug = uid => String(uid).slice(KICK_PREFIX.length);

async function getKickToken() {
  if (!USE_KICK) return null;
  if (kickToken && Date.now() < kickTokenExp - 60000) return kickToken;
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KICK_ID,
      client_secret: KICK_SECRET
    });
    const r = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!r.ok) { console.error('[kick] token', r.status, (await r.text()).slice(0, 200)); return null; }
    const j = await r.json();
    kickToken = j.access_token;
    kickTokenExp = Date.now() + (Number(j.expires_in || 3600) * 1000);
    return kickToken;
  } catch (e) { console.error('[kick] token', e.message); return null; }
}

// 日本語配信中の一覧を1回で取得（同接付き）
async function fetchKickLiveList() {
  const tok = await getKickToken();
  if (!tok) return null;
  const tries = [
    'https://api.kick.com/public/v1/livestreams?language=ja&sort=viewer_count&limit=100',
    'https://api.kick.com/public/v1/livestreams?language=japanese&sort=viewer_count&limit=100'
  ];
  for (const url of tries) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      const data = (j && j.data) || [];
      if (data.length) {
        return data.map(x => {
          const cslug = x.channel_slug || x.slug;
          return {
            slug: cslug,
            channel_slug: x.channel_slug || null,
            broadcaster_user_id: x.broadcaster_user_id ?? null,
            user_id: KICK_PREFIX + cslug,
            name: x.channel_name || x.slug || cslug,
            image: x.thumbnail || null,
            viewers: Number(x.viewer_count || 0),
            started_at: x.started_at || null,
            language: x.language || null
          };
        });
      }
    } catch (e) { /* next */ }
  }
  return [];
}

let kickLiveCache = { at: 0, list: [] };
async function getKickLive() {
  if (Date.now() - kickLiveCache.at < 12000) return kickLiveCache.list;
  const list = await fetchKickLiveList();
  if (list) kickLiveCache = { at: Date.now(), list };
  return kickLiveCache.list;
}

async function fetchKickChannel(slug) {
  const tok = await getKickToken();
  if (!tok) return null;
  try {
    const r = await fetch(`https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' }
    });
    if (!r.ok) return null;
    const j = await r.json();
    const c = (j && j.data && j.data[0]) || null;
    if (!c) return null;
    return {
      name: c.slug || slug,
      image: c.banner_picture || null,
      live: !!(c.stream && c.stream.is_live),
      viewers: Number((c.stream && c.stream.viewer_count) || 0)
    };
  } catch (e) { return null; }
}

// broadcaster_user_id から正しいチャンネルスラッグを解決
async function resolveKickSlug(b) {
  if (b.kick_slug) return b.kick_slug;
  const cand = kickSlug(b.user_id);

  // 1) 非公開APIで直接当たるか
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(cand)}`, { headers: KICK_HDRS });
    if (r.ok) { b.kick_slug = cand; return cand; }
  } catch (e) {}

  // 2) 公式APIで broadcaster_user_id から引く
  const uid = b.kick_user_id;
  if (uid) {
    const tok = await getKickToken();
    if (tok) {
      try {
        const r = await fetch(`https://api.kick.com/public/v1/channels?broadcaster_user_id=${uid}`, {
          headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' }
        });
        if (r.ok) {
          const j = await r.json();
          const c = (j && j.data && j.data[0]) || null;
          if (c && c.slug) { b.kick_slug = c.slug; return c.slug; }
        }
      } catch (e) {}
    }
  }
  return null;
}

// Kick の過去配信を取り込む（非公開API）
async function backfillKick(b) {
  const slug = await resolveKickSlug(b);
  if (!slug) return { ok: false, reason: 'slug_unresolved', imported: 0 };

  let vids = [];
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`, { headers: KICK_HDRS });
    if (!r.ok) return { ok: false, reason: `status_${r.status}`, imported: 0 };
    const j = await r.json();
    vids = Array.isArray(j) ? j : (j.data || []);
  } catch (e) { return { ok: false, reason: e.message, imported: 0 }; }

  const uid = b.user_id;
  if (!broadcasterStats[uid]) broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };

  const rows = [];
  for (const v of vids) {
    const ls = v.livestream || v;
    const startedRaw = ls.start_time || v.created_at || ls.created_at;
    if (!startedRaw) continue;
    const startedMs = new Date(String(startedRaw).replace(' ', 'T') + (String(startedRaw).endsWith('Z') ? '' : 'Z')).getTime();
    if (!startedMs || isNaN(startedMs)) continue;
    const durMs = Number(v.duration || ls.duration || 0);
    const peak = Number(ls.viewer_count ?? v.viewer_count ?? 0);
    const total = Number(v.views ?? v.view_count ?? ls.views ?? 0);
    if (!peak && !total) continue;

    const id = `karc_${uid}_${v.id || ls.id}`;
    if (broadcasterStats[uid].history.some(h => h.broadcast_id === id)) continue;

    const obj = {
      broadcast_id: id,
      started_at: new Date(startedMs).toISOString(),
      ended_at: new Date(startedMs + durMs).toISOString(),
      source: 'archive', platform: 'kick',
      peak, total_final: total, duration: Math.round(durMs / 1000),
      samples: []
    };
    broadcasterStats[uid].history.push(obj);
    rows.push({
      id, user_id: uid, started_at: obj.started_at, ended_at: obj.ended_at,
      peak, total, duration: obj.duration, source: 'archive', platform: 'kick'
    });
    if (peak > (b.best_peak || 0)) b.best_peak = peak;
  }

  if (rows.length && USE_SB) {
    try { await sb('POST', 'tw_broadcasts', { body: rows, prefer: 'resolution=merge-duplicates' }); }
    catch (e) { console.error('kick backfill upsert:', e.message); }
  }
  try { await persistBroadcasterAdd(b); } catch (e) {}
  broadcasterStats[uid].history.sort((a, c) => new Date(a.started_at) - new Date(c.started_at));
  if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
  return { ok: true, imported: rows.length, slug };
}

// Kick の自動収集（同接上位・日本語）
async function discoverKick() {
  if (!USE_KICK) return { ok: false, reason: 'no_credentials' };
  const list = await getKickLive();
  if (!list || !list.length) return { ok: true, added: [], slept: [], auto_slots: '0/' + KICK_LIMIT, candidates: 0 };

  const byId = new Map(config.broadcasters.map(b => [b.user_id, b]));
  const added = [], slept = [], kickNew = [], now = new Date().toISOString();
  const activeAutos = () => config.broadcasters.filter(b => b.auto && !b.dormant && b.platform === 'kick');
  const scoreOf = b => Number(b.best_peak || 0);

  for (const c of list) {
    const ex = byId.get(c.user_id);
    if (ex) {
      let changed = false;
      if (c.viewers > (ex.best_peak || 0)) { ex.best_peak = c.viewers; changed = true; }
      if (!ex.kick_user_id && c.broadcaster_user_id) { ex.kick_user_id = c.broadcaster_user_id; changed = true; }
      if (!ex.kick_slug && c.channel_slug) { ex.kick_slug = c.channel_slug; changed = true; }
      ex.last_live_at = now;
      if (ex.dormant && ex.auto) {
        const autos = activeAutos();
        if (autos.length < KICK_LIMIT) { ex.dormant = false; ex.dormant_at = null; changed = true; }
      }
      if (changed) { try { await persistBroadcasterAdd(ex); } catch (e) {} }
      continue;
    }
    const autos = activeAutos();
    if (autos.length >= KICK_LIMIT) {
      const weakest = autos.reduce((m, b) => scoreOf(b) < scoreOf(m) ? b : m, autos[0]);
      if (c.viewers > scoreOf(weakest)) {
        weakest.dormant = true; weakest.dormant_at = now;
        slept.push(weakest.user_id);
        try { await persistBroadcasterAdd(weakest); } catch (e) {}
      } else continue;
    }
    const b = {
      user_id: c.user_id, name: c.name, image: c.image,
      pinned: false, auto: true, dormant: false,
      best_peak: c.viewers, last_live_at: now, platform: 'kick',
      kick_slug: c.channel_slug || null, kick_user_id: c.broadcaster_user_id || null
    };
    config.broadcasters.push(b);
    byId.set(b.user_id, b);
    if (!broadcasterStats[b.user_id]) broadcasterStats[b.user_id] = { user_id: b.user_id, current_broadcast: null, history: [] };
    added.push({ user_id: b.user_id, name: b.name, viewers: c.viewers });
    try { await persistBroadcasterAdd(b); } catch (e) { console.error('kick add:', e.message); }
    kickNew.push(b.user_id);
  }
  if (!USE_SB) saveJson(CONFIG_FILE, config);
  if (kickNew.length && !backfillJob.running) runBackfillJob(kickNew);
  const act = activeAutos().length;
  if (added.length || slept.length) console.log(`[kick] +${added.length} 休止${slept.length} (稼働 ${act}/${KICK_LIMIT})`);
  return { ok: true, added, slept, auto_slots: `${act}/${KICK_LIMIT}`, candidates: list.length };
}

// Kick 非公開APIの疎通テスト（Cloudflareで弾かれる可能性あり）
const KICK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const KICK_HDRS = {
  'User-Agent': KICK_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Referer': 'https://kick.com/',
  'Origin': 'https://kick.com'
};

async function kickProbe(slug) {
  const urls = [
    `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(slug)}/videos`,
    `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`
  ];
  const out = [];
  for (const u of urls) {
    const rec = { url: u };
    try {
      const r = await fetch(u, { headers: KICK_HDRS });
      rec.status = r.status;
      rec.contentType = r.headers.get('content-type');
      rec.cfRay = r.headers.get('cf-ray') || null;
      const t = await r.text();
      rec.len = t.length;
      if ((rec.contentType || '').includes('json')) {
        try {
          const j = JSON.parse(t);
          const arr = Array.isArray(j) ? j : (j.data || j.videos || null);
          if (Array.isArray(arr)) {
            rec.items = arr.length;
            rec.sample = arr.slice(0, 2).map(v => ({
              id: v.id, created_at: v.created_at || v.start_time || null,
              session_title: (v.session_title || (v.livestream && v.livestream.session_title)) || null,
              duration: v.duration || (v.livestream && v.livestream.duration) || null,
              viewer_count: v.viewer_count ?? (v.livestream && v.livestream.viewer_count) ?? null,
              viewers: v.views ?? v.view_count ?? null
            }));
          } else {
            rec.keys = Object.keys(j).slice(0, 25);
            if (j.previous_livestreams) rec.previous_livestreams = j.previous_livestreams.length;
          }
        } catch (e) { rec.parseError = e.message; rec.head = t.slice(0, 200); }
      } else {
        rec.head = t.slice(0, 200);
      }
    } catch (e) { rec.error = e.message; }
    out.push(rec);
  }
  return out;
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
  const added = [], revived = [], slept = [], newlyAdded = [];
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
    newlyAdded.push(b.user_id);
  }

  if (!USE_SB) saveJson(CONFIG_FILE, config);

  // 新しく追加した配信者は過去配信を自動で取り込む（バックグラウンド）
  if (newlyAdded.length && !backfillJob.running) {
    runBackfillJob(newlyAdded).then(() => autoBackfillMissing());
  }

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

      let s;
      if (bc.platform === 'kick') {
        const live = await getKickLive();
        const hit = (live || []).find(x => x.user_id === uid);
        if (hit) s = { concurrent: hit.viewers, total: 0, timestamp: new Date().toISOString() };
        else {
          // 一覧に出ない場合のみ個別確認（言語フィルタ外の可能性）
          const ch = await fetchKickChannel(kickSlug(uid));
          s = (ch && ch.live) ? { concurrent: ch.viewers, total: 0, timestamp: new Date().toISOString() } : null;
        }
      } else {
        s = await fetchBroadcastStats(uid);
      }

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
      kick_api: USE_KICK,
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

  // Kickのスラッグを解決し直す: POST /api/kick-resolve
  if (pathname === '/api/kick-resolve' && req.method === 'POST') {
    (async () => {
      const targets = config.broadcasters.filter(b => b.platform === 'kick');
      let ok = 0, ng = 0;
      for (const b of targets) {
        b.kick_slug = null;
        const slug = await resolveKickSlug(b);
        if (slug) { ok++; try { await persistBroadcasterAdd(b); } catch (e) {} } else ng++;
      }
      if (!USE_SB) saveJson(CONFIG_FILE, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: targets.length, resolved: ok, failed: ng }));
    })();
    return;
  }

  // Kick 非公開API疎通テスト: GET /api/kick-probe/<slug>
  if (pathname.startsWith('/api/kick-probe/') && req.method === 'GET') {
    (async () => {
      const slug = decodeURIComponent(pathname.replace('/api/kick-probe/', ''));
      const r = await kickProbe(slug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, results: r }, null, 2));
    })();
    return;
  }

  // 全体の日別サマリー: GET /api/overall
  if (pathname === '/api/overall' && req.method === 'GET') {
    (async () => {
      try {
        if (USE_SB) {
          const plat = (url.parse(req.url, true).query.platform) || 'twitcasting';
          const rows = await sb('GET', 'tw_daily_overall', { query: `?select=*&platform=eq.${encodeURIComponent(plat)}&order=day.asc` });
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
      const plat = (url.parse(req.url, true).query.platform) || 'twitcasting';
      const r = plat === 'kick' ? await discoverKick() : await discoverTopLives();
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

  // 未取込の配信者だけ取り込む: POST /api/backfill-missing
  if (pathname === '/api/backfill-missing' && req.method === 'POST') {
    (async () => {
      if (backfillJob.running) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ started: false, reason: 'already_running', job: backfillJob }));
        return;
      }
      const targets = findMissingArchive();
      if (!targets.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ started: false, reason: 'nothing_to_do' }));
        return;
      }
      runBackfillJob(targets);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true, targets: targets.length }));
    })();
    return;
  }

  // 取り込み状況: GET /api/backfill/status
  if (pathname === '/api/backfill/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(backfillJob));
    return;
  }

  // 過去配信の取り込み（バックグラウンド実行）: POST /api/backfill[/<user_id>]
  if (pathname.startsWith('/api/backfill') && req.method === 'POST') {
    const spec = pathname.replace('/api/backfill', '').replace(/^\//, '');
    const targets = spec ? [decodeURIComponent(spec)] : config.broadcasters.map(b => b.user_id);
    if (backfillJob.running) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: false, reason: 'already_running', job: backfillJob }));
      return;
    }
    runBackfillJob(targets);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true, targets: targets.length }));
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
        let info, plat = 'twitcasting';
        if (isKick(uid)) {
          plat = 'kick';
          const ch = await fetchKickChannel(kickSlug(uid));
          info = ch ? { name: ch.name, image: ch.image } : null;
        } else {
          info = await fetchUserInfo(uid);
        }
        if (!info) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `ユーザーが見つかりません: ${uid}` })); return; }

        const b = { user_id: uid, name: info.name, image: info.image, pinned: true, auto: false, dormant: false, best_peak: 0, platform: plat };
        if (plat === 'kick') b.kick_slug = kickSlug(uid);
        config.broadcasters.push(b);
        broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };
        await persistBroadcasterAdd(b);

        monitorBroadcasters();
        if (!backfillJob.running) runBackfillJob([uid]);
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
    console.log(`Tracker on :${PORT} / storage=${USE_SB ? 'supabase' : 'local'} / twitcasting=${USE_TC_API} / kick=${USE_KICK} / broadcasters=${config.broadcasters.length}`);
  });
  refreshAllUserInfo();
  discoverTopLives();
  setInterval(discoverTopLives, 5 * 60 * 1000);
  if (USE_KICK) { discoverKick(); setInterval(discoverKick, 5 * 60 * 1000); }
  setTimeout(autoBackfillMissing, 30 * 1000);
  setInterval(autoBackfillMissing, 30 * 60 * 1000);
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
