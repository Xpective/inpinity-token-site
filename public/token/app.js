/* ===========================================
   Inpinity Token – Frontend (Phantom-first)
   Pfad: /token/app.js
   ===========================================
   Neu dazu:
   - Lädt /public/app-cfg (falls vorhanden) und überschreibt Fallbacks:
     RPC, INPI_MINT, USDC_MINT, API_BASE, CREATOR_USDC_ATA,
     PRICE_WITH/WITHOUT_NFT_FALLBACK (aus PRICE_USDC_PER_INPI + DISCOUNT_BPS)
   =========================================== */

/* ==================== KONFIG ==================== */
const CFG = {
  // Wird ggf. dynamisch via /public/app-cfg überschrieben
  RPC: "https://api.mainnet-beta.solana.com",

  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  API_BASE: "https://inpinity.online/api/token",

  // Fallbacks, falls API mal nicht antwortet
  PRICE_WITHOUT_NFT_FALLBACK: 0.00031415,
  PRICE_WITH_NFT_FALLBACK:    0.000282735, // 10% Rabatt
  DEPOSIT_USDC_ATA_FALLBACK:  "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
  TGE_TS_FALLBACK: Math.floor(Date.now()/1000) + 60*60*24*90,

  SUPPLY_FALLBACK: 3141592653,
  DISTR_FALLBACK_BPS: {
    dist_presale_bps:        1000,
    dist_dex_liquidity_bps:  2000,
    dist_staking_bps:         700,
    dist_ecosystem_bps:      2000,
    dist_treasury_bps:       1500,
    dist_team_bps:           1000,
    dist_airdrop_nft_bps:    1000,
    dist_buyback_reserve_bps: 800
  },

  // CDN-Fallback für web3.js (IIFE Build)
  WEB3_IIFE: "https://unpkg.com/@solana/web3.js@1.95.8/lib/index.iife.min.js"
};

/* ================ SOLANA / PHANTOM ================ */
let Connection = null; // wird nachgeladen, falls nötig

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);
const short = (a) => (a ? (a.slice(0,4) + "…" + a.slice(-4)) : "");
function fmt(n,d=2){ if(n==null||isNaN(n))return "–"; return Number(n).toLocaleString("de-DE",{maximumFractionDigits:d}); }
function fmti(n){ if(n==null||isNaN(n))return "–"; return Number(n).toLocaleString("de-DE"); }
function solscan(addr){ return `https://solscan.io/account/${addr}`; }
function nowSec(){ return Math.floor(Date.now()/1000); }

/* ---------- Web3 + Provider laden ---------- */
function getPhantomProvider(){
  if (typeof window !== "undefined"){
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
  }
  return null;
}
function ensureWeb3(){
  return new Promise((resolve)=>{
    if (window.solanaWeb3?.Connection){
      Connection = window.solanaWeb3.Connection;
      return resolve(true);
    }
    const s = document.createElement("script");
    s.src = CFG.WEB3_IIFE; s.async = true; s.onload = ()=>{
      if (window.solanaWeb3?.Connection){
        Connection = window.solanaWeb3.Connection;
        resolve(true);
      } else {
        console.error("web3.js konnte nicht geladen werden.");
        resolve(false);
      }
    };
    s.onerror = ()=>{ console.error("web3.js CDN-Load Fehler"); resolve(false); };
    document.head.appendChild(s);
  });
}

/* ---------- /public/app-cfg laden (optional) ---------- */
async function loadPublicAppCfg(){
  try{
    const r = await fetch("/public/app-cfg", { headers:{accept:"application/json"} });
    if (!r.ok) return;
    const c = await r.json();

    // RPC / API
    if (c?.RPC) CFG.RPC = c.RPC;
    if (c?.API_BASE) CFG.API_BASE = c.API_BASE;

    // Mints / Deposit
    if (c?.INPI_MINT) CFG.INPI_MINT = c.INPI_MINT;
    if (c?.USDC_MINT) CFG.USDC_MINT = c.USDC_MINT;
    if (c?.CREATOR_USDC_ATA) CFG.DEPOSIT_USDC_ATA_FALLBACK = c.CREATOR_USDC_ATA;

    // Preis-Fallbacks aus PRICE_USDC_PER_INPI + DISCOUNT_BPS
    const base = Number(c?.PRICE_USDC_PER_INPI);
    const disc = Number(c?.DISCOUNT_BPS ?? 0);
    if (Number.isFinite(base) && base>0){
      CFG.PRICE_WITHOUT_NFT_FALLBACK = base;
      const withNft = base * (1 - (Number.isFinite(disc)? disc : 0)/10000);
      CFG.PRICE_WITH_NFT_FALLBACK = Math.round(withNft*1e6)/1e6;
    }
  }catch(e){ /* still fine – Fallbacks bleiben */ }
}

/* ---------- Tokenomics UI ---------- */
function ensureTokenomicsSection(){
  if (el("tokenomicsBox")) return;
  const main = document.querySelector("main"); if (!main) return;
  const sec = document.createElement("section"); sec.className = "card"; sec.id = "tokenomicsBox";
  sec.innerHTML = `
    <h2>Tokenomics</h2>
    <div class="stats">
      <div><b>Total Supply:</b> <span id="tokTotal">—</span></div>
      <div><b>Presale-Allocation:</b> <span id="tokPresale">—</span></div>
    </div>
    <div style="overflow:auto;margin-top:.6rem">
      <table id="tokTable" style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;padding:.4rem;border-bottom:1px solid #234">Bucket</th>
          <th style="text-align:right;padding:.4rem;border-bottom:1px solid #234">BPS</th>
          <th style="text-align:right;padding:.4rem;border-bottom:1px solid #234">%</th>
          <th style="text-align:right;padding:.4rem;border-bottom:1px solid #234">INPI</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  main.appendChild(sec);
}
function renderTokenomics(supply, dist){
  ensureTokenomicsSection();
  const tTotal = el("tokTotal"), tPres = el("tokPresale"), tbl = el("tokTable")?.querySelector("tbody");
  if (!tTotal || !tbl) return;
  tTotal.textContent = fmti(supply); tbl.innerHTML = "";
  const rows = [
    ["Presale", dist.dist_presale_bps],
    ["DEX Liquidity", dist.dist_dex_liquidity_bps],
    ["Staking", dist.dist_staking_bps],
    ["Ecosystem", dist.dist_ecosystem_bps],
    ["Treasury", dist.dist_treasury_bps],
    ["Team", dist.dist_team_bps],
    ["Airdrop (NFT)", dist.dist_airdrop_nft_bps],
    ["Buyback Reserve", dist.dist_buyback_reserve_bps],
  ].filter(([,b])=>typeof b==="number");
  let presaleInpi=0;
  for (const [name,bps] of rows){
    const pct = bps/100, inpi = Math.floor(supply*(bps/10000));
    if (name==="Presale") presaleInpi=inpi;
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:.4rem;border-bottom:1px solid #1c2836">${name}</td>
      <td style="padding:.4rem;border-bottom:1px solid #1c2836;text-align:right">${fmti(bps)}</td>
      <td style="padding:.4rem;border-bottom:1px solid #1c2836;text-align:right">${pct.toFixed(2)}%</td>
      <td style="padding:.4rem;border-bottom:1px solid #1c2836;text-align:right">${fmti(inpi)}</td>`;
    tbl.appendChild(tr);
  }
  if (tPres) tPres.textContent = `${fmti(presaleInpi)} INPI (${(dist.dist_presale_bps/100).toFixed(2)}%)`;
}

/* ---------- UI-Refs ---------- */
const btnConnect = $("#btnConnect");
const walletAddr = $("#walletAddr");
const usdcBal = $("#usdcBal");
const inpiBal = $("#inpiBal");
const presaleState = $("#presaleState");
const tgeTime = $("#tgeTime");
const p0 = $("#p0");
const inpAmount = $("#inpAmount");
const expectedInpi = $("#expectedInpi");
const btnPresaleIntent = $("#btnPresaleIntent");
const btnHowTo = $("#btnHowTo");
const intentMsg = $("#intentMsg");
const depositAddrEl = $("#depositAddr");
const depositSolscanA = $("#depositSolscan");
const depositOwnerEl = $("#depositOwner");
const btnCopyDeposit = $("#btnCopyDeposit");

// Presale QR
const payArea = $("#payArea");
const qrContrib = $("#inpi-qr");
// Optionale Deep-Link Buttons (falls im HTML vorhanden)
const aPhantom = $("#link-phantom");
const aSolflare = $("#link-solflare");

// Early Claim
const earlyBox = $("#earlyBox");
const btnClaim = $("#btnClaim");
const earlyArea = $("#earlyArea");
const earlyMsg = $("#earlyMsg");
const earlySig = $("#earlySig");
const btnEarlyConfirm = $("#btnEarlyConfirm");
const qrClaimNow = $("#early-qr");

/* ---------- Badge bei Preis ---------- */
let gateBadge = document.createElement("span");
gateBadge.id = "gateBadge";
gateBadge.style.marginLeft = ".5rem";
gateBadge.className = "muted";
if (p0?.parentElement) p0.parentElement.appendChild(gateBadge);

/* ---------- State ---------- */
let connection = null, currentRpcUrl = null, provider = null, pubkey = null, POLL = null;
let lastDeepLinks = { contribute:null, claimNow:null };

const STATE = {
  rpc_url: null, inpi_mint: null, usdc_mint: null,
  presale_state: "pre", tge_ts: null, deposit_ata: null,
  deposit_owner: null,
  presale_min_usdc: null, presale_max_usdc: null,
  price_with_nft_usdc: null, price_without_nft_usdc: null,
  gate_ok: false,
  early: { enabled:false, flat_usdc:1, fee_dest_wallet:null },
  airdrop_bonus_bps: 600,
  claimable_inpi: 0,
  supply_total: CFG.SUPPLY_FALLBACK, dist_bps: { ...CFG.DISTR_FALLBACK_BPS }
};

/* ---------- Preis/Erwartung ---------- */
function currentPriceUSDC(){
  const w = STATE.price_with_nft_usdc, wo = STATE.price_without_nft_usdc;
  return STATE.gate_ok ? (w ?? wo) : (wo ?? w) ;
}
function calcExpectedInpi(usdc){
  if (!usdc||usdc<=0) return "–";
  const price=currentPriceUSDC(); if (!price||price<=0) return "–";
  return fmt(usdc/price,0) + " INPI";
}
function updatePriceRow(){
  if (!p0) return;
  const w=STATE.price_with_nft_usdc, wo=STATE.price_without_nft_usdc, active=currentPriceUSDC();
  const withTxt=(w&&w>0)? Number(w).toFixed(6)+" USDC" : "–";
  const woTxt=(wo&&wo>0)? Number(wo).toFixed(6)+" USDC" : "–";
  const actTxt=(active&&active>0)? Number(active).toFixed(6)+" USDC" : "–";
  const badge = STATE.gate_ok ? "NFT ✓" : "NFT ✗";
  p0.textContent = `mit NFT: ${withTxt} • ohne NFT: ${woTxt} • aktiv: ${actTxt}`;
  gateBadge.textContent = `(${badge})`;
}
function updateIntentAvailability(){
  let reason = (STATE.presale_state==="closed") ? "Der Presale ist geschlossen." : null;
  if (btnPresaleIntent){ btnPresaleIntent.disabled = !!reason; btnPresaleIntent.title = reason || ""; }
  if (intentMsg){
    const id="intent-reason"; let n=document.getElementById(id);
    if (reason){ if(!n){ n=document.createElement('p'); n.id=id; n.className='muted'; intentMsg.appendChild(n); } n.textContent="Hinweis: "+reason; }
    else if (n) n.remove();
  }
}

/* ==================== INIT ==================== */
async function init(){
  // 0) Falls vorhanden, app-cfg einlesen (setzt Defaults dynamisch)
  await loadPublicAppCfg();

  // 1) web3.js sicherstellen
  const okWeb3 = await ensureWeb3();
  if (!okWeb3) {
    alert("Fehler: web3.js konnte nicht geladen werden. Bitte Seite neu laden.");
    return;
  }

  // 2) API-Status laden (setzt Preise, RPC, etc.)
  await refreshStatus();

  // 3) Verbindung vorbereiten
  if (!STATE.rpc_url) STATE.rpc_url = CFG.RPC;
  if (!connection || currentRpcUrl !== STATE.rpc_url){
    connection = new Connection(STATE.rpc_url, "confirmed");
    currentRpcUrl=STATE.rpc_url;
  }

  updatePriceRow(); updateIntentAvailability();

  if (inpAmount && STATE.presale_min_usdc != null) inpAmount.min = String(STATE.presale_min_usdc);
  if (inpAmount && STATE.presale_max_usdc != null) inpAmount.max = String(STATE.presale_max_usdc);
  if (inpAmount && !inpAmount.step) inpAmount.step = "0.000001";

  // 4) Phantom Provider erkennen + Connect-Button konfigurieren
  provider = getPhantomProvider();
  if (provider?.isPhantom){
    try{
      await provider.connect({ onlyIfTrusted:true }).then(({publicKey})=>onConnected(publicKey)).catch(()=>{});
    }catch{}
    if (btnConnect){
      btnConnect.disabled=false; btnConnect.textContent="Verbinden";
      btnConnect.onclick = async () => {
        try{
          const { publicKey } = await provider.connect();
          onConnected(publicKey);
        } catch(e){
          console.error(e);
          alert("Wallet-Verbindung abgebrochen.");
        }
      };
    }
  } else {
    if (btnConnect){
      btnConnect.textContent="Phantom installieren";
      btnConnect.onclick=()=> window.open("https://phantom.app","_blank","noopener");
    }
  }

  if (btnCopyDeposit){
    btnCopyDeposit.onclick = async ()=>{
      const val = depositAddrEl?.textContent?.trim(); if(!val) return;
      await navigator.clipboard.writeText(val).catch(()=>{});
      btnCopyDeposit.textContent = "Kopiert ✓";
      setTimeout(()=>btnCopyDeposit.textContent="Kopieren", 1200);
    };
  }

  tickTGE(); setInterval(tickTGE, 1000);
  if (expectedInpi && inpAmount) expectedInpi.textContent = calcExpectedInpi(Number(inpAmount.value||"0"));
  if (earlyBox) earlyBox.style.display = STATE.early.enabled ? "block" : "none";
  if (btnClaim) btnClaim.onclick = startEarlyFlow;
  if (btnEarlyConfirm) btnEarlyConfirm.onclick = confirmEarlyFee;

  setBonusNote(); renderTokenomics(STATE.supply_total, STATE.dist_bps);
}

/* ---------- Bonus-Hinweis ---------- */
function setBonusNote(){
  const pct = (STATE.airdrop_bonus_bps/100).toFixed(2);
  const text = `Hinweis: Kein Early-Claim → Bonus-Airdrop von ca. ${pct}% vor TGE/Pool auf offene INPI.`;
  const p = document.createElement("p"); p.className="muted"; p.style.marginTop=".5rem"; p.textContent=text;

  if (earlyBox){
    if (!earlyBox.querySelector(".bonus-note")){
      const div=document.createElement("div"); div.className="bonus-note"; div.appendChild(p); earlyBox.appendChild(div);
    }
  } else if (intentMsg){
    if (!intentMsg.querySelector(".bonus-note")){
      const div=document.createElement("div"); div.className="bonus-note"; div.appendChild(p); intentMsg.appendChild(div);
    }
  }
}

/* ---------- Status laden ---------- */
async function refreshStatus(){
  try{
    const r = await fetch(`${CFG.API_BASE}/status?t=${Date.now()}`, { headers:{accept:"application/json"} });
    const j = await r.json();

    STATE.rpc_url   = j?.rpc_url || CFG.RPC;
    STATE.inpi_mint = j?.inpi_mint || CFG.INPI_MINT;
    STATE.usdc_mint = j?.usdc_mint || CFG.USDC_MINT;

    STATE.presale_state = j?.presale_state || "pre";
    STATE.tge_ts        = (j?.tge_ts ?? CFG.TGE_TS_FALLBACK);

    STATE.deposit_ata   = j?.deposit_usdc_ata || CFG.DEPOSIT_USDC_ATA_FALLBACK;
    STATE.deposit_owner = j?.deposit_usdc_owner || null;

    STATE.presale_min_usdc = (typeof j?.presale_min_usdc === "number") ? j.presale_min_usdc : null;
    STATE.presale_max_usdc = (typeof j?.presale_max_usdc === "number") ? j.presale_max_usdc : null;

    STATE.price_with_nft_usdc    = ("price_with_nft_usdc" in (j||{}))    ? (Number(j.price_with_nft_usdc)||null)    : (Number(j?.presale_price_usdc)||null);
    STATE.price_without_nft_usdc = ("price_without_nft_usdc" in (j||{})) ? (Number(j.price_without_nft_usdc)||null) : (Number(j?.public_price_usdc)||null);
    if (STATE.price_with_nft_usdc==null && STATE.price_without_nft_usdc==null){
      STATE.price_without_nft_usdc = CFG.PRICE_WITHOUT_NFT_FALLBACK;
      STATE.price_with_nft_usdc    = CFG.PRICE_WITH_NFT_FALLBACK;
    }

    const ec=j?.early_claim||{};
    STATE.early.enabled = !!ec.enabled;
    STATE.early.flat_usdc = Number(ec.flat_usdc || 1);
    STATE.early.fee_dest_wallet = ec.fee_dest_wallet || STATE.deposit_ata || null;
    STATE.airdrop_bonus_bps = Number(j?.airdrop_bonus_bps ?? STATE.airdrop_bonus_bps);

    STATE.supply_total = Number(j?.supply_total || CFG.SUPPLY_FALLBACK);
    STATE.dist_bps = { ...CFG.DISTR_FALLBACK_BPS, ...{
      dist_presale_bps:        numOr(CFG.DISTR_FALLBACK_BPS.dist_presale_bps, j?.dist_presale_bps),
      dist_dex_liquidity_bps:  numOr(CFG.DISTR_FALLBACK_BPS.dist_dex_liquidity_bps, j?.dist_dex_liquidity_bps),
      dist_staking_bps:        numOr(CFG.DISTR_FALLBACK_BPS.dist_staking_bps, j?.dist_staking_bps),
      dist_ecosystem_bps:      numOr(CFG.DISTR_FALLBACK_BPS.dist_ecosystem_bps, j?.dist_ecosystem_bps),
      dist_treasury_bps:       numOr(CFG.DISTR_FALLBACK_BPS.dist_treasury_bps, j?.dist_treasury_bps),
      dist_team_bps:           numOr(CFG.DISTR_FALLBACK_BPS.dist_team_bps, j?.dist_team_bps),
      dist_airdrop_nft_bps:    numOr(CFG.DISTR_FALLBACK_BPS.dist_airdrop_nft_bps, j?.dist_airdrop_nft_bps),
      dist_buyback_reserve_bps:numOr(CFG.DISTR_FALLBACK_BPS.dist_buyback_reserve_bps, j?.dist_buyback_reserve_bps)
    }};

    if (presaleState) presaleState.textContent = STATE.presale_state;
    if (depositAddrEl) depositAddrEl.textContent = STATE.deposit_ata || "—";
    if (depositSolscanA){
      if (STATE.deposit_ata){ depositSolscanA.href=solscan(STATE.deposit_ata); depositSolscanA.style.display="inline"; }
      else depositSolscanA.style.display="none";
    }
    if (depositOwnerEl) depositOwnerEl.textContent = STATE.deposit_owner || "—";

    updatePriceRow(); updateIntentAvailability(); setBonusNote(); renderTokenomics(STATE.supply_total, STATE.dist_bps);
  } catch (e){
    console.error(e);
    STATE.rpc_url=CFG.RPC; STATE.inpi_mint=CFG.INPI_MINT; STATE.usdc_mint=CFG.USDC_MINT;
    STATE.presale_state="pre"; STATE.tge_ts=CFG.TGE_TS_FALLBACK; STATE.deposit_ata=CFG.DEPOSIT_USDC_ATA_FALLBACK;
    STATE.price_without_nft_usdc=CFG.PRICE_WITHOUT_NFT_FALLBACK; STATE.price_with_nft_usdc=CFG.PRICE_WITH_NFT_FALLBACK;
    STATE.supply_total=CFG.SUPPLY_FALLBACK; STATE.dist_bps={...CFG.DISTR_FALLBACK_BPS};
    if (presaleState) presaleState.textContent="API offline";
    if (depositAddrEl) depositAddrEl.textContent = STATE.deposit_ata || "—";
    if (depositSolscanA){
      if (STATE.deposit_ata){ depositSolscanA.href=solscan(STATE.deposit_ata); depositSolscanA.style.display="inline"; }
      else depositSolscanA.style.display="none";
    }
    if (depositOwnerEl) depositOwnerEl.textContent = "—";
    updatePriceRow(); updateIntentAvailability(); setBonusNote(); renderTokenomics(STATE.supply_total, STATE.dist_bps);
  }
}
function numOr(def, maybe){ const n=Number(maybe); return Number.isFinite(n)? n : def; }

/* ---------- Wallet ---------- */
async function refreshBalances(){
  if (!pubkey) return;
  try{
    const url = `${CFG.API_BASE}/wallet/balances?wallet=${encodeURIComponent(pubkey.toBase58())}&t=${Date.now()}`;
    const r = await fetch(url, { headers:{accept:"application/json"}});
    const j = await r.json();

    const usdc = Number(j?.usdc?.uiAmount ?? NaN);
    const inpi = Number(j?.inpi?.uiAmount ?? NaN);
    if (usdcBal) usdcBal.textContent = fmt(usdc,2);
    if (inpiBal) inpiBal.textContent = fmt(inpi,0);

    STATE.gate_ok = !!j?.gate_ok;
    updatePriceRow(); updateIntentAvailability();
  } catch(e){
    console.error(e);
    if (usdcBal) usdcBal.textContent="–";
    if (inpiBal) inpiBal.textContent="–";
    STATE.gate_ok=false;
    updatePriceRow(); updateIntentAvailability();
  }
}
async function refreshClaimStatus(){
  if (!pubkey) return;
  try{
    const r = await fetch(`${CFG.API_BASE}/claim/status?wallet=${pubkey.toBase58()}&t=${Date.now()}`, { headers:{accept:"application/json"} });
    const st = await r.json();

    const pending = Number(st?.pending_inpi || 0);
    STATE.claimable_inpi = pending;
    const earlyExpected = $("#earlyExpected");
    if (earlyExpected) earlyExpected.textContent = fmt(pending,0) + " INPI";
  } catch(e){
    console.error(e);
    STATE.claimable_inpi = 0;
    const earlyExpected = $("#earlyExpected");
    if (earlyExpected) earlyExpected.textContent = "–";
  }
}
function tickTGE(){
  if (!tgeTime) return;
  if (!STATE.tge_ts){ tgeTime.textContent="tbd"; return; }
  const secs=Math.max(0, STATE.tge_ts - nowSec());
  const d=Math.floor(secs/86400), h=Math.floor((secs%86400)/3600), m=Math.floor((secs%3600)/60), s=secs%60;
  tgeTime.textContent = `${d}d ${h}h ${m}m ${s}s`;
}
function onConnected(publicKey){
  pubkey = publicKey;
  if (walletAddr) walletAddr.textContent = publicKey.toBase58();
  provider?.on?.("accountChanged", (pk)=>{ if (!pk) { onDisconnected(); return; } onConnected(pk); });
  provider?.on?.("disconnect", onDisconnected);
  refreshBalances().catch(()=>{});
  refreshClaimStatus().catch(()=>{});
  clearInterval(POLL); POLL=setInterval(()=>{ refreshBalances(); refreshClaimStatus(); }, 30000);
}
function onDisconnected(){
  pubkey=null; if (walletAddr) walletAddr.textContent="—";
  if (usdcBal) usdcBal.textContent="—"; if (inpiBal) inpiBal.textContent="—";
  STATE.gate_ok=false; STATE.claimable_inpi=0;
  const earlyExpected=$("#earlyExpected"); if (earlyExpected) earlyExpected.textContent="–";
  updatePriceRow(); updateIntentAvailability(); clearInterval(POLL);
}

/* ---------- Inputs ---------- */
if (inpAmount && expectedInpi){
  inpAmount.addEventListener("input", ()=>{
    const usdc=Number(inpAmount.value||"0"); expectedInpi.textContent=calcExpectedInpi(usdc);
  });
}
if (btnHowTo){
  btnHowTo.addEventListener("click",()=> {
    alert(`Kurzanleitung:
1) Phantom verbinden
2) Intent senden → QR oder Deep-Link für USDC-Zahlung
3) Optional: Early-Claim (1 USDC)`);
  });
}

/* ---------- PRESALE INTENT ---------- */
let inFlight=false;
if (btnPresaleIntent){
  btnPresaleIntent.addEventListener("click", async ()=>{
    if(inFlight) return;
    if(!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
    if (STATE.presale_state==="closed") return alert("Presale ist geschlossen.");

    const usdc = Number(inpAmount?.value || "0");
    if (!usdc||usdc<=0) return alert("Bitte gültigen USDC-Betrag eingeben.");
    if (STATE.presale_min_usdc!=null && usdc<STATE.presale_min_usdc) return alert(`Mindestens ${STATE.presale_min_usdc} USDC.`);
    if (STATE.presale_max_usdc!=null && usdc>STATE.presale_max_usdc) return alert(`Maximal ${STATE.presale_max_usdc} USDC.`);

    inFlight=true; if (intentMsg) intentMsg.textContent="Prüfe Caps & registriere Intent …";
    try{
      // optional signMessage
      let sig_b58=null, msg_str=null;
      if (provider?.signMessage){
        msg_str = `INPI Presale Intent\nwallet=${pubkey.toBase58()}\namount_usdc=${usdc}\nts=${Date.now()}`;
        const enc=new TextEncoder().encode(msg_str);
        let signed = await provider.signMessage(enc,"utf8").catch(async()=>{ try{ return await provider.signMessage(enc);}catch{ return null; }});
        const signatureBytes = (signed && signed.signature)? signed.signature : signed;
        if (signatureBytes?.length) sig_b58 = bs58Encode(signatureBytes);
      }

      const r = await fetch(`${CFG.API_BASE}/presale/intent?t=${Date.now()}`, {
        method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
        body: JSON.stringify({ wallet: pubkey.toBase58(), amount_usdc: usdc, sig_b58, msg_str })
      });
      const j = await r.json().catch(()=>null);
      if (!r.ok || !j?.ok) throw new Error(j?.error || j?.detail || "Intent fehlgeschlagen");

      // QR + Deep-Links für die USDC-Zahlung
      const contrib = j?.qr_contribute || {};
      lastDeepLinks.contribute = contrib;
      const qrUrl = contrib.qr_url || j?.qr_url || null;

      if (payArea) payArea.style.display="block";
      if (qrContrib && qrUrl){ qrContrib.src = qrUrl; qrContrib.style.display="block"; }
      if (aPhantom && contrib.phantom_universal_url){ aPhantom.href = contrib.phantom_universal_url; aPhantom.style.display="inline-block"; }
      if (aSolflare && contrib.solflare_universal_url){ aSolflare.href = contrib.solflare_universal_url; aSolflare.style.display="inline-block"; }

      if (intentMsg){
        intentMsg.textContent="";
        const p1=document.createElement("p"); p1.textContent=`✅ Intent registriert. Bitte ${usdc} USDC via QR/Link senden (SPL-USDC).`;
        const p2=document.createElement("p"); p2.textContent=`Optional: Nutze unten den Early-Claim (1 USDC Fee) für sofortige Gutschrift.`;
        intentMsg.appendChild(p1); intentMsg.appendChild(p2); setBonusNote();
      }

      await refreshStatus();
    }catch(e){
      console.error(e); alert(`Intent fehlgeschlagen:\n${e?.message||e}`);
    }finally{ inFlight=false; }
  });
}

/* ---------- Early Claim ---------- */
async function startEarlyFlow(){
  if (!pubkey) return alert("Bitte zuerst Wallet verbinden.");
  if (!STATE.early.enabled) return alert("Early-Claim ist derzeit deaktiviert.");
  try{
    earlyArea?.classList?.remove("hidden");
    if (earlyMsg) earlyMsg.textContent="Erzeuge Solana-Pay Link …";
    const r = await fetch(`${CFG.API_BASE}/claim/early-intent`, {
      method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58() })
    });
    const j = await r.json().catch(()=>null);
    if (!r.ok || !j?.ok) throw new Error(j?.error || "Early-Intent fehlgeschlagen");

    const qrUrl = j.qr_url || null;
    lastDeepLinks.claimNow = {
      solana_pay_url: j.solana_pay_url || null,
      phantom_universal_url: j.solana_pay_url ? `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(j.solana_pay_url)}` : null,
      solflare_universal_url: j.solana_pay_url ? `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(j.solana_pay_url)}` : null
    };

    if (qrClaimNow && qrUrl) { qrClaimNow.src = qrUrl; qrClaimNow.style.display="block"; }
    if (earlyMsg) earlyMsg.textContent = `Sende ${STATE.early.flat_usdc} USDC (QR oder Link). Danach unten die Transaktions-Signatur eintragen und bestätigen.`;
  }catch(e){ console.error(e); alert(e?.message||e); }
}
async function confirmEarlyFee(){
  if (!pubkey) return alert("Wallet verbinden.");
  const sig=(earlySig?.value||"").trim();
  if (!sig) return alert("Bitte die Transaktions-Signatur der Fee-Zahlung eintragen.");
  try{
    if (earlyMsg) earlyMsg.textContent="Prüfe Zahlung & queued Claim …";
    const r = await fetch(`${CFG.API_BASE}/claim/confirm`, {
      method:"POST", headers:{ "content-type":"application/json", accept:"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58(), fee_signature: sig })
    });
    const j = await r.json().catch(()=>null);
    if (!r.ok || !j?.ok) throw new Error(j?.error || "Confirm fehlgeschlagen");
    if (earlyMsg) earlyMsg.textContent = `✅ Claim eingereiht (Job: ${j.job_id || "n/a"}).`;
    await refreshClaimStatus();
  }catch(e){ console.error(e); alert(e?.message||e); if (earlyMsg) earlyMsg.textContent="Fehler bei der Bestätigung."; }
}

/* ---------- Base58 (encode) ---------- */
const B58_ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58Encode(bytes){
  if (!(bytes&&bytes.length)) return "";
  let zeros=0; while(zeros<bytes.length && bytes[zeros]===0) zeros++;
  let n=0n; for (const b of bytes) n = (n<<8n) + BigInt(b);
  let out=""; while(n>0n){ const rem=Number(n%58n); out = B58_ALPH[rem]+out; n = n/58n; }
  for (let i=0;i<zeros;i++) out="1"+out;
  return out || "1".repeat(zeros);
}

/* ---------- Boot ---------- */
window.addEventListener("DOMContentLoaded", ()=>{ init().catch(console.error); });