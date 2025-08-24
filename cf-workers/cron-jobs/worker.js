export default {
  async scheduled(event, env, ctx) {
    const now = Date.now();
    const cfg = await loadConfig(env);

    // jede 30 Min: Buyback/TWAP & Creator-Streams
    if (event.cron === "*/30 * * * *") {
      if (cfg.buyback_enabled) {
        ctx.waitUntil(handleBuyback(env, cfg, now));
      }
      ctx.waitUntil(handleCreatorStreams(env, cfg, now));
    }

    // alle 10 Min: Metriken
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(handleMetrics(env, cfg, now));
    }
  },

  async fetch(req, env) {
    // Optionale IP-Restriktion
    if (!ipOk(req, env)) return new Response("Forbidden", { status: 403, headers: secHeaders() });

    const url = new URL(req.url);
    const path = url.pathname;

    // Mini-Status + Queue-Statistik
    if (path === "/cron/status") {
      const last = await env.OPS.get("last_metrics_json");
      const stats = await queueStats(env);
      return J({ ok: true, metrics: last ? JSON.parse(last) : {}, stats });
    }

    // --- OPS: next (Bot holt nächsten Auftrag) ---
    if (path === "/cron/ops/next" && req.method === "POST") {
      const body = await readJson(req);
      if (!(await authOps(req, env, body))) return unauthorized();
      const { kind } = body || {};

      // FIFO über alle "intent:*" Keys (mit Cursor)
      const key = await popIntent(env, kind);
      if (!key) return J({ ok: true, key: null, intent: null });

      const val = await env.OPS.get(key);
      if (!val) return J({ ok: true, key: null, intent: null });

      const obj = JSON.parse(val);

      // in inflight verschieben (30 Min TTL)
      const inflightKey = `inflight:${Date.now()}:${rand()}`;
      await env.OPS.put(inflightKey, JSON.stringify(obj), { expirationTtl: 60 * 30 });
      await env.OPS.delete(key);

      return J({ ok: true, key: inflightKey, intent: obj });
    }

    // --- OPS: complete (Bot bestätigt Abschluss) ---
    if (path === "/cron/ops/complete" && req.method === "POST") {
      const body = await readJson(req);
      if (!(await authOps(req, env, body))) return unauthorized();

      const { key, result, error, idempotency_key } = body || {};
      if (!key || (!result && !error)) return J({ ok:false, error:"key AND (result|error) required" }, 400);

      // Idempotenz-Schutz (5 Min)
      if (idempotency_key) {
        const idk = `idemp:${idempotency_key}`;
        const seen = await env.OPS.get(idk);
        if (seen) return J({ ok:true, idempotent:true });
        await env.OPS.put(idk, "1", { expirationTtl: 300 });
      }

      const val = await env.OPS.get(key);
      if (!val) return J({ ok:false, error:"not_found" }, 404);

      const doneKey = `done:${key.replace(/^inflight:/,"")}`;
      await env.OPS.put(doneKey, JSON.stringify({ finished: Date.now(), result: result||null, error: error||null }), { expirationTtl: 86400 * 30 });
      await env.OPS.delete(key);

      return J({ ok:true, doneKey });
    }

    return new Response("OK", { headers: secHeaders() });
  }
};

/* ----------------- Auth & Security ----------------- */
function unauthorized(){ return new Response("Unauthorized", { status: 401, headers: secHeaders() }); }

async function authOps(req, env, body){
  // Bearer Pflicht
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  const token = h.slice(7);
  if (token !== env.OPS_API_KEY) return false;

  // Optional: HMAC prüfen (Body muss exakt der signierte String sein)
  const sig = req.headers.get("x-ops-hmac") || req.headers.get("x-ops-hmac-sha256") || "";
  if (!sig) return true; // falls nicht benutzt
  try {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return await verifyHmac(payload, env.OPS_API_KEY, sig, env.OPS_HMAC_ALGO || "SHA-256");
  } catch { return false; }
}

function ipOk(req, env){
  const csv = (env.IP_ALLOWLIST||"").trim();
  if (!csv) return true;
  const allow = csv.split(",").map(s=>s.trim()).filter(Boolean);
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

/* ----------------- Config Loader ----------------- */
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

/* ----------------- Jobs ----------------- */
async function handleBuyback(env, cfg, now) {
  // Concurrency-Lock (1 Min) – verhindert doppelte Ausführung
  if (!(await lock(env.OPS, "lock:buyback", 60))) return;

  try {
    // Cooldown einhalten
    const minMs = (cfg.buyback_cooldown_min|0) * 60_000;
    if (cfg.last_buyback_ts && now - cfg.last_buyback_ts < minMs) return;

    // Budget prüfen
    const bucket = Number((await env.CONFIG.get("lp_bucket_usdc")) || "0");
    if (bucket < cfg.buyback_min_usdc) return;

    const intent = {
      kind: "BUYBACK_TWAP_AND_LP",
      created: now,
      usdc: bucket,
      twap_slices: cfg.buyback_twap_slices,
      split_burn_bps: cfg.buyback_split_burn_bps,
      split_lp_bps: cfg.buyback_split_lp_bps
    };
    await env.OPS.put(`intent:buyback:${now}`, JSON.stringify(intent));
    await env.CONFIG.put("lp_bucket_usdc", "0");
    await env.CONFIG.put("last_buyback_ts", String(now));
  } catch (e) {
    await env.OPS.put(`error:buyback:${now}`, String(e));
  } finally {
    await env.OPS.delete("lock:buyback");
  }
}

async function handleMetrics(env, cfg, now) {
  try {
    // TODO: Onchain KPIs über /rpc lesen (TVL, Holder, Volumen, Unlocks…)
    const metrics = { ts: now };
    await env.OPS.put("last_metrics_json", JSON.stringify(metrics));
  } catch (e) {
    await env.OPS.put(`error:metrics:${now}`, String(e));
  }
}

async function handleCreatorStreams(env, cfg, now) {
  // Concurrency-Lock (1 Min)
  if (!(await lock(env.OPS, "lock:creator", 60))) return;

  try {
    // USDC-Stream
    const mUsd = Number(await env.CONFIG.get("creator_usdc_stream_monthly_usdc") || "0");
    const monthsUsd = Number(await env.CONFIG.get("creator_usdc_stream_months") || "0");
    const nextUsd = Number(await env.CONFIG.get("creator_usdc_stream_next_ts") || "0");
    if (mUsd > 0 && monthsUsd > 0 && now >= nextUsd) {
      const intent = { kind:"CREATOR_PAYOUT_USDC", created: now, amount_usdc: mUsd };
      await env.OPS.put(`intent:creator:usdc:${now}`, JSON.stringify(intent));
      await env.CONFIG.put("creator_usdc_stream_next_ts", String(nextUsd + 30*24*3600*1000));
      await env.CONFIG.put("creator_usdc_stream_months", String(monthsUsd - 1));
    }

    // INPI-Stream (bps vom total supply)
    const bps = Number(await env.CONFIG.get("creator_inpi_stream_bps_per_month") || "0");
    const monthsInpi = Number(await env.CONFIG.get("creator_inpi_stream_months") || "0");
    const nextInpi = Number(await env.CONFIG.get("creator_inpi_stream_next_ts") || "0");
    const supply = Number(await env.CONFIG.get("supply_total") || "0");
    if (bps > 0 && monthsInpi > 0 && now >= nextInpi && supply > 0) {
      const amountInpi = Math.floor(supply * (bps/10000));
      const intent = { kind:"CREATOR_PAYOUT_INPI", created: now, amount_inpi: amountInpi };
      await env.OPS.put(`intent:creator:inpi:${now}`, JSON.stringify(intent));
      await env.CONFIG.put("creator_inpi_stream_next_ts", String(nextInpi + 30*24*3600*1000));
      await env.CONFIG.put("creator_inpi_stream_months", String(monthsInpi - 1));
    }
  } catch(e) {
    await env.OPS.put(`error:creator:${now}`, String(e));
  } finally {
    await env.OPS.delete("lock:creator");
  }
}

/* ----------------- Helpers ----------------- */
async function readJson(req){
  const ct = (req.headers.get("content-type")||"").toLowerCase();
  if (!ct.includes("application/json")) return null;
  return await req.json().catch(()=>null);
}
const J = (x, status=200) => new Response(JSON.stringify(x), { status, headers: { "content-type":"application/json", ...secHeaders() } });
const rand = () => Math.random().toString(36).slice(2);

/* KV Lock via set-if-absent mit TTL */
async function lock(ns, key, ttlSec){
  const exists = await ns.get(key);
  if (exists) return false;
  await ns.put(key, "1", { expirationTtl: Math.max(1, ttlSec|0) });
  return true;
}

/* Queue-Statistik grob zählen */
async function queueStats(env){
  const prefixes = ["intent:", "inflight:", "done:", "error:", "lock:"];
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

/* popIntent: holt 1. passenden intent:* (optional Filter nach kind) */
async function popIntent(env, kind){
  let cursor;
  do{
    const r = await env.OPS.list({ prefix: "intent:", cursor });
    for (const k of (r.keys||[])) {
      if (!kind) return k.name;
      const v = await env.OPS.get(k.name);
      if (!v) continue;
      try {
        const obj = JSON.parse(v);
        if (obj.kind === kind) return k.name;
      } catch {}
    }
    cursor = r.cursor;
  } while(cursor);
  return null;
}

/* HMAC-Signatur prüfen (hex oder base64) */
async function verifyHmac(payload, secret, sig, algo="SHA-256"){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:{name:algo} }, false, ["sign", "verify"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  // hex und base64 unterstützen
  const hex = [...new Uint8Array(mac)].map(b=>b.toString(16).padStart(2,"0")).join("");
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sig === hex || sig === b64;
}