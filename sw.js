// REEL service worker: faz streaming autenticado de ficheiros do Drive (com Range) para o <video>.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(clients.claim()));
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url),m=u.pathname.match(/\/stream\/([\w-]+)$/);
  if(!m)return;
  e.respondWith((async()=>{
    const t=await(await caches.open('reel-tok')).match('/__tok');
    if(!t)return new Response('Sem sessão Google',{status:401});
    const {tok}=await t.json();
    const size=+u.searchParams.get('s')||0,h={Authorization:'Bearer '+tok};
    const rg=(e.request.headers.get('Range')||'').match(/bytes=(\d*)-(\d*)/);
    let a=0,b=size-1;
    if(rg&&size){a=+rg[1]||0;b=rg[2]?Math.min(+rg[2],size-1):size-1;h.Range=`bytes=${a}-${b}`}
    const r=await fetch(`https://www.googleapis.com/drive/v3/files/${m[1]}?alt=media&supportsAllDrives=true`,{headers:h});
    if(!r.ok)return new Response(r.body,{status:r.status,headers:{'content-type':r.headers.get('content-type')||'application/json'}});
    const o=new Headers({'content-type':r.headers.get('content-type')||'video/mp4','accept-ranges':'bytes'});
    if(size){o.set('content-length',String(b-a+1));if(rg)o.set('content-range',`bytes ${a}-${b}/${size}`)}
    if(u.searchParams.has('dl'))o.set('content-disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(u.searchParams.get('n')||'video.mp4'));
    return new Response(r.body,{status:rg&&size?206:200,headers:o});
  })())});
