// INPI Token API (Deposit-Balance, Wallet-Balances, Intent, Reconcile, Claims, Allocations, Early-Claim)
// KV-Bindings: CONFIG, PRESALE, INPI_CLAIMS
// Vars (optional): GATE_MINT, GATE_COLLECTION, PRESALE_MIN_USDC, PRESALE_MAX_USDC, RPC_URL
// Secrets (optional): HELIUS_API_KEY, RECONCILE_KEY
// Neue Config-Keys (über Admin-Worker setzbar):
//   early_claim_enabled ("true"/"false"), early_claim_fee_bps, early_claim_fee_dest ("lp"|"treasury"),
//   wait_bonus_bps, early_fee_usdc_ata
//   ZUSATZ (für Preis-Tiers): tier_nft_price_usdc, tier_public_price_usdc, public_mint_price_usdc

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC4wEGGkZwyTDt1v";
const QR_SVC    = "https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=";
const EARLY_FLAT_USDC = 1; // $1 Fee

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;

      // ---- CORS Preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // ---- STATUS (public)
      if (req.method === "GET" && p === "/api/token/status") {
        const cfg     = await readPublicConfig(env);
        const rpc_url = await getPublicRpcUrl(env);
        const early   = await getEarlyConfig(env);

        // Deposit + Owner (für Solana Pay als "to" prefer Owner)
        const depoAta = cfg.presale_deposit_usdc || "";
        let depoOwner = "";
        if (isAddress(depoAta)) {
          try { depoOwner = await getTokenAccountOwner(rpc_url, depoAta) || ""; } catch {}
        }

        // Early Fee Ziel (eigene ATA optional)
        const feeAta = cfg.early_fee_usdc_ata || cfg.presale_deposit_usdc || "";
        let feeOwner = "";
        if (isAddress(feeAta)) {
          try { feeOwner = await getTokenAccountOwner(rpc_url, feeAta) || ""; } catch {}
        }

        // Tier-Preise bestimmen
        const priceWith =
          toNumOrNull(cfg.tier_nft_price_usdc) ??
          toNumOrNull(cfg.public_mint_price_usdc) ??
          toNumOrNull(cfg.presale_price_usdc);

        const priceWithout =
          toNumOrNull(cfg.tier_public_price_usdc) ??
          toNumOrNull(cfg.public_price_usdc) ??
          null;

        return J({
          rpc_url,
          usdc_mint: USDC_MINT,
          inpi_mint: cfg.INPI_MINT || "",
          presale_state: cfg.presale_state || "pre",
          tge_ts: cfg.tge_ts,

          // klassische Felder
          presale_price_usdc: toNumOrNull(cfg.presale_price_usdc),
          public_price_usdc:  toNumOrNull(cfg.public_price_usdc),

          // neue Tier-Preise (Frontend nutzt das für "mit/ohne NFT")
          price_with_nft_usdc:  priceWith,
          price_without_nft_usdc: priceWithout,

          // Deposit
          deposit_usdc_ata:   depoAta,
          deposit_usdc_owner: depoOwner || null,
          cap_per_wallet_usdc: toNumOrNull(cfg.cap_per_wallet_usdc),
          presale_min_usdc: toNumOrNull(env.PRESALE_MIN_USDC),
          presale_max_usdc: toNumOrNull(env.PRESALE_MAX_USDC),

          // Early-Claim/Boni
          early_claim: {
            enabled: early.enabled,
            flat_usdc: EARLY_FLAT_USDC,
            fee_dest_wallet: feeOwner || ""
          },
          early_claim_fee_bps: early.fee_bps,
          wait_bonus_bps: early.bonus_bps,

          updated_at: Date.now()
        });
      }

      // ---- DEPOSIT BALANCE (public)
      if (req.method === "GET" && p === "/api/token/deposit/balance") {
        const cfg  = await readPublicConfig(env);
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

      // ---- WALLET BALANCES (public) (+ gate_ok)
      if (req.method === "GET" && p === "/api/token/wallet/balances") {
        const wallet = (url.searchParams.get("wallet") || "").trim();
        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const cfg = await readPublicConfig(env);
        const rpc = await getPublicRpcUrl(env);

        const [usdc, inpi] = await Promise.all([
          getSplBalance(rpc, wallet, USDC_MINT),
          cfg.INPI_MINT ? getSplBalance(rpc, wallet, cfg.INPI_MINT) : Promise.resolve(null)
        ]);

        // Gate prüfen: zuerst Collection (DAS), sonst Mint
        let gate_ok = true;
        const gateCollection = String(env.GATE_COLLECTION || "").trim();
        const gateMint = String(env.GATE_MINT || "").trim();
        if (gateCollection) {
          gate_ok = await passesCollectionGate(env, wallet, gateCollection);
        } else if (gateMint) {
          gate_ok = await passesMintGate(env, wallet, gateMint);
        }

        return J({ ok:true, wallet, usdc, inpi, gate_ok, updated_at:Date.now() });
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

        const cfg   = await readPublicConfig(env);
        const state = String(cfg.presale_state || "pre");
        if (state !== "pre" && state !== "public") return J({ ok:false, error:"phase_closed", phase: state }, 403);

        const cap = toNumOrNull(cfg.cap_per_wallet_usdc);
        if (cap != null && amount > cap) return J({ ok:false, error:"over_cap", cap_per_wallet_usdc: cap }, 400);

        const depoAta = cfg.presale_deposit_usdc || "";
        if (!isAddress(depoAta)) return J({ ok:false, error:"deposit_not_ready" }, 503);

        // Gate prüfen (und ggf. erzwingen)
        const gateCollection = String(env.GATE_COLLECTION || "").trim();
        const gateMint = String(env.GATE_MINT || "").trim();
        let gateOk = true;
        if (gateCollection) {
          gateOk = await passesCollectionGate(env, wallet, gateCollection);
          if (!gateOk) return J({ ok:false, error:"gate_denied" }, 403);
        } else if (gateMint) {
          gateOk = await passesMintGate(env, wallet, gateMint);
          if (!gateOk) return J({ ok:false, error:"gate_denied" }, 403);
        }

        // Effektiven Preis je nach Gate wählen
        const appliedPrice = pickEffectivePrice(cfg, gateOk);
        const expected_inpi = appliedPrice ? Math.floor(amount / appliedPrice) : null;

        // Solana Pay + QR – Owner bevorzugen
        const rpc = await getPublicRpcUrl(env);
        let depoOwner = await getTokenAccountOwner(rpc, depoAta).catch(()=>null);
        if (!isAddress(depoOwner)) depoOwner = null;
        const sp = makeSolanaPayUrl({
          to: depoOwner || depoAta,
          amount, splToken: USDC_MINT,
          label: "Inpinity Presale",
          message: "INPI Presale Contribution"
        });
        const phantom  = `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`;
        const solflare = `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`;
        const qr_url   = `${QR_SVC}${encodeURIComponent(sp)}`;

        // Intent speichern (30 Tage TTL)
        const key = `intent:${Date.now()}:${wallet}`;
        await env.PRESALE.put(
          key,
          JSON.stringify({ wallet, amount_usdc:amount, sig_b58, msg_str, ts:Date.now(), gate_ok:gateOk, applied_price_usdc: appliedPrice }),
          { expirationTtl: 60*60*24*30 }
        );

        return J({
          ok:true,
          wallet,
          amount_usdc: amount,
          expected_inpi,
          applied_price_usdc: appliedPrice, // <-- Transparenz
          gate_ok: gateOk,                  // <-- zur UI
          deposit_usdc_ata: depoAta,
          usdc_mint: USDC_MINT,
          solana_pay_url: sp,
          phantom_universal_url: phantom,
          solflare_universal_url: solflare,
          qr_url,
          label:"INPI Presale",
          message:"INPI Presale Contribution",
          updated_at: Date.now()
        });
      }

      // ---- PRESALE RECONCILE (admin, idempotent)
      if (p === "/api/token/presale/reconcile-one") {
        if (req.method !== "POST") return J({ ok:false, error:"method_not_allowed" }, 405, { "allow":"POST" });
        return reconcileOne(req, env);
      }

      // ---- CLAIM STATUS (public)
      if (req.method === "GET" && p === "/api/token/claim/status") {
        const wallet = (url.searchParams.get("wallet") || "").trim();
        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const claim = await loadClaim(env, wallet);
        const early = await getEarlyConfig(env);
        const cfg = await readPublicConfig(env);

        const total_inpi = Math.floor(claim.total_inpi || 0);
        const early_net_claimed = Math.floor(claim.early?.net_claimed || 0);
        const pending_inpi = Math.max(0, total_inpi - early_net_claimed);

        const phase = String(cfg.presale_state || "pre");
        const bonus_preview = (phase === "pre" || phase === "closed")
          ? Math.floor(pending_inpi * (early.bonus_bps / 10000))
          : 0;

        return J({
          ok:true,
          wallet,
          total_usdc: Number(claim.total_usdc || 0),
          total_inpi,
          early: {
            enabled: early.enabled,
            fee_bps: early.fee_bps,
            net_claimed: early_net_claimed,
            fee_paid_inpi: Math.floor(claim.early?.fee_inpi_sum || 0),
            last_jobs: (claim.early?.jobs || []).slice(-5)
          },
          pending_inpi,
          bonus_preview_inpi: bonus_preview,
          updated_at: Date.now()
        });
      }

      // ---- EARLY-CLAIM QUOTE (bps-Modell)
      if (req.method === "GET" && p === "/api/token/claim/early/quote") {
        const wallet = (url.searchParams.get("wallet") || "").trim();
        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const early = await getEarlyConfig(env);
        if (!early.enabled) return J({ ok:false, error:"early_disabled" }, 403);

        const claim = await loadClaim(env, wallet);
        const gross = Math.floor((claim.total_inpi || 0) - (claim.early?.net_claimed || 0));
        if (gross <= 0) return J({ ok:false, error:"nothing_to_claim" }, 400);

        const fee = Math.floor((gross * early.fee_bps) / 10000);
        const net = Math.max(0, gross - fee);

        return J({ ok:true, wallet, gross_inpi: gross, fee_inpi: fee, net_inpi: net,
          fee_bps: early.fee_bps, fee_dest: early.fee_dest, updated_at: Date.now() });
      }

      // ---- EARLY-CLAIM INTENT (public → $1 USDC Fee QR)
      if (req.method === "POST" && p === "/api/token/claim/early-intent") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const { wallet } = await req.json().catch(()=>({}));
        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const early = await getEarlyConfig(env);
        if (!early.enabled) return J({ ok:false, error:"early_disabled" }, 403);

        const cfg = await readPublicConfig(env);
        const destAta = cfg.early_fee_usdc_ata || cfg.presale_deposit_usdc || "";
        if (!isAddress(destAta)) return J({ ok:false, error:"fee_dest_not_ready" }, 503);

        const rpc = await getPublicRpcUrl(env);
        let destOwner = await getTokenAccountOwner(rpc, destAta).catch(()=>null);
        if (!isAddress(destOwner)) destOwner = null;

        const sp = makeSolanaPayUrl({
          to: destOwner || destAta,
          amount: EARLY_FLAT_USDC, splToken: USDC_MINT,
          label: "INPI Early Claim Fee", message: "INPI Early Claim Fee"
        });
        const phantom  = `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`;
        const solflare = `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`;
        const qr_url   = `${QR_SVC}${encodeURIComponent(sp)}`;

        return J({ ok:true, wallet, dest_wallet: destOwner || destAta, amount_usdc: EARLY_FLAT_USDC,
          solana_pay_url: sp, phantom_universal_url: phantom, solflare_universal_url: solflare, qr_url });
      }

      // ---- EARLY-CLAIM CONFIRM (public → prüft $1 Fee, queued Claim)
      if (req.method === "POST" && p === "/api/token/claim/confirm") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const { wallet, fee_signature } = await req.json().catch(()=>({}));
        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(String(fee_signature||"")))
          return J({ ok:false, error:"bad_signature" }, 400);

        // Idempotenz
        const usedKey = `early_fee_tx:${fee_signature}`;
        const usedVal = await env.INPI_CLAIMS.get(usedKey);
        if (usedVal) {
          try { const prev = JSON.parse(usedVal); return J({ ok:true, already:true, job_id: prev.job_id, wallet }); } catch {}
          return J({ ok:true, already:true, wallet });
        }

        const cfg = await readPublicConfig(env);
        const destAta = cfg.early_fee_usdc_ata || cfg.presale_deposit_usdc || "";
        if (!isAddress(destAta)) return J({ ok:false, error:"fee_dest_not_ready" }, 503);

        // Tx prüfen: >= $1 USDC vom wallet -> dest ATA
        const rpc = await getPublicRpcUrl(env);
        const tx = await rpcCall(rpc, "getTransaction", [
          String(fee_signature),
          { maxSupportedTransactionVersion: 0, commitment: "confirmed" }
        ]).catch((e) => { throw new Error("get_tx_failed: " + e.message); });
        if (!tx) return J({ ok:false, error:"tx_not_found" }, 404);

        const pre = tx.meta?.preTokenBalances || [];
               post = tx.meta?.postTokenBalances || [];
        const ownerOut = ownerDeltaUSDC(pre, post, wallet);
        const destIn  = accountDeltaUSDC(pre, post, destAta);

        const okAmt = (ownerOut + 1e-9) >= EARLY_FLAT_USDC && (destIn + 1e-9) >= EARLY_FLAT_USDC;
        if (!okAmt) return J({ ok:false, error:"fee_underpaid", ownerOut, destIn, need: EARLY_FLAT_USDC }, 400);

        // Claimable berechnen
        const claim = await loadClaim(env, wallet);
        const gross = Math.floor((claim.total_inpi || 0) - (claim.early?.net_claimed || 0));
        if (gross <= 0) return J({ ok:false, error:"nothing_to_claim" }, 400);

        // Job anlegen – $1 Fee ist separat in USDC
        const jobId = `ec:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
        const job = {
          kind: "EARLY_CLAIM",
          job_id: jobId,
          wallet,
          gross_inpi: gross,
          fee_inpi: 0,
          net_inpi: gross,
          fee_bps: 0,
          fee_dest: "flat_usdc",
          status: "queued",
          ts: Date.now(),
          fee_signature
        };
        await env.INPI_CLAIMS.put(`early_job:${jobId}`, JSON.stringify(job), { expirationTtl: 60*60*24*30 });
        await env.INPI_CLAIMS.put(`early_state:${wallet}`, JSON.stringify({ pending_job_id: jobId, ts: Date.now() }), { expirationTtl: 60*60*24*7 });
        await env.INPI_CLAIMS.put(usedKey, JSON.stringify({ job_id: jobId, wallet, ts: Date.now() }), { expirationTtl: 60*60*24*60 });

        return J({ ok:true, queued:true, job_id: jobId, wallet, net_inpi: gross });
      }

      // ---- EARLY-CLAIM REQUEST (bps-Variante)
      if (req.method === "POST" && p === "/api/token/claim/early/request") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const body = await req.json().catch(() => ({}));
        const wallet = String(body.wallet || "").trim();
        const sig_b58 = String(body.sig_b58 || "").trim();
        const msg_str = String(body.msg_str || "").trim();

        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);

        const early = await getEarlyConfig(env);
        if (!early.enabled) return J({ ok:false, error:"early_disabled" }, 403);

        const pendingKey = `early_state:${wallet}`;
        const prevStateTxt = await env.INPI_CLAIMS.get(pendingKey);
        if (prevStateTxt) {
          try {
            const s = JSON.parse(prevStateTxt);
            if (s?.pending_job_id && !s?.last_done_ts) {
              return J({ ok:false, error:"already_pending", job_id:s.pending_job_id }, 429);
            }
          } catch {}
        }

        const claim = await loadClaim(env, wallet);
        const gross = Math.floor((claim.total_inpi || 0) - (claim.early?.net_claimed || 0));
        if (gross <= 0) return J({ ok:false, error:"nothing_to_claim" }, 400);

        const fee = Math.floor((gross * early.fee_bps) / 10000);
        const net = Math.max(0, gross - fee);

        if (sig_b58 && msg_str) {
          const ok = await verifySolanaSig(wallet, msg_str, sig_b58).catch(() => false);
          if (!ok) return J({ ok:false, error:"bad_sig" }, 400);
        }

        const jobId = `ec:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
        const job = {
          kind: "EARLY_CLAIM",
          job_id: jobId,
          wallet,
          gross_inpi: gross,
          fee_inpi: fee,
          net_inpi: net,
          fee_bps: early.fee_bps,
          fee_dest: early.fee_dest,
          status: "queued",
          ts: Date.now(),
          sig_b58: sig_b58 || null,
          msg_str: msg_str || null
        };

        await env.INPI_CLAIMS.put(`early_job:${jobId}`, JSON.stringify(job), { expirationTtl: 60*60*24*30 });
        await env.INPI_CLAIMS.put(pendingKey, JSON.stringify({ pending_job_id: jobId, ts: Date.now() }), { expirationTtl: 60*60*24*7 });

        return J({ ok:true, queued:true, job_id: jobId, wallet, net_inpi: net, fee_inpi: fee, fee_bps: early.fee_bps, fee_dest: early.fee_dest });
      }

      // ---- EARLY-CLAIM FINALIZE (admin)
      if (req.method === "POST" && p === "/api/token/claim/early/finalize") {
        if (!adminOk(req, env)) return J({ ok:false, error:"forbidden" }, 403);
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);

        const body = await req.json().catch(() => ({}));
        const wallet = String(body.wallet || "").trim();
        const job_id = String(body.job_id || "").trim();
        const tx_signature = String(body.tx_signature || "").trim();

        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        if (!job_id) return J({ ok:false, error:"bad_job_id" }, 400);

        const jobTxt = await env.INPI_CLAIMS.get(`early_job:${job_id}`);
        if (!jobTxt) return J({ ok:false, error:"job_not_found" }, 404);
        const job = JSON.parse(jobTxt);
        if (job.status === "done") {
          return J({ ok:true, already:true, job_id, wallet });
        }
        if (job.wallet !== wallet) return J({ ok:false, error:"job_wallet_mismatch" }, 400);

        const claim = await loadClaim(env, wallet);
        claim.early = claim.early || { net_claimed: 0, fee_inpi_sum: 0, jobs: [] };
        claim.early.net_claimed = Math.floor((claim.early.net_claimed || 0) + Math.max(0, job.net_inpi || 0));
        claim.early.fee_inpi_sum = Math.floor((claim.early.fee_inpi_sum || 0) + Math.max(0, job.fee_inpi || 0));
        claim.early.jobs = (claim.early.jobs || []);
        claim.early.jobs.push({
          job_id, net_inpi: job.net_inpi, fee_inpi: job.fee_inpi,
          fee_bps: job.fee_bps, fee_dest: job.fee_dest,
          tx_signature: tx_signature || null,
          ts_done: Date.now()
        });
        claim.updated_at = Date.now();
        await saveClaim(env, wallet, claim);

        job.status = "done";
        job.tx_signature = tx_signature || null;
        job.ts_done = Date.now();
        await env.INPI_CLAIMS.put(`early_job:${job_id}`, JSON.stringify(job), { expirationTtl: 60*60*24*60 });
        await env.INPI_CLAIMS.put(`early_state:${wallet}`, JSON.stringify({ last_done_ts: Date.now(), last_job_id: job_id }), { expirationTtl: 60*60*24*60 });

        return J({ ok:true, job_id, wallet, tx_signature, totals: {
          total_inpi: Math.floor(claim.total_inpi||0),
          early_net_claimed: Math.floor(claim.early.net_claimed||0),
          pending_inpi: Math.max(0, Math.floor(claim.total_inpi||0) - Math.floor(claim.early.net_claimed||0))
        }});
      }

      // ---- 404
      return J({ ok:false, error:"not_found" }, 404);
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
  0
  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  const blockTime = tx.blockTime ? (tx.blockTime * 1000) : null;
  const slot = tx.slot;

  const ownerDelta = ownerDeltaUSDC(pre, post, wallet);
  if (!(ownerDelta > 0)) return J({ ok:false, error:"no_owner_outflow" }, 400);

  const depoDelta = accountDeltaUSDC(pre, post, depo);
  if (!(depoDelta > 0)) return J({ ok:false, error:"no_deposit_inflow" }, 400);

  if (Math.abs(depoDelta - ownerDelta) > 0.000001) {
    return J({ ok:false, error:"mismatch_amounts", ownerDelta, depoDelta }, 400);
  }

  const usdc = ownerDelta;

  let inpi;
  if (overrideInpi != null && overrideInpi > 0) {
    inpi = Math.floor(overrideInpi);
  } else {
    const price = toNumOrNull(cfg.presale_price_usdc);
    if (!(price > 0)) return J({ ok:false, error:"price_not_set" }, 500);
    inpi = Math.floor(usdc / price);
  }

  const claim = await loadClaim(env, wallet);
  if (claim.txs.some(t => t.signature === signature)) {
    return J({ ok:true, already:true, wallet, signature, usdc, inpi,
      totals:{ total_usdc: claim.total_usdc, total_inpi: claim.total_inpi } });
  }

  claim.total_usdc = round6((claim.total_usdc || 0) + usdc);
  claim.total_inpi = Math.floor((claim.total_inpi || 0) + inpi);
  claim.txs.push({ signature, usdc, inpi, slot, ts: blockTime || Date.now() });
  claim.updated_at = Date.now();
  claim.wallet = wallet;

  await saveClaim(env, wallet, claim);

  return J({
    ok:true, wallet, signature, usdc, inpi,
    totals:{ total_usdc: claim.total_usdc, total_inpi: claim.total_inpi },
    updated_at: claim.updated_at
  });
}

/* ---------------- Gate-Helper ---------------- */
async function passesMintGate(env, owner, gateMint) {
  try {
    const rpc = await getPublicRpcUrl(env);
    const res = await rpcCall(rpc, "getTokenAccountsByOwner",
      [owner, { mint: gateMint }, { encoding:"jsonParsed", commitment:"confirmed" }]);
    for (const it of res?.value || []) {
      const amt = it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      if (amt > 0) return true;
    }
    return false;
  } catch { return true; } // Fail-open
}

// Collection-Gate via Helius DAS (compressed & uncompressed)
async function passesCollectionGate(env, owner, collection) {
  try {
    const rpc = await getPublicRpcUrl(env);
    const body = {
      jsonrpc: "2.0", id: 1, method: "getAssetsByOwner",
      params: {
        ownerAddress: owner, page: 1, limit: 100,
        displayOptions: { showFungible: false, showInscription: false }
      }
    };
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type":"application/json", "accept":"application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(()=>null);
    const items = j?.result?.items || [];
    for (const a of items) {
      const groups = a?.grouping || a?.groups || [];
      if (Array.isArray(groups)) {
        if (groups.some(g => (g?.group_key === "collection" && String(g?.group_value) === String(collection)))) {
          return true;
        }
      }
    }
    return false;
  } catch { return true; } // Fail-open
}

/* ---------------- Balance-Helper ---------------- */
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
    if (!txt) return { total_usdc: 0, total_inpi: 0, txs: [], early: { net_claimed: 0, fee_inpi_sum: 0, jobs: [] } };
    const j = JSON.parse(txt);
    if (!Array.isArray(j.txs)) j.txs = [];
    j.total_usdc = Number(j.total_usdc || 0);
    j.total_inpi = Math.floor(j.total_inpi || 0);
    if (!j.early || typeof j.early !== "object") j.early = { net_claimed: 0, fee_inpi_sum: 0, jobs: [] };
    if (!Array.isArray(j.early.jobs)) j.early.jobs = [];
    j.early.net_claimed = Math.floor(j.early.net_claimed || 0);
    j.early.fee_inpi_sum = Math.floor(j.early.fee_inpi_sum || 0);
    return j;
  } catch {
    return { total_usdc: 0, total_inpi: 0, txs: [], early: { net_claimed: 0, fee_inpi_sum: 0, jobs: [] } };
  }
}
async function saveClaim(env, wallet, claim) {
  const key = `claim:${wallet}`;
  await env.INPI_CLAIMS.put(key, JSON.stringify(claim));
}

/* ---------------- Config/RPC ---------------- */
async function readPublicConfig(env) {
  const keys = [
    "INPI_MINT","presale_state","tge_ts","presale_price_usdc","public_price_usdc",
    "presale_deposit_usdc","cap_per_wallet_usdc","public_rpc_url",
    "early_fee_usdc_ata",
    // Preis-Tiers & Mint
    "tier_nft_price_usdc","tier_public_price_usdc","public_mint_price_usdc",
    // Gate Keys (optional, nur lesend für Status/Debug)
    "gate_collection","gate_mint"
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
async function getEarlyConfig(env) {
  const keys = ["early_claim_enabled","early_claim_fee_bps","early_claim_fee_dest","wait_bonus_bps"];
  const vals = {};
  await Promise.all(keys.map(async k => (vals[k] = await env.CONFIG.get(k))));
  return {
    enabled: String(vals.early_claim_enabled || "false").toLowerCase() === "true",
    fee_bps: Math.max(0, Number(vals.early_claim_fee_bps || 0) || 0),
    fee_dest: String(vals.early_claim_fee_dest || "lp"),
    bonus_bps: Math.max(0, Number(vals.wait_bonus_bps || 300) || 0)
  };
}
async function getPublicRpcUrl(env) {
  try { const fromCfg = await env.CONFIG.get("public_rpc_url"); if (fromCfg) return fromCfg; } catch {}
  if (env.RPC_URL) return env.RPC_URL;
  if (env.HELIUS_API_KEY) return `https://rpc.helius.xyz/?api-key=${env.HELIUS_API_KEY}`; // Helius DAS kompatibel
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

/* ---------------- Utils ---------------- */
function isAddress(s){ return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || "")); }
function toNumOrNull(x){ if (x==null || x==="") return null; const n = Number(x); return Number.isFinite(n)? n : null; }
async function isJson(req){ return (req.headers.get("content-type")||"").toLowerCase().includes("application/json"); }
function adminOk(req, env){ return (req.headers.get("x-admin-key") || "") === String(env.RECONCILE_KEY || ""); }
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-key",
    "access-control-max-age": "86400"
  };
}
function jsonMetaHeaders(){ return { "content-type":"application/json; charset=utf-8" }; }
function J(obj, status=200, extra={}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...jsonMetaHeaders(), "cache-control":"no-store", ...secHeaders(), ...corsHeaders(), ...extra }
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
function round6(x){ return Math.round(Number(x||0)*1e6)/1e6; }
function numFrom(amountStr, decimals){
  const a = BigInt(amountStr || "0");
  const d = Number(decimals || 0);
  const den = 10n ** BigInt(d);
  return Number(a) / Number(den);
}

/* ---------- Preiswahl: mit/ohne NFT ---------- */
function pickEffectivePrice(cfg, gateOk) {
  const withNft =
    toNumOrNull(cfg.tier_nft_price_usdc) ??
    toNumOrNull(cfg.public_mint_price_usdc) ??
    toNumOrNull(cfg.presale_price_usdc);

  const withoutNft =
    toNumOrNull(cfg.tier_public_price_usdc) ??
    toNumOrNull(cfg.public_price_usdc) ??
    null;

  return gateOk ? withNft : (withoutNft ?? withNft);
}

/* ---------- Token-Account -> Owner ---------- */
async function getTokenAccountOwner(rpcUrl, tokenAccount) {
  const res = await rpcCall(rpcUrl, "getAccountInfo", [tokenAccount, { encoding:"jsonParsed", commitment:"confirmed" }]);
  const owner = res?.value?.data?.parsed?.info?.owner;
  return isAddress(owner) ? owner : null;
}

/* ---------- Solana Signatur-Verify ---------- */
async function verifySolanaSig(pubkeyBase58, message, sigBase58){
  try{
    const pub = b58decode(pubkeyBase58);
    const sig = b58decode(sigBase58);
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(message));
    return !!ok;
  }catch{
    try{
      const pub = b58decode(pubkeyBase58);
      const sig = b58decode(sigBase58);
      const key = await crypto.subtle.importKey("raw", pub, { name: "NODE-ED25519" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("NODE-ED25519", key, sig, new TextEncoder().encode(message));
      return !!ok;
    }catch{ return false; }
  }
}
/* ---------- Base58 minimal ---------- */
const B58_ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = Object.fromEntries(B58_ALPH.split("").map((c,i)=>[c,i]));
function b58decode(s){
  let n = 0n;
  for (const ch of s) {
    const v = B58_MAP[ch];
    if (v == null) throw new Error("bad_b58");
    n = n * 58n + BigInt(v);
  }
  let bytes = [];
  while (n > 0n){
    bytes.push(Number(n % 256n));
    n = n / 256n;
  }
  bytes = bytes.reverse();
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return new Uint8Array(bytes);
}
/* ---------- Solana Pay URL ---------- */
function makeSolanaPayUrl({ to, amount, splToken, label, message }) {
  const amt = Number(amount || 0);
  const amountStr = (Math.round(amt * 1e6) / 1e6).toString();
  const qp = new URLSearchParams();
  if (amountStr) qp.set("amount", amountStr);
  if (splToken) qp.set("spl-token", splToken);
  if (label) qp.set("label", label);
  if (message) qp.set("message", message);
  return `solana:${to}?${qp.toString()}`;
}