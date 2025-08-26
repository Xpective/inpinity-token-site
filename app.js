/* ===========================================
   Inpinity Token – Frontend (Phantom-first)
   Pfad: /public/token/app.js
   =========================================== */

/* ==================== KONFIG ==================== */
const CFG = {
  RPC: "https://inpinity.online/rpc",
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  API_BASE: "https://inpinity.online/api/token",

  P0_USDC: 0.00031415,           // Fallback-Preis pro 1 INPI
  PRESALE_DISCOUNT: 0.10,        // Fallback-Rabatt

  DEPOSIT_USDC_ATA_FALLBACK: "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
  TGE_TS_FALLBACK: Math.floor(Date.now()/1000) + 60*60*24*90
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

// Pay-Area
const payArea = $("#payArea");
const qrImg = $("#inpi-qr");
const btnPhantom = $("#btn-phantom");
const btnSolflare = $("#btn-solflare");
const btnSolpay = $("#btn-solpay");

let connection = null;
let currentRpcUrl = null;
let provider = null; // Phantom
let pubkey = null;
let POLL = null;

const STATE = {
  rpc_url: null,
  inpi_mint: null,
  usdc_mint: null,
  price_presale: null,
  price_public: null,
  presale_state: "pre",
  tge_ts: null,
  deposit_ata: null,
  presale_min_usdc: null,
  presale_max_usdc: null
};

/* ---------- Preis/Erwartung ---------- */
function currentPriceUSDC() {
  if (STATE.presale_state === "pre" && STATE.price_presale) return STATE.price_presale;
  if (STATE.presale_state === "public" && STATE.price_public) return STATE.price_public;
  return CFG.P0_USDC * (1 - CFG.PRESALE_DISCOUNT);
}
function calcExpectedInpi(usdc) {
  if (!usdc || usdc <= 0) return "–";
  const price = currentPriceUSDC();   // USDC pro 1 INPI
  const tokens = usdc / price;
  return fmt(tokens, 0) + " INPI";
}

/* ==================== INIT ==================== */
async function init() {
  await refreshStatus();

  if (!STATE.rpc_url) STATE.rpc_url = CFG.RPC;
  if (!connection || currentRpcUrl !== STATE.rpc_url) {
    connection = new Connection(STATE.rpc_url, "confirmed");
    currentRpcUrl = STATE.rpc_url;
  }

  p0.textContent = `${Number(STATE.price_presale ?? (CFG.P0_USDC*(1-CFG.PRESALE_DISCOUNT))).toFixed(6)} USDC`;

  // Min/Max vom Server auf Input setzen
  if (STATE.presale_min_usdc != null) inpAmount.min = String(STATE.presale_min_usdc);
  if (STATE.presale_max_usdc != null) inpAmount.max = String(STATE.presale_max_usdc);

  if (window.solana?.isPhantom) {
    provider = window.solana;
    try {
      await provider.connect({ onlyIfTrusted: true })
        .then(({ publicKey }) => onConnected(publicKey));
    } catch {}
    btnConnect.disabled = false;
    btnConnect.textContent = "Verbinden";
  } else {
    btnConnect.textContent = "Phantom installieren";
    btnConnect.onclick = () => window.open("https://phantom.app", "_blank");
  }

  tickTGE();
  setInterval(tickTGE, 1000);

  // Erwartung initial
  expectedInpi.textContent = calcExpectedInpi(Number(inpAmount.value || "0"));
}

async function refreshStatus(){
  try {
    const r = await fetch(`${CFG.API_BASE}/status`, { headers: { "accept":"application/json" }});
    const j = await r.json().catch(()=> ({}));

    STATE.rpc_url       = j?.rpc_url || CFG.RPC;
    STATE.inpi_mint     = j?.inpi_mint || CFG.INPI_MINT;
    STATE.usdc_mint     = j?.usdc_mint || CFG.USDC_MINT;

    STATE.presale_state = j?.presale_state || "pre";
    STATE.tge_ts        = j?.tge_ts || CFG.TGE_TS_FALLBACK; // Sekunden!
    STATE.price_presale = j?.presale_price_usdc ?? null;
    STATE.price_public  = j?.public_price_usdc ?? null;
    STATE.deposit_ata   = j?.deposit_usdc_ata || CFG.DEPOSIT_USDC_ATA_FALLBACK;
    STATE.presale_min_usdc = j?.presale_min_usdc ?? null;
    STATE.presale_max_usdc = j?.presale_max_usdc ?? null;

  } catch (e) {
    console.error(e);
    STATE.rpc_url       = CFG.RPC;
    STATE.inpi_mint     = CFG.INPI_MINT;
    STATE.usdc_mint     = CFG.USDC_MINT;

    STATE.presale_state = "pre";
    STATE.tge_ts        = CFG.TGE_TS_FALLBACK;
    STATE.price_presale = null;
    STATE.price_public  = null;
    STATE.deposit_ata   = CFG.DEPOSIT_USDC_ATA_FALLBACK;
    presaleState.textContent = "API offline";
  }

  // UI aktualisieren
  if (depositAddrEl) {
    depositAddrEl.textContent = STATE.deposit_ata || "—";
    if (depositSolscanA && STATE.deposit_ata) {
      depositSolscanA.href = solscan(STATE.deposit_ata);
      depositSolscanA.style.display = "inline";
    } else if (depositSolscanA) depositSolscanA.style.display = "none";
  }
  presaleState.textContent = STATE.presale_state;
  p0.textContent = `${Number(STATE.price_presale ?? (CFG.P0_USDC*(1-CFG.PRESALE_DISCOUNT))).toFixed(6)} USDC`;
}

function tickTGE(){
  if (!STATE.tge_ts) { tgeTime.textContent = "tbd"; return; }
  const secs = Math.max(0, STATE.tge_ts - nowSec());
  const d = Math.floor(secs/86400), h = Math.floor((secs%86400)/3600), m = Math.floor((secs%3600)/60), s = secs%60;
  tgeTime.textContent = `${d}d ${h}h ${m}m ${s}s`;
}

/* ---------- Wallet Connect ---------- */
btnConnect.addEventListener("click", async () => {
  if (!window.solana?.isPhantom) return;
  try {
    const { publicKey } = await window.solana.connect();
    onConnected(publicKey);
  } catch (e) {
    console.error(e);
    alert("Wallet-Verbindung abgebrochen.");
  }
});

function onConnected(publicKey){
  pubkey = publicKey;
  walletAddr.textContent = publicKey.toBase58();
  provider?.on?.("accountChanged", (pk) => { if (!pk) { onDisconnected(); return; } onConnected(pk); });
  provider?.on?.("disconnect", onDisconnected);

  refreshBalances();
  clearInterval(POLL);
  POLL = setInterval(refreshBalances, 30000);
}
function onDisconnected(){
  pubkey = null;
  walletAddr.textContent = "—";
  usdcBal.textContent = "—";
  inpiBal.textContent = "—";
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
4) Nach TGE claimst du deine INPI`
  );
});

/* ---------- Presale Intent ---------- */
let inFlight = false;
btnPresaleIntent.addEventListener("click", async () => {
  if (inFlight) return;
  if (!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
  const usdc = Number(inpAmount.value || "0");
  if (!usdc || usdc <= 0) return alert("Bitte gültigen USDC-Betrag eingeben.");

  // Min/Max local check
  if (STATE.presale_min_usdc != null && usdc < STATE.presale_min_usdc) {
    return alert(`Mindestens ${STATE.presale_min_usdc} USDC.`);
  }
  if (STATE.presale_max_usdc != null && usdc > STATE.presale_max_usdc) {
    return alert(`Maximal ${STATE.presale_max_usdc} USDC.`);
  }

  inFlight = true;
  intentMsg.textContent = "Prüfe Caps & registriere Intent …";
  try {
    // optionale Nachricht signieren
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

    // --- robust: erst Text lesen, dann JSON versuchen ---
    const raw = await r.text();
    if (!r.ok) throw new Error(raw || "Intent fehlgeschlagen");

    let j = null;
    try { j = JSON.parse(raw); } catch {}

    // Fallback: Server hat Text-Antwort → Solana-Pay-Link extrahieren
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

    // Ergebnisbereich sichtbar machen
    payArea.style.display = "block";

    // QR + Links
    if (j.qr_url) {
      qrImg.src = j.qr_url;
      qrImg.style.display = "block";
    }
    if (j.phantom_universal_url) { btnPhantom.href = j.phantom_universal_url; btnPhantom.style.pointerEvents = "auto"; }
    if (j.solflare_universal_url){ btnSolflare.href = j.solflare_universal_url; btnSolflare.style.pointerEvents = "auto"; }
    if (j.solana_pay_url) {
      btnSolpay.href = j.solana_pay_url;
      btnSolpay.onclick = () => { window.location.href = j.solana_pay_url; };
      btnSolpay.style.pointerEvents = "auto";
    }

    // Textinfo/Copy
    intentMsg.textContent = "";
    const p = document.createElement("p");
    p.textContent = `✅ Intent registriert. Bitte ${usdc} USDC an ${j.deposit_usdc_ata} senden (USDC SPL).`;
    intentMsg.appendChild(p);

    const small = document.createElement("small");
    small.innerText = `Deposit-Adresse (USDC): ${j.deposit_usdc_ata} `;
    const a = document.createElement("a");
    a.href = solscan(j.deposit_usdc_ata); a.target="_blank"; a.rel="noopener"; a.textContent = `(Solscan)`;
    small.appendChild(a);

    const copyBtn = document.createElement("button");
    copyBtn.className = "secondary";
    copyBtn.textContent = "Kopieren";
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(j.deposit_usdc_ata); copyBtn.textContent = "Kopiert ✓"; setTimeout(()=>copyBtn.textContent="Kopieren",1000); } catch {}
    };
    small.appendChild(document.createTextNode(" "));
    small.appendChild(copyBtn);
    intentMsg.appendChild(small);

    await refreshStatus(); // falls Preise/Phase live geändert
  } catch (e) {
    console.error(e);
    alert(`Intent fehlgeschlagen:\n${e?.message || e}`);
  } finally {
    inFlight = false;
  }
});

/* ---------- Wallet-Balances über API ---------- */
async function refreshBalances() {
  if (!pubkey) return;
  try {
    const url = `${CFG.API_BASE}/wallet/balances?wallet=${pubkey.toBase58()}`;
    const j = await fetch(url).then(r => r.json());
    const u = Number(j?.usdc?.uiAmount ?? 0);
    const i = Number(j?.inpi?.uiAmount ?? 0);
    usdcBal.textContent = fmt(u, 6) + " USDC";
    inpiBal.textContent = fmt(i, 2) + " INPI";
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