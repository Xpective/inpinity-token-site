// Leitet https://inpinity.online/token* auf deine Pages-Site weiter
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const origin = "https://inpinity-token-site.pages.dev"; // DEINE Pages-URL

    // /token oder /token/ -> index.html
    if (url.pathname === "/token" || url.pathname === "/token/") {
      const r = await fetch(origin + "/token/index.html" + url.search, { headers: { "cache-control": "no-cache" } });
      return withProxyHeaders(r);
    }

    // Unterpfade (Assets, JS, CSS, Bilder)
    if (url.pathname.startsWith("/token/")) {
      const r = await fetch(origin + url.pathname + url.search, { headers: { "cache-control": "no-cache" } });
      return withProxyHeaders(r);
    }

    return new Response("Not found", { status: 404 });
  }
};

function withProxyHeaders(r){
  const h = new Headers(r.headers);
  h.set("x-proxy", "token-pages");
  h.set("access-control-allow-origin", "*");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("x-content-type-options", "nosniff");
  return new Response(r.body, { status: r.status, headers: h });
}
