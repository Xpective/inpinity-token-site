/* ===========================================
   INPI Token API – kompatibel zur /public/token/app.js
   Bindings: CONFIG (KV), PRESALE (KV), INPI_CLAIMS (KV)
   Vars: HELIUS_API_KEY (empfohlen), RPC_URL (optional), RECONCILE_KEY (optional)
   =========================================== */

   const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
   const QR_SVC = "https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=";
   const TOKEN_2022_PID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
   
   export default {
     async fetch(req, env) {
       try {
         const url = new URL(req.url);
         const p = url.pathname;
         if (req.method === "OPTIONS") return noContent();
   
         // Routing-Check
         if (req.method === "GET" && p === "/api/token/ping") {
           return J({ ok: true, service: "inpi-api", ts: Date.now() });
         }
   
         /* -------- STATUS (für app.js/refreshStatus) -------- */
         if (req.method === "GET" && p === "/api/token/status") {
           const cfg = await readCfg(env);
           const rpc = await getRpc(env);
   
           const deposit_ata   = firstAddr(cfg.presale_deposit_usdc);
           const deposit_owner = deposit_ata ? (await getAtaOwnerSafe(rpc, deposit_ata)) : null;
   
           const base = pickBasePrice(cfg); // presale_price_usdc | public_mint_price_usdc | public_price_usdc
           const discBps = toNum(cfg.gate_discount_bps, 1000); // 10% default
           const price_without = base ?? null;
           const price_with    = base != null ? round6(base * (1 - discBps/10000)) : null;
   
           return J({
             rpc_url: rpc,
             inpi_mint: cfg.INPI_MINT || "",
             usdc_mint: USDC_MINT,
   
             presale_state: cfg.presale_state || "pre",
             tge_ts: normalizeSecs(cfg.tge_ts),
   
             presale_min_usdc: numOrNull(cfg.presale_min_usdc),
             presale_max_usdc: numOrNull(cfg.presale_max_usdc),
   
             price_without_nft_usdc: price_without,
             price_with_nft_usdc:    price_with,
   
             deposit_usdc_ata: deposit_ata || "",
             deposit_usdc_owner: deposit_owner || null,
   
             airdrop_bonus_bps: toNum(cfg.airdrop_bonus_bps, 600),
   
             early_claim: {
               enabled: isTrue(cfg.early_claim_enabled),
               flat_usdc: toNum(cfg.early_flat_usdc, 1),
               fee_dest_ata: firstAddr(cfg.early_fee_usdc_ata, deposit_ata) || ""
             },
   
             // Tokenomics (optional, kann in CONFIG gepflegt werden)
             supply_total: numOrNull(cfg.supply_total),
             dist_presale_bps: numOrNull(cfg.dist_presale_bps),
             dist_dex_liquidity_bps: numOrNull(cfg.dist_dex_liquidity_bps),
             dist_staking_bps: numOrNull(cfg.dist_staking_bps),
             dist_ecosystem_bps: numOrNull(cfg.dist_ecosystem_bps),
             dist_treasury_bps: numOrNull(cfg.dist_treasury_bps),
             dist_team_bps: numOrNull(cfg.dist_team_bps),
             dist_airdrop_nft_bps: numOrNull(cfg.dist_airdrop_nft_bps),
             dist_buyback_reserve_bps: numOrNull(cfg.dist_buyback_reserve_bps),
   
             updated_at: Date.now()
           });
         }
   
         /* -------- WALLET /balances -------- */
         if (req.method === "GET" && (p === "/api/token/wallet/balances" || p === "/api/token/wallet/brief")) {
           const wallet = (url.searchParams.get("wallet") || "").trim();
           if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
   
           const cfg = await readCfg(env);
           const rpc = await getRpc(env);
   
           const [usdc, inpi] = await Promise.all([
             getSplBalance(rpc, wallet, USDC_MINT),
             cfg.INPI_MINT ? getSplBalance(rpc, wallet, cfg.INPI_MINT) : null
           ]);
   
           // Soft-Gate (optional)
           const gate_ok = await gateOkForWallet(env, cfg, wallet);
   
           const base = pickBasePrice(cfg);
           const discBps = toNum(cfg.gate_discount_bps, 1000);
           const applied_price_usdc = base==null ? null : round6(base*(gate_ok? (1-discBps/10000):1));
   
           return J({ ok:true, wallet, usdc, inpi, gate_ok, applied_price_usdc, updated_at: Date.now() });
         }
   
         /* -------- PRESALE INTENT (liefert QR + Deep-Links) -------- */
         if (req.method === "POST" && p === "/api/token/presale/intent") {
           if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
           const { wallet, amount_usdc } = await req.json().catch(()=> ({}));
           const amount = Number(amount_usdc || 0);
           if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
           if (!(amount > 0))   return J({ ok:false, error:"bad_amount" }, 400);
   
           const cfg = await readCfg(env);
           const rpc = await getRpc(env);
           const phase = String(cfg.presale_state || "pre");
           if (!["pre","public"].includes(phase)) return J({ ok:false, error:"phase_closed" }, 403);
   
           const capMin = numOrNull(cfg.presale_min_usdc);
           const capMax = numOrNull(cfg.presale_max_usdc);
           if (capMin!=null && amount < capMin) return J({ ok:false, error:"under_min", min:capMin }, 400);
           if (capMax!=null && amount > capMax) return J({ ok:false, error:"over_max", max:capMax }, 400);
   
           const depoAta = firstAddr(cfg.presale_deposit_usdc);
           if (!isAddr(depoAta)) return J({ ok:false, error:"deposit_not_ready" }, 503);
           const depoOwner = await getAtaOwnerSafe(rpc, depoAta) || depoAta;
   
           // Preis + Gate
           const gate_ok = await gateOkForWallet(env, cfg, wallet);
           const base = pickBasePrice(cfg);
           const discBps = toNum(cfg.gate_discount_bps, 1000);
           const price = base==null ? null : round6(base*(gate_ok? (1-discBps/10000):1));
           const expected_inpi = price ? Math.floor(amount/price) : null;
   
           const payUrl = solanaPay({
             to: depoOwner, amount, spl: USDC_MINT,
             label: "INPI Presale", msg: "INPI Presale Contribution"
           });
           const qr_contribute = withWalletDeepLinks(payUrl);
   
           // Early Fee Link (nur vorab anzeigen; echtes QR kommt über /claim/early-intent)
           const feeAta = firstAddr(cfg.early_fee_usdc_ata, depoAta);
           const feeOwn = feeAta ? (await getAtaOwnerSafe(rpc, feeAta)) : null;
           const feeAmt = toNum(cfg.early_flat_usdc, 1);
           const feeUrl = feeAta ? solanaPay({
             to: feeOwn || feeAta, amount: feeAmt, spl: USDC_MINT,
             label: "INPI Early Claim Fee", msg:"INPI Early Claim Fee"
           }) : null;
           const qr_claim_now = feeUrl ? withWalletDeepLinks(feeUrl) : null;
   
           // Intent loggen
           await env.PRESALE.put(`intent:${Date.now()}:${wallet}`, JSON.stringify({
             wallet, amount_usdc: amount, applied_price_usdc: price, gate_ok, ts: Date.now()
           }), { expirationTtl: 60*60*24*30 });
   
           return J({
             ok:true, wallet, amount_usdc: amount, expected_inpi, applied_price_usdc: price, gate_ok,
             deposit_usdc_ata: depoAta, usdc_mint: USDC_MINT,
             qr_contribute,              // <-- app.js nutzt .qr_url + Deep-Links
             qr_claim_now,               // optional angezeigt
             airdrop_bonus_bps: toNum(cfg.airdrop_bonus_bps, 600),
             updated_at: Date.now()
           });
         }
   
         /* -------- EARLY-CLAIM: QR generieren -------- */
         if (req.method === "POST" && p === "/api/token/claim/early-intent") {
           if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
           const { wallet } = await req.json().catch(()=> ({}));
           if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
   
           const cfg = await readCfg(env);
           if (!isTrue(cfg.early_claim_enabled)) return J({ ok:false, error:"early_disabled" }, 403);
   
           const rpc = await getRpc(env);
           const depoAta = firstAddr(cfg.presale_deposit_usdc);
           const feeAta  = firstAddr(cfg.early_fee_usdc_ata, depoAta);
           if (!feeAta) return J({ ok:false, error:"fee_dest_not_ready" }, 503);
           const feeOwn = await getAtaOwnerSafe(rpc, feeAta);
           const feeAmt = toNum(cfg.early_flat_usdc, 1);
           const feeUrl = solanaPay({ to: feeOwn||feeAta, amount: feeAmt, spl: USDC_MINT, label:"INPI Early Claim Fee", msg:"INPI Early Claim Fee" });
   
           return J({
             ok:true, wallet,
             qr_url: `${QR_SVC}${encodeURIComponent(feeUrl)}`,
             solana_pay_url: feeUrl
           });
         }
   
         /* -------- EARLY-CLAIM: Fee verifizieren + Job enqueuen -------- */
         if (req.method === "POST" && p === "/api/token/claim/confirm") {
           if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
           const { wallet, fee_signature } = await req.json().catch(()=> ({}));
           if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
           if (!isSig(fee_signature)) return J({ ok:false, error:"bad_signature" }, 400);
   
           // Doppeleinreichung verhindern
           const usedKey = `early_fee_tx:${fee_signature}`;
           if (await env.INPI_CLAIMS.get(usedKey)) {
             const prev = JSON.parse(await env.INPI_CLAIMS.get(usedKey));
             return J({ ok:true, already:true, job_id: prev.job_id || null, wallet });
           }
   
           const cfg = await readCfg(env);
           const rpc = await getRpc(env);
           const feeAta = firstAddr(cfg.early_fee_usdc_ata, cfg.presale_deposit_usdc);
           if (!feeAta) return J({ ok:false, error:"fee_dest_not_ready" }, 503);
   
           // Zahlung >= flat?
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
   
           // Claimable
           const claim = await loadClaim(env, wallet);
           const gross = Math.floor((claim.total_inpi || 0) - (claim.early?.net_claimed || 0));
           if (gross <= 0) return J({ ok:false, error:"nothing_to_claim" }, 400);
   
           const job_id = `ec:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
           const job = { kind:"EARLY_CLAIM", job_id, wallet, gross_inpi:gross, net_inpi:gross, status:"queued", ts:Date.now(), fee_signature };
           await env.INPI_CLAIMS.put(`early_job:${job_id}`, JSON.stringify(job), { expirationTtl: 60*60*24*30 });
           await env.INPI_CLAIMS.put(`early_state:${wallet}`, JSON.stringify({ pending_job_id: job_id, ts: Date.now() }), { expirationTtl: 60*60*24*7 });
           await env.INPI_CLAIMS.put(usedKey, JSON.stringify({ job_id, wallet, ts: Date.now() }), { expirationTtl: 60*60*24*60 });
   
           return J({ ok:true, queued:true, job_id, wallet, net_inpi:gross });
         }
   
         /* -------- CLAIM STATUS -------- */
         if (req.method === "GET" && p === "/api/token/claim/status") {
           const wallet = url.searchParams.get("wallet") || "";
           if (!isAddr(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
           const claim = await loadClaim(env, wallet);
           const cfg = await readCfg(env);
           const total_inpi = Math.floor(claim.total_inpi || 0);
           const early_net  = Math.floor(claim.early?.net_claimed || 0);
           const pending    = Math.max(0, total_inpi - early_net);
           const bonus_bps  = toNum(cfg.airdrop_bonus_bps, 600);
           const bonus_prev = Math.floor(pending * (bonus_bps/10000));
           return J({
             ok:true, wallet,
             total_usdc: Number(claim.total_usdc||0),
             total_inpi, pending_inpi: pending,
             early:{ enabled: isTrue(cfg.early_claim_enabled), net_claimed: early_net,
                     fee_inpi_sum: Math.floor(claim.early?.fee_inpi_sum||0),
                     last_jobs: (claim.early?.jobs||[]).slice(-5) },
             bonus_preview_inpi: bonus_prev,
             updated_at: Date.now()
           });
         }
   
         return J({ ok:false, error:"not_found" }, 404);
       } catch (e) {
         return J({ ok:false, error:"internal", detail: String(e?.message||e) }, 500);
       }
     }
   };
   
   /* ---------------- Helpers ---------------- */
   async function readCfg(env){
     const keys = [
       "INPI_MINT","presale_state","tge_ts",
       "presale_price_usdc","public_mint_price_usdc","public_price_usdc",
       "presale_deposit_usdc","presale_min_usdc","presale_max_usdc",
       "nft_gate_enabled","gate_mint","gate_collection","gate_discount_bps",
       "airdrop_bonus_bps",
       "early_claim_enabled","early_fee_usdc_ata","early_flat_usdc",
       "supply_total","dist_presale_bps","dist_dex_liquidity_bps","dist_staking_bps",
       "dist_ecosystem_bps","dist_treasury_bps","dist_team_bps","dist_airdrop_nft_bps","dist_buyback_reserve_bps",
       "public_rpc_url"
     ];
     const out = {};
     await Promise.all(keys.map(async k => (out[k] = await env.CONFIG.get(k))));
     return out;
   }
   function pickBasePrice(cfg){ return firstNum(cfg.presale_price_usdc, cfg.public_mint_price_usdc, cfg.public_price_usdc); }
   async function gateOkForWallet(env, cfg, wallet){
     if (!isTrue(cfg.nft_gate_enabled)) return true;
     // Einfache Mint-Gate-Prüfung
     if (isAddr(cfg.gate_mint)) {
       try {
         const rpc = await getRpc(env);
         const r = await rpcCall(rpc, "getTokenAccountsByOwner",
           [wallet, { mint: cfg.gate_mint }, { encoding:"jsonParsed", commitment:"confirmed" }]);
         for (const it of r?.value || []) {
           const amt = it?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
           if (amt > 0) return true;
         }
       } catch {}
     }
     // optional: Collections via Helius DAS, wenn HELIUS_API_KEY vorhanden (weggelassen für Kürze)
     return false;
   }
   
   /* ---- Claims KV ---- */
   async function loadClaim(env, wallet){
     const txt = await env.INPI_CLAIMS.get(`claim:${wallet}`);
     if (!txt) return { total_usdc:0, total_inpi:0, txs:[], early:{ net_claimed:0, fee_inpi_sum:0, jobs:[] } };
     const j = safeJson(txt) || {};
     j.txs = Array.isArray(j.txs) ? j.txs : [];
     j.early = (j.early && typeof j.early==="object") ? j.early : { net_claimed:0, fee_inpi_sum:0, jobs:[] };
     j.early.jobs = Array.isArray(j.early.jobs) ? j.early.jobs : [];
     j.total_usdc = Number(j.total_usdc||0);
     j.total_inpi = Math.floor(j.total_inpi||0);
     j.early.net_claimed = Math.floor(j.early.net_claimed||0);
     j.early.fee_inpi_sum = Math.floor(j.early.fee_inpi_sum||0);
     return j;
   }
   
   /* ---- RPC helpers ---- */
   async function getRpc(env){
     const cfg = await env.CONFIG.get("public_rpc_url").catch(()=>null);
     if (cfg) return cfg;
     if (env.RPC_URL) return env.RPC_URL;
     if (env.HELIUS_API_KEY) return `https://rpc.helius.xyz/?api-key=${env.HELIUS_API_KEY}`;
     return "https://api.mainnet-beta.solana.com";
   }
   async function rpcCall(rpcUrl, method, params){
     const r = await fetch(rpcUrl, { method:"POST", headers:{ "content-type":"application/json" },
       body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }) });
     const txt = await r.text();
     if (!r.ok) throw new Error(`rpc_http_${r.status}: ${txt.slice(0,120)}`);
     let j; try{ j=JSON.parse(txt);}catch{ throw new Error("rpc_bad_json"); }
     if (j.error) throw new Error(j.error?.message || "rpc_error");
     return j.result;
   }
   async function getTxSafe(rpc, sig){
     return await rpcCall(rpc, "getTransaction", [String(sig), { maxSupportedTransactionVersion: 0, commitment:"confirmed" }]).catch(()=>null);
   }
   async function getAtaOwnerSafe(rpc, ata){
     try{
       const r = await rpcCall(rpc, "getAccountInfo", [ata, { encoding:"jsonParsed", commitment:"confirmed" }]);
       const o = r?.value?.data?.parsed?.info?.owner;
       return isAddr(o) ? o : null;
     }catch{ return null; }
   }
   async function getSplBalance(rpcUrl, owner, mint){
     let res = await rpcCall(rpcUrl, "getTokenAccountsByOwner",
       [owner, { mint }, { encoding:"jsonParsed", commitment:"confirmed" }]).catch(()=>null);
     if (!res || (res.value||[]).length === 0) {
       res = await rpcCall(rpcUrl, "getTokenAccountsByOwner",
         [owner, { programId: TOKEN_2022_PID }, { encoding:"jsonParsed", commitment:"confirmed" }]).catch(()=>null);
       if (res && Array.isArray(res.value)) res.value = res.value.filter(v => v?.account?.data?.parsed?.info?.mint === mint);
     }
     const arr = res?.value || [];
     let raw = 0n, decimals = 0;
     for (const it of arr) {
       const ta = it?.account?.data?.parsed?.info?.tokenAmount;
       if (!ta) continue;
       decimals = Number(ta?.decimals ?? decimals ?? 0);
       raw += BigInt(ta?.amount || "0");
     }
     const den = 10n ** BigInt(decimals || 0);
     const ui = Number(raw) / Number(den || 1n);
     return { amount: raw.toString(), decimals, uiAmount: ui, uiAmountString: String(ui) };
   }
   
   /* ---- math & tiny utils ---- */
   function ownerDeltaUSDC(pre, post, owner){ return round6(Math.max(0, sumOwnerUSDC(pre, owner) - sumOwnerUSDC(post, owner))); }
   function accountDeltaUSDC(pre, post, account){
     const p0 = findUSDC(pre, account), p1 = findUSDC(post, account);
     if (!p0 && !p1) return 0;
     return round6(Math.max(0, (p1?.uiAmount||0) - (p0?.uiAmount||0)));
   }
   function sumOwnerUSDC(arr, owner){
     let s=0; for (const b of arr||[]) if (b.mint===USDC_MINT && b.owner===owner) {
       const u = b.uiTokenAmount?.uiAmount ?? numFrom(b.uiTokenAmount?.amount, b.uiTokenAmount?.decimals);
       s += Number(u||0);
     } return round6(s);
   }
   function findUSDC(arr, account){
     for (const b of arr||[]) if (b.mint===USDC_MINT && b.account===account) {
       const u = b.uiTokenAmount?.uiAmount ?? numFrom(b.uiTokenAmount?.amount, b.uiTokenAmount?.decimals);
       return { uiAmount: Number(u||0) };
     } return null;
   }
   function withWalletDeepLinks(link){
     return {
       solana_pay_url: link,
       phantom_universal_url: `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(link)}`,
       solflare_universal_url: `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(link)}`,
       qr_url: `${QR_SVC}${encodeURIComponent(link)}`
     };
   }
   function solanaPay({to, amount, spl, label, msg}){
     const qp = new URLSearchParams();
     if (amount!=null) qp.set("amount", String(round6(Number(amount)||0)));
     if (spl) qp.set("spl-token", spl);
     if (label) qp.set("label", label);
     if (msg) qp.set("message", msg);
     return `solana:${to}?${qp.toString()}`;
   }
   function J(x,status=200){ return new Response(JSON.stringify(x),{status,headers:{...cors(),"content-type":"application/json; charset=utf-8","cache-control":"no-store"}}); }
   function noContent(){ return new Response(null,{status:204,headers:cors()}); }
   function cors(){ return {"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"content-type,x-admin-key","access-control-max-age":"86400"}; }
   function firstAddr(...xs){ for (const x of xs){ if (isAddr(x)) return x; } return ""; }
   function firstNum(...xs){ for (const x of xs){ const n=Number(x); if (Number.isFinite(n)) return n; } return null; }
   function toNum(x,d=0){ const n=Number(x); return Number.isFinite(n)? n : d; }
   function numOrNull(x){ const n=Number(x); return Number.isFinite(n)? n : null; }
   function round6(x){ return Math.round(Number(x||0)*1e6)/1e6; }
   function numFrom(amountStr,dec){ const a=BigInt(amountStr||"0"); const d=Number(dec||0); const den=10n**BigInt(d); return Number(a)/Number(den||1n); }
   function normalizeSecs(v){ if (v==null) return null; let t=Number(v); if (!Number.isFinite(t)||t<=0) return null; if (t>1e12) t=Math.floor(t/1000); return t; }
   function isTrue(x){ return String(x||"").toLowerCase()==="true"; }
   function isAddr(s){ return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s||"")); }
   function isSig(s){ return /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(String(s||"")); }
   function safeJson(t){ try{return JSON.parse(t);}catch{return null;} }