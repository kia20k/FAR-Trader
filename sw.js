const CACHE="far-trader-v68-shell";

self.addEventListener("install",event=>{
 self.skipWaiting();

 event.waitUntil(
  caches.open(CACHE).then(cache=>
   cache.addAll([
    "./",
    "./index.html",
    "./manifest.webmanifest"
   ])
  )
 );
});

self.addEventListener("activate",event=>{
 event.waitUntil((async()=>{
  for(const key of await caches.keys()){
   if(key!==CACHE){
    await caches.delete(key);
   }
  }

  await self.clients.claim();
 })());
});

self.addEventListener("fetch",event=>{
 const url=new URL(event.request.url);

 if(
  event.request.method!=="GET"||
  url.pathname.includes("/api/")
 ){
  return;
 }

 event.respondWith(
  fetch(event.request).catch(()=>
   caches.match(event.request)
  )
 );
});

self.addEventListener("push",event=>{
 let data={
  title:"FAR Trader",
  body:"سیگنال جدید دریافت شد.",
  url:"./"
 };

 try{
  data={...data,...event.data.json()};
 }catch(_){}

 event.waitUntil(
  self.registration.showNotification(data.title,{
   body:data.body,
   icon:"./icon-192.png",
   badge:"./icon-192.png",
   tag:data.tag||"far-signal",
   data:{url:data.url||"./"},
   vibrate:[200,100,200]
  })
 );
});

self.addEventListener("notificationclick",event=>{
 event.notification.close();

 event.waitUntil(
  clients.matchAll({
   type:"window",
   includeUncontrolled:true
  }).then(list=>{
   for(const client of list){
    if("focus"in client){
     return client.focus();
    }
   }

   return clients.openWindow(
    event.notification.data.url||"./"
   );
  })
 );
});
