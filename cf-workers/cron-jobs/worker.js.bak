export default {
  async scheduled(event, env, ctx) {
    const now = Date.now();
    const cfg = await loadConfig(env);

    // 30-minütlich: Buyback/Streams
    if (event.cron === "*/30 * * * *") {
      if (cfg.buyback_enabled) ctx.waitUntil(handleBuyback(env, cfg, now));
      ctx.waitUntil(handleCreatorStreams(env, cfg, now));
    }

    // 10-minütlich: Reconcile + Metrics
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(reconcilePresale(env, now));
      ctx.waitUntil(handleMetrics(env, cfg, now));
    }
  },

  async fetch(req, env) {
    if (!ipOk(req, env)) return new Response("Forbidden", { status: 403, headers: secHeaders() });
    if (req.method === "OPTIONS") return new Response("", { status: 204, headers: secHeaders() });

    const url = new URL(req.url);
    const path = url.pathname;

    // Status
    if (path === "/cron/status") {
      const last = await env.OPS.get("last_metrics_json");
      const stats = await queueStats(env);
      return J({ ok:true, metrics: last ? JSON.parse(last) : {}, stats });
    }

    // Peek (nur schauen, nichts verschieben)
    if (path === "/cron/ops/peek" && req.method === "GET") {
      if (!(await authOps(req, env, null))) return unauthorized();
      const limit = Math.max(1, Math.min( Number(url.searchParams.get("limit")||"10"), 100 ));
      const kind = url.searchParams.get("kind") || null;
      const items = await peekIntents(env, limit, kind);
      return J({ ok:true, items });
    }

    // Bot holt nächsten Auftrag
    if (path === "/cron/ops/next" && req.method === "POST") {
      const body = await readJson(req);
      if (!(await authOps(req, env, body))) return unauthorized();
      const { kind } = body || {};

      const key = await popIntent(env, kind);
      if (!key) return J({ ok:true, key:null, intent:null });

      const val = await env.OPS.get(key);
      if (!val) return J({ ok:true, key:null, intent:null });

      const obj = JSON.parse(val);

      const inflightKey = `inflight:${Date.now()}:${rand()}`;
      await env.OPS.put(inflightKey, JSON.stringify(obj), { expirationTtl: 60 * 30 }); // 30m
      await env.OPS.delete(key);

      return J({ ok:true, key: inflightKey, intent: obj });
    }

    // Bot bestätigt Abschluss
    if (path === "/cron/ops/complete" && req.method === "POST") {
      const body = await readJson(req);
      if (!(await authOps(req, env, body))) return unauthorized();

      const { key, result, error, idempotency_key } = body || {};
      if (!key || (!result && !error)) return J({ ok:false, error:"key AND (result|error) required" }, 400);

      // Idempotenz (5 Min)
      if (idempotency_key) {
        const idk = `idemp:${idempotency_key}`;
        const seen = await env.OPS.get(idk);
        if (seen) return J({ ok:true, idempotent:true });
        await env.OPS.put(idk, "1", { expirationTtl: 300 });
      }

      const val = await env.OPS.get(key);
      if (!val) return J({ ok:false, error:"not_found" }, 404);

      const doneKey = `done:${key.replace(/^inflight:/, "")}`;
      await env.OPS.put(doneKey, JSON.stringify({ finished: Date.now(), result: result||null, error: error||null }), { expirationTtl: 86400*30 });
      await env.OPS.delete(key);

      // Dead-letter bei Fehler
      if (error) {
        const deadKey = `dead:${Date.now()}:${rand()}`;
        await env.OPS.put(deadKey, JSON.stringify({ key, error, ts: Date.now() }), { expirationTtl: 86400*30 });
      }

      return J({ ok:true, doneKey });
    }

    // Manuelles Reconcile (mit Auth) – optional limit=100
    if (path === "/cron/reconcile-presale" && req.method === "POST") {
      const body = await readJson(req);
      if (!(await authOps(req, env, body))) return unauthorized();
      const n = await reconcilePresale(env, Date.now(), Number(body?.limit||0));
      return J({ ok:true, mirrored:n });
    }

    return new Response("OK", { headers: secHeaders() });
  }
};

/* ---------------- Security & Auth ---------------- */
function unauthorized(){ return new Response("Unauthorized", { status: 401, headers: secHeaders() }); }

async function authOps(req, env, body){
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  if (h.slice(7) !== env.OPS_API_KEY) return false;

  const sig = req.headers.get("x-ops-hmac") || req.headers.get("x-ops-hmac-sha256") || "";
  if (!sig) return true; // HMAC optional
  try {
    const payload = typeof body === "string" ? body : JSON.stringify(body||{});
    return await verifyHmac(payload, env.OPS_API_KEY, sig, env.OPS_HMAC_ALGO || "SHA-256");
  } catch { return false; }
}

function ipOk(req, env){
  const allow = (env.IP_ALLOWLIST||"").split(",").map(s=>s.trim()).filter(Boolean);
  if (allow.length===0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}

function secHeaders(){
  return {
    "x-content-type-options":"nosniff",
    "x-frame-options":"DENY",
    "referrer-policy":"strict-origin-when-cross-origin",
    "permissions-policy":"geolocation=(), microphone=(), camera=()",
    "strict-transport-security":"max-age=31536000; includeSubDomains; preload",
    "cache-control":"no-store",
    "access-control-allow-origin":"*",
    "access-control-allow-methods":"GET,POST,OPTIONS",
    "access-control-allow-headers":"*"
  };
}
const J = (x, status=200) => new Response(JSON.stringify(x), { status, headers: { "content-type":"application/json", ...secHeaders() } });
async function readJson(req){ const ct=(req.headers.get("content-type")||"").toLowerCase(); return ct.includes("application/json") ? await req.json().catch(()=>null) : null; }

/* ---------------- Config Loader ---------------- */
async function loadConfig(env) {
  const get = (k, d=null) => env.CONFIG.get(k).then(v => v ?? d);
  const [
    buyback_enabled, buyback_min_usdc, buyback_twap_slices,
    buyback_cooldown_min, buyback_split_burn_bps, buyback_split_lp_bps,
    last_buyback_ts
  ] = await Promise.all([
    get("buyback_enabled","false"), get("buyback_min_usdc","2000"), get("buyback_twap_slices","6"),
    get("buyback_cooldown_min","30"), get("buyback_split_burn_bps","2500"), get("buyback_split_lp_bps","7500"),
    get("last_buyback_ts","0")
  ]);
  return {
    buyback_enabled: String(buyback_enabled) === "true",
    buyback_min_usdc: Number(buyback_min_usdc),
    buyback_twap_slices: Number(buyback_twap_slices),
    buyback_cooldown_min: Number(buyback_cooldown_min),
    buyback_split_burn_bps: Number(buyback_split_burn_bps),
    buyback_split_lp_bps: Number(buyback_split_lp_bps),
    last_buyback_ts: Number(last_buyback_ts) || 0
  };
}

/* ---------------- Jobs ---------------- */
async function handleBuyback(env, cfg, now) {
  if (!(await lock(env.OPS, "lock:buyback", 60))) return;
  try {
    const minMs = (cfg.buyback_cooldown_min|0) * 60000;
    if (cfg.last_buyback_ts && now - cfg.last_buyback_ts < minMs) return;

    const bucket = Number((await env.CONFIG.get("lp_bucket_usdc")) || "0");
    if (bucket < cfg.buyback_min_usdc) return;

    const intent = {
      kind:"BUYBACK_TWAP_AND_LP",
      created: now,
      usdc: bucket,
      twap_slices: cfg.buyback_twap_slices,
      split_burn_bps: cfg.buyback_split_burn_bps,
      split_lp_bps: cfg.buyback_split_lp_bps
    };
    await putIntent(env, `intent:buyback:${now}`, intent);
    await env.CONFIG.put("lp_bucket_usdc", "0");
    await env.CONFIG.put("last_buyback_ts", String(now));
  } catch(e) {
    await env.OPS.put(`error:buyback:${now}`, String(e));
  } finally {
    await env.OPS.delete("lock:buyback");
  }
}

async function handleCreatorStreams(env, cfg, now) {
  if (!(await lock(env.OPS, "lock:creator", 60))) return;
  try {
    // USDC-Stream
    const mUsd = Number(await env.CONFIG.get("creator_usdc_stream_monthly_usdc") || "0");
    const monthsUsd = Number(await env.CONFIG.get("creator_usdc_stream_months") || "0");
    const nextUsd = Number(await env.CONFIG.get("creator_usdc_stream_next_ts") || "0");
    if (mUsd > 0 && monthsUsd > 0 && now >= nextUsd) {
      await putIntent(env, `intent:creator:usdc:${now}`, { kind:"CREATOR_PAYOUT_USDC", created: now, amount_usdc: mUsd });
      await env.CONFIG.put("creator_usdc_stream_next_ts", String(nextUsd + 30*24*3600*1000));
      await env.CONFIG.put("creator_usdc_stream_months", String(monthsUsd - 1));
    }

    // INPI-Stream
    const bps = Number(await env.CONFIG.get("creator_inpi_stream_bps_per_month") || "0");
    const monthsInpi = Number(await env.CONFIG.get("creator_inpi_stream_months") || "0");
    const nextInpi = Number(await env.CONFIG.get("creator_inpi_stream_next_ts") || "0");
    const supply = Number(await env.CONFIG.get("supply_total") || "0");
    if (bps > 0 && monthsInpi > 0 && now >= nextInpi && supply > 0) {
      const amountInpi = Math.floor(supply * (bps/10000));
      await putIntent(env, `intent:creator:inpi:${now}`, { kind:"CREATOR_PAYOUT_INPI", created: now, amount_inpi: amountInpi });
      await env.CONFIG.put("creator_inpi_stream_next_ts", String(nextInpi + 30*24*3600*1000));
      await env.CONFIG.put("creator_inpi_stream_months", String(monthsInpi - 1));
    }
  } catch(e) {
    await env.OPS.put(`error:creator:${now}`, String(e));
  } finally {
    await env.OPS.delete("lock:creator");
  }
}

async function handleMetrics(env, cfg, now) {
  try {
    const metrics = { ts: now };
    await env.OPS.put("last_metrics_json", JSON.stringify(metrics));
  } catch(e) {
    await env.OPS.put(`error:metrics:${now}`, String(e));
  }
}

/* --------- PRESALE → OPS Reconcile --------- */
async function reconcilePresale(env, now, overrideLimit){
  if (!(await lock(env.OPS, "lock:reconcile", 55))) return 0;
  const BATCH = Math.max(1, Number(env.RECONCILE_BATCH||"200"));
  const LIMIT = overrideLimit ? Math.min(overrideLimit, BATCH) : BATCH;

  let mirrored = 0;
  try {
    // neues Schema: intent:<wallet>:<ts>
    mirrored += await mirrorPrefix(env, "intent:", LIMIT - mirrored, (key) => {
      const p = key.split(":"); // ["intent", "<wallet>", "<ts>"]
      return { wallet: p[1], ts: Number(p[2]||now) };
    });
    if (mirrored < LIMIT) {
      // altes Schema: legacy_intent:<ts>:<wallet>
      mirrored += await mirrorPrefix(env, "legacy_intent:", LIMIT - mirrored, (key) => {
        const p = key.split(":"); // ["legacy_intent", "<ts>", "<wallet>"]
        return { wallet: p[2], ts: Number(p[1]||now) };
      });
    }
  } finally {
    await env.OPS.delete("lock:reconcile");
  }
  return mirrored;

  async function mirrorPrefix(env, prefix, max, parseFn){
    let cursor, n=0;
    do{
      const r = await env.PRESALE.list({ prefix, cursor });
      for (const k of (r.keys||[])) {
        if (n >= max) return n;
        const srcKey = k.name;
        const markKey = `mirror:presale:${srcKey}`;
        if (await env.OPS.get(markKey)) continue; // schon gespiegelt

        const raw = await env.PRESALE.get(srcKey); if (!raw) { await env.OPS.put(markKey, "missing", { expirationTtl: 7*86400 }); continue; }
        let obj; try { obj = JSON.parse(raw); } catch { obj = {}; }

        const meta = parseFn(srcKey);
        const wallet = obj.wallet || meta.wallet || null;
        const amount = Number(obj.amount_usdc || 0);
        const ts = Number(obj.ts || meta.ts || now);

        if (!wallet || !(amount > 0)) { // markiere ungültig
          await env.OPS.put(markKey, "invalid", { expirationTtl: 7*86400 });
          continue;
        }

        const intent = {
          kind: "PRESALE_ALLOCATION",
          created: ts,
          wallet, amount_usdc: amount,
          source: "INPI_PRESALE",
          source_key: srcKey
        };

        const dstKey = `intent:presale:${ts}:${rand()}`;
        await putIntent(env, dstKey, intent);
        await env.OPS.put(markKey, "1", { expirationTtl: 365*86400 });
        n++;

        // optional Webhook
        await webhook(env, "intent_created", intent).catch(()=>{});
        if (n >= max) return n;
      }
      cursor = r.cursor;
    } while (cursor);
    return n;
  }
}

/* ----------------- Intent Utils ----------------- */
async function putIntent(env, key, obj){
  await env.OPS.put(key, JSON.stringify(obj));
}
async function popIntent(env, kind){
  let cursor;
  do{
    const r = await env.OPS.list({ prefix: "intent:", cursor });
    for (const k of (r.keys||[])) {
      if (!kind) return k.name;
      const v = await env.OPS.get(k.name);
      if (!v) continue;
      try { const o = JSON.parse(v); if (o.kind === kind) return k.name; } catch {}
    }
    cursor = r.cursor;
  } while(cursor);
  return null;
}
async function peekIntents(env, limit, kind){
  const out = []; let cursor;
  do{
    const r = await env.OPS.list({ prefix: "intent:", cursor });
    for (const k of (r.keys||[])) {
      if (out.length >= limit) return out;
      const v = await env.OPS.get(k.name); if (!v) continue;
      try {
        const o = JSON.parse(v);
        if (kind && o.kind !== kind) continue;
        out.push({ key: k.name, kind: o.kind, created: o.created||null, brief: summarize(o) });
      } catch {}
    }
    cursor = r.cursor;
  } while(cursor);
  return out;
}
function summarize(o){
  switch(o.kind){
    case "PRESALE_ALLOCATION": return { wallet:o.wallet, usdc:o.amount_usdc };
    case "BUYBACK_TWAP_AND_LP": return { usdc:o.usdc, slices:o.twap_slices };
    case "CREATOR_PAYOUT_USDC": return { amount_usdc:o.amount_usdc };
    case "CREATOR_PAYOUT_INPI": return { amount_inpi:o.amount_inpi };
    default: return {};
  }
}

/* ----------------- Common Helpers ----------------- */
const rand = () => Math.random().toString(36).slice(2);

async function queueStats(env){
  const prefixes = ["intent:", "inflight:", "done:", "dead:", "error:", "lock:", "mirror:presale:"];
  const out = {};
  for (const p of prefixes) {
    let cursor, n=0;
    do {
      const r = await env.OPS.list({ prefix: p, cursor });
      n += (r.keys||[]).length;
      cursor = r.cursor;
    } while(cursor);
    out[p] = n;
  }
  return out;
}

async function webhook(env, event, payload){
  const url = (env.WEBHOOK_URL||"").trim(); if (!url) return;
  const body = JSON.stringify({ event, ts: Date.now(), payload });
  const headers = { "content-type":"application/json" };
  const secret = await env.WEBHOOK_SECRET;
  if (secret) headers["x-webhook-hmac"] = await hmacHex(secret, body);
  await fetch(url, { method:"POST", headers, body }).catch(()=>{});
}

/* Locks via TTL */
async function lock(ns, key, ttlSec){
  const exists = await ns.get(key);
  if (exists) return false;
  await ns.put(key, "1", { expirationTtl: Math.max(1, ttlSec|0) });
  return true;
}

/* HMAC */
async function verifyHmac(payload, secret, sig, algo="SHA-256"){
  const hex = await hmacHex(secret, typeof payload === "string" ? payload : JSON.stringify(payload||{}), algo);
  const b64 = await hmacB64(secret, typeof payload === "string" ? payload : JSON.stringify(payload||{}), algo);
  return sig === hex || sig === b64;
}
async function hmacHex(secret, msg, algo="SHA-256"){
  const mac = await hmac(secret, msg, algo);
  return [...new Uint8Array(mac)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function hmacB64(secret, msg, algo="SHA-256"){
  const mac = await hmac(secret, msg, algo);
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
async function hmac(secret, msg, algo="SHA-256"){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:{name:algo} }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(msg));
}

function ipOk(req, env){
  const csv = (env.IP_ALLOWLIST||"").trim();
  if (!csv) return true;
  const allow = csv.split(",").map(s=>s.trim()).filter(Boolean);
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}