/* ===========================================
   INPI Token API – Presale + Early Claim
   KV: CONFIG, PRESALE, INPI_CLAIMS
   ENV (optional): RPC_URL, HELIUS_API_KEY, RECONCILE_KEY,
                   PRESALE_MIN_USDC, PRESALE_MAX_USDC
   =========================================== */

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // offizielles USDC
const QR_SVC    = "https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=";
const DEPOSIT_USDC_ATA_FALLBACK = "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6";
const TOKEN_2022_PID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;

      if (req.method === "OPTIONS") return noContent();

      /* ---------- HEALTH ---------- */
      if (req.method === "GET" && p === "/api/token/ping") {
        return J({ ok: true, service: "inpi-api", ts: Date.now() });
      }

      /* ---------- STATUS (Frontend liest hier fast alles) ---------- */
      if (req.method === "GET" && p === "/api/token/status") {
        const cfg = await readCfg(env);
        const rpc = await getRpc(env);

        const depoAta   = firstAddr(cfg.presale_deposit_usdc, DEPOSIT_USDC_ATA_FALLBACK);
        const depoOwner = isAddr(depoAta) ? (await getAtaOwnerSafe(rpc, depoAta)) : null;

        // Preise: Base aus KV, daraus "mit/ohne NFT" berechnen
        const base = pickBasePrice(cfg); // Number | null
        const discBps = toNum(cfg.gate_discount_bps, 1000); // default 10% Rabatt
        const priceWithGate    = base != null ? round6(base * (1 - discBps / 10000)) : null;
        const priceWithoutGate = base;

        // Caps aus KV → sonst aus ENV
        const presale_min_usdc = firstNum(cfg.presale_min_usdc, env.PRESALE_MIN_USDC, null);
        const presale_max_usdc = firstNum(cfg.presale_max_usdc, env.PRESALE_MAX_USDC, null);

        // Tokenomics (dist_*_bps): wenn im KV gesetzt → als Number liefern
        const dist = pickDists(cfg);

        return J({
          rpc_url: rpc,
          inpi_mint: cfg.INPI_MINT || "",
          usdc_mint: USDC_MINT,

          presale_state: cfg.presale_state || "pre",
          tge_ts: normalizeSecs(cfg.tge_ts),

          // aktiv verwendete Preise
          price_with_nft_usdc: priceWithGate,
          price_without_nft_usdc: priceWithoutGate,

          // Basis-Preise (für Frontend-Fallback/Anzeige)
          presale_price_usdc: numOrNull(cfg.presale_price_usdc),
          public_mint_price_usdc: numOrNull(cfg.public_mint_price_usdc),
          public_price_usdc: numOrNull(cfg.public_price_usdc),

          // Deposit / Owner (Owner = Wallet der ATA)
          deposit_usdc_ata: depoAta || "",
          deposit_usdc_owner: depoOwner,

          // Caps / Limits
          presale_min_usdc,
          presale_max_usdc,
          cap_per_wallet_usdc: firstNum(cfg.cap_per_wallet_usdc, null),

          // NFT Gate
          gate: {
            enabled: isTrue(cfg.nft_gate_enabled),
            collection: cfg.gate_collection || null,
            mint: cfg.gate_mint || null,
            discount_bps: discBps
          },

          // Early Claim Parameter
          early_claim: {
            enabled: isTrue(cfg.early_claim_enabled),
            flat_usdc: toNum(cfg.early_flat_usdc, 1),
            fee_dest_wallet: firstAddr(cfg.early_fee_usdc_ata, depoAta) || ""
          },

          // Tokenomics / Sonstiges
          airdrop_bonus_bps: toNum(cfg.airdrop_bonus_bps, 600),
          supply_total: firstNum(cfg.supply_total, 3141592653),
          ...dist,                            // dist_*_bps Felder aus KV
          creator_pubkey: cfg.creator_pubkey || null,

          updated_at: Date.now()
        });
      }

      /* ---------- WALLET BRIEF / BALANCES ---------- */
      if (req.method === "GET" && (p === "/api/token/wallet/brief" || p === "/api/token/wallet/balances")) {
        const wallet = (new URL(req.url)).searchParams.get("wallet")?.trim() || "";
        if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const cfg = await readCfg(env);
        const rpc = await getRpc(env);

        const [usdc, inpi] = await Promise.all([
          getSplBalance(rpc, wallet, USDC_MINT),
          cfg.INPI_MINT ? getSplBalance(rpc, wallet, cfg.INPI_MINT) : null
        ]);

        const gateOk  = await gateOkForWallet(env, cfg, wallet);
        const base    = pickBasePrice(cfg);
        const discBps = toNum(cfg.gate_discount_bps, 1000);
        const price   = base == null ? null : round6(base * (gateOk ? (1 - discBps/10000) : 1));

        return J({ ok:true, wallet, usdc, inpi, gate_ok: gateOk, applied_price_usdc: price, updated_at: Date.now() });
      }

      /* ---------- PRESALE INTENT ---------- */
      if (req.method === "POST" && p === "/api/token/presale/intent") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const { wallet, amount_usdc, sig_b58, msg_str } = await req.json().catch(()=>({}));
        const amount = Number(amount_usdc || 0);
        if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        if (!(amount > 0))   return J({ ok:false, error:"bad_amount" }, 400);

        const cfg   = await readCfg(env);
        const rpc   = await getRpc(env);
        const phase = String(cfg.presale_state || "pre");
        if (phase !== "pre" && phase !== "public") return J({ ok:false, error:"phase_closed", phase }, 403);

        const minCap = firstNum(cfg.presale_min_usdc, env.PRESALE_MIN_USDC, null);
        const maxCap = firstNum(cfg.presale_max_usdc, env.PRESALE_MAX_USDC, null);
        if (minCap != null && amount < minCap) return J({ ok:false, error:"under_min", presale_min_usdc: minCap }, 400);
        if (maxCap != null && amount > maxCap) return J({ ok:false, error:"over_max", presale_max_usdc: maxCap }, 400);

        const depoAta = firstAddr(cfg.presale_deposit_usdc, DEPOSIT_USDC_ATA_FALLBACK);
        if (!isAddr(depoAta)) return J({ ok:false, error:"deposit_not_ready" }, 503);
        const depoOwner = await getAtaOwnerSafe(rpc, depoAta);

        const gateOk  = await gateOkForWallet(env, cfg, wallet);
        const base    = pickBasePrice(cfg);
        const discBps = toNum(cfg.gate_discount_bps, 1000);
        const price   = base == null ? null : round6(base * (gateOk ? (1 - discBps/10000) : 1));
        const expected_inpi = price ? Math.floor(amount / price) : null;

        const payUrl = solanaPay({ to: depoOwner || depoAta, amount, spl: USDC_MINT, label:"INPI Presale", msg:"INPI Presale Contribution" });
        const contribute = withWalletDeepLinks(payUrl);

        const feeAta = firstAddr(cfg.early_fee_usdc_ata, depoAta);
        const feeOwn = await getAtaOwnerSafe(rpc, feeAta);
        const feeAmt = toNum(cfg.early_flat_usdc, 1);
        const feeUrl = solanaPay({ to: feeOwn || feeAta, amount: feeAmt, spl: USDC_MINT, label:"INPI Early Claim Fee", msg:"INPI Early Claim Fee" });
        const claimNow = withWalletDeepLinks(feeUrl);

        const key = `intent:${Date.now()}:${wallet}`;
        await env.PRESALE.put(key, JSON.stringify({
          wallet, amount_usdc: amount, applied_price_usdc: price, gate_ok: gateOk, ts: Date.now(),
          sig_b58: sig_b58 || null, msg_str: msg_str || null
        }), { expirationTtl: 60*60*24*30 });

        return J({
          ok:true,
          wallet, amount_usdc: amount,
          expected_inpi, applied_price_usdc: price, gate_ok: gateOk,
          deposit_usdc_ata: depoAta, usdc_mint: USDC_MINT,
          qr_contribute: contribute,     // USDC Beitrag (SolanaPay + QR + Universal-Links)
          qr_claim_now: claimNow,        // 1 USDC Early-Fee sofort zahlen
          airdrop_bonus_bps: toNum(cfg.airdrop_bonus_bps, 600),
          updated_at: Date.now()
        });
      }

      /* ---------- EARLY CLAIM – QR ---------- */
      if (req.method === "POST" && p === "/api/token/claim/early-intent") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const { wallet } = await req.json().catch(()=>({}));
        if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const cfg = await readCfg(env);
        const rpc = await getRpc(env);
        const depoAta = firstAddr(cfg.presale_deposit_usdc, DEPOSIT_USDC_ATA_FALLBACK);
        const feeAta  = firstAddr(cfg.early_fee_usdc_ata, depoAta);
        if (!isAddr(feeAta)) return J({ ok:false, error:"fee_dest_not_ready" }, 503);
        const feeOwn = await getAtaOwnerSafe(rpc, feeAta);
        const feeAmt = toNum(cfg.early_flat_usdc, 1);
        const feeUrl = solanaPay({ to: feeOwn || feeAta, amount: feeAmt, spl: USDC_MINT, label:"INPI Early Claim Fee", msg:"INPI Early Claim Fee" });
        return J({ ok:true, wallet, qr_url: `${QR_SVC}${encodeURIComponent(feeUrl)}`, solana_pay_url: feeUrl });
      }

      /* ---------- CLAIM CONFIRM ---------- */
      if (req.method === "POST" && p === "/api/token/claim/confirm") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const { wallet, fee_signature } = await req.json().catch(()=>({}));
        if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        if (!isSig(fee_signature)) return J({ ok:false, error:"bad_signature" }, 400);

        const usedKey = `early_fee_tx:${fee_signature}`;
        const usedVal = await env.INPI_CLAIMS.get(usedKey);
        if (usedVal) { const prev = safeJson(usedVal) || {}; return J({ ok:true, already:true, job_id: prev.job_id || null, wallet }); }

        const cfg = await readCfg(env);
        const rpc = await getRpc(env);
        const feeAta = firstAddr(cfg.early_fee_usdc_ata, cfg.presale_deposit_usdc, DEPOSIT_USDC_ATA_FALLBACK);
        if (!isAddr(feeAta)) return J({ ok:false, error:"fee_dest_not_ready" }, 503);

        const feeAmt = toNum(cfg.early_flat_usdc, 1);
        const tx = await getTxSafe(rpc, fee_signature);
        if (!tx) return J({ ok:false, error:"tx_not_found" }, 404);
        const pre  = tx.meta?.preTokenBalances || [];
        const post = tx.meta?.postTokenBalances || [];
        const ownerOut = ownerDeltaUSDC(pre, post, wallet);
        const destIn   = accountDeltaUSDC(pre, post, feeAta);
        if ((ownerOut + 1e-9) < feeAmt || (destIn + 1e-9) < feeAmt) {
          return J({ ok:false, error:"fee_underpaid", need: feeAmt, ownerOut, destIn }, 400);
        }

        const claim = await loadClaim(env, wallet);
        const gross = Math.floor((claim.total_inpi || 0) - (claim.early?.net_claimed || 0));
        if (gross <= 0) return J({ ok:false, error:"nothing_to_claim" }, 400);

        const jobId = `ec:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
        const job = { kind:"EARLY_CLAIM", job_id:jobId, wallet, gross_inpi:gross, fee_inpi:0, net_inpi:gross,
                      fee_bps:0, fee_dest:"flat_usdc", status:"queued", ts:Date.now(), fee_signature };
        await env.INPI_CLAIMS.put(`early_job:${jobId}`, JSON.stringify(job), { expirationTtl: 60*60*24*30 });
        await env.INPI_CLAIMS.put(`early_state:${wallet}`, JSON.stringify({ pending_job_id: jobId, ts: Date.now() }), { expirationTtl: 60*60*24*7 });
        await env.INPI_CLAIMS.put(usedKey, JSON.stringify({ job_id: jobId, wallet, ts: Date.now() }), { expirationTtl: 60*60*24*60 });

        return J({ ok:true, queued:true, job_id: jobId, wallet, net_inpi: gross });
      }

      /* ---------- CLAIM STATUS ---------- */
      if (req.method === "GET" && p === "/api/token/claim/status") {
        const wallet = (new URL(req.url)).searchParams.get("wallet") || "";
        if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        const claim = await loadClaim(env, wallet);
        const cfg = await readCfg(env);
        const earlyEnabled = isTrue(cfg.early_claim_enabled);
        const total_inpi = Math.floor(claim.total_inpi || 0);
        const early_net   = Math.floor(claim.early?.net_claimed || 0);
        const pending     = Math.max(0, total_inpi - early_net);
        const bonus_bps   = toNum(cfg.airdrop_bonus_bps, 600);
        const bonus_prev  = Math.floor(pending * (bonus_bps/10000));

        return J({ ok:true, wallet, total_usdc: Number(claim.total_usdc||0), total_inpi,
          early:{ enabled: earlyEnabled, net_claimed: early_net, fee_inpi_sum: Math.floor(claim.early?.fee_inpi_sum||0),
                  last_jobs:(claim.early?.jobs||[]).slice(-5) },
          pending_inpi: pending, bonus_preview_inpi: bonus_prev, updated_at: Date.now()
        });
      }

      /* ---------- DEPOSIT BALANCE ---------- */
      if (req.method === "GET" && p === "/api/token/deposit/balance") {
        const cfg = await readCfg(env);
        const depo = firstAddr(cfg.presale_deposit_usdc, DEPOSIT_USDC_ATA_FALLBACK);
        if (!isAddr(depo)) return J({ ok:false, error:"deposit_not_ready" }, 503);
        const rpc = await getRpc(env);
        const v = (await rpcCall(rpc, "getTokenAccountBalance", [depo, { commitment:"confirmed" }]))?.value;
        if (!v) return J({ ok:false, error:"rpc_no_value" }, 502);
        return J({ ok:true, address:depo, mint:USDC_MINT, amount:v.amount, ui_amount:v.uiAmount,
                   ui_amount_string:v.uiAmountString, decimals:v.decimals, updated_at: Date.now() });
      }

      /* ---------- RECONCILE (ADMIN) ---------- */
      if (p === "/api/token/presale/reconcile-one") {
        if (req.method !== "POST") return J({ ok:false, error:"method_not_allowed" }, 405, { "allow":"POST" });
        return reconcileOne(req, env);
      }

      return J({ ok:false, error:"not_found" }, 404);
    } catch (e) {
      return J({ ok:false, error:"internal", detail:String(e?.message||e) }, 500);
    }
  }
};

/* ================= Helpers ================= */

async function reconcileOne(req, env){
  if (!adminOk(req, env)) return J({ ok:false, error:"forbidden" }, 403);
  if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);

  const { wallet, signature, override_inpi } = await req.json().catch(()=>({}));
  if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
  if (!isSig(signature)) return J({ ok:false, error:"bad_signature" }, 400);

  const cfg = await readCfg(env);
  const rpc = await getRpc(env);
  const depoAta = firstAddr(cfg.presale_deposit_usdc, DEPOSIT_USDC_ATA_FALLBACK);
  if (!isAddr(depoAta)) return J({ ok:false, error:"deposit_not_ready" }, 503);

  const tx = await getTxSafe(rpc, signature);
  if (!tx) return J({ ok:false, error:"tx_not_found" }, 404);

  const pre = tx.meta?.preTokenBalances || [];
  const post= tx.meta?.postTokenBalances || [];
  const ownerOut = ownerDeltaUSDC(pre, post, wallet);
  const depoIn   = accountDeltaUSDC(pre, post, depoAta);
  if (!(ownerOut > 0)) return J({ ok:false, error:"no_owner_outflow" }, 400);
  if (!(depoIn   > 0)) return J({ ok:false, error:"no_deposit_inflow" }, 400);
  if (Math.abs(ownerOut - depoIn) > 0.000001) return J({ ok:false, error:"mismatch_amounts", ownerOut, depoIn }, 400);

  const price = firstNum(override_inpi, null) ? null : pickBasePrice(cfg);
  const inpi = firstNum(override_inpi, null) ? Math.floor(Number(override_inpi))
                                            : (price && price>0 ? Math.floor(ownerOut / price) : 0);
  if (!(inpi > 0)) return J({ ok:false, error:"price_not_set" }, 500);

  const claim = await loadClaim(env, wallet);
  if ((claim.txs || []).some(t => t.signature === signature)) {
    return J({ ok:true, already:true, wallet, signature, usdc: ownerOut, inpi,
      totals:{ total_usdc: claim.total_usdc, total_inpi: claim.total_inpi } });
  }

  claim.txs = claim.txs || [];
  claim.total_usdc = round6((claim.total_usdc || 0) + ownerOut);
  claim.total_inpi = Math.floor((claim.total_inpi || 0) + inpi);
  claim.txs.push({ signature, usdc: ownerOut, inpi, slot: tx.slot, ts: tx.blockTime ? tx.blockTime*1000 : Date.now() });
  claim.wallet = wallet; claim.updated_at = Date.now();
  await saveClaim(env, wallet, claim);

  return J({ ok:true, wallet, signature, usdc: ownerOut, inpi,
    totals:{ total_usdc: claim.total_usdc, total_inpi: claim.total_inpi }, updated_at: claim.updated_at });
}

/* --------- Config + Gate --------- */
async function readCfg(env){
  const keys = [
    // Basics
    "INPI_MINT","presale_state","tge_ts","public_rpc_url",
    // Preise
    "presale_price_usdc","public_mint_price_usdc","public_price_usdc",
    // Deposit / Caps
    "presale_deposit_usdc","cap_per_wallet_usdc","presale_min_usdc","presale_max_usdc",
    // Gate
    "nft_gate_enabled","gate_mint","gate_collection","gate_discount_bps",
    // Tokenomics
    "airdrop_bonus_bps","supply_total",
    "dist_presale_bps","dist_dex_liquidity_bps","dist_staking_bps","dist_ecosystem_bps",
    "dist_treasury_bps","dist_team_bps","dist_airdrop_nft_bps","dist_buyback_reserve_bps",
    // Early Claim
    "early_claim_enabled","early_fee_usdc_ata","early_flat_usdc",
    // Meta
    "creator_pubkey"
  ];
  const out = {};
  await Promise.all(keys.map(async k => (out[k] = await env.CONFIG.get(k))));
  return out;
}
function pickBasePrice(cfg){
  return firstNum(cfg.presale_price_usdc, cfg.public_mint_price_usdc, cfg.public_price_usdc);
}
function pickDists(cfg){
  const fields = [
    "dist_presale_bps","dist_dex_liquidity_bps","dist_staking_bps","dist_ecosystem_bps",
    "dist_treasury_bps","dist_team_bps","dist_airdrop_nft_bps","dist_buyback_reserve_bps"
  ];
  const o = {};
  for (const f of fields){
    const n = numOrNull(cfg[f]);
    if (n != null) o[f] = n;
  }
  return o;
}
async function gateOkForWallet(env, cfg, wallet){
  if (!isTrue(cfg.nft_gate_enabled)) return true; // soft gate: ohne Gate = ok

  // 1) konkreter gate_mint
  if (isAddr(cfg.gate_mint)) {
    try {
      const rpc = await getRpc(env);
      const res = await rpcCall(rpc, "getTokenAccountsByOwner",
        [wallet, { mint: cfg.gate_mint }, { encoding:"jsonParsed", commitment:"confirmed" }]);
      for (const it of (res?.value || [])) {
        const amt = it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
        if (amt > 0) return true;
      }
    } catch {}
  }

  // 2) Collection via Helius (nur wenn API-Key + collection gesetzt)
  if (cfg.gate_collection && env.HELIUS_API_KEY) {
    try {
      const rpc = await getRpc(env);
      const r = await fetch(rpc, {
        method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"getAssetsByOwner",
          params:{ ownerAddress: wallet, page:1, limit:500, displayOptions:{ showFungible:false } } })
      });
      const j = await r.json().catch(()=>null);
      const items = j?.result?.items || [];
      for (const a of items) {
        const groups = a?.grouping || a?.groups || [];
        if (groups.some(g => g?.group_key==="collection" && String(g?.group_value)===String(cfg.gate_collection))) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

/* --------- Claims storage --------- */
async function loadClaim(env, wallet){
  const key = `claim:${wallet}`;
  try {
    const txt = await env.INPI_CLAIMS.get(key);
    if (!txt) return { total_usdc:0, total_inpi:0, txs:[], early:{ net_claimed:0, fee_inpi_sum:0, jobs:[] } };
    const j = JSON.parse(txt);
    j.txs = Array.isArray(j.txs) ? j.txs : [];
    j.early = (j.early && typeof j.early==="object") ? j.early : { net_claimed:0, fee_inpi_sum:0, jobs:[] };
    j.early.jobs = Array.isArray(j.early.jobs) ? j.early.jobs : [];
    j.total_usdc = Number(j.total_usdc||0); j.total_inpi = Math.floor(j.total_inpi||0);
    j.early.net_claimed = Math.floor(j.early.net_claimed||0); j.early.fee_inpi_sum = Math.floor(j.early.fee_inpi_sum||0);
    return j;
  } catch {
    return { total_usdc:0, total_inpi:0, txs:[], early:{ net_claimed:0, fee_inpi_sum:0, jobs:[] } };
  }
}
async function saveClaim(env, wallet, claim){
  await env.INPI_CLAIMS.put(`claim:${wallet}`, JSON.stringify(claim));
}

/* --------- RPC / Balance ---------- */
async function getRpc(env){
  const fromCfg = await env.CONFIG