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
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || "2011256472";

// LINE Pay 正式環境（沿用你 Render 現有的 Key 名稱）
const LINEPAY_CHANNEL_ID = process.env.LINEPAY_CHANNEL_ID || "";
const LINEPAY_CHANNEL_SECRET = process.env.LINEPAY_CHANNEL_SECRET || "";
const LINEPAY_API_BASE = "https://api-pay.line.me";
const BASE_URL = String(process.env.BASE_URL || "https://yipin-order.onrender.com").replace(/\/$/,"");
const LINEPAY_PENDING_DB = path.join(DATA_DIR, "linepay-pending.json");

fs.mkdirSync(DATA_DIR,{recursive:true});
if(!fs.existsSync(DB)) fs.writeFileSync(DB,"[]");
if(!fs.existsSync(SHARED_DB)) fs.writeFileSync(SHARED_DB,"{}");
if(!fs.existsSync(LINEPAY_PENDING_DB)) fs.writeFileSync(LINEPAY_PENDING_DB,"{}");

app.use(express.json({limit:"1mb",verify:(req,res,buf)=>{req.rawBody=Buffer.from(buf)}}));
app.use(express.static(path.join(__dirname,"public")));

function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch(e){return fallback}}
function writeJson(file,data){fs.writeFileSync(file,JSON.stringify(data,null,2),"utf8")}
function readOrders(){return readJson(DB,[])}
function writeOrders(x){writeJson(DB,x)}
function readSharedCarts(){return readJson(SHARED_DB,{})}
function writeSharedCarts(x){writeJson(SHARED_DB,x)}
function readLinePayPending(){return readJson(LINEPAY_PENDING_DB,{})}
function writeLinePayPending(x){writeJson(LINEPAY_PENDING_DB,x)}
function id(){return "YP"+crypto.randomBytes(4).toString("hex").toUpperCase()}
function sharedCartId(){return crypto.randomBytes(8).toString("hex")}

function sanitizeSharedItem(item){
  if(!item||typeof item!=="object") return null;
  const tops=Array.isArray(item.tops)?item.tops.slice(0,10).map(t=>({name:String(t?.name||"").slice(0,40),p:Number(t?.p||0)})).filter(t=>t.name&&Number.isFinite(t.p)):[];
  const x={sharedItemId:String(item.sharedItemId||crypto.randomBytes(6).toString("hex")).slice(0,40),name:String(item.name||"").slice(0,80),price:Number(item.price||0),sweet:String(item.sweet||"").slice(0,40),ice:String(item.ice||"").slice(0,40),tops};
  return x.name&&Number.isFinite(x.price)&&x.price>=0?x:null;
}
function sanitizeSharedCart(cart){return Array.isArray(cart)?cart.slice(0,100).map(sanitizeSharedItem).filter(Boolean):[]}

async function verifyLineIdToken(idToken){
  if(!idToken) return null;
  const body=new URLSearchParams({
    id_token:String(idToken),
    client_id:LINE_LOGIN_CHANNEL_ID
  });

  const r=await fetch("https://api.line.me/oauth2/v2.1/verify",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body
  });

  if(!r.ok){
    console.error("LINE ID token verify failed:",r.status,await r.text());
    return null;
  }

  const data=await r.json();
  return data?.sub ? String(data.sub) : null;
}

async function resolveLineUserId(idToken,accessToken){
  if(idToken){
    try{
      const userId=await verifyLineIdToken(idToken);
      if(userId) return String(userId);
    }catch(e){ console.error("[LINE] id token resolve failed",e?.message); }
  }
  if(accessToken){
    try{
      const r=await fetch("https://api.line.me/v2/profile",{
        headers:{"Authorization":`Bearer ${String(accessToken)}`}
      });
      const raw=await r.text();
      if(r.ok){
        const data=JSON.parse(raw||"{}");
        if(data?.userId) return String(data.userId);
      }else{
        console.error("[LINE] profile resolve failed",r.status,raw);
      }
    }catch(e){ console.error("[LINE] access token resolve failed",e?.message); }
  }
  return "";
}

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


function handleLinePayBigInteger(text){
  return JSON.parse(String(text||"{}").replace(/:\s*(\d{16,})\b/g,': "$1"'));
}

function linePaySignature(apiPath,data,nonce){
  const body=JSON.stringify(data||{});
  const message=LINEPAY_CHANNEL_SECRET + apiPath + body + nonce;
  return crypto.createHmac("sha256",LINEPAY_CHANNEL_SECRET).update(message,"utf8").digest("base64");
}

async function requestLinePayV4(apiPath,data){
  if(!LINEPAY_CHANNEL_ID||!LINEPAY_CHANNEL_SECRET){
    throw new Error("LINE Pay 正式 Channel ID / Channel Secret 尚未設定");
  }

  const nonce=crypto.randomUUID();
  const signature=linePaySignature(apiPath,data,nonce);

  console.log("[LINEPAY] POST",apiPath);

  const response=await fetch(LINEPAY_API_BASE+apiPath,{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-LINE-ChannelId":LINEPAY_CHANNEL_ID,
      "X-LINE-Authorization-Nonce":nonce,
      "X-LINE-Authorization":signature
    },
    body:JSON.stringify(data),
    signal:AbortSignal.timeout(45000)
  });

  const raw=await response.text();
  let result;
  try{
    result=handleLinePayBigInteger(raw);
  }catch(e){
    console.error("[LINEPAY] invalid JSON response",response.status,raw);
    throw new Error("LINE Pay 回傳格式錯誤");
  }

  console.log("[LINEPAY] response",apiPath,{
    httpStatus:response.status,
    returnCode:result?.returnCode,
    returnMessage:result?.returnMessage
  });

  if(!response.ok){
    throw new Error(`LINE Pay HTTP ${response.status}`);
  }
  return result;
}

function normalizeCheckoutPayload(o){
  const method=o?.method==="外送"?"外送":"自取";
  const total=Number(o?.total||0);

  if(!o?.name||!o?.phone||!o?.pickup||!Array.isArray(o?.items)||!o.items.length)
    throw new Error("缺少必要訂單資料");
  if(!Number.isFinite(total)||total<=0)
    throw new Error("訂單金額錯誤");
  if(method==="外送"&&total<200)
    throw new Error("外送訂單需滿 $200");
  if(method==="外送"&&!String(o?.address||"").trim())
    throw new Error("請填寫外送地址");

  return {
    name:String(o.name).slice(0,40),
    phone:String(o.phone).slice(0,30),
    pickup:String(o.pickup).slice(0,40),
    address:String(o.address||"").slice(0,160),
    remark:String(o.remark||"").slice(0,300),
    method,
    paymentMethod:"LINE Pay",
    lineIdToken:String(o.lineIdToken||""),
    lineAccessToken:String(o.lineAccessToken||""),
    items:o.items,
    total
  };
}

function linePayProducts(items){
  return (items||[]).map((x,i)=>{
    const topAmount=(x.tops||[]).reduce((a,t)=>a+Number(t?.p||0),0);
    const unitPrice=Number(x.price||0)+topAmount;
    return {
      id:`ITEM-${i+1}`,
      name:String(x.name||`飲品${i+1}`).slice(0,100),
      quantity:1,
      price:unitPrice
    };
  });
}


function customerStatusMessage(order,status){
  const time=String(order.pickup||"").includes("T")
    ? String(order.pickup).split("T")[1].slice(0,5)
    : String(order.pickup||"");
  const method=order.method==="外送"?"外送":"門市自取";

  if(status==="accepted"){
    return [
      "✅ 一品現泡茶｜店家已接單",
      `訂單編號：${order.id}`,
      `${method}時間：${time}`,
      `金額：$${order.total}`,
      "",
      "店家已確認您的訂單，會開始為您準備 🧋"
    ].join("\n");
  }
  if(status==="making"){
    return [
      "🥤 一品現泡茶｜製作中",
      `訂單編號：${order.id}`,
      "您的飲料正在製作中，請稍候。"
    ].join("\n");
  }
  if(status==="done"){
    return [
      "✅ 一品現泡茶｜訂單完成",
      `訂單編號：${order.id}`,
      order.method==="外送"
        ? "您的訂單已完成，將依安排配送。"
        : "您的飲料已完成，可以前來取餐囉！"
    ].join("\n");
  }
  if(status==="cancelled"){
    return [
      "⚠️ 一品現泡茶｜訂單狀態通知",
      `訂單編號：${order.id}`,
      "此訂單已取消。如有疑問請直接聯繫門市。"
    ].join("\n");
  }
  return "";
}

async function notifyCustomerForStatus(order,status){
  if(!order?.lineUserId || !LINE_CHANNEL_ACCESS_TOKEN) return false;
  const text=customerStatusMessage(order,status);
  if(!text) return false;
  try{
    await pushLineMessage(order.lineUserId,text);
    console.log("[ORDER] customer status push success",{orderId:order.id,status});
    return true;
  }catch(e){
    console.error("[ORDER] customer status push failed",{orderId:order.id,status,message:e?.message});
    return false;
  }
}


function customerPaidReceipt(order){
  const items=(order.items||[]).map((x,i)=>{
    const tops=(x.tops||x.addons||[]).map(t=>typeof t==="string"?t:t?.name).filter(Boolean);
    return `${i+1}. ${x.name||x.title||"品項"}${x.sweet?`｜${x.sweet}`:""}${x.ice?`｜${x.ice}`:""}${tops.length?`｜加料：${tops.join("、")}`:""}`;
  });
  return [
    "✅ LINE Pay 付款成功｜訂單已收到",
    `訂單編號：${order.id}`,
    order.method==="外送"?`🛵 外送\n地址：${order.address||"-"}`:"🏪 門市自取",
    `姓名：${order.name}`,
    `時間：${order.pickup}`,
    "",
    ...items,
    "",
    `💰 已付款：$${order.total}`,
    "店家接單後會再由官方帳號通知您。"
  ].join("\\n");
}

async function pushPaidReceipt(order){
  if(!order?.lineUserId){
    console.warn("[LINEPAY] Official push skipped: no saved lineUserId",{orderId:order?.id});
    return false;
  }
  try{
    await pushLineMessage(order.lineUserId,customerPaidReceipt(order));
    console.log("[LINEPAY] Official paid receipt sent",{orderId:order.id});
    return true;
  }catch(e){
    console.error("[LINEPAY] Official paid receipt failed",{orderId:order.id,message:e?.message});
    return false;
  }
}

function createPaidOrderFromPending(orderId,pending,transactionId){
  const existing=readOrders().find(x=>x.id===orderId);
  if(existing) return existing;

  const p=pending.payload;
  const order={
    id:orderId,
    createdAt:new Date().toISOString(),
    status:"new",
    name:p.name,
    phone:p.phone,
    pickup:p.pickup,
    address:p.address,
    remark:p.remark,
    method:p.method,
    paymentMethod:"LINE Pay",
    paymentStatus:"paid",
    linePayTransactionId:String(transactionId||pending.transactionId||""),
    lineUserId:String(pending.lineUserId||""),
    items:p.items,
    total:p.total
  };

  const orders=readOrders();
  orders.unshift(order);
  writeOrders(orders);
  io.emit("new-order",order);
  return order;
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




// LINE Pay Online API v4 - 正式環境
app.post("/api/linepay/request",async(req,res)=>{
  let payload;
  try{
    payload=normalizeCheckoutPayload(req.body||{});
  }catch(e){
    return res.status(400).json({error:e.message});
  }

  const orderId=id();
  const products=linePayProducts(payload.items);
  const productSum=products.reduce((a,x)=>a+(Number(x.price)||0)*(Number(x.quantity)||1),0);

  if(productSum!==payload.total){
    console.error("[LINEPAY] amount mismatch",{orderId,productSum,total:payload.total});
    return res.status(400).json({error:"訂單品項金額與總金額不一致"});
  }

  const requestBody={
    amount:payload.total,
    currency:"TWD",
    orderId,
    packages:[{
      id:"1",
      amount:payload.total,
      products
    }],
    redirectUrls:{
      confirmUrl:`${BASE_URL}/api/linepay/confirm?orderId=${encodeURIComponent(orderId)}`,
      cancelUrl:`${BASE_URL}/api/linepay/cancel?orderId=${encodeURIComponent(orderId)}`
    }
  };

  console.log("[LINEPAY] request start",{orderId,total:payload.total,method:payload.method});

  try{
    // IMPORTANT: resolve customer LINE userId BEFORE redirecting to LINE Pay.
    // The callback must not depend on LIFF/browser state after payment.
    const lineUserId=await resolveLineUserId(payload.lineIdToken,payload.lineAccessToken);
    console.log("[LINEPAY] customer captured before redirect",{
      orderId,
      hasLineUserId:Boolean(lineUserId)
    });

    const result=await requestLinePayV4("/v4/payments/request",requestBody);

    if(result?.returnCode!=="0000"){
      console.error("[LINEPAY] request rejected",{
        orderId,
        returnCode:result?.returnCode,
        returnMessage:result?.returnMessage
      });
      return res.status(400).json({
        error:`LINE Pay 建立付款失敗 (${result?.returnCode||"UNKNOWN"}) ${result?.returnMessage||""}`.trim()
      });
    }

    const transactionId=String(result?.info?.transactionId||"");
    const paymentUrl=result?.info?.paymentUrl||{};

    if(!transactionId||(!paymentUrl.web&&!paymentUrl.app)){
      console.error("[LINEPAY] missing payment data",{orderId,result});
      return res.status(502).json({error:"LINE Pay 未回傳付款網址或交易編號"});
    }

    const pending=readLinePayPending();
    const pendingPayload={...payload};
    delete pendingPayload.lineIdToken;
    delete pendingPayload.lineAccessToken;
    pending[orderId]={
      orderId,
      transactionId,
      payload:pendingPayload,
      lineUserId:String(lineUserId||""),
      createdAt:Date.now()
    };
    writeLinePayPending(pending);

    console.log("[LINEPAY] request success",{orderId,transactionId});

    res.json({
      ok:true,
      orderId,
      transactionId,
      paymentUrl
    });
  }catch(e){
    console.error("[LINEPAY] request exception",{
      orderId,
      message:e?.message,
      stack:e?.stack
    });
    res.status(500).json({error:e?.message||"LINE Pay 建立付款失敗"});
  }
});

app.get("/api/linepay/confirm",async(req,res)=>{
  const orderId=String(req.query?.orderId||"");
  if(!orderId){
    return res.redirect(`${BASE_URL}/?linepay=fail&message=${encodeURIComponent("缺少訂單編號")}`);
  }

  const pendingStore=readLinePayPending();
  const pending=pendingStore[orderId];
  if(!pending){
    const paid=readOrders().find(x=>x.id===orderId&&x.paymentStatus==="paid");
    if(paid){
      return res.redirect(`${BASE_URL}/?linepay=success&orderId=${encodeURIComponent(orderId)}`);
    }
    console.error("[LINEPAY] confirm pending order missing",{orderId});
    return res.redirect(`${BASE_URL}/?linepay=fail&orderId=${encodeURIComponent(orderId)}&message=${encodeURIComponent("找不到待付款訂單")}`);
  }

  const transactionId=String(req.query?.transactionId||pending.transactionId||"");
  if(!transactionId){
    console.error("[LINEPAY] confirm transactionId missing",{orderId});
    return res.redirect(`${BASE_URL}/?linepay=fail&orderId=${encodeURIComponent(orderId)}&message=${encodeURIComponent("缺少 LINE Pay 交易編號")}`);
  }

  console.log("[LINEPAY] confirm start",{orderId,transactionId,total:pending.payload.total});

  try{
    const apiPath=`/v4/payments/${encodeURIComponent(transactionId)}/confirm`;
    const result=await requestLinePayV4(apiPath,{
      amount:Number(pending.payload.total),
      currency:"TWD"
    });

    if(result?.returnCode!=="0000"){
      console.error("[LINEPAY] confirm rejected",{
        orderId,
        transactionId,
        returnCode:result?.returnCode,
        returnMessage:result?.returnMessage
      });
      return res.redirect(
        `${BASE_URL}/?linepay=fail&orderId=${encodeURIComponent(orderId)}&message=${encodeURIComponent(`LINE Pay 確認付款失敗 (${result?.returnCode||"UNKNOWN"}) ${result?.returnMessage||""}`)}`
      );
    }

    const order=createPaidOrderFromPending(orderId,pending,transactionId);
    delete pendingStore[orderId];
    writeLinePayPending(pendingStore);

    console.log("[LINEPAY] confirm success",{
      orderId,transactionId,total:order.total,hasLineUserId:Boolean(order.lineUserId)
    });
    await pushPaidReceipt(order);
    res.redirect(`${BASE_URL}/?linepay=success&orderId=${encodeURIComponent(orderId)}`);
  }catch(e){
    console.error("[LINEPAY] confirm exception",{
      orderId,
      transactionId,
      message:e?.message,
      stack:e?.stack
    });
    res.redirect(
      `${BASE_URL}/?linepay=fail&orderId=${encodeURIComponent(orderId)}&message=${encodeURIComponent(e?.message||"LINE Pay 確認付款失敗")}`
    );
  }
});

app.get("/api/linepay/cancel",(req,res)=>{
  const orderId=String(req.query?.orderId||"");
  console.log("[LINEPAY] customer cancelled",{orderId});
  res.redirect(`${BASE_URL}/?linepay=cancel&orderId=${encodeURIComponent(orderId)}`);
});

app.get("/api/orders/:id/receipt",(req,res)=>{
  const o=readOrders().find(x=>x.id===req.params.id);
  if(!o) return res.status(404).json({error:"找不到付款完成訂單"});
  if(o.paymentMethod!=="LINE Pay"||o.paymentStatus!=="paid")
    return res.status(409).json({error:"此訂單尚未完成 LINE Pay 付款"});
  res.json(o);
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

app.post("/api/orders",async(req,res)=>{
  const o=req.body||{},method=o.method==="外送"?"外送":"自取",total=Number(o.total||0);

  if(!o.name||!o.phone||!o.pickup||!Array.isArray(o.items)||!o.items.length)
    return res.status(400).json({error:"缺少必要訂單資料"});
  if(method==="外送"&&total<200)
    return res.status(400).json({error:"外送訂單需滿 $200"});
  if(method==="外送"&&!String(o.address||"").trim())
    return res.status(400).json({error:"請填寫外送地址"});

  const lineUserId=await resolveLineUserId(o.lineIdToken,o.lineAccessToken);

  const order={
    id:id(),
    createdAt:new Date().toISOString(),
    status:"new",
    name:String(o.name).slice(0,40),
    phone:String(o.phone).slice(0,30),
    pickup:o.pickup,
    address:String(o.address||"").slice(0,160),
    remark:String(o.remark||"").slice(0,300),
    method,
    paymentMethod:String(o.paymentMethod||"現場付款").slice(0,30),
    paymentStatus:o.paymentMethod==="LINE Pay"?"paid":"unpaid",
    lineUserId,
    items:o.items,
    total
  };

  const orders=readOrders();
  orders.unshift(order);
  writeOrders(orders);
  io.emit("new-order",order);
  res.json(order);
});

app.get("/api/orders/:id",(req,res)=>{const o=readOrders().find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:"找不到訂單"});res.json({id:o.id,status:o.status,pickup:o.pickup,total:o.total,createdAt:o.createdAt})});
app.post("/api/admin/login",(req,res)=>res.json({ok:String(req.body?.pin||"")===ADMIN_PIN}));
app.get("/api/admin/orders",(req,res)=>res.json(readOrders()));
app.post("/api/admin/orders/:id/status",async(req,res)=>{
  const allowed=["new","accepted","making","done","cancelled"];
  const status=req.body?.status;
  if(!allowed.includes(status)) return res.status(400).json({error:"無效狀態"});

  const orders=readOrders();
  const o=orders.find(x=>x.id===req.params.id);
  if(!o) return res.status(404).json({error:"找不到訂單"});

  o.status=status;
  o.updatedAt=new Date().toISOString();
  writeOrders(orders);
  io.emit("order-updated",o);

  const notified=await notifyCustomerForStatus(o,status);
  res.json({...o,lineCustomerNotified:notified});
});

io.on("connection",socket=>{
  socket.emit("server-ready",{at:new Date().toISOString()});
  socket.on("join-shared-cart",id=>{id=String(id||"");if(id&&id.length<80)socket.join(`shared-cart:${id}`)});
  socket.on("leave-shared-cart",id=>{id=String(id||"");if(id&&id.length<80)socket.leave(`shared-cart:${id}`)});
});
server.listen(PORT,()=>console.log(`一品現泡茶 order system listening on :${PORT}`));