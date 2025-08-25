// Leitet https://inpinity.online/token* auf deine Pages-Site im ROOT um.
// Files liegen in der Pages-Site im Root (public/index.html, public/app.js, …)

const ORIGIN = "https://inpinity-token-site.pages.dev";

export default {
  async fetch(req) {
    const url = new URL(req.url);

    // /token oder /token/ -> /index.html der Pages-Site
    if (url.pathname === "/token" || url.pathname === "/token/") {
      return send(ORIGIN + "/index.html" + url.search);
    }

    // /token/* -> gleiche Datei ABER ohne das /token-Präfix vom Root holen
    if (url.pathname.startsWith("/token/")) {
      const path = url.pathname.replace(/^\/token/, "") || "/";
      return send(ORIGIN + path + url.search);
    }

    return new Response("Not found", { status: 404, headers: baseHeaders() });
  }
};

async function send(targetUrl) {
  const r = await fetch(targetUrl, { headers: { "cache-control": "no-cache" } });
  return withProxyHeaders(r);
}

function withProxyHeaders(r) {
  const h = new Headers(r.headers);
  h.set("x-proxy", "token-pages");
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(r.body, { status: r.status, headers: h });
}

function baseHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin"
  };
}
