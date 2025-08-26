/* ===========================================
   Inpinity Token – Frontend (Phantom-only)
   Pfad: /public/token/app.js
   =========================================== */

/* ==================== KONFIG ==================== */
const CFG = {
  RPC: "https://inpinity.online/rpc",
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  API_BASE: "https://inpinity.online/api/token",

  P0_USDC: 0.00031415,           // Fallback-Preis
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
  deposit_ata: null
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

  if (window.solana?.isPhantom) {
    provider = window.solana;
    try {
      await provider.connect({ onlyIfTrusted: true })
        .then(({ publicKey }) => onConnected(publicKey));
    } catch {}
    btnConnect.disabled = false;
  } else {
    btnConnect.textContent = "Phantom installieren";
    btnConnect.onclick = () => window.open("https://phantom.app", "_blank");
  }

  tickTGE();
  setInterval(tickTGE, 1000);
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
3) USDC an die angezeigte Presale-Adresse senden
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

  inFlight = true;
  intentMsg.textContent = "Prüfe Caps & registriere Intent …";
  try {
    // optionaler Sign-In via Nachricht
    let sig_b58 = null, msg_str = null;
    if (provider.signMessage) {
      msg_str = `INPI Presale Intent\nwallet=${pubkey.toBase58()}\namount_usdc=${usdc}\nts=${Date.now()}`;
      const enc = new TextEncoder().encode(msg_str);
      const { signature } = await provider.signMessage(enc, "utf8");
      sig_b58 = bs58Encode(signature);
    }

    const r = await fetch(`${CFG.API_BASE}/presale/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: pubkey.toBase58(), amount_usdc: usdc, sig_b58, msg_str })
    });
    const text = await r.text();

    intentMsg.textContent = "";
    const p = document.createElement("p"); p.textContent = text; intentMsg.appendChild(p);

    if (STATE.deposit_ata) {
      const small = document.createElement("small");
      small.innerText = `Deposit-Adresse (USDC): ${STATE.deposit_ata} `;
      const a = document.createElement("a");
      a.href = solscan(STATE.deposit_ata); a.target="_blank"; a.rel="noopener";
      a.textContent = `(Solscan)`;
      small.appendChild(a);

      const copyBtn = document.createElement("button");
      copyBtn.className = "secondary";
      copyBtn.textContent = "Kopieren";
      copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText(STATE.deposit_ata); copyBtn.textContent = "Kopiert ✓"; setTimeout(()=>copyBtn.textContent="Kopieren",1000); } catch {}
      };
      small.appendChild(document.createTextNode(" "));
      small.appendChild(copyBtn);

      intentMsg.appendChild(small);
    }

    await refreshStatus();
  } catch (e) {
    console.error(e);
    intentMsg.textContent = "API nicht erreichbar.";
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
    const u = Number(j?.usdc?.amount ?? 0);
    const i = Number(j?.inpi?.amount ?? 0);
    usdcBal.textContent = fmt(u, 2) + " USDC";
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