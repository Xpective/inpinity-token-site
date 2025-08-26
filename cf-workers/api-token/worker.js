// INPI Token API (Deposit-Balance, Wallet-Balances, Intent, Reconcile, Claims)
// KV-Bindings: CONFIG, PRESALE, INPI_CLAIMS
// Vars (optional): GATE_MINT, PRESALE_MIN_USDC, PRESALE_MAX_USDC, RPC_URL
// Secrets (optional): HELIUS_API_KEY, RECONCILE_KEY

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QR_SVC = "https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=";

function wantsJson(req, url) {
  const accept = (req.headers.get("accept") || "").toLowerCase();
  return url.searchParams.get("format") === "json" || accept.includes("application/json");
}

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;

      // ---- STATUS (public)
      if (req.method === "GET" && p === "/api/token/status") {
        const cfg = await readPublicConfig(env);
        const rpc_url = await getPublicRpcUrl(env);
        return J({
          rpc_url,
          usdc_mint: USDC_MINT,
          inpi_mint: cfg.INPI_MINT || "",
          presale_state: cfg.presale_state || "pre",
          tge_ts: cfg.tge_ts,
          presale_price_usdc: toNumOrNull(cfg.presale_price_usdc),
          public_price_usdc:  toNumOrNull(cfg.public_price_usdc),
          deposit_usdc_ata:   cfg.presale_deposit_usdc || "",
          cap_per_wallet_usdc: toNumOrNull(cfg.cap_per_wallet_usdc),
          presale_min_usdc: toNumOrNull(env.PRESALE_MIN_USDC),
          presale_max_usdc: toNumOrNull(env.PRESALE_MAX_USDC),
          updated_at: Date.now()
        });
      }

      // ---- DEPOSIT BALANCE (public)
      if (req.method === "GET" && p === "/api/token/deposit/balance") {
        const cfg = await readPublicConfig(env);
        const depo = cfg.presale_deposit_usdc || "";
        if (!isAddress(depo)) return J({ ok:false, error:"deposit_not_ready" }, 503);

        const rpc = await getPublicRpcUrl(env);
        const r = await rpcCall(rpc, "getTokenAccountBalance", [depo, { commitment: "confirmed" }]);
        const v = r?.value;
        if (!v) return J({ ok:false, error:"rpc_no_value" }, 502);

        return J({ ok:true, address:depo, mint:USDC_MINT,
          amount:v.amount, ui_amount:v.uiAmount, ui_amount_string:v.uiAmountString,
          decimals:v.decimals, updated_at:Date.now() });
      }

      // ---- WALLET BALANCES (public)
      if (req.method === "GET" && p === "/api/token/wallet/balances") {
        const wallet = (url.searchParams.get("wallet") || "").trim();
        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const cfg = await readPublicConfig(env);
        const rpc = await getPublicRpcUrl(env);

        const [usdc, inpi] = await Promise.all([
          getSplBalance(rpc, wallet, USDC_MINT),
          cfg.INPI_MINT ? getSplBalance(rpc, wallet, cfg.INPI_MINT) : Promise.resolve(null)
        ]);

        return J({ ok:true, wallet, usdc, inpi, updated_at:Date.now() });
      }

      // ---- PRESALE INTENT (public)
      if (req.method === "POST" && p === "/api/token/presale/intent") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const body   = await req.json().catch(() => ({}));
        const wallet = String(body.wallet || "").trim();
        const amount = Number(body.amount_usdc || 0);
        const sig_b58 = (body.sig_b58 || "").trim();
        const msg_str = (body.msg_str || "").trim();

        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        if (!(amount > 0))      return J({ ok:false, error:"bad_amount" }, 400);

        const minAmt = toNumOrNull(env.PRESALE_MIN_USDC);
        const maxAmt = toNumOrNull(env.PRESALE_MAX_USDC);
        if (minAmt != null && amount < minAmt) return J({ ok:false, error:"below_min", min_usdc:minAmt }, 400);
        if (maxAmt != null && amount > maxAmt) return J({ ok:false, error:"above_max", max_usdc:maxAmt }, 400);

        const cfg = await readPublicConfig(env);
        const state = String(cfg.presale_state || "pre");
        if (state !== "pre" && state !== "public") return J({ ok:false, error:"phase_closed", phase: state }, 403);

        const cap = toNumOrNull(cfg.cap_per_wallet_usdc);
        if (cap != null && amount > cap) return J({ ok:false, error:"over_cap", cap_per_wallet_usdc: cap }, 400);

        const depo = cfg.presale_deposit_usdc || "";
        if (!isAddress(depo)) return J({ ok:false, error:"deposit_not_ready" }, 503);

        const gateMint = String(env.GATE_MINT || "").trim();
        if (gateMint && !(await passesNftGate(env, wallet, gateMint))) {
          return J({ ok:false, error:"gate_denied" }, 403);
        }

        // Intent speichern (30 Tage TTL)
        const key = `intent:${Date.now()}:${wallet}`;
        await env.PRESALE.put(key, JSON.stringify({ wallet, amount_usdc:amount, sig_b58, msg_str, ts:Date.now() }),
                              { expirationTtl: 60*60*24*30 });

        // Solana Pay + QR
        const sp = makeSolanaPayUrl({ to: depo, amount, splToken: USDC_MINT, label: "Inpinity Presale", message: "INPI Presale Contribution" });
        const phantom = `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`;
        const solflare = `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`;
        const qr_url = `${QR_SVC}${encodeURIComponent(sp)}`;

        return J({ ok:true, wallet, amount_usdc:amount, deposit_usdc_ata:depo, usdc_mint:USDC_MINT,
          solana_pay_url:sp, phantom_universal_url:phantom, solflare_universal_url:solflare,
          qr_url, label:"Inpinity Presale", message:"INPI Presale Contribution", updated_at:Date.now() });
      }

      // ---- PRESALE RECONCILE (admin)
      if (p === "/api/token/presale/reconcile-one") {
        if (req.method !== "POST") return J({ ok:false, error:"method_not_allowed" }, 405, { "allow":"POST" });
        return reconcileOne(req, env);
      }

      // ---- CLAIM STATUS (public)
      if (req.method === "GET" && p === "/api/token/claim/status") {
        const wallet = (url.searchParams.get("wallet") || "").trim();
        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        const claim = await loadClaim(env, wallet);
        return J({ ok:true, wallet, ...claim, updated_at: Date.now() });
      }

      // ---- 404
      return new Response("Not found", { status: 404, headers: secTextHeaders() });
    } catch (e) {
      return J({ ok:false, error:"internal", detail: String(e?.message || e) }, 500);
    }
  }
};

/* ---------------- Admin: Reconcile ---------------- */
async function reconcileOne(req, env) {
  if (!adminOk(req, env)) return J({ ok:false, error:"forbidden" }, 403);
  if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);

  const body = await req.json().catch(() => ({}));
  const wallet = String(body.wallet || "").trim();
  const signature = String(body.signature || "").trim();
  const overrideInpi = toNumOrNull(body.override_inpi);

  if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(signature)) return J({ ok:false, error:"bad_signature" }, 400);

  const cfg = await readPublicConfig(env);
  const depo = cfg.presale_deposit_usdc || "";
  if (!isAddress(depo)) return J({ ok:false, error:"deposit_not_ready" }, 503);

  const rpc = await getPublicRpcUrl(env);
  const tx = await rpcCall(rpc, "getTransaction", [
    signature,
    { maxSupportedTransactionVersion: 0, commitment: "confirmed" }
  ]).catch((e) => { throw new Error("get_tx_failed: " + e.message); });

  if (!tx) return J({ ok:false, error:"tx_not_found" }, 404);
  const meta = tx.meta || {};
  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  const blockTime = tx.blockTime ? (tx.blockTime * 1000) : null;
  const slot = tx.slot;

  // Delta
  const ownerDelta = ownerDeltaUSDC(pre, post, wallet);
  if (!(ownerDelta > 0)) return J({ ok:false, error:"no_owner_outflow" }, 400);

  const depoDelta = accountDeltaUSDC(pre, post, depo);
  if (!(depoDelta > 0)) return J({ ok:false, error:"no_deposit_inflow" }, 400);

  if (Math.abs(depoDelta - ownerDelta) > 0.000001) {
    return J({ ok:false, error:"mismatch_amounts", ownerDelta, depoDelta }, 400);
  }

  const usdc = ownerDelta;

  // INPI berechnen
  let inpi;
  if (overrideInpi != null && overrideInpi > 0) {
    inpi = Math.floor(overrideInpi);
  } else {
    const price = toNumOrNull(cfg.presale_price_usdc);
    if (!(price > 0)) return J({ ok:false, error:"price_not_set" }, 500);
    inpi = Math.floor(usdc / price);
  }

  // Idempotenz
  const claim = await loadClaim(env, wallet);
  if (claim.txs.some(t => t.signature === signature)) {
    return J({ ok:true, already:true, wallet, signature, usdc, inpi,
      totals:{ total_usdc: claim.total_usdc, total_inpi: claim.total_inpi } });
  }

  // Speichern
  claim.total_usdc = round6((claim.total_usdc || 0) + usdc);
  claim.total_inpi = Math.floor((claim.total_inpi || 0) + inpi);
  claim.txs.push({ signature, usdc, inpi, slot, ts: blockTime || Date.now() });
  claim.updated_at = Date.now();

  await saveClaim(env, wallet, claim);

  return J({
    ok:true, wallet, signature, usdc, inpi,
    totals:{ total_usdc: claim.total_usdc, total_inpi: claim.total_inpi },
    updated_at: claim.updated_at
  });
}

function ownerDeltaUSDC(pre, post, owner) {
  const preBal = sumOwnerUSDC(pre, owner);
  const postBal = sumOwnerUSDC(post, owner);
  return round6(Math.max(0, preBal - postBal));
}

function accountDeltaUSDC(pre, post, account) {
  const p0 = findAccountUSDC(pre, account);
  const p1 = findAccountUSDC(post, account);
  if (p0 == null && p1 == null) return 0;
  const a0 = p0?.uiAmount || 0;
  const a1 = p1?.uiAmount || 0;
  return round6(Math.max(0, a1 - a0));
}

function sumOwnerUSDC(arr, owner) {
  let s = 0;
  for (const b of arr || []) {
    if (b.mint === USDC_MINT && (b.owner === owner)) {
      const u = b.uiTokenAmount?.uiAmount ?? numFrom(b.uiTokenAmount?.amount, b.uiTokenAmount?.decimals);
      s += Number(u || 0);
    }
  }
  return round6(s);
}

function findAccountUSDC(arr, account) {
  for (const b of arr || []) {
    if (b.mint === USDC_MINT && b.account === account) {
      const uiAmount = b.uiTokenAmount?.uiAmount ?? numFrom(b.uiTokenAmount?.amount, b.uiTokenAmount?.decimals);
      return { uiAmount: Number(uiAmount || 0) };
    }
  }
  return null;
}

/* ---------------- Claims: load/save ---------------- */
async function loadClaim(env, wallet) {
  const key = `claim:${wallet}`;
  try {
    const txt = await env.INPI_CLAIMS.get(key);
    if (!txt) return { total_usdc: 0, total_inpi: 0, txs: [] };
    const j = JSON.parse(txt);
    if (!Array.isArray(j.txs)) j.txs = [];
    j.total_usdc = Number(j.total_usdc || 0);
    j.total_inpi = Math.floor(j.total_inpi || 0);
    return j;
  } catch {
    return { total_usdc: 0, total_inpi: 0, txs: [] };
  }
}

async function saveClaim(env, wallet, claim) {
  const key = `claim:${wallet}`;
  await env.INPI_CLAIMS.put(key, JSON.stringify(claim));
}

/* ---------------- Helpers ---------------- */
async function readPublicConfig(env) {
  const keys = [
    "INPI_MINT","presale_state","tge_ts","presale_price_usdc","public_price_usdc",
    "presale_deposit_usdc","cap_per_wallet_usdc","public_rpc_url"
  ];
  const out = {};
  await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
  if (out.tge_ts != null) {
    let t = Number(out.tge_ts);
    if (Number.isFinite(t)) { if (t > 1e12) t = Math.floor(t/1000); if (t <= 0) t = null; out.tge_ts = t; }
    else out.tge_ts = null;
  } else out.tge_ts = null;
  return out;
}

async function getPublicRpcUrl(env) {
  try { const fromCfg = await env.CONFIG.get("public_rpc_url"); if (fromCfg) return fromCfg; } catch {}
  if (env.RPC_URL) return env.RPC_URL;
  if (env.HELIUS_API_KEY) return `https://rpc.helius.xyz/?api-key=${env.HELIUS_API_KEY}`;
  return "https://api.mainnet-beta.solana.com";
}

async function rpcCall(rpcUrl, method, params) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type":"application/json", "accept":"application/json" },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`rpc_http_${r.status}: ${txt.trim().slice(0,160)}`);
  let j; try { j = JSON.parse(txt); } catch { throw new Error(`rpc_bad_json: ${txt.trim().slice(0,160)}`); }
  if (j.error) throw new Error(j.error?.message || "rpc_error");
  if (!("result" in j)) throw new Error("rpc_no_result");
  return j.result;
}

async function getSplBalance(rpcUrl, owner, mint) {
  const res = await rpcCall(rpcUrl, "getTokenAccountsByOwner",
    [owner, { mint }, { encoding:"jsonParsed", commitment:"confirmed" }]);
  const arr = res?.value || [];
  let raw = 0n, decimals = 0;
  for (const it of arr) {
    const ta = it?.account?.data?.parsed?.info?.tokenAmount;
    if (!ta) continue;
    decimals = Number(ta?.decimals ?? decimals ?? 0);
    raw += BigInt(ta?.amount || "0");
  }
  const den = BigInt(10) ** BigInt(decimals || 0);
  const ui = Number(raw) / Number(den || 1n);
  return { amount: raw.toString(), decimals, uiAmount: ui, uiAmountString: String(ui) };
}

async function passesNftGate(env, owner, gateMint) {
  try {
    const rpc = await getPublicRpcUrl(env);
    const res = await rpcCall(rpc, "getTokenAccountsByOwner",
      [owner, { mint: gateMint }, { encoding:"jsonParsed", commitment:"confirmed" }]);
    for (const it of res?.value || []) {
      const amt = it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      if (amt > 0) return true;
    }
    return false;
  } catch { return true; }
}

function makeSolanaPayUrl({ to, amount, splToken, label, message }) {
  const u = new URL(`solana:${to}`);
  if (amount != null) u.searchParams.set("amount", String(amount));
  if (splToken) u.searchParams.set("spl-token", splToken);
  if (label)    u.searchParams.set("label", label);
  if (message)  u.searchParams.set("message", message);
  return u.toString();
}

function isAddress(s){ return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || "")); }
function toNumOrNull(x){ if (x==null || x==="") return null; const n = Number(x); return Number.isFinite(n)? n : null; }
async function isJson(req){ return (req.headers.get("content-type")||"").toLowerCase().includes("application/json"); }
function adminOk(req, env){ return (req.headers.get("x-admin-key") || "") === String(env.RECONCILE_KEY || ""); }
function J(obj, status=200, extra={}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...secHeaders(), ...extra }
  });
}
function secHeaders(){
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "x-proxy": "api-token"
  };
}
function secTextHeaders(){
  return { "content-type":"text/plain; charset=utf-8", "cache-control":"no-store", ...secHeaders() };
}
function round6(x){ return Math.round(Number(x||0)*1e6)/1e6; }
function numFrom(amountStr, decimals){
  const a = BigInt(amountStr || "0");
  const d = Number(decimals || 0);
  const den = 10n ** BigInt(d);
  return Number(a) / Number(den);
}