// fomo.family wallet exporter. Paste into DevTools console on https://fomo.family while logged in.
// Outputs GMGN / Terminal wallet-tracker import files: [{ address, rename, emoji }]
(async () => {
  const CFG = {
    crawlAll: true,        // false = leaderboards only (top earners). true = also walk followers + recommended graph
    maxUsers: 5000,        // stop crawling after this many unique users
    concurrency: 4,
    delayMs: 150,          // pause between requests per worker
    minPnl: null,          // e.g. 1000 to drop anyone with totalPnL under $1k from the export
    renameMax: 24,         // trackers truncate long labels
  };

  const API = 'https://prod-api.fomo.family';
  const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Privy keeps a fresh access token in localStorage and rotates it; re-read on every call.
  let capturedAuth = null;
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith(API)) {
        const h = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
        if (h.get('Authorization')) capturedAuth = { auth: h.get('Authorization'), chains: h.get('X-Supported-Chains') };
      }
    } catch {}
    return origFetch(input, init);
  };
  const token = () => {
    try {
      const raw = localStorage.getItem('privy:token');
      if (raw) return 'Bearer ' + JSON.parse(raw);
    } catch {}
    return capturedAuth?.auth || null;
  };
  if (!token()) {
    console.log('%c[fomo] waiting for an auth token: click around the app (open the leaderboard)...', 'color:orange');
    for (let i = 0; i < 60 && !token(); i++) await sleep(1000);
    if (!token()) return console.error('[fomo] no Privy token found. Are you logged in on fomo.family?');
  }

  async function api(path, attempt = 0) {
    const headers = { 'Content-Type': 'application/json', Authorization: token() };
    if (capturedAuth?.chains) headers['X-Supported-Chains'] = capturedAuth.chains;
    const res = await origFetch(API + path, { headers, credentials: 'include' });
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 5) throw new Error(`${res.status} ${path}`);
      await sleep(1000 * 2 ** attempt);
      return api(path, attempt + 1);
    }
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    const body = await res.json();
    return body.responseObject ?? body;
  }

  // ---- user store ----
  const users = new Map(); // id -> record
  const num = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);
  function findDeep(o, re, depth = 0) {
    if (!o || typeof o !== 'object' || depth > 3) return null;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && re.test(v) && /addr|wallet|sol|evm|svm/i.test(k) && !/token|mint|contract/i.test(k)) return v;
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') { const f = findDeep(v, re, depth + 1); if (f) return f; }
    }
    return null;
  }
  function ingest(raw, source) {
    const u = raw?.user && typeof raw.user === 'object' ? { ...raw, ...raw.user } : raw;
    const id = u?.id ?? u?.userId;
    if (!id) return null;
    const prev = users.get(id) || { id, sources: new Set() };
    const sol = [u.address, u.solanaAddress, u.svmAddress, u.wallets?.solana].find((a) => SOL_RE.test(a || '')) || findDeep(u, SOL_RE);
    const evm = [u.evmAddress, u.wallets?.evm].find((a) => EVM_RE.test(a || '')) || findDeep(u, EVM_RE);
    const rec = {
      ...prev,
      handle: u.userHandle ?? u.handle ?? prev.handle,
      name: u.displayName ?? prev.name,
      twitter: (typeof u.twitter === 'string' ? u.twitter : u.twitter?.username) ?? prev.twitter,
      sol: sol || prev.sol,
      evm: evm || prev.evm,
      totalPnL: num(u.totalPnL) ?? prev.totalPnL ?? null,
      pnl30d: num(u.pnl30d) ?? prev.pnl30d ?? null,
      pnl7d: num(u.pnl7d) ?? prev.pnl7d ?? null,
      pnl24h: num(u.pnl24h) ?? prev.pnl24h ?? null,
    };
    rec.sources.add(source);
    users.set(id, rec);
    return rec;
  }

  // ---- 1. leaderboards (top earners) ----
  for (const w of ['all-time', '30d', '7d', '24h']) {
    try {
      const r = await api(w === 'all-time' ? '/v2/leaderboard' : `/v2/leaderboard/${w}`);
      const list = r.leaderboard ?? r.users ?? r;
      if (Array.isArray(list)) list.forEach((x) => ingest(x, `lb:${w}`));
      console.log(`[fomo] leaderboard ${w}: ${Array.isArray(list) ? list.length : 0}`);
      if (w === 'all-time' && Array.isArray(list) && list[0]) console.log('[fomo] sample row keys:', Object.keys(list[0]));
    } catch (e) { console.warn('[fomo] leaderboard', w, e.message); }
  }
  const leaderboardIds = new Set(users.keys());

  // ---- 2. crawl the social graph (everyone reachable) + fill missing wallets ----
  const queue = [...users.keys()];
  const expanded = new Set();
  const detailed = new Set();
  let done = 0;

  async function processUser(id) {
    const rec = users.get(id);
    if ((!rec?.sol && !rec?.evm) || rec?.totalPnL == null) {
      if (!detailed.has(id)) {
        detailed.add(id);
        try { ingest(await api(`/v2/users/${id}`), 'profile'); } catch (e) { console.warn('[fomo] profile', id, e.message); }
      }
    }
    if (!CFG.crawlAll || expanded.has(id)) return;
    expanded.add(id);
    const neighbours = [];
    try { const r = await api(`/v2/users/${id}/followers`); neighbours.push(...(r.users ?? [])); } catch {}
    try { const r = await api(`/v2/users/${id}/recommendedUsers`); neighbours.push(...(r.following ?? []), ...(r.topTraders ?? [])); } catch {}
    for (const n of neighbours) {
      if (users.size >= CFG.maxUsers) break;
      const isNew = !users.has(n?.id ?? n?.userId);
      const got = ingest(n, 'graph');
      if (got && isNew) queue.push(got.id);
    }
  }

  const workers = Array.from({ length: CFG.concurrency }, async () => {
    while (queue.length) {
      const id = queue.shift();
      await processUser(id);
      done++;
      if (done % 25 === 0) console.log(`[fomo] processed ${done} | known ${users.size} | queued ${queue.length}`);
      await sleep(CFG.delayMs);
    }
  });
  await Promise.all(workers);

  // ---- 3. export ----
  const all = [...users.values()]
    .filter((u) => u.sol || u.evm)
    .filter((u) => CFG.minPnl == null || (u.totalPnL ?? -Infinity) >= CFG.minPnl)
    .sort((a, b) => (b.totalPnL ?? -Infinity) - (a.totalPnL ?? -Infinity));

  const label = (u) => (u.handle || u.name || u.id).toString().slice(0, CFG.renameMax);
  const toTracker = (list, key) => list.filter((u) => u[key]).map((u) => ({ address: u[key], rename: label(u), emoji: '' }));
  const top = all.filter((u) => leaderboardIds.has(u.id));

  const files = {
    'fomo-solana-all.json': toTracker(all, 'sol'),
    'fomo-evm-all.json': toTracker(all, 'evm'),
    'fomo-solana-leaderboard.json': toTracker(top, 'sol'),
    'fomo-evm-leaderboard.json': toTracker(top, 'evm'),
    'fomo-full.json': all.map(({ sources, ...u }) => ({ ...u, onLeaderboard: leaderboardIds.has(u.id), sources: [...sources] })),
  };
  const download = (name, data) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  for (const [name, data] of Object.entries(files)) { download(name, data); await sleep(400); }

  window.fetch = origFetch;
  window.fomoExport = files;
  console.table(all.slice(0, 25).map((u) => ({ handle: u.handle, totalPnL: u.totalPnL, pnl30d: u.pnl30d, sol: u.sol, evm: u.evm })));
  console.log(`[fomo] done: ${all.length} users with wallets (${top.length} from leaderboards). Files downloaded; also in window.fomoExport`);
})();
