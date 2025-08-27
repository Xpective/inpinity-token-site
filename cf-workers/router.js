// Proxy /token* → https://inpinity-token-site.pages.dev (Root)
// /token     -> /index.html
// /token/xy  -> /xy

const ORIGIN = "https://inpinity-token-site.pages.dev";

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/token" || p === "/token/") {
      return fetch(ORIGIN + "/index.html" + url.search, {
        headers: { "cache-control": "no-cache", "x-proxy": "token-pages" }
      });
    }
    if (p.startsWith("/token/")) {
      const sub = p.slice("/token".length);       // z.B. "/app.js"
      const target = sub === "/" ? "/index.html" : sub;
      return fetch(ORIGIN + target + url.search, {
        headers: { "cache-control": "no-cache", "x-proxy": "token-pages" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};