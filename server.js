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
const SAMPLE_RETENTION_DAYS = 3;   // 生サンプルの保持日数
const MONITOR_CONCURRENCY = 20;    // 監視の並列数
const MISS_TOLERANCE = 3;          // 連続でこの回数取れなければ配信終了とみなす
const HISTORY_KEEP = 40;           // メモリに保持する直近配信数（集計はDB側で行う）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
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

// PostgREST は1回1000行までしか返さないため、全件取るページャ
async function sbAll(table, selectAndOrder, pageSize = 1000, maxPages = 500) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const q = `${selectAndOrder}&limit=${pageSize}&offset=${page * pageSize}`;
    const rows = await sb('GET', table, { query: q });
    if (!rows || !rows.length) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
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
    const bcs = await sbAll('tw_broadcasters', '?select=user_id,name,image,pinned,auto,last_live_at,best_peak,dormant,dormant_at,platform,kick_slug,kick_user_id,follower_count,ww_user_id&order=created_at.asc');
    config = { broadcasters: bcs || [] };

    const brs = await sbAll('tw_broadcasts', '?select=id,user_id,started_at,ended_at,peak,total,duration,source,platform,avg_concurrent,sample_count,category,title&order=started_at.asc');
    console.log(`[bootstrap] 配信記録 ${brs.length} 件を読み込み（メモリ保持は直近${HISTORY_KEEP}件/人）`);
    const cutoff = new Date(Date.now() - SAMPLE_RETENTION_DAYS * 864e5).toISOString();
    const smp = await sbAll('tw_samples', `?select=broadcast_id,concurrent,total,ts&ts=gte.${cutoff}&order=ts.asc`, 1000, 300);

    const byBc = {};
    (smp || []).forEach(s => {
      (byBc[s.broadcast_id] = byBc[s.broadcast_id] || []).push({
        concurrent: s.concurrent, total: s.total, timestamp: s.ts
      });
    });

    broadcasterStats = {};
    const staleToClose = [];
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
        avg_concurrent: b.avg_concurrent ?? null,
        category: b.category ?? null,
        title: b.title ?? null,
        duration: b.duration ?? null,
        samples: byBc[b.id] || []
      };
      if (b.ended_at) {
        broadcasterStats[b.user_id].history.push(obj);
      } else if (Date.now() - new Date(b.started_at).getTime() > 6 * 3600e3) {
        // 6時間以上開きっぱなしは異常。サンプルの最終時刻で閉じる
        const sm = (obj.samples || []).filter(x => x.concurrent > 0);
        obj.ended_at = sm.length ? sm[sm.length - 1].timestamp : new Date().toISOString();
        obj.avg_concurrent = sm.length ? Math.round(sm.reduce((t, x) => t + x.concurrent, 0) / sm.length) : null;
        obj.peak = sm.length ? Math.max(...sm.map(x => x.concurrent)) : obj.peak;
        obj.total_final = sm.length ? sm[sm.length - 1].total : obj.total_final;
        const dsec = Math.round((new Date(obj.ended_at) - new Date(obj.started_at)) / 1000);
        obj.duration = (dsec > 0 && dsec <= 86400) ? dsec : null;
        obj.sample_count = sm.length;
        staleToClose.push({ uid: b.user_id, obj });
        broadcasterStats[b.user_id].history.push(obj);
      } else {
        broadcasterStats[b.user_id].current_broadcast = obj;
      }
    });
    // メモリ使用量を抑えるため、履歴は直近分だけ残す（集計はDBビューで行う）
    for (const uid of Object.keys(broadcasterStats)) {
      const h = broadcasterStats[uid].history;
      if (h.length > HISTORY_KEEP) broadcasterStats[uid].history = h.slice(-HISTORY_KEEP);
    }

    if (staleToClose.length) {
      console.log(`[bootstrap] 開きっぱなしの配信 ${staleToClose.length} 件を終了処理`);
      for (const x of staleToClose) {
        try { await persistBroadcastEnd(x.uid, x.obj); } catch (e) {}
      }
    }
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
    kick_slug: b.kick_slug ?? null, kick_user_id: b.kick_user_id ?? null,
    ww_user_id: b.ww_user_id ?? null,
    follower_count: b.follower_count ?? null,
    follower_updated_at: b.follower_updated_at ?? null,
    ww_user_id: b.ww_user_id ?? null
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
async function persistBroadcastEnd(uid, b) {
  if (!USE_SB) { saveJson(STATS_FILE, broadcasterStats); return; }
  await sb('PATCH', 'tw_broadcasts', {
    query: `?id=eq.${encodeURIComponent(b.broadcast_id)}`,
    body: {
      ended_at: b.ended_at,
      avg_concurrent: b.avg_concurrent ?? null,
      peak: b.peak ?? null,
      total: b.total_final ?? null,
      duration: b.duration ?? null,
      sample_count: b.sample_count ?? null,
      category: b.category ?? null,
      title: b.title ?? null
    }
  });
}
async function persistSample(uid, bid, s) {
  if (!USE_SB) { saveJson(STATS_FILE, broadcasterStats); return; }
  await sb('POST', 'tw_samples', {
    body: [{ broadcast_id: bid, user_id: uid, concurrent: s.concurrent, total: s.total, ts: s.timestamp }]
  });
}

// "9.5k" "1.2万" "12,345" → 数値
function parseCountToken(tok) {
  if (!tok) return null;
  const m = String(tok).replace(/,/g, '').match(/([\d.]+)\s*([kKmM万億]?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  const suf = m[2];
  if (suf === 'k' || suf === 'K') n *= 1000;
  else if (suf === 'm' || suf === 'M') n *= 1000000;
  else if (suf === '万') n *= 10000;
  else if (suf === '億') n *= 100000000;
  return Math.round(n);
}

// プロフィールHTMLから「ファン(Fans)」数を取る。/{user}/backers/ リンクの近傍を見る
function parseFansFromHtml(html, userId) {
  if (!html) return null;
  const esc = userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`/${esc}/backers`, 'i');
  const idx = html.search(re);
  if (idx === -1) return null;

  // idx は <a href="/xxx/backers/"> のタグ内部を指すので、
  // タグを閉じる '>' の直後から読み始める（ユーザーID内の数字を拾わないため）
  let start = html.indexOf('>', idx);
  start = (start === -1) ? idx : start + 1;

  const win = html.slice(start, start + 1500)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 「ファン」「Fans」ラベルの直後の数値を最優先
  let m = win.match(/(?:ファン|Fans?)\s*[:：]?\s*([\d.,]+\s*[kKmM万億]?)/i);
  if (!m) {
    // ラベルが無い場合のみ、先頭付近の数値トークンを使う（120文字以内に限定）
    const head = win.slice(0, 120);
    m = head.match(/(?<![\w\/])([\d.,]+\s*[kKmM万億]?)(?![\w])/);
  }
  if (!m) return null;
  const n = parseCountToken(m[1]);
  // 明らかに異常な値は捨てる
  if (n == null || n <= 0 || n > 50000000) return null;
  return n;
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
          const apiRes = {
            name: j.user.name || j.user.screen_id || userId,
            image: (j.user.image || '').replace(/^http:/, 'https:').replace(/_normal\.(jpg|png)/, '_400x400.$1') || null,
            followers: null
          };
          if (!apiRes.followers) {
            try {
              const h = await fetch(`https://twitcasting.tv/${encodeURIComponent(userId)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
              if (h.ok) apiRes.followers = parseFansFromHtml(await h.text(), userId);
            } catch (e) {}
          }
          return apiRes;
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

    let name = null, image = null, followers = null;

    // フォロワー数をHTMLから拾う
    followers = parseFansFromHtml(html, userId);

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

    return { name: name || userId, image: image || null, followers };
  } catch (e) {
    console.error(`fetchUserInfo (${userId}):`, e.message);
    return null;
  }
}

// 起動時に既存配信者の名前・アイコンを更新
async function refreshOne(b) {
  {
    try {
      let changed = false;
      if ((b.platform || 'twitcasting') === 'whowatch') {
        const w = await fetchWWUser(wwPath(b.user_id), b.ww_user_id);
        if (w) {
          if (w.source === 'api') {
            if (w.name && w.name !== b.name) { b.name = w.name; changed = true; }
            if (w.image && w.image !== b.image) { b.image = w.image; changed = true; }
          }
          if (w.user_id_num && w.user_id_num !== b.ww_user_id) { b.ww_user_id = w.user_id_num; changed = true; }
          if (w.followers && w.followers !== b.follower_count) {
            b.follower_count = w.followers; b.follower_updated_at = new Date().toISOString(); changed = true;
          }
        }
      } else if ((b.platform || 'twitcasting') === 'kick') {
        const f = await fetchKickFollowers(b);
        if (f && f !== b.follower_count) {
          b.follower_count = f; b.follower_updated_at = new Date().toISOString(); changed = true;
        }
      } else {
        const info = await fetchUserInfo(b.user_id);
        if (!info) return;
        if (info.name !== b.name || info.image !== b.image) {
          b.name = info.name; b.image = info.image; changed = true;
        }
        if (info.followers && info.followers !== b.follower_count) {
          b.follower_count = info.followers; b.follower_updated_at = new Date().toISOString(); changed = true;
        }
      }
      if (changed) {
        await persistBroadcasterAdd(b);
      }
    } catch (e) { console.error('refresh:', e.message); }
  }
}

async function refreshAllUserInfo() {
  const targets = config.broadcasters.filter(b => !b.dormant);
  const C = 6;
  for (let i = 0; i < targets.length; i += C) {
    await Promise.all(targets.slice(i, i + C).map(b => refreshOne(b).catch(() => {})));
  }
  if (!USE_SB) saveJson(CONFIG_FILE, config);
  const n = config.broadcasters.filter(b => b.follower_count).length;
  console.log(`[refresh] 完了 フォロワー取得済み ${n}/${config.broadcasters.length}`);
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
      title: m.title || m.subtitle || null,
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
    return { concurrent: api.concurrent, total: api.total, title: api.title || null, timestamp: new Date().toISOString() };
  }

  // フォールバック: 配信中かどうかだけ判定（視聴数は0）
  const info = await fetchLiveInfo(userId);
  if (!info.live) return null;
  return { concurrent: 0, total: 0, timestamp: new Date().toISOString() };
}

// ---------- 過去配信の取り込み ----------
const backfillJob = { running: false, done: 0, totalTargets: 0, imported: 0, titleFixed: 0, current: null, finishedAt: null, error: null };

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
  backfillJob.done = 0; backfillJob.imported = 0; backfillJob.titleFixed = 0; backfillJob.error = null;
  backfillJob.totalTargets = targets.length; backfillJob.finishedAt = null;
  console.log(`[backfill] 開始 ${targets.length}人`);
  for (const uid of targets) {
    backfillJob.current = uid;
    try {
      const r = await backfillUser(uid);
      if (r.ok) { backfillJob.imported += r.imported || 0; backfillJob.titleFixed += r.titleFixed || 0; }
    } catch (e) { backfillJob.error = e.message; }
    backfillJob.done++;
  }
  backfillJob.current = null;
  backfillJob.running = false;
  backfillJob.finishedAt = new Date().toISOString();
  clearCache();
  console.log(`[backfill] 完了 新規${backfillJob.imported}件 / タイトル補完${backfillJob.titleFixed}件`);
}

async function backfillUser(userId, maxMovies = 500) {
  if (isWW(userId)) {
    const b = config.broadcasters.find(x => x.user_id === userId);
    return b ? await backfillWW(b) : { ok: false, reason: 'not_found', imported: 0 };
  }
  if (isKick(userId)) {
    const b = config.broadcasters.find(x => x.user_id === userId);
    return b ? await backfillKick(b) : { ok: false, reason: 'not_found', imported: 0 };
  }
  if (!USE_TC_API) return { ok: false, reason: 'no_credentials' };
  let offset = 0, imported = 0, scanned = 0, totalCount = null, titleFixed = 0;

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
      let dur = Number(m.duration || 0);
      if (!(dur > 0) || dur > 86400) dur = null;
      const peak = Number(m.max_view_count ?? 0);
      const total = Number(m.total_view_count ?? m.current_view_count ?? 0);
      if (!peak && !total) continue;

      const id = `arc_${userId}_${m.id}`;
      const existing = broadcasterStats[userId].history.find(h => h.broadcast_id === id);
      if (existing) {
        // 既に取り込み済み。タイトルが未取得なら補完する
        const t = m.title || m.subtitle || null;
        if (t && !existing.title) {
          existing.title = t;
          titleFixed++;
          if (USE_SB) {
            try {
              await sb('PATCH', 'tw_broadcasts', {
                query: `?id=eq.${encodeURIComponent(id)}`, body: { title: t }
              });
            } catch (e) { console.error('title patch:', e.message); }
          }
        }
        continue;
      }

      // 監視済みの同一配信があれば、そちらに最高同接・総来場者を補完して二重登録を防ぐ
      const eMs = startedMs + (dur || 0) * 1000;
      const dup = (broadcasterStats[userId].history || []).find(h => {
        if (h.source !== 'live') return false;
        const hs = new Date(h.started_at).getTime();
        return hs >= startedMs - 10 * 60000 && hs <= eMs + 20 * 60000;
      });
      if (dup) {
        const np = Math.max(dup.peak || 0, peak);
        const nt = Math.max(dup.total_final || 0, total);
        const nd = Math.max(dup.duration || 0, dur);
        if (np !== dup.peak || nt !== dup.total_final || nd !== dup.duration) {
          dup.peak = np; dup.total_final = nt; dup.duration = nd;
          if (!dup.title && m.title) dup.title = m.title;
          if (USE_SB) {
            try {
              await sb('PATCH', 'tw_broadcasts', {
                query: `?id=eq.${encodeURIComponent(dup.broadcast_id)}`,
                body: { peak: np, total: nt, duration: nd, title: dup.title || null }
              });
            } catch (e) { console.error('tc merge:', e.message); }
          }
        }
        continue;
      }

      const obj = {
        broadcast_id: id,
        started_at: new Date(startedMs).toISOString(),
        ended_at: new Date(startedMs + (dur || 0) * 1000).toISOString(),
        title: m.title || m.subtitle || null,
        source: 'archive',
        peak, total_final: total, duration: dur,
        samples: []
      };
      broadcasterStats[userId].history.push(obj);
      rows.push({
        id, user_id: userId,
        started_at: obj.started_at, ended_at: obj.ended_at,
        peak, total, duration: dur, source: 'archive', platform: 'twitcasting',
        title: obj.title
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
  return { ok: true, imported, scanned, titleFixed };
}

// ---------- ふわっち (whowatch) ----------
const WW_PREFIX = 'ww:';
const isWW = uid => String(uid).startsWith(WW_PREFIX);
const wwPath = uid => String(uid).slice(WW_PREFIX.length);   // 例 "w:pastelcafe"
const WW_LIMIT = 50;
const WW_HDRS = { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'ja' };

let wwLiveCache = { at: 0, list: [] };

// 配信中の一覧（認証不要・1リクエストで全件）
async function fetchWWLiveList() {
  const urls = [
    'https://api.whowatch.tv/lives?order=popular',
    'https://api.whowatch.tv/lives'
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: WW_HDRS });
      if (!r.ok) continue;
      const j = await r.json();
      const out = [];
      const push = (l) => {
        if (!l || !l.user || !l.user.user_path) return;
        out.push({
          user_id: WW_PREFIX + l.user.user_path,
          user_num: l.user.id ?? null,
          live_id: l.id,
          name: l.user.name || l.user.user_path,
          image: l.user.icon_url || null,
          viewers: Number(l.view_count || 0),
          total: Number(l.total_view_count || 0),
          title: l.title || null,
          started_at: l.started_at ? new Date(Number(l.started_at)).toISOString() : null
        });
      };
      if (Array.isArray(j)) {
        for (const cat of j) {
          for (const key of ['new', 'popular', 'lives']) {
            if (Array.isArray(cat[key])) cat[key].forEach(push);
          }
        }
      } else if (j && Array.isArray(j.lives)) {
        j.lives.forEach(push);
      }
      // 同一配信者の重複を除去（同接が大きい方を残す）
      const map = new Map();
      for (const x of out) {
        const cur = map.get(x.user_id);
        if (!cur || x.viewers > cur.viewers) map.set(x.user_id, x);
      }
      const list = [...map.values()].sort((a, b) => b.viewers - a.viewers);
      if (list.length) return list;
    } catch (e) { /* next */ }
  }
  return [];
}

async function getWWLive() {
  if (Date.now() - wwLiveCache.at < 12000) return wwLiveCache.list;
  const list = await fetchWWLiveList();
  if (list && list.length) wwLiveCache = { at: Date.now(), list };
  return wwLiveCache.list;
}

// プロフィール（フォロワー数など）
function parseWWCount(txt) {
  if (!txt) return null;
  const m = String(txt).replace(/,/g, '').match(/([\d.]+)\s*([kKmM万億]?)/);
  if (!m) return null;
  let n = parseFloat(m[1]); if (isNaN(n)) return null;
  const suf = m[2];
  if (suf === 'k' || suf === 'K') n *= 1000;
  else if (suf === 'm' || suf === 'M') n *= 1e6;
  else if (suf === '万') n *= 1e4;
  else if (suf === '億') n *= 1e8;
  return Math.round(n);
}

async function fetchWWUser(userPath, numId) {
  // 1) API候補
  const tries = [];
  if (numId) {
    // 実測で確認済み: /users/{id}/profile が正解
    tries.push(`https://api.whowatch.tv/users/${numId}/profile`);
    tries.push(`https://api.whowatch.tv/users/${numId}`);
  }

  for (const u of tries) {
    try {
      const r = await fetch(u, { headers: WW_HDRS });
      if (!r.ok) continue;
      const j = await r.json();
      const usr = j.user || j.profile || j;
      if (!usr || (!usr.name && !usr.user_id && !usr.id)) continue;
      const fol = Number(
        usr.follower_count ?? usr.followers_count ?? usr.fan_count ??
        j.follower_count ?? j.followers_count ?? 0) || null;
      return {
        name: usr.name || userPath,
        image: usr.icon_url || usr.profile_icon_url || null,
        followers: fol,
        followees: Number(usr.follow_count ?? 0) || null,
        user_id_num: usr.user_id ?? usr.id ?? numId ?? null,
        source: 'api'
      };
    } catch (e) { /* next */ }
  }

  // 2) プロフィールページのHTMLから拾う
  try {
    const r = await fetch(`https://whowatch.tv/profile/${encodeURIComponent(userPath)}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }
    });
    if (r.ok) {
      const html = await r.text();
      let fol = null, idNum = numId || null, m;

      m = html.match(/"follower_count"\s*:\s*"?([\d,]+)"?/)
           || html.match(/"followerCount"\s*:\s*"?([\d,]+)"?/);
      if (m) fol = parseWWCount(m[1]);
      if (!fol) {
        const t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const mm = t.match(/フォロワー[^0-9]{0,20}([\d,]+\s*[万億]?)/);
        if (mm) fol = parseWWCount(mm[1]);
      }
      // og:title / og:image はプロフィールページではサイト共通値（「ふわっち」）になるため使わない
      m = html.match(/"user"\s*:\s*\{\s*"id"\s*:\s*(\d+)/);
      if (m) idNum = Number(m[1]);

      if (fol || idNum) {
        return { name: null, image: null, followers: fol, user_id_num: idNum, source: 'html' };
      }
    }
  } catch (e) { /* give up */ }
  return null;
}

// 過去配信（取得できるか不明なので複数経路を試す）
async function fetchWWArchives(b) {
  const path = wwPath(b.user_id);
  let numId = b.ww_user_id || null;
  if (!numId) {
    const info = await fetchWWUser(path, null);
    if (info && info.user_id_num) numId = info.user_id_num;
  }
  const tries = [];
  if (numId) {
    // 実測で確認済み: /users/{id}/live_histories が正解
    tries.push(`https://api.whowatch.tv/users/${numId}/live_histories`);
    tries.push(`https://api.whowatch.tv/users/${numId}/live_histories?page=1`);
  }

  for (const u of tries) {
    try {
      const r = await fetch(u, { headers: WW_HDRS });
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.live_histories || j.lives || j.archives || j.data || null);
      if (!Array.isArray(arr)) continue;
      if (!arr.length) return { ok: true, endpoint: u, items: [] };
      const out = arr.map(l => {
        const st = l.started_at || l.created_at;
        if (!st) return null;
        const ms = Number(st) > 1e12 ? Number(st) : Number(st) * 1000;
        if (!ms) return null;
        const total = Number(l.total_view_count ?? l.view_count ?? 0);
        if (!total) return null;
        const dur = Number(l.duration || 0);
        return {
          live_id: l.id,
          started_at: new Date(ms).toISOString(),
          title: l.title || null,
          total,
          duration: (dur > 0 ? (dur > 100000 ? Math.round(dur / 1000) : dur) : null)
        };
      }).filter(Boolean);
      return { ok: true, endpoint: u, items: out };
    } catch (e) { /* next */ }
  }
  return { ok: false, items: [] };
}

async function backfillWW(b) {
  const r = await fetchWWArchives(b);
  if (!r.ok) return { ok: false, reason: 'no_archive_api', imported: 0 };
  const uid = b.user_id;
  if (!broadcasterStats[uid]) broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };
  const rows = [];
  let titleFixed = 0;
  for (const v of r.items) {
    const id = `warc_${uid}_${v.live_id}`;
    const ex = broadcasterStats[uid].history.find(h => h.broadcast_id === id);
    if (ex) {
      if (v.title && !ex.title) {
        ex.title = v.title; titleFixed++;
        if (USE_SB) { try { await sb('PATCH', 'tw_broadcasts', { query: `?id=eq.${encodeURIComponent(id)}`, body: { title: v.title } }); } catch (e) {} }
      }
      continue;
    }
    const sMs = new Date(v.started_at).getTime();
    const dup = (broadcasterStats[uid].history || []).find(h => {
      if (h.source !== 'live') return false;
      const hs = new Date(h.started_at).getTime();
      return hs >= sMs - 10 * 60000 && hs <= sMs + (v.duration || 0) * 1000 + 20 * 60000;
    });
    if (dup) {
      if (!dup.total_final || dup.total_final < v.total) {
        dup.total_final = v.total;
        if (!dup.title && v.title) dup.title = v.title;
        if (USE_SB) { try { await sb('PATCH', 'tw_broadcasts', { query: `?id=eq.${encodeURIComponent(dup.broadcast_id)}`, body: { total: v.total, title: dup.title || null } }); } catch (e) {} }
      }
      continue;
    }
    const obj = {
      broadcast_id: id, started_at: v.started_at,
      ended_at: new Date(sMs + (v.duration || 0) * 1000).toISOString(),
      title: v.title, source: 'archive', platform: 'whowatch',
      peak: null, total_final: v.total, duration: v.duration || null, samples: []
    };
    broadcasterStats[uid].history.push(obj);
    rows.push({
      id, user_id: uid, started_at: obj.started_at, ended_at: obj.ended_at,
      peak: null, total: v.total, duration: obj.duration, source: 'archive',
      platform: 'whowatch', title: v.title
    });
  }
  if (rows.length && USE_SB) {
    try { await sb('POST', 'tw_broadcasts', { body: rows, prefer: 'resolution=merge-duplicates' }); }
    catch (e) { console.error('ww backfill:', e.message); }
  }
  broadcasterStats[uid].history.sort((a, c) => new Date(a.started_at) - new Date(c.started_at));
  return { ok: true, imported: rows.length, titleFixed, endpoint: r.endpoint };
}

// ふわっちの自動収集（同接上位）
async function discoverWW() {
  const list = await getWWLive();
  if (!list || !list.length) return { ok: false, reason: 'no_data' };

  const byId = new Map(config.broadcasters.map(b => [b.user_id, b]));
  const added = [], slept = [], newlyAdded = [], now = new Date().toISOString();
  const activeAutos = () => config.broadcasters.filter(b => b.auto && !b.dormant && b.platform === 'whowatch');
  const scoreOf = b => Number(b.best_peak || 0);

  for (const c of list) {
    const ex = byId.get(c.user_id);
    if (ex) {
      let changed = false;
      if (c.viewers > (ex.best_peak || 0)) { ex.best_peak = c.viewers; changed = true; }
      if (!ex.ww_user_id && c.user_num) { ex.ww_user_id = c.user_num; changed = true; }
      ex.last_live_at = now;
      if (ex.dormant && ex.auto) {
        const autos = activeAutos();
        if (autos.length < WW_LIMIT) { ex.dormant = false; ex.dormant_at = null; changed = true; }
      }
      if (changed) { try { await persistBroadcasterAdd(ex); } catch (e) {} }
      continue;
    }
    const autos = activeAutos();
    if (autos.length >= WW_LIMIT) {
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
      best_peak: c.viewers, last_live_at: now, platform: 'whowatch',
      ww_user_id: c.user_num || null
    };
    config.broadcasters.push(b);
    byId.set(b.user_id, b);
    if (!broadcasterStats[b.user_id]) broadcasterStats[b.user_id] = { user_id: b.user_id, current_broadcast: null, history: [] };
    added.push({ user_id: b.user_id, name: b.name, viewers: c.viewers });
    newlyAdded.push(b.user_id);
    try { await persistBroadcasterAdd(b); } catch (e) { console.error('ww add:', e.message); }
  }
  if (!USE_SB) saveJson(CONFIG_FILE, config);
  if (newlyAdded.length && !backfillJob.running) runBackfillJob(newlyAdded);
  const act = activeAutos().length;
  if (added.length || slept.length) console.log(`[ww] +${added.length} 休止${slept.length} (稼働 ${act}/${WW_LIMIT})`);
  return { ok: true, added, slept, auto_slots: `${act}/${WW_LIMIT}`, candidates: list.length };
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
            language: x.language || null,
            category: (x.category && (x.category.name || x.category)) || null,
            title: x.stream_title || x.session_title || x.title || (x.stream && x.stream.stream_title) || null
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
      viewers: Number((c.stream && c.stream.viewer_count) || 0),
      title: c.stream_title || (c.stream && c.stream.stream_title) || null
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
async function fetchKickStreamTitle(b) {
  const slug = await resolveKickSlug(b);
  if (!slug) return null;
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { headers: KICK_HDRS });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.livestream && (j.livestream.session_title || j.livestream.slug)) || null;
  } catch (e) { return null; }
}

async function fetchKickFollowers(b) {
  const slug = await resolveKickSlug(b);
  if (!slug) return null;
  try {
    const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { headers: KICK_HDRS });
    if (!r.ok) return null;
    const j = await r.json();
    const n = Number(j.followers_count ?? j.followersCount ?? 0);
    return n || null;
  } catch (e) { return null; }
}

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
  let kTitleFixed = 0;
  for (const v of vids) {
    const ls = v.livestream || v;
    const startedRaw = ls.start_time || v.created_at || ls.created_at;
    if (!startedRaw) continue;
    const startedMs = new Date(String(startedRaw).replace(' ', 'T') + (String(startedRaw).endsWith('Z') ? '' : 'Z')).getTime();
    if (!startedMs || isNaN(startedMs)) continue;
    let durMs = Number(v.duration || ls.duration || 0);
    if (!durMs) continue;
    if (durMs / 1000 > 86400) durMs = 0;                       // 配信中のものが混ざるので除外
    if (ls.is_live || v.is_live) continue;
    // Kick の viewer_count は「終了時点の残り人数」で最高同接ではないため使わない
    const total = Number(v.views ?? v.view_count ?? ls.views ?? 0);
    if (!total) continue;
    const peak = null;

    const id = `karc_${uid}_${v.id || ls.id}`;
    const existingK = broadcasterStats[uid].history.find(h => h.broadcast_id === id);
    if (existingK) {
      const t = v.session_title || ls.session_title || v.title || null;
      if (t && !existingK.title) {
        existingK.title = t;
        kTitleFixed++;
        if (USE_SB) {
          try {
            await sb('PATCH', 'tw_broadcasts', {
              query: `?id=eq.${encodeURIComponent(id)}`, body: { title: t }
            });
          } catch (e) { console.error('kick title patch:', e.message); }
        }
      }
      continue;
    }

    // 同じ配信を監視済みなら、その行の総来場者だけ補完する（二重登録を防ぐ）
    const sMs = startedMs, eMs = startedMs + durMs;
    const dup = (broadcasterStats[uid].history || []).find(h => {
      if (h.source !== 'live') return false;
      const hs = new Date(h.started_at).getTime();
      return hs >= sMs - 10 * 60000 && hs <= eMs + 20 * 60000;
    });
    if (dup) {
      if (!dup.total_final || dup.total_final < total) {
        dup.total_final = total;
        if (!dup.duration) dup.duration = Math.round(durMs / 1000);
        if (!dup.title && kTitle) dup.title = kTitle;
        if (USE_SB) {
          try {
            await sb('PATCH', 'tw_broadcasts', {
              query: `?id=eq.${encodeURIComponent(dup.broadcast_id)}`,
              body: { total, duration: dup.duration, title: dup.title || null }
            });
          } catch (e) { console.error('kick merge:', e.message); }
        }
      }
      continue;
    }

    const kTitle = v.session_title || ls.session_title || v.title || null;
    const obj = {
      broadcast_id: id,
      started_at: new Date(startedMs).toISOString(),
      ended_at: new Date(startedMs + durMs).toISOString(),
      title: kTitle,
      source: 'archive', platform: 'kick',
      peak: null, total_final: total, duration: Math.round(durMs / 1000),
      samples: []
    };
    broadcasterStats[uid].history.push(obj);
    rows.push({
      id, user_id: uid, started_at: obj.started_at, ended_at: obj.ended_at,
      peak: null, total, duration: obj.duration, source: 'archive', platform: 'kick',
      title: kTitle
    });
  }

  if (rows.length && USE_SB) {
    try { await sb('POST', 'tw_broadcasts', { body: rows, prefer: 'resolution=merge-duplicates' }); }
    catch (e) { console.error('kick backfill upsert:', e.message); }
  }
  try { await persistBroadcasterAdd(b); } catch (e) {}
  broadcasterStats[uid].history.sort((a, c) => new Date(a.started_at) - new Date(c.started_at));
  if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
  return { ok: true, imported: rows.length, titleFixed: kTitleFixed, slug };
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
  const activeAutos = () => config.broadcasters.filter(b => b.auto && !b.dormant && (b.platform || 'twitcasting') === 'twitcasting');

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
      best_peak: c.viewers, last_live_at: now, platform: 'twitcasting'
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
async function pruneAuto() {
  const now = new Date().toISOString();
  const result = {};
  for (const [plat, keep] of [['twitcasting', AUTO_LIMIT], ['kick', KICK_LIMIT], ['whowatch', WW_LIMIT]]) {
    const autos = config.broadcasters.filter(
      b => b.auto && !b.dormant && (b.platform || 'twitcasting') === plat);
    if (autos.length <= keep) { result[plat] = 0; continue; }
    autos.sort((a, b) => (a.best_peak || 0) - (b.best_peak || 0));
    const drop = autos.slice(0, autos.length - keep);
    for (const b of drop) {
      b.dormant = true; b.dormant_at = now;
      try { await persistBroadcasterAdd(b); } catch (e) { console.error('prune:', e.message); }
    }
    result[plat] = drop.length;
  }
  if (!USE_SB) saveJson(CONFIG_FILE, config);
  return { slept: result };
}

// ---------- 監視ループ ----------
let monitoring = false;
const offlineCheckedAt = {};
const OFFLINE_INTERVAL = 5 * 60 * 1000;

async function checkOne(bc, now) {
  const uid = bc.user_id;
  if (!broadcasterStats[uid]) broadcasterStats[uid] = { user_id: uid, current_broadcast: null, history: [] };
  const wasLive = !!broadcasterStats[uid].current_broadcast;

  if (!wasLive) {
    const last = offlineCheckedAt[uid] || 0;
    if (now - last < OFFLINE_INTERVAL) return;
    offlineCheckedAt[uid] = now;
  }

  let s = null;
  if (bc.platform === 'whowatch') {
    const live = await getWWLive();
    const hit = (live || []).find(x => x.user_id === uid);
    if (hit) {
      // 配信一覧の情報が最も正確なので、名前・アイコン・数値IDをここで補正する
      let ch = false;
      if (hit.name && hit.name !== bc.name) { bc.name = hit.name; ch = true; }
      if (hit.image && hit.image !== bc.image) { bc.image = hit.image; ch = true; }
      if (hit.user_num && hit.user_num !== bc.ww_user_id) { bc.ww_user_id = hit.user_num; ch = true; }
      if (bc.ww_user_id && !bc.follower_count) {
        const w = await fetchWWUser(wwPath(uid), bc.ww_user_id);
        if (w && w.followers) {
          bc.follower_count = w.followers;
          bc.follower_updated_at = new Date().toISOString();
          if (w.name) bc.name = w.name;
          if (w.image) bc.image = w.image;
          ch = true;
        }
      }
      if (ch) { try { await persistBroadcasterAdd(bc); } catch (e) {} }
    }
    s = hit ? {
      concurrent: hit.viewers, total: hit.total,
      timestamp: new Date().toISOString(), title: hit.title || null
    } : null;
  } else if (bc.platform === 'kick') {
    const live = await getKickLive();
    const hit = (live || []).find(x => x.user_id === uid);
    if (hit) s = { concurrent: hit.viewers, total: 0, timestamp: new Date().toISOString(), category: hit.category || null };
    else {
      const ch = await fetchKickChannel(kickSlug(uid));
      s = (ch && ch.live) ? { concurrent: ch.viewers, total: 0, timestamp: new Date().toISOString() } : null;
    }
  } else {
    s = await fetchBroadcastStats(uid);
  }

  if (s) {
    if (!wasLive) {
      const b = {
        broadcast_id: `${uid}_${Date.now()}`, started_at: s.timestamp,
        samples: [s], source: 'live', platform: bc.platform || 'twitcasting',
        category: s.category || null, title: s.title || null
      };
      broadcasterStats[uid].current_broadcast = b;
      console.log(`[${uid}] 配信開始 ${s.concurrent}`);
      if (!b.title && (bc.platform || 'twitcasting') === 'kick') {
        try {
          const t = await fetchKickStreamTitle(bc);
          if (t) {
            b.title = t;
            if (USE_SB) await sb('PATCH', 'tw_broadcasts', {
              query: `?id=eq.${encodeURIComponent(b.broadcast_id)}`, body: { title: t }
            });
          }
        } catch (e) {}
      }
      try { await persistBroadcastStart(uid, b); await persistSample(uid, b.broadcast_id, s); }
      catch (e) { console.error('persist start:', e.message); }
    } else {
      const b = broadcasterStats[uid].current_broadcast;
      b.miss = 0;
      if (!b.title && s.title) b.title = s.title;
      if (!b.title && (bc.platform || 'twitcasting') === 'kick' && (b.samples.length % 10 === 0)) {
        try {
          const t = await fetchKickStreamTitle(bc);
          if (t) {
            b.title = t;
            if (USE_SB) await sb('PATCH', 'tw_broadcasts', {
              query: `?id=eq.${encodeURIComponent(b.broadcast_id)}`, body: { title: t }
            });
          }
        } catch (e) {}
      }
      b.samples.push(s);
      try { await persistSample(uid, b.broadcast_id, s); } catch (e) { console.error('persist sample:', e.message); }
    }
    if (s.concurrent > (bc.best_peak || 0)) {
      bc.best_peak = s.concurrent;
      bc.last_live_at = s.timestamp;
      try { await persistBroadcasterAdd(bc); } catch (e) {}
    }
    if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
  } else if (wasLive) {
    const b = broadcasterStats[uid].current_broadcast;
    b.miss = (b.miss || 0) + 1;
    if (b.miss < MISS_TOLERANCE) return;   // 一時的な取得失敗では終了扱いにしない
    b.ended_at = new Date().toISOString();
    const sm = (b.samples || []).filter(x => x.concurrent > 0);
    b.avg_concurrent = sm.length ? Math.round(sm.reduce((t, x) => t + x.concurrent, 0) / sm.length) : null;
    b.peak = sm.length ? Math.max(...sm.map(x => x.concurrent)) : null;
    b.total_final = sm.length ? sm[sm.length - 1].total : null;
    const durSec = Math.round((new Date(b.ended_at) - new Date(b.started_at)) / 1000);
    b.duration = (durSec > 0 && durSec <= 86400) ? durSec : null;
    b.sample_count = sm.length;
    broadcasterStats[uid].history.push(b);
    if (broadcasterStats[uid].history.length > HISTORY_KEEP)
      broadcasterStats[uid].history = broadcasterStats[uid].history.slice(-HISTORY_KEEP);
    broadcasterStats[uid].current_broadcast = null;
    offlineCheckedAt[uid] = now;
    console.log(`[${uid}] 配信終了 avg=${b.avg_concurrent} peak=${b.peak} n=${sm.length}`);
    if (b.avg_concurrent == null && b.peak == null && !b.total_final) {
      // 中身のない配信記録は残さない
      broadcasterStats[uid].history = broadcasterStats[uid].history.filter(h => h !== b);
      if (USE_SB) {
        try { await sb('DELETE', 'tw_broadcasts', { query: `?id=eq.${encodeURIComponent(b.broadcast_id)}` }); }
        catch (e) {}
      }
      return;
    }
    if ((bc.platform || 'twitcasting') === 'kick') {
      // Kick は配信中に総視聴数が取れないので、終了後にVODから補完
      setTimeout(() => { backfillKick(bc).catch(() => {}); }, 5 * 60 * 1000);
    }
    try { await persistBroadcastEnd(uid, b); } catch (e) { console.error('persist end:', e.message); }
    if (!USE_SB) saveJson(STATS_FILE, broadcasterStats);
  }
}

async function monitorBroadcasters() {
  if (monitoring) return;
  if (!config.broadcasters || !config.broadcasters.length) return;
  monitoring = true;
  const now = Date.now();
  const targets = config.broadcasters.filter(b => !b.dormant);
  try {
    for (let i = 0; i < targets.length; i += MONITOR_CONCURRENCY) {
      const chunk = targets.slice(i, i + MONITOR_CONCURRENCY);
      await Promise.all(chunk.map(b => checkOne(b, now).catch(e => console.error(b.user_id, e.message))));
    }
  } finally {
    monitoring = false;
  }
}

// ---------- サンプル圧縮・保持期間 ----------
// 直近の生サンプルを時間別集計へ反映（削除はしない）
async function syncHourly() {
  if (!USE_SB) return;
  try {
    await sb('POST', 'rpc/tw_sync_hourly', { body: {} });
  } catch (e) { console.error('[hourly]', e.message); }
}

async function compactSamples() {
  if (!USE_SB) return { ok: false, reason: 'local' };
  const cutoff = new Date(Date.now() - SAMPLE_RETENTION_DAYS * 864e5).toISOString();
  try {
    // 1) 時間別集計に退避
    await sb('POST', 'rpc/tw_compact_samples', { body: { cutoff } });
  } catch (e) {
    console.error('[compact]', e.message);
    return { ok: false, reason: e.message };
  }
  // メモリ側も古いサンプルを落とす
  const cutMs = Date.now() - SAMPLE_RETENTION_DAYS * 864e5;
  for (const uid of Object.keys(broadcasterStats)) {
    const st = broadcasterStats[uid];
    st.history = (st.history || []).map(b => {
      if (b.samples && b.samples.length && new Date(b.started_at).getTime() < cutMs) {
        return { ...b, samples: [] };
      }
      return b;
    });
  }
  try { await sb('POST', 'rpc/tw_refresh_ratio', { body: {} }); } catch (e) { console.error('[ratio]', e.message); }
  await loadRatios();
  clearCache();
  console.log('[compact] 完了');
  return { ok: true };
}

// ---------- 集計APIのキャッシュ ----------
const apiCache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = apiCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val;
  const val = await fn();
  apiCache.set(key, { at: Date.now(), val });
  return val;
}
function clearCache(prefix) {
  for (const k of apiCache.keys()) if (!prefix || k.startsWith(prefix)) apiCache.delete(k);
}

// ---------- 集計ヘルパー ----------
let RATIOS = {};   // DB(tw_ratio_mv)から読み込む実測比率
const RATIO_MIN_N = 30;

async function loadRatios() {
  if (!USE_SB) return;
  try {
    const rows = await sb('GET', 'tw_ratio_mv', { query: '?select=*' });
    const m = {};
    (rows || []).forEach(r => {
      m[r.platform] = {
        peak: Number(r.ratio_peak_n) >= RATIO_MIN_N ? Number(r.ratio_peak) : null,
        view: Number(r.ratio_view_n) >= RATIO_MIN_N ? Number(r.ratio_view) : null,
        peak_n: Number(r.ratio_peak_n) || 0,
        view_n: Number(r.ratio_view_n) || 0
      };
    });
    RATIOS = m;
    console.log('[ratio]', JSON.stringify(m));
  } catch (e) { console.error('[ratio]', e.message); }
}

// 実測が十分でなければ推定しない（nullを返す）
function ratioOf(plat) {
  return RATIOS[plat] || { peak: null, view: null, peak_n: 0, view_n: 0 };
}
function estAvg(b, plat) {
  const r = ratioOf(plat);
  if (b.avg_concurrent != null) return b.avg_concurrent;
  if (b.peak != null && r.peak) return Math.round(b.peak * r.peak);
  if (b.total_final && r.view) return Math.round(b.total_final * r.view);
  return null;   // 根拠のある比率が無い間は推定しない
}
function broadcastList(uid, plat) {
  const st = broadcasterStats[uid];
  if (!st) return [];
  const src = [...(st.history || [])];
  if (st.current_broadcast) src.push({ ...st.current_broadcast, _live: true });
  return src.map(b => {
    const sm = (b.samples || []).filter(x => x.concurrent > 0);
    const avg = b.avg_concurrent != null ? b.avg_concurrent
      : (sm.length ? Math.round(sm.reduce((t, x) => t + x.concurrent, 0) / sm.length) : null);
    const peak = b.peak != null ? b.peak : (sm.length ? Math.max(...sm.map(x => x.concurrent)) : null);
    const total = b.total_final != null ? b.total_final : (sm.length ? sm[sm.length - 1].total : 0);
    const o = {
      t: new Date(b.started_at).getTime(),
      started_at: b.started_at,
      live: !!b._live,
      archive: b.source === 'archive',
      avg, peak, total: total || 0,
      title: b.title || null,
      duration: b.duration || 0
    };
    o.val = estAvg({ avg_concurrent: avg, peak, total_final: total }, plat);
    return o;
  }).filter(x => x.val != null).sort((a, b) => a.t - b.t);
}
function dailySeries(list) {
  const m = {};
  for (const x of list) {
    const k = new Date(x.t + 9 * 3600e3).toISOString().slice(0, 10);
    (m[k] = m[k] || { v: [], p: [], n: 0 });
    m[k].v.push(x.val);
    if (x.peak != null) m[k].p.push(x.peak);
    m[k].n++;
  }
  return Object.keys(m).sort().map(k => ({
    day: k,
    val: Math.round(m[k].v.reduce((t, v) => t + v, 0) / m[k].v.length),
    peak: m[k].p.length ? Math.max(...m[k].p) : null,
    n: m[k].n
  }));
}
function summarize(uid, plat) {
  const st = broadcasterStats[uid];
  const list = broadcastList(uid, plat);
  const done = list.filter(x => !x.live);
  const vals = list.map(x => x.val);
  const pk = list.map(x => x.peak).filter(v => v != null);
  const cut = Date.now() - 30 * 864e5;
  const w30 = done.filter(x => x.t >= cut);
  const cb = st.current_broadcast;
  const lastSample = cb && cb.samples && cb.samples.length ? cb.samples[cb.samples.length - 1] : null;
  const withTot = list.filter(x => x.total > 0);
  return {
    live: !!cb,
    cur: lastSample ? lastSample.concurrent : null,
    curTotal: lastSample ? lastSample.total : null,
    n: list.length,
    allAvg: vals.length ? Math.round(vals.reduce((t, v) => t + v, 0) / vals.length) : null,
    recent: list.length ? list[list.length - 1].val : null,
    best: pk.length ? Math.max(...pk) : null,
    d30avg: w30.length ? Math.round(w30.reduce((t, x) => t + x.val, 0) / w30.length) : null,
    d30n: w30.length,
    lastTs: done.length ? done[done.length - 1].t : null,
    retention: withTot.length
      ? Math.round(withTot.reduce((t, x) => t + (x.val / x.total * 100), 0) / withTot.length)
      : null
  };
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true;   // 未設定なら従来どおり通す
  const t = url.parse(req.url, true).query.token || req.headers['x-admin-token'];
  if (t === ADMIN_TOKEN) return true;
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'forbidden' }));
  return false;
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
      whowatch_api: true,
      retention_days: SAMPLE_RETENTION_DAYS,
      monitor_interval_sec: 60,
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

  // 2プラットフォーム比較: GET /api/compare
  if (pathname === '/api/compare' && req.method === 'GET') {
    (async () => {
      try {
        if (!USE_SB) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
        const rows = await cached('compare', 5 * 60 * 1000, () =>
          sbAll('tw_daily_overall', '?select=*&order=day.asc'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // 全体ヒートマップ: GET /api/heatmap?platform=
  if (pathname === '/api/heatmap' && req.method === 'GET') {
    (async () => {
      try {
        if (!USE_SB) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
        const plat = (url.parse(req.url, true).query.platform) || 'twitcasting';
        const rows = await cached(`heat:${plat}`, 10 * 60 * 1000, () =>
          sbAll('tw_heatmap_overall', `?select=*&platform=eq.${encodeURIComponent(plat)}`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // 配信時間の分析: GET /api/duration?platform=
  if (pathname === '/api/duration' && req.method === 'GET') {
    (async () => {
      try {
        if (!USE_SB) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
        const plat = (url.parse(req.url, true).query.platform) || 'twitcasting';
        const rows = await cached(`dur:${plat}`, 10 * 60 * 1000, () =>
          sbAll('tw_duration_analysis', `?select=*&platform=eq.${encodeURIComponent(plat)}&order=sort_key.asc`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // CSV出力: GET /api/export.csv?platform=&type=daily|broadcasters
  if (pathname === '/api/export.csv' && req.method === 'GET') {
    (async () => {
      const q = url.parse(req.url, true).query;
      const plat = q.platform || 'twitcasting';
      const type = q.type || 'daily';
      const esc = v => {
        if (v == null) return '';
        const t = String(v);
        return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      let head = [], rows = [];
      if (type === 'broadcasters') {
        head = ['user_id', 'name', 'platform', 'pinned', 'auto', 'dormant', 'best_peak',
                'broadcasts', 'avg_peak', 'avg_concurrent', 'last_live_at'];
        rows = config.broadcasters
          .filter(b => (b.platform || 'twitcasting') === plat)
          .map(b => {
            const st = broadcasterStats[b.user_id] || {};
            const hist = (st.history || []);
            const peaks = hist.map(h => h.peak).filter(v => v != null);
            const avgs = hist.map(h => h.avg_concurrent).filter(v => v != null);
            return [b.user_id, b.name, b.platform || 'twitcasting', b.pinned, b.auto, b.dormant,
              b.best_peak || 0, hist.length,
              peaks.length ? Math.round(peaks.reduce((t, v) => t + v, 0) / peaks.length) : '',
              avgs.length ? Math.round(avgs.reduce((t, v) => t + v, 0) / avgs.length) : '',
              b.last_live_at || ''];
          });
      } else {
        head = ['day', 'platform', 'broadcasts', 'broadcasters', 'overall_peak_avg',
                'overall_avg', 'measured_broadcasts', 'overall_total_viewers', 'day_max_peak', 'avg_duration_sec'];
        try {
          const data = USE_SB
            ? await sbAll('tw_daily_overall', `?select=*&platform=eq.${encodeURIComponent(plat)}&order=day.asc`)
            : [];
          rows = data.map(r => head.map(k => r[k]));
        } catch (e) { /* empty */ }
      }
      const csv = '\uFEFF' + [head.join(','), ...rows.map(r => r.map(esc).join(','))].join('\r\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="tracker-${type}-${plat}-${new Date().toISOString().slice(0,10)}.csv"`
      });
      res.end(csv);
    })();
    return;
  }

  // 急上昇アラート: GET /api/alerts?platform=&threshold=50
  if (pathname === '/api/alerts' && req.method === 'GET') {
    const q = url.parse(req.url, true).query;
    const plat = q.platform || 'twitcasting';
    const th = Number(q.threshold || 50);
    const out = [];
    for (const b of config.broadcasters) {
      if ((b.platform || 'twitcasting') !== plat) continue;
      const st = broadcasterStats[b.user_id];
      if (!st) continue;
      const done = (st.history || [])
        .map(h => ({ t: new Date(h.started_at).getTime(), v: h.avg_concurrent ?? h.peak }))
        .filter(x => x.v != null).sort((a, c) => a.t - c.t);
      if (done.length < 4) continue;
      const n = Math.min(3, Math.floor(done.length / 2));
      const rec = done.slice(-n).map(x => x.v), prv = done.slice(-2 * n, -n).map(x => x.v);
      const r = Math.round(rec.reduce((t, v) => t + v, 0) / rec.length);
      const p = Math.round(prv.reduce((t, v) => t + v, 0) / prv.length);
      if (!p) continue;
      const pct = Math.round((r - p) / p * 100);
      if (pct >= th) out.push({ user_id: b.user_id, name: b.name, image: b.image, pct, recent: r, prev: p, n });
    }
    out.sort((a, b) => b.pct - a.pct);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  // サンプル圧縮を今すぐ実行: POST /api/compact
  if (pathname === '/api/compact' && req.method === 'POST') {
    (async () => {
      const r = await compactSamples();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    })();
    return;
  }

  // ふわっちの名前・アイコンを配信一覧から復旧: POST /api/ww-fix-profiles
  if (pathname === '/api/ww-fix-profiles' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    (async () => {
      const live = await getWWLive();
      const byId = new Map((live || []).map(x => [x.user_id, x]));
      let fixed = 0, cleared = 0;
      for (const b of config.broadcasters) {
        if (b.platform !== 'whowatch') continue;
        const hit = byId.get(b.user_id);
        if (hit) {
          let ch = false;
          if (hit.name && hit.name !== b.name) { b.name = hit.name; ch = true; }
          if (hit.image && hit.image !== b.image) { b.image = hit.image; ch = true; }
          if (hit.user_num && hit.user_num !== b.ww_user_id) { b.ww_user_id = hit.user_num; ch = true; }
          if (ch) { fixed++; try { await persistBroadcasterAdd(b); } catch (e) {} }
        } else {
          const w = await fetchWWUser(wwPath(b.user_id), b.ww_user_id);
          if (w && w.source === 'api') {
            let ch = false;
            if (w.name && w.name !== b.name) { b.name = w.name; ch = true; }
            if (w.image && w.image !== b.image) { b.image = w.image; ch = true; }
            if (w.followers && w.followers !== b.follower_count) {
              b.follower_count = w.followers; b.follower_updated_at = new Date().toISOString(); ch = true;
            }
            if (ch) { fixed++; try { await persistBroadcasterAdd(b); } catch (e) {} }
          } else if (b.name === 'ふわっち') {
            b.name = wwPath(b.user_id); b.image = null; cleared++;
            try { await persistBroadcasterAdd(b); } catch (e) {}
          }
        }
      }
      if (!USE_SB) saveJson(CONFIG_FILE, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fixed, cleared }));
    })();
    return;
  }

  // ふわっちAPI総当たり診断: GET /api/probe-ww/<user_path>
  if (pathname.startsWith('/api/probe-ww/') && req.method === 'GET') {
    (async () => {
      const path = decodeURIComponent(pathname.replace('/api/probe-ww/', ''));
      const live = await getWWLive();
      const hit = (live || []).find(x => x.user_id === WW_PREFIX + path);
      const known = config.broadcasters.find(x => x.user_id === WW_PREFIX + path);
      const numId = (hit && hit.user_num) || (known && known.ww_user_id) || null;
      const out = { user_path: path, num_id: numId, from_live_list: !!hit, results: [] };
      const urls = [];
      if (numId) {
        ['', '/profile', '/lives', '/archives', '/past_lives', '/live_histories', '/movies', '/replays', '/followers']
          .forEach(sfx => urls.push(`https://api.whowatch.tv/users/${numId}${sfx}`));
      }
      urls.push(`https://api.whowatch.tv/users/${encodeURIComponent(path)}`);
      urls.push(`https://api.whowatch.tv/profiles/${encodeURIComponent(path)}`);
      if (hit && hit.live_id) urls.push(`https://api.whowatch.tv/lives/${hit.live_id}`);

      for (const u of urls) {
        const rec = { url: u };
        try {
          const r = await fetch(u, { headers: WW_HDRS });
          rec.status = r.status;
          const t = await r.text();
          rec.len = t.length;
          if (r.ok) {
            try {
              const j = JSON.parse(t);
              rec.keys = Array.isArray(j) ? `array(${j.length})` : Object.keys(j).slice(0, 25);
              const flat = JSON.stringify(j);
              const fm = flat.match(/"follower[_A-Za-z]*"\s*:\s*"?(\d+)"?/);
              if (fm) rec.follower_hint = fm[1];
            } catch (e) { rec.head = t.slice(0, 150); }
          }
        } catch (e) { rec.error = e.message; }
        out.results.push(rec);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out, null, 2));
    })();
    return;
  }

  // ふわっちの過去配信APIを診断: GET /api/debug-ww/<user_path>
  if (pathname.startsWith('/api/debug-ww/') && req.method === 'GET') {
    (async () => {
      const path = decodeURIComponent(pathname.replace('/api/debug-ww/', ''));
      const out = { user_path: path };
      const live0 = await getWWLive();
      const hit0 = (live0 || []).find(x => x.user_id === WW_PREFIX + path);
      out.profile = await fetchWWUser(path, hit0 ? hit0.user_num : null);
      const b = { user_id: WW_PREFIX + path, ww_user_id: (out.profile && out.profile.user_id_num) || (hit0 && hit0.user_num) };
      const r = await fetchWWArchives(b);
      out.archive_ok = r.ok;
      out.archive_endpoint = r.endpoint || null;
      out.archive_count = (r.items || []).length;
      out.archive_sample = (r.items || []).slice(0, 3);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out, null, 2));
    })();
    return;
  }

  // フォロワー抽出の診断: GET /api/debug-fans/<id>
  if (pathname.startsWith('/api/debug-fans/') && req.method === 'GET') {
    (async () => {
      const uid = decodeURIComponent(pathname.replace('/api/debug-fans/', ''));
      const out = { user_id: uid };
      try {
        const r = await fetch(`https://twitcasting.tv/${encodeURIComponent(uid)}`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'ja' }
        });
        out.status = r.status;
        const html = await r.text();
        out.html_len = html.length;
        const re = new RegExp(`/${uid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/backers`, 'i');
        const idx = html.search(re);
        out.backers_index = idx;
        if (idx !== -1) {
          out.window = html.slice(idx, idx + 1500)
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 400);
        }
        out.parsed = parseFansFromHtml(html, uid);
      } catch (e) { out.error = e.message; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out, null, 2));
    })();
    return;
  }

  // フォロワーをリセットして再取得: POST /api/reset-followers
  if (pathname === '/api/reset-followers' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    (async () => {
      for (const b of config.broadcasters) {
        if ((b.platform || 'twitcasting') !== 'twitcasting') continue;
        b.follower_count = null; b.follower_updated_at = null;
      }
      if (USE_SB) {
        try {
          await sb('PATCH', 'tw_broadcasters', {
            query: '?platform=eq.twitcasting',
            body: { follower_count: null, follower_updated_at: null }
          });
        } catch (e) { console.error('reset followers:', e.message); }
      } else saveJson(CONFIG_FILE, config);
      await refreshAllUserInfo();
      const after = config.broadcasters.filter(b => b.follower_count).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reset: true, after, total: config.broadcasters.length }));
    })();
    return;
  }

  // フォロワーを今すぐ更新: POST /api/refresh-followers
  if (pathname === '/api/refresh-followers' && req.method === 'POST') {
    (async () => {
      const before = config.broadcasters.filter(b => b.follower_count).length;
      await refreshAllUserInfo();
      const after = config.broadcasters.filter(b => b.follower_count).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ before, after, total: config.broadcasters.length }));
    })();
    return;
  }

  // 生データ確認: GET /api/debug-user/<id>
  if (pathname.startsWith('/api/debug-user/') && req.method === 'GET') {
    (async () => {
      const uid = decodeURIComponent(pathname.replace('/api/debug-user/', ''));
      const out = { user_id: uid };
      if (isKick(uid)) {
        const b = config.broadcasters.find(x => x.user_id === uid) || { user_id: uid, kick_slug: kickSlug(uid) };
        const slug = await resolveKickSlug(b);
        out.slug = slug;
        try {
          const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { headers: KICK_HDRS });
          out.status = r.status;
          const j = await r.json();
          out.followers_count = j.followers_count ?? null;
          out.stream_title = j.livestream?.session_title ?? null;
          out.keys = Object.keys(j).slice(0, 40);
        } catch (e) { out.error = e.message; }
      } else {
        try {
          const r = await fetch(`https://apiv2.twitcasting.tv/users/${encodeURIComponent(uid)}`, {
            headers: { 'X-Api-Version': '2.0', Authorization: `Basic ${TC_BASIC}`, Accept: 'application/json' }
          });
          out.user_status = r.status;
          out.user_raw = await r.json();
        } catch (e) { out.user_error = e.message; }
        try {
          const r2 = await fetch(`https://apiv2.twitcasting.tv/users/${encodeURIComponent(uid)}/current_live`, {
            headers: { 'X-Api-Version': '2.0', Authorization: `Basic ${TC_BASIC}`, Accept: 'application/json' }
          });
          out.live_status = r2.status;
          const j2 = await r2.json();
          out.live_movie_keys = j2.movie ? Object.keys(j2.movie) : null;
          out.live_title = j2.movie ? (j2.movie.title ?? null) : null;
          out.live_subtitle = j2.movie ? (j2.movie.subtitle ?? null) : null;
        } catch (e) { out.live_error = e.message; }
        out.parsedUserInfo = await fetchUserInfo(uid);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out, null, 2));
    })();
    return;
  }

  // 配信者検索: GET /api/search?q=&platform=
  if (pathname === '/api/search' && req.method === 'GET') {
    (async () => {
      const q = url.parse(req.url, true).query;
      const word = String(q.q || '').trim();
      const plat = q.platform || 'twitcasting';
      if (!word) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
      const out = [];
      try {
        if (plat === 'whowatch') {
          let path = word.match(/whowatch\.tv\/profile\/([^/?#]+)/i)?.[1] || word.replace(/^ww:/i, '');
          const w = await fetchWWUser(path, null);
          if (w) out.push({ user_id: WW_PREFIX + path, name: w.name, image: w.image, platform: 'whowatch', followers: w.followers });
          const live = await getWWLive();
          const q = word.toLowerCase();
          for (const c of (live || [])) {
            if (out.some(x => x.user_id === c.user_id)) continue;
            if (String(c.name).toLowerCase().includes(q) || String(c.user_id).toLowerCase().includes(q)) {
              out.push({ user_id: c.user_id, name: c.name, image: c.image, platform: 'whowatch', live: true });
            }
            if (out.length >= 12) break;
          }
        } else if (plat === 'kick') {
          const slug = word.match(/kick\.com\/([^/?#]+)/i)?.[1] || word.replace(/^kick:/i, '');
          // 完全一致
          const ch = await fetchKickChannel(slug);
          if (ch) out.push({ user_id: KICK_PREFIX + slug, name: ch.name, image: ch.image, platform: 'kick', live: ch.live });
          // 部分一致（非公開検索API）
          try {
            const r = await fetch(`https://kick.com/api/search?searched_word=${encodeURIComponent(word)}`, { headers: KICK_HDRS });
            if (r.ok) {
              const j = await r.json();
              const chans = j.channels || j.data?.channels || [];
              for (const c of chans.slice(0, 10)) {
                const uid = KICK_PREFIX + (c.slug || c.user?.username);
                if (!c.slug || out.some(x => x.user_id === uid)) continue;
                out.push({ user_id: uid, name: c.user?.username || c.slug, image: c.user?.profile_pic || null, platform: 'kick' });
              }
            }
          } catch (e) {}
        } else {
          const direct = word.match(/twitcasting\.tv\/([^/?#]+)/)?.[1] || word;
          const info = await fetchUserInfo(direct);
          if (info) out.push({ user_id: direct, name: info.name, image: info.image, platform: 'twitcasting', followers: info.followers || null });
          if (USE_TC_API) {
            try {
              const r = await fetch(`https://apiv2.twitcasting.tv/search/users?words=${encodeURIComponent(word)}&limit=10&lang=ja`, {
                headers: { 'X-Api-Version': '2.0', Authorization: `Basic ${TC_BASIC}`, Accept: 'application/json' }
              });
              if (r.ok) {
                const j = await r.json();
                for (const u of (j.users || []).slice(0, 10)) {
                  if (out.some(x => x.user_id === u.screen_id)) continue;
                  out.push({
                    user_id: u.screen_id, name: u.name || u.screen_id,
                    image: (u.image || '').replace(/^http:/, 'https:'),
                    platform: 'twitcasting', followers: Number(u.supporter_count ?? 0) || null,
                    live: !!u.is_live
                  });
                }
              }
            } catch (e) {}
          }
        }
      } catch (e) { /* ignore */ }
      // 既に追跡中かどうかを付与
      const known = new Set(config.broadcasters.map(b => b.user_id));
      out.forEach(x => { x.tracked = known.has(x.user_id); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    })();
    return;
  }

  // 追跡外の配信者をその場で分析: GET /api/lookup?id=
  if (pathname === '/api/lookup' && req.method === 'GET') {
    (async () => {
      const uid = String(url.parse(req.url, true).query.id || '').trim();
      if (!uid) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      try {
        const plat = isWW(uid) ? 'whowatch' : isKick(uid) ? 'kick' : 'twitcasting';
        let profile = null, broadcasts = [];

        if (plat === 'whowatch') {
          const w = await fetchWWUser(wwPath(uid), (config.broadcasters.find(x=>x.user_id===uid)||{}).ww_user_id);
          const live = await getWWLive();
          const hit = (live || []).find(x => x.user_id === uid);
          profile = w ? { name: w.name, image: w.image, followers: w.followers, live: !!hit, current: hit ? hit.viewers : null } : null;
          const arc = await fetchWWArchives({ user_id: uid, ww_user_id: w && w.user_id_num });
          broadcasts = (arc.items || []).map(v => ({
            started_at: v.started_at, title: v.title, peak: null, total: v.total, duration: v.duration
          }));
        } else if (plat === 'kick') {
          const b = { user_id: uid, kick_slug: kickSlug(uid) };
          const ch = await fetchKickChannel(kickSlug(uid));
          const fol = await fetchKickFollowers(b);
          profile = ch ? { name: ch.name, image: ch.image, followers: fol, live: ch.live, current: ch.viewers } : null;
          const slug = await resolveKickSlug(b);
          if (slug) {
            const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`, { headers: KICK_HDRS });
            if (r.ok) {
              const j = await r.json();
              const vids = Array.isArray(j) ? j : (j.data || []);
              broadcasts = vids.map(v => {
                const ls = v.livestream || v;
                const st = ls.start_time || v.created_at;
                if (!st) return null;
                const ms = new Date(String(st).replace(' ', 'T') + (String(st).endsWith('Z') ? '' : 'Z')).getTime();
                const dur = Number(v.duration || ls.duration || 0);
                const total = Number(v.views ?? v.view_count ?? 0);
                if (!ms || !dur || !total) return null;
                return { started_at: new Date(ms).toISOString(), title: v.session_title || ls.session_title || null,
                         peak: null, total, duration: Math.round(dur / 1000) };
              }).filter(Boolean);
            }
          }
        } else {
          const info = await fetchUserInfo(uid);
          const cur = await fetchCurrentLiveApi(uid);
          profile = info ? { name: info.name, image: info.image, followers: info.followers || null,
                             live: !!(cur.ok && cur.live), current: cur.live ? cur.concurrent : null } : null;
          if (USE_TC_API) {
            let offset = 0;
            for (let page = 0; page < 4; page++) {
              const r = await fetch(`https://apiv2.twitcasting.tv/users/${encodeURIComponent(uid)}/movies?offset=${offset}&limit=50`, {
                headers: { 'X-Api-Version': '2.0', Authorization: `Basic ${TC_BASIC}`, Accept: 'application/json' }
              });
              if (!r.ok) break;
              const j = await r.json();
              const ms = j.movies || [];
              if (!ms.length) break;
              for (const m of ms) {
                if (m.is_live) continue;
                const startedMs = Number(m.created) * 1000;
                if (!startedMs) continue;
                broadcasts.push({
                  started_at: new Date(startedMs).toISOString(),
                  title: m.title || m.subtitle || null,
                  peak: Number(m.max_view_count ?? 0) || null,
                  total: Number(m.total_view_count ?? m.current_view_count ?? 0),
                  duration: Number(m.duration || 0)
                });
              }
              offset += ms.length;
              if (j.total_count != null && offset >= j.total_count) break;
            }
          }
        }
        if (!profile) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return; }
        broadcasts.sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
        const known = config.broadcasters.some(b => b.user_id === uid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user_id: uid, platform: plat, tracked: known, profile, broadcasts }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // 推定比率: GET /api/ratio
  if (pathname === '/api/ratio' && req.method === 'GET') {
    (async () => {
      try {
        if (!USE_SB) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
        const rows = await cached('ratio', 10 * 60 * 1000, () =>
          sb('GET', 'tw_ratio_mv', { query: '?select=*' }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows || []));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
      }
    })();
    return;
  }

  // 全体の日別サマリー: GET /api/overall
  if (pathname === '/api/overall' && req.method === 'GET') {
    (async () => {
      try {
        if (USE_SB) {
          const plat = (url.parse(req.url, true).query.platform) || 'twitcasting';
          const rows = await cached(`overall:${plat}`, 3 * 60 * 1000, () =>
            sbAll('tw_daily_overall', `?select=*&platform=eq.${encodeURIComponent(plat)}&order=day.asc`));
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
      const r = plat === 'kick' ? await discoverKick()
        : plat === 'whowatch' ? await discoverWW()
        : await discoverTopLives();
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
    if (!requireAdmin(req, res)) return;
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
    if (!requireAdmin(req, res)) return;
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
    (async () => {
      const plat = (url.parse(req.url, true).query.platform) || null;
      const out = {};
      const byId = new Map(config.broadcasters.map(b => [b.user_id, b]));

      // 集計はDBビューから取得（メモリに全履歴を持たない）
      let sums = [];
      if (USE_SB) {
        try {
          sums = await cached(`summary:${plat || 'all'}`, 60 * 1000, () =>
            sbAll('tw_broadcaster_summary',
              plat ? `?select=*&platform=eq.${encodeURIComponent(plat)}` : '?select=*'));
        } catch (e) { console.error('summary:', e.message); }
      }
      const byUid = new Map((sums || []).map(r => [r.user_id, r]));

      for (const b of config.broadcasters) {
        const p = b.platform || 'twitcasting';
        if (plat && p !== plat) continue;
        const st = broadcasterStats[b.user_id];
        const cb = st && st.current_broadcast;
        const ls = cb && cb.samples && cb.samples.length ? cb.samples[cb.samples.length - 1] : null;
        const r = byUid.get(b.user_id);
        out[b.user_id] = {
          live: !!cb,
          cur: ls ? ls.concurrent : null,
          curTotal: ls ? ls.total : null,
          n: r ? Number(r.n) : 0,
          allAvg: r ? r.all_avg : null,
          recent: r ? r.recent : null,
          best: r ? r.best : null,
          d30avg: r ? r.d30avg : null,
          d30n: r ? Number(r.d30n || 0) : 0,
          lastTs: r && r.last_ts ? new Date(r.last_ts).getTime() : null,
          retention: r ? r.retention : null,
          watchHours: r ? r.watch_hours : null
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    })();
    return;
  }

  // 配信者1人の詳細: GET /api/broadcaster?id=
  if (pathname === '/api/broadcaster' && req.method === 'GET') {
    (async () => {
      const uid = String(url.parse(req.url, true).query.id || '');
      const bc = config.broadcasters.find(b => b.user_id === uid);
      const p = (bc && bc.platform) || 'twitcasting';
      const st = broadcasterStats[uid];
      let list = [];
      if (USE_SB) {
        try {
          const rows = await sbAll('tw_broadcasts',
            `?select=started_at,ended_at,peak,total,duration,source,avg_concurrent,title` +
            `&user_id=eq.${encodeURIComponent(uid)}&order=started_at.asc`);
          const r = ratioOf(p);
          list = (rows || []).map(b => {
            const avg = b.avg_concurrent;
            let val = avg;
            if (val == null && b.peak != null && r.peak) val = Math.round(b.peak * r.peak);
            if (val == null && b.total && r.view) val = Math.round(b.total * r.view);
            if (val == null) return null;
            return {
              t: new Date(b.started_at).getTime(), started_at: b.started_at,
              live: !b.ended_at, archive: b.source === 'archive',
              avg, peak: b.peak, total: b.total || 0,
              title: b.title || null, duration: b.duration || 0, val
            };
          }).filter(Boolean);
        } catch (e) { console.error('broadcaster:', e.message); }
      }
      if (!list.length && st) list = broadcastList(uid, p);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        user_id: uid,
        found: !!st || list.length > 0,
        list_count: list.length,
        daily: dailySeries(list),
        broadcasts: list.slice(-100),
        current_samples: (st && st.current_broadcast)
          ? (st.current_broadcast.samples || []).slice(-720) : []
      }));
    })();
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
        if (isWW(uid)) {
          plat = 'whowatch';
          const w = await fetchWWUser(wwPath(uid), (config.broadcasters.find(x=>x.user_id===uid)||{}).ww_user_id);
          info = w ? { name: w.name, image: w.image, followers: w.followers } : null;
        } else if (isKick(uid)) {
          plat = 'kick';
          const ch = await fetchKickChannel(kickSlug(uid));
          info = ch ? { name: ch.name, image: ch.image } : null;
        } else {
          info = await fetchUserInfo(uid);
        }
        if (!info) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `ユーザーが見つかりません: ${uid}` })); return; }

        const b = { user_id: uid, name: info.name, image: info.image, pinned: true, auto: false, dormant: false, best_peak: 0, platform: plat };
        if (plat === 'whowatch') { if (info.followers) { b.follower_count = info.followers; b.follower_updated_at = new Date().toISOString(); } }
        else if (plat === 'kick') { b.kick_slug = kickSlug(uid); const f = await fetchKickFollowers(b); if (f) { b.follower_count = f; b.follower_updated_at = new Date().toISOString(); } }
        else if (info.followers) { b.follower_count = info.followers; b.follower_updated_at = new Date().toISOString(); }
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
    if (!requireAdmin(req, res)) return;
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
  if (!ADMIN_TOKEN) console.warn('[warn] ADMIN_TOKEN が未設定です。削除APIが保護されません。');
server.listen(PORT, () => {
    console.log(`Tracker on :${PORT} / storage=${USE_SB ? 'supabase' : 'local'} / twitcasting=${USE_TC_API} / kick=${USE_KICK} / broadcasters=${config.broadcasters.length}`);
  });
  loadRatios();
  setInterval(loadRatios, 60 * 60 * 1000);
  refreshAllUserInfo();
  discoverTopLives();
  setInterval(discoverTopLives, 5 * 60 * 1000);
  if (USE_KICK) { discoverKick(); setInterval(discoverKick, 5 * 60 * 1000); }
  discoverWW(); setInterval(discoverWW, 5 * 60 * 1000);
  setTimeout(async () => { const r = await pruneAuto(); console.log('[prune]', JSON.stringify(r)); }, 10 * 1000);
  setInterval(() => pruneAuto(), 60 * 60 * 1000);
  setTimeout(syncHourly, 2 * 60 * 1000);
  setInterval(syncHourly, 60 * 60 * 1000);
  setTimeout(compactSamples, 3 * 60 * 1000);
  setInterval(compactSamples, 6 * 60 * 60 * 1000);
  // 開きっぱなしの配信を定期的に閉じる
  setInterval(() => {
    const now = Date.now();
    for (const uid of Object.keys(broadcasterStats)) {
      const cb = broadcasterStats[uid].current_broadcast;
      if (!cb) continue;
      if (now - new Date(cb.started_at).getTime() > 8 * 3600e3) {
        const sm = (cb.samples || []).filter(x => x.concurrent > 0);
        cb.ended_at = new Date().toISOString();
        cb.avg_concurrent = sm.length ? Math.round(sm.reduce((t, x) => t + x.concurrent, 0) / sm.length) : null;
        cb.peak = sm.length ? Math.max(...sm.map(x => x.concurrent)) : null;
        cb.total_final = sm.length ? sm[sm.length - 1].total : null;
        const cbd = Math.round((new Date(cb.ended_at) - new Date(cb.started_at)) / 1000);
        cb.duration = (cbd > 0 && cbd <= 86400) ? cbd : null;
        cb.sample_count = sm.length;
        broadcasterStats[uid].history.push(cb);
        broadcasterStats[uid].current_broadcast = null;
        persistBroadcastEnd(uid, cb).catch(() => {});
        console.log(`[cleanup] ${uid} の長時間配信を終了処理`);
      }
    }
  }, 60 * 60 * 1000);
  setTimeout(autoBackfillMissing, 30 * 1000);
  setInterval(autoBackfillMissing, 30 * 60 * 1000);
  setInterval(refreshAllUserInfo, 3 * 60 * 60 * 1000);
  setInterval(monitorBroadcasters, 60000);
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
