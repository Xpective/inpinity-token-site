/* ===========================================
   Inpinity Token – Frontend (Phantom-first)
   Pfad: /public/token/app.js
   =========================================== */

/* ==================== KONFIG ==================== */
const CFG = {
  RPC: "https://inpinity.online/rpc",
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC4wEGGkZwyTDt1v",
  API_BASE: "https://inpinity.online/api/token",

  PRICE_WITH_NFT: 0.003141,
  PRICE_WITHOUT_NFT: 0.03141,

  DEPOSIT_USDC_ATA_FALLBACK: "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
  TGE_TS_FALLBACK: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
};

/* ================ SOLANA / PHANTOM ================ */
const { Connection } = solanaWeb3;
const $ = (sel) => document.querySelector(sel);
const short = (a) => (a?.slice(0, 4) + "…" + a?.slice(-4));
function fmt(n, d = 2) { if (n == null || isNaN(n)) return "–"; return Number(n).toLocaleString("de-DE",{maximumFractionDigits:d}); }
function solscan(addr){ return `https://solscan.io/account/${addr}`; }
function nowSec(){ return Math.floor(Date.now()/1000); }

// UI-Refs
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

// Pay-Area (Presale)
const payArea = $("#payArea");
const qrImg = $("#inpi-qr");
const btnPhantom = $("#btn-phantom");
const btnSolflare = $("#btn-solflare");
const btnSolpay = $("#btn-solpay");

// EARLY CLAIM UI ($1 Fee)
const earlyBox = $("#earlyBox");
const btnEarly = $("#btnEarlyClaim");
const earlyArea = $("#earlyArea");
const earlyMsg = $("#earlyMsg");
const earlyQR = $("#early-qr");
const btnPhantomEarly  = $("#btn-phantom-early");
const btnSolflareEarly = $("#btn-solflare-early");
const btnSolpayEarly   = $("#btn-solpay-early");
const earlyExpect = $("#earlyExpected");
const earlySig = $("#earlySig");
const btnEarlyConfirm = $("#btnEarlyConfirm");

let gateBadge = document.getElementById("gateBadge");
if (!gateBadge && p0 && p0.parentElement) {
  gateBadge = document.createElement("span");
  gateBadge.id = "gateBadge";
  gateBadge.style.marginLeft = ".5rem";
  gateBadge.className = "muted";
  p0.parentElement.appendChild(gateBadge);
}

let connection = null;
let currentRpcUrl = null;
let provider = null; // Phantom
let pubkey = null;
let POLL = null;

/* ---------- State ---------- */
const STATE = {
  rpc_url: null,
  inpi_mint: null,
  usdc_mint: null,

  presale_state: "pre",
  tge_ts: null,
  deposit_owner: null,
  deposit_ata: null,

  presale_min_usdc: null,
  presale_max_usdc: null,

  price_with_nft_usdc: CFG.PRICE_WITH_NFT,
  price_without_nft_usdc: CFG.PRICE_WITHOUT_NFT,

  gate_ok: false,

  // Early-Claim ($1 USDC Fee)
  early: { enabled:false, flat_usdc:1, fee_dest_wallet:null },

  // Claimbar
  claimable_inpi: 0
};

/* ---------- Preis/Erwartung ---------- */
function currentPriceUSDC() {
  return STATE.gate_ok ? STATE.price_with_nft_usdc : STATE.price_without_nft_usdc;
}
function calcExpectedInpi(usdc) {
  if (!usdc || usdc <= 0) return "–";
  const price = currentPriceUSDC();
  const tokens = usdc / price;
  return fmt(tokens, 0) + " INPI";
}
function updatePriceRow() {
  if (!p0) return;
  const w = STATE.price_with_nft_usdc;
  const wo = STATE.price_without_nft_usdc;
  const active = currentPriceUSDC();
  const badge = STATE.gate_ok ? "NFT ✓" : "NFT ✗";
  p0.textContent = `mit NFT: ${Number(w).toFixed(6)} USDC • ohne NFT: ${Number(wo).toFixed(6)} USDC • dein aktiv: ${Number(active).toFixed(6)} USDC`;
  if (gateBadge) gateBadge.textContent = `(${badge})`;
}

/* ==================== INIT ==================== */
async function init() {
  await refreshStatus();

  if (!STATE.rpc_url) STATE.rpc_url = CFG.RPC;
  if (!connection || currentRpcUrl !== STATE.rpc_url) {
    connection = new Connection(STATE.rpc_url, "confirmed");
    currentRpcUrl = STATE.rpc_url;
  }

  updatePriceRow();

  if (STATE.presale_min_usdc != null) inpAmount.min = String(STATE.presale_min_usdc);
  if (STATE.presale_max_usdc != null) inpAmount.max = String(STATE.presale_max_usdc);

  if (window.solana?.isPhantom) {
    provider = window.solana;
    try {
      await provider.connect({ onlyIfTrusted: true })
        .then(({ publicKey }) => onConnected(publicKey)).catch(()=>{});
    } catch {}
    btnConnect.disabled = false;
    btnConnect.textContent = "Verbinden";
    btnConnect.onclick = async () => {
      try {
        const { publicKey } = await provider.connect();
        onConnected(publicKey);
      } catch (e) { console.error(e); alert("Wallet-Verbindung abgebrochen."); }
    };
  } else {
    btnConnect.textContent = "Phantom installieren";
    btnConnect.onclick = () => window.open("https://phantom.app", "_blank");
  }

  tickTGE();
  setInterval(tickTGE, 1000);

  expectedInpi.textContent = calcExpectedInpi(Number(inpAmount.value || "0"));

  earlyBox.style.display = STATE.early.enabled ? "block" : "none";
  btnEarly.onclick = startEarlyFlow;
  btnEarlyConfirm.onclick = confirmEarlyFee;
}

/* ---------- Status laden ---------- */
async function refreshStatus(){
  try {
    const r = await fetch(`${CFG.API_BASE}/status`, { headers: { "accept":"application/json" }});
    const j = await r.json().catch(()=> ({}));

    STATE.rpc_url       = j?.rpc_url || CFG.RPC;
    STATE.inpi_mint     = j?.inpi_mint || CFG.INPI_MINT;
    STATE.usdc_mint     = j?.usdc_mint || CFG.USDC_MINT;

    STATE.presale_state = j?.presale_state || "pre";
    STATE.tge_ts        = j?.tge_ts || CFG.TGE_TS_FALLBACK;
    STATE.deposit_owner = j?.deposit_usdc_owner || null;
    STATE.deposit_ata   = j?.deposit_usdc_ata || CFG.DEPOSIT_USDC_ATA_FALLBACK;

    STATE.presale_min_usdc = j?.presale_min_usdc ?? null;
    STATE.presale_max_usdc = j?.presale_max_usdc ?? null;

    const w = Number(j?.price_with_nft_usdc);
    const wo = Number(j?.price_without_nft_usdc);
    STATE.price_with_nft_usdc = Number.isFinite(w) && w > 0 ? w : CFG.PRICE_WITH_NFT;
    STATE.price_without_nft_usdc = Number.isFinite(wo) && wo > 0 ? wo : CFG.PRICE_WITHOUT_NFT;

    // Early aus status.legacy/neu
    const ec = j?.early_claim || {};
    STATE.early.enabled = !!ec.enabled;
    STATE.early.flat_usdc = Number(ec.flat_usdc || 1);
    STATE.early.fee_dest_wallet = ec.fee_dest_wallet || STATE.deposit_ata || null;

    presaleState.textContent = STATE.presale_state;
    updatePriceRow();
  } catch (e) {
    console.error(e);

    STATE.rpc_url       = CFG.RPC;
    STATE.inpi_mint     = CFG.INPI_MINT;
    STATE.usdc_mint     = CFG.USDC_MINT;

    STATE.presale_state = "pre";
    STATE.tge_ts        = CFG.TGE_TS_FALLBACK;
    STATE.deposit_owner = null;
    STATE.deposit_ata   = CFG.DEPOSIT_USDC_ATA_FALLBACK;

    presaleState.textContent = "API offline";
    updatePriceRow();
  }

  if (depositAddrEl) {
    depositAddrEl.textContent = STATE.deposit_ata || "—";
    if (depositSolscanA && STATE.deposit_ata) {
      depositSolscanA.href = solscan(STATE.deposit_ata);
      depositSolscanA.style.display = "inline";
    } else if (depositSolscanA) depositSolscanA.style.display = "none";
  }
  earlyBox.style.display = STATE.early.enabled ? "block" : "none";
}

/* ---------- Claim-Status (claimbar) ---------- */
async function refreshClaimStatus(){
  if (!pubkey) return;
  try{
    const st = await fetch(`${CFG.API_BASE}/claim/status?wallet=${pubkey.toBase58()}`).then(r=>r.json());
    const pending = Number(st?.pending_inpi || 0);
    STATE.claimable_inpi = pending;
    earlyExpect.textContent = fmt(pending, 0) + " INPI";
  }catch(e){
    console.error(e);
    STATE.claimable_inpi = 0;
    earlyExpect.textContent = "–";
  }
}

function tickTGE(){
  if (!STATE.tge_ts) { tgeTime.textContent = "tbd"; return; }
  const secs = Math.max(0, STATE.tge_ts - nowSec());
  const d = Math.floor(secs/86400), h = Math.floor((secs%86400)/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  tgeTime.textContent = `${d}d ${h}h ${m}m ${s}s`;
}

/* ---------- Wallet Connect ---------- */
function onConnected(publicKey){
  pubkey = publicKey;
  walletAddr.textContent = publicKey.toBase58();
  provider?.on?.("accountChanged", (pk) => { if (!pk) { onDisconnected(); return; } onConnected(pk); });
  provider?.on?.("disconnect", onDisconnected);

  refreshBalances().catch(()=>{});
  refreshClaimStatus().catch(()=>{});
  clearInterval(POLL);
  POLL = setInterval(() => { refreshBalances(); refreshClaimStatus(); }, 30000);
}
function onDisconnected(){
  pubkey = null;
  walletAddr.textContent = "—";
  usdcBal.textContent = "—";
  inpiBal.textContent = "—";
  STATE.gate_ok = false;
  STATE.claimable_inpi = 0;
  earlyExpect.textContent = "–";
  updatePriceRow();
  clearInterval(POLL);
}

/* ---------- UI ---------- */
inpAmount.addEventListener("input", () => {
  const usdc = Number(inpAmount.value || "0");
  expectedInpi.textContent = calcExpectedInpi(usdc);
});

btnHowTo.addEventListener("click", () => {
  alert(
`Kurzanleitung:
1) Phantom verbinden
2) Intent senden (wir prüfen Cap & registrieren dich)
3) USDC mit Solana Pay (QR/Buttons) an die Deposit-Adresse senden
4) Early-Claim: $1 USDC Fee zahlen → INPI werden gutgeschrieben (oder später normal claimen).`
  );
});

/* ---------- Presale Intent ---------- */
let inFlight = false;
btnPresaleIntent.addEventListener("click", async () => {
  if (inFlight) return;
  if (!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
  const usdc = Number(inpAmount.value || "0");
  if (!usdc || usdc <= 0) return alert("Bitte gültigen USDC-Betrag eingeben.");

  if (STATE.presale_min_usdc != null && usdc < STATE.presale_min_usdc) {
    return alert(`Mindestens ${STATE.presale_min_usdc} USDC.`);
  }
  if (STATE.presale_max_usdc != null && usdc > STATE.presale_max_usdc) {
    return alert(`Maximal ${STATE.presale_max_usdc} USDC.`);
  }

  inFlight = true;
  intentMsg.textContent = "Prüfe Caps & registriere Intent …";
  try {
    let sig_b58 = null, msg_str = null;
    if (provider.signMessage) {
      msg_str = `INPI Presale Intent\nwallet=${pubkey.toBase58()}\namount_usdc=${usdc}\nts=${Date.now()}`;
      const enc = new TextEncoder().encode(msg_str);
      const { signature } = await provider.signMessage(enc, "utf8");
      sig_b58 = bs58Encode(signature);
    }

    const r = await fetch(`${CFG.API_BASE}/presale/intent?format=json`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept":"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58(), amount_usdc: usdc, sig_b58, msg_str })
    });

    const raw = await r.text();
    if (!r.ok) throw new Error(raw || "Intent fehlgeschlagen");

    let j = null;
    try { j = JSON.parse(raw); } catch {}

    if (!j) {
      const m = raw.match(/solana:[^\s]+/i);
      const sp = m ? m[0] : null;
      j = {
        ok: true,
        deposit_usdc_ata: STATE.deposit_ata,
        solana_pay_url: sp,
        phantom_universal_url: sp ? `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(sp)}` : null,
        solflare_universal_url: sp ? `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(sp)}` : null,
        qr_url: sp ? `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(sp)}` : null
      };
    }

    payArea.style.display = "block";
    if (j.qr_url) { qrImg.src = j.qr_url; qrImg.style.display = "block"; }
    if (j.phantom_universal_url) { btnPhantom.href = j.phantom_universal_url; btnPhantom.style.pointerEvents = "auto"; }
    if (j.solflare_universal_url){ btnSolflare.href = j.solflare_universal_url; btnSolflare.style.pointerEvents = "auto"; }
    if (j.solana_pay_url) {
      btnSolpay.href = j.solana_pay_url;
      btnSolpay.onclick = () => { window.location.href = j.solana_pay_url; };
      btnSolpay.style.pointerEvents = "auto";
    }

    intentMsg.textContent = "";
    const p = document.createElement("p");
    p.textContent = `✅ Intent registriert. Bitte ${usdc} USDC mit Solana Pay senden.`;
    intentMsg.appendChild(p);

    await refreshStatus();
  } catch (e) {
    console.error(e);
    alert(`Intent fehlgeschlagen:\n${e?.message || e}`);
  } finally {
    inFlight = false;
  }
});

/* ---------- EARLY CLAIM ($1 Fee) ---------- */
async function startEarlyFlow(){
  if (!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
  if (!STATE.early.enabled) return alert("Early-Claim ist aktuell deaktiviert.");

  await refreshClaimStatus();
  const pending = Number(STATE.claimable_inpi || 0);
  if (!pending) return alert("Kein vorgekaufter INPI-Betrag zum Early-Claim gefunden.");

  earlyExpect.textContent = fmt(pending, 0) + " INPI";

  try {
    // Hole QR/Links vom Server (Fee-Ziel + 1 USDC)
    const r = await fetch(`${CFG.API_BASE}/claim/early-intent`, {
      method:"POST",
      headers:{ "content-type":"application/json", "accept":"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58() })
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) throw new Error(j?.error || "early_intent_failed");

    earlyArea.style.display = "block";
    if (j.qr_url) { earlyQR.src = j.qr_url; earlyQR.style.display = "block"; }
    if (j.phantom_universal_url) { btnPhantomEarly.href = j.phantom_universal_url; btnPhantomEarly.style.pointerEvents = "auto"; }
    if (j.solflare_universal_url){ btnSolflareEarly.href = j.solflare_universal_url; btnSolflareEarly.style.pointerEvents = "auto"; }
    if (j.solana_pay_url) {
      btnSolpayEarly.href = j.solana_pay_url;
      btnSolpayEarly.onclick = () => { window.location.href = j.solana_pay_url; };
      btnSolpayEarly.style.pointerEvents = "auto";
    }

    earlyMsg.textContent = `Zahle jetzt ${STATE.early.flat_usdc} USDC (Fee). Nach Bestätigung schreiben wir dir ${fmt(pending,0)} INPI gut.`;
  } catch (e) {
    console.error(e);
    alert(`Early-Claim fehlgeschlagen:\n${e?.message || e}`);
  }
}

// Fee-Tx-Signatur bestätigen → Worker prüft & queued Claim
async function confirmEarlyFee(){
  const sig = (earlySig.value || "").trim();
  if (!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
  if (!sig) return alert("Bitte Fee-Transaktionssignatur einfügen.");

  try{
    const r = await fetch(`${CFG.API_BASE}/claim/confirm`, {
      method:"POST",
      headers:{ "content-type":"application/json", "accept":"application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58(), fee_signature: sig })
    });
    const j = await r.json();
    if (!r.ok || !j?.ok) throw new Error(j?.error || "confirm_failed");

    alert("Danke! Fee bestätigt. Dein Early-Claim wurde eingereiht.");
    earlySig.value = "";
    await refreshClaimStatus();
  }catch(e){
    console.error(e);
    alert(`Bestätigung fehlgeschlagen:\n${e?.message || e}`);
  }
}

/* ---------- Wallet-Balances ---------- */
async function refreshBalances() {
  if (!pubkey) return;
  try {
    const url = `${CFG.API_BASE}/wallet/balances?wallet=${pubkey.toBase58()}`;
    const j = await fetch(url).then(r => r.json());
    const u = Number(j?.usdc?.uiAmount ?? 0);
    const i = Number(j?.inpi?.uiAmount ?? 0);

    STATE.gate_ok = !!j?.gate_ok;
    updatePriceRow();

    usdcBal.textContent = fmt(u, 6) + " USDC";
    inpiBal.textContent = fmt(i, 2) + " INPI";

    const usdcIn = Number(inpAmount.value || "0");
    expectedInpi.textContent = calcExpectedInpi(usdcIn);
  } catch (e) {
    console.error(e);
    usdcBal.textContent = "—";
    inpiBal.textContent = "—";
  }
}

/* ---------- bs58 Helper ---------- */
function bs58Encode(bytes){
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE = BigInt(58);
  let x = 0n; for (const b of bytes) x = (x << 8n) + BigInt(b);
  let out = ""; while (x > 0n) { const mod = x % BASE; out = alphabet[Number(mod)] + out; x = x / BASE; }
  let zeros = 0; for (const b of bytes) { if (b === 0) zeros++; else break; }
  return "1".repeat(zeros) + out;
}

window.addEventListener("load", init);