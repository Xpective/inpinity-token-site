// leitet https://inpinity.online/token* -> https://inpinity-token-site.pages.dev/*
const ORIGIN = 'https://inpinity-token-site.pages.dev';

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/token')) {
      return new Response('Not found', { status: 404 });
    }

    // /token-Präfix entfernen: /token -> /, /token/foo -> /foo
    let path = url.pathname.replace(/^\/token/, '') || '/';
    const target = new URL(path + url.search, ORIGIN);

    if (!['GET','HEAD'].includes(req.method)) {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const res = await fetch(new Request(target, {
      method: req.method,
      headers: req.headers,
    }));

    // Fallback: bei 404 und „ordnerähnlichem“ Pfad auf /index.html
    if (res.status === 404 && !/\.\w{1,8}$/.test(path)) {
      return fetch(new URL('/index.html', ORIGIN));
    }

    // Kein aggressives Caching
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-cache');
    return new Response(res.body, { status: res.status, headers: h });
  }
}