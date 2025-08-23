// Pfad: cf-workers/proxy-token-pages/worker.js
// Aufgabe: leitet https://inpinity.online/token* auf deine Pages-Site

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const origin = "https://inpinity-token-site.pages.dev"; // <-- DEINE Pages-URL

    // /token oder /token/ -> index.html
    if (url.pathname === "/token" || url.pathname === "/token/") {
      return fetch(origin + "/token/index.html" + url.search, {
        headers: { "cache-control": "no-cache" }
      });
    }

    // Unterpfade 1:1 weiterreichen (Assets, JS, JSON, Bilder)
    if (url.pathname.startsWith("/token/")) {
      return fetch(origin + url.pathname + url.search, {
        headers: { "cache-control": "no-cache" }
      });
    }

    // alles andere ignorieren
    return new Response("Not found", { status: 404 });
  }
}