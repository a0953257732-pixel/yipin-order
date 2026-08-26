
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
const DB = path.join(__dirname, "data", "orders.json");

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "public")));

function readOrders(){
  try { return JSON.parse(fs.readFileSync(DB,"utf8")); }
  catch(e){ return []; }
}
function writeOrders(orders){
  fs.writeFileSync(DB, JSON.stringify(orders,null,2), "utf8");
}
function id(){ return "YP" + crypto.randomBytes(4).toString("hex").toUpperCase(); }

app.get("/api/health",(req,res)=>res.json({ok:true,service:"yipin-order"}));

app.post("/api/orders",(req,res)=>{
  const o=req.body||{};
  const method=o.method==="外送" ? "外送" : "自取";
  const total=Number(o.total||0);
  if(!o.name || !o.phone || !o.pickup || !Array.isArray(o.items) || !o.items.length)
    return res.status(400).json({error:"缺少必要訂單資料"});
  if(method==="外送" && total<200) return res.status(400).json({error:"外送訂單需滿 $200"});
  if(method==="外送" && !String(o.address||"").trim()) return res.status(400).json({error:"請填寫外送地址"});
  const order={
    id:id(), createdAt:new Date().toISOString(), status:"new",
    name:String(o.name).slice(0,40), phone:String(o.phone).slice(0,30),
    pickup:o.pickup, address:String(o.address||"").slice(0,160), remark:String(o.remark||"").slice(0,300),
    method, items:o.items, total
  };
  const orders=readOrders(); orders.unshift(order); writeOrders(orders);
  io.emit("new-order",order);
  res.json(order);
});

app.get("/api/orders/:id",(req,res)=>{
  const o=readOrders().find(x=>x.id===req.params.id);
  if(!o) return res.status(404).json({error:"找不到訂單"});
  res.json({id:o.id,status:o.status,pickup:o.pickup,total:o.total,createdAt:o.createdAt});
});

app.post("/api/admin/login",(req,res)=>{
  res.json({ok:String(req.body?.pin||"")===ADMIN_PIN});
});

app.get("/api/admin/orders",(req,res)=>res.json(readOrders()));

app.post("/api/admin/orders/:id/status",(req,res)=>{
  const allowed=["new","accepted","making","done","cancelled"];
  const status=req.body?.status;
  if(!allowed.includes(status)) return res.status(400).json({error:"無效狀態"});
  const orders=readOrders(); const o=orders.find(x=>x.id===req.params.id);
  if(!o) return res.status(404).json({error:"找不到訂單"});
  o.status=status; o.updatedAt=new Date().toISOString(); writeOrders(orders);
  io.emit("order-updated",o);
  res.json(o);
});

io.on("connection",(socket)=>{
  socket.emit("server-ready",{at:new Date().toISOString()});
});

server.listen(PORT,()=>console.log(`一品現泡茶 order system listening on :${PORT}`));
