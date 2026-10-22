// fledge's service worker. It caches nothing: the page always comes from
// the fledge server on this Mac, so a new release shows up on reload. It
// only steps in when that server isn't running, with a page saying how to
// start it (instead of the browser's "can't connect"), which retries on its own.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>fledge isn't running</title>
<style>
  :root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  svg { width: 96px; height: 96px; }
  h1 { font-size: 1.15rem; margin: 1rem 0 .5rem; }
  p { opacity: .75; line-height: 1.5; margin: .5rem 0; }
  code { font-family: "JetBrains Mono", ui-monospace, monospace; background: color-mix(in srgb, CanvasText 8%, transparent); padding: .15rem .4rem; border-radius: .3rem; }
  small { display: block; margin-top: 1.25rem; opacity: .55; }
</style></head>
<body><main>
  __ICON__
  <h1>fledge isn't running</h1>
  <p>Start it in Terminal, in your app's folder:</p>
  <p><code>fledge</code></p>
  <small>This page opens fledge as soon as it's up.</small>
</main>
<script>
  setInterval(() => fetch("/manifest.webmanifest", { cache: "no-store" }).then((r) => r.ok && location.reload(), () => {}), 2000);
</script>
</body></html>`;

// The icon is written into this file (public/icon.svg), not fetched: the server is the thing that's down.
const ICON = `<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="112" fill="#18181b"/>
<g transform="translate(64 52) scale(6)"><g>
  <path d="M31 13c-2-4 0-8 4-9-1 3 0 6 2 7-2 0-4 1-6 2z" fill="#E0A526"/>
  <path d="M28 14c-3-2-3-6-1-8 0 3 2 5 4 6z" fill="#E0A526"/>
  <path d="M15 31c-7 2-9 10-5 15 4-1 8-6 8-12z" fill="#E0A526"/>
  <path d="M49 31c7 2 9 10 5 15-4-1-8-6-8-12z" fill="#E0A526"/>
  <ellipse cx="32" cy="36" rx="18.5" ry="21" fill="#F5C842"/>
  <ellipse cx="32" cy="44" rx="12" ry="10.5" fill="#FBF1CF"/>
  <ellipse cx="21.5" cy="38" rx="3" ry="1.8" fill="#F09A8A" opacity="0.55"/>
  <ellipse cx="42.5" cy="38" rx="3" ry="1.8" fill="#F09A8A" opacity="0.55"/>
  <circle cx="25.5" cy="31.5" r="3.2" fill="#24242c"/>
  <circle cx="38.5" cy="31.5" r="3.2" fill="#24242c"/>
  <circle cx="26.6" cy="30.4" r="1.05" fill="#fff"/>
  <circle cx="39.6" cy="30.4" r="1.05" fill="#fff"/>
  <path d="M28.6 35.6h6.8L32 40.2z" fill="#E8833A" stroke="#E8833A" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M27 56.5v3m-2 0h4m10-3v3m-2 0h4" stroke="#E8833A" stroke-width="1.6" stroke-linecap="round" fill="none"/>
</g></g>
</svg>`;

const offline = () => new Response(OFFLINE.replace("__ICON__", ICON), { headers: { "content-type": "text/html; charset=utf-8" } });

self.addEventListener("fetch", (event) => {
  // Only page loads; everything else goes straight to the network as usual.
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => offline()));
});
