const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "30242";
const DATA_DIR = path.join(__dirname, "data");
const DB = path.join(DATA_DIR, "orders.json");
const SHARED_DB = path.join(DATA_DIR, "shared-carts.json");

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_NOTIFY_TARGET = process.env.LINE_NOTIFY_TARGET || "";
const LINE_SEND_TOKENS = new Map();
const LINE_SEND_TOKEN_TTL_MS = 10 * 60 * 1000;

fs.mkdirSync(DATA_DIR,{recursive:true});
if(!fs.existsSync(DB)) fs.writeFileSync(DB,"[]");
if(!fs.existsSync(SHARED_DB)) fs.writeFileSync(SHARED_DB,"{}");

app.use(express.json({limit:"1mb",verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf)}}));
app.use(express.static(path.join(__dirname,"public")));

function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch(e){return fallback}}
function writeJson(file,data){fs.writeFileSync(file,JSON.stringify(data,null,2),"utf8")}
function readOrders(){return readJson(DB,[])}
function writeOrders(x){writeJson(DB,x)}
function readSharedCarts(){return readJson(SHARED_DB,{})}
function writeSharedCarts(x){writeJson(SHARED_DB,x)}
function id(){return "YP"+crypto.randomBytes(4).toString("hex").toUpperCase()}
function sharedCartId(){return crypto.randomBytes(8).toString("hex")}

function sanitizeSharedItem(item){
  if(!item||typeof item!=="object") return null;
  const tops=Array.isArray(item.tops)?item.tops.slice(0,10).map(t=>({name:String(t?.name||"").slice(0,40),p:Number(t?.p||0)})).filter(t=>t.name&&Number.isFinite(t.p)):[];
  const x={sharedItemId:String(item.sharedItemId||crypto.randomBytes(6).toString("hex")).slice(0,40),name:String(item.name||"").slice(0,80),price:Number(item.price||0),sweet:String(item.sweet||"").slice(0,40),ice:String(item.ice||"").slice(0,40),tops};
  return x.name&&Number.isFinite(x.price)&&x.price>=0?x:null;
}
function sanitizeSharedCart(cart){return Array.isArray(cart)?cart.slice(0,100).map(sanitizeSharedItem).filter(Boolean):[]}

function verifyLineSignature(req){
  if(!LINE_CHANNEL_SECRET) return false;
  const signature=req.get("x-line-signature")||"";
  const expected=crypto.createHmac("sha256",LINE_CHANNEL_SECRET).update(req.rawBody||Buffer.from("")).digest("base64");
  try{return crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))}catch{return false}
}
async function lineApi(pathname,payload){
  if(!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN 尚未設定");
  const r=await fetch(`https://api.line.me${pathname}`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`},body:JSON.stringify(payload)});
  if(!r.ok) throw new Error(`LINE API ${r.status}: ${await r.text()}`);
}
async function replyLineMessage(replyToken,text){if(replyToken) await lineApi("/v2/bot/message/reply",{replyToken,messages:[{type:"text",text}]})}
async function pushLineMessage(to,text){if(to) await lineApi("/v2/bot/message/push",{to,messages:[{type:"text",text}]})}
function formatOrderForLine(o){
  const items=(o.items||[]).map((x,i)=>{
    const tops=(x.tops||x.addons||[]).map(t=>typeof t==="string"?t:t.name).filter(Boolean);
    const sweet=x.sweet||x.sugar||"";
    const ice=x.ice||"";
    const price=Number(x.price||0)+(x.tops||[]).reduce((a,t)=>a+Number(t.p||0),0);
    return `${i+1}. ${x.name||x.title||"品項"}${sweet?`｜${sweet}`:""}${ice?`｜${ice}`:""}${tops.length?`｜加料：${tops.join("、")}`:""}${price?`｜$${price}`:""}`;
  });
  return ["🔔 一品現泡茶｜新訂單",`訂單編號：${o.id}`,o.method==="外送"?`🛵 外送\n地址：${o.address||"-"}`:"🏪 門市自取",`姓名：${o.name}`,`電話：${o.phone}`,`時間：${o.pickup}`,"",...items,"",`💰 總金額：$${o.total}`,o.remark?`備註：${o.remark}`:""].filter(Boolean).join("\n");
}

app.get("/api/health",(req,res)=>res.json({ok:true,service:"yipin-order",lineConfigured:Boolean(LINE_CHANNEL_ACCESS_TOKEN&&LINE_CHANNEL_SECRET)}));

app.post("/webhook",async(req,res)=>{
  if(!verifyLineSignature(req)) return res.status(401).send("Invalid signature");
  res.sendStatus(200);
  for(const event of (Array.isArray(req.body?.events)?req.body.events:[])){
    try{
      const source=event.source||{}, sourceId=source.userId||source.groupId||source.roomId||"";
      if(event.type==="message"&&event.message?.type==="text"&&event.message.text.trim()==="取得通知ID"&&sourceId)
        await replyLineMessage(event.replyToken,`你的 LINE 通知 ID：\n${sourceId}\n\n請把這串填到 Render 的 LINE_NOTIFY_TARGET。`);
      if(event.type==="message"&&event.message?.type==="text"&&event.message.text.trim()==="測試訂單通知")
        await replyLineMessage(event.replyToken,"✅ LINE Webhook 已連線成功，可以開始接收網站訂單通知。");
    }catch(e){console.error("LINE webhook event error:",e.message)}
  }
});


function cleanupLineSendTokens(){
  const now=Date.now();
  for(const [token,data] of LINE_SEND_TOKENS.entries()){
    if(!data || now-Number(data.createdAt||0)>LINE_SEND_TOKEN_TTL_MS){
      LINE_SEND_TOKENS.delete(token);
    }
  }
}

app.post("/api/line-send-token",(req,res)=>{
  cleanupLineSendTokens();
  const text=String(req.body?.text||"").trim();
  if(!text) return res.status(400).json({error:"缺少訂單文字"});
  if(text.length>4500) return res.status(400).json({error:"訂單文字過長"});
  const token=crypto.randomBytes(16).toString("hex");
  LINE_SEND_TOKENS.set(token,{text,createdAt:Date.now()});
  res.json({ok:true,token});
});

app.get("/api/line-send-token/:token",(req,res)=>{
  cleanupLineSendTokens();
  const token=String(req.params.token||"");
  const data=LINE_SEND_TOKENS.get(token);
  if(!data) return res.status(404).json({error:"訂單回傳識別碼已失效，請回點餐頁重新送出"});
  res.json({ok:true,text:data.text});
});

app.delete("/api/line-send-token/:token",(req,res)=>{
  LINE_SEND_TOKENS.delete(String(req.params.token||""));
  res.json({ok:true});
});

app.post("/api/shared-carts",(req,res)=>{
  const cart=sanitizeSharedCart(req.body?.cart); if(!cart.length)return res.status(400).json({error:"購物車是空的"});
  const store=readSharedCarts(),shareId=sharedCartId(),now=Date.now();
  store[shareId]={cart,createdAt:now,updatedAt:now,version:1};writeSharedCarts(store);
  res.json({ok:true,shareId,cart,version:1,url:`${req.protocol}://${req.get("host")}/?share=${encodeURIComponent(shareId)}`});
});
app.get("/api/shared-carts/:id",(req,res)=>{
  const x=readSharedCarts()[req.params.id]; if(!x)return res.status(404).json({error:"找不到團購單，可能已失效"});
  res.json({shareId:req.params.id,cart:x.cart||[],version:Number(x.version||1),createdAt:x.createdAt,updatedAt:x.updatedAt});
});
app.post("/api/shared-carts/:id/items",(req,res)=>{
  const store=readSharedCarts(),x=store[req.params.id];if(!x)return res.status(404).json({error:"找不到團購單"});
  const item=sanitizeSharedItem(req.body?.item);if(!item)return res.status(400).json({error:"品項資料錯誤"});
  x.cart=x.cart||[];x.cart.push(item);x.version=Number(x.version||0)+1;x.updatedAt=Date.now();writeSharedCarts(store);
  const payload={shareId:req.params.id,cart:x.cart,version:x.version,updatedAt:x.updatedAt};io.to(`shared-cart:${req.params.id}`).emit("shared-cart-updated",payload);res.json({ok:true,...payload,item});
});
app.delete("/api/shared-carts/:id/items/:itemId",(req,res)=>{
  const store=readSharedCarts(),x=store[req.params.id];if(!x)return res.status(404).json({error:"找不到團購單"});
  const before=(x.cart||[]).length;x.cart=(x.cart||[]).filter(v=>String(v.sharedItemId||"")!==req.params.itemId);
  if(x.cart.length===before)return res.status(404).json({error:"找不到這個品項"});
  x.version=Number(x.version||0)+1;x.updatedAt=Date.now();writeSharedCarts(store);
  const payload={shareId:req.params.id,cart:x.cart,version:x.version,updatedAt:x.updatedAt};io.to(`shared-cart:${req.params.id}`).emit("shared-cart-updated",payload);res.json({ok:true,...payload});
});

app.post("/api/orders",(req,res)=>{
  const o=req.body||{},method=o.method==="外送"?"外送":"自取",total=Number(o.total||0);
  if(!o.name||!o.phone||!o.pickup||!Array.isArray(o.items)||!o.items.length)return res.status(400).json({error:"缺少必要訂單資料"});
  if(method==="外送"&&total<200)return res.status(400).json({error:"外送訂單需滿 $200"});
  if(method==="外送"&&!String(o.address||"").trim())return res.status(400).json({error:"請填寫外送地址"});
  const order={id:id(),createdAt:new Date().toISOString(),status:"new",name:String(o.name).slice(0,40),phone:String(o.phone).slice(0,30),pickup:o.pickup,address:String(o.address||"").slice(0,160),remark:String(o.remark||"").slice(0,300),method,items:o.items,total};
  const orders=readOrders();orders.unshift(order);writeOrders(orders);io.emit("new-order",order);res.json(order);
  if(LINE_NOTIFY_TARGET&&LINE_CHANNEL_ACCESS_TOKEN)pushLineMessage(LINE_NOTIFY_TARGET,formatOrderForLine(order)).catch(e=>console.error("LINE order push failed:",e.message));
});

app.get("/api/orders/:id",(req,res)=>{const o=readOrders().find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:"找不到訂單"});res.json({id:o.id,status:o.status,pickup:o.pickup,total:o.total,createdAt:o.createdAt})});
app.post("/api/admin/login",(req,res)=>res.json({ok:String(req.body?.pin||"")===ADMIN_PIN}));
app.get("/api/admin/orders",(req,res)=>res.json(readOrders()));
app.post("/api/admin/orders/:id/status",(req,res)=>{
  const allowed=["new","accepted","making","done","cancelled"],status=req.body?.status;if(!allowed.includes(status))return res.status(400).json({error:"無效狀態"});
  const orders=readOrders(),o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:"找不到訂單"});
  o.status=status;o.updatedAt=new Date().toISOString();writeOrders(orders);io.emit("order-updated",o);res.json(o);
});

io.on("connection",socket=>{
  socket.emit("server-ready",{at:new Date().toISOString()});
  socket.on("join-shared-cart",id=>{id=String(id||"");if(id&&id.length<80)socket.join(`shared-cart:${id}`)});
  socket.on("leave-shared-cart",id=>{id=String(id||"");if(id&&id.length<80)socket.leave(`shared-cart:${id}`)});
});
server.listen(PORT,()=>console.log(`一品現泡茶 order system listening on :${PORT}`));
