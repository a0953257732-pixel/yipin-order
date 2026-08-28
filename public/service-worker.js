const CACHE="yipin-admin-v3";
const STATIC=["/manifest.json"];

self.addEventListener("install",event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(STATIC)));
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch",event=>{
  const req=event.request;
  if(req.method!=="GET") return;
  const url=new URL(req.url);

  if(url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;

  if(url.pathname==="/admin.html" || url.pathname==="/"){
    event.respondWith(fetch(req,{cache:"no-store"}).catch(()=>caches.match(req)));
    return;
  }

  event.respondWith(
    fetch(req).then(res=>{
      const copy=res.clone();
      caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
      return res;
    }).catch(()=>caches.match(req))
  );
});
