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
const SHARED_CARTS_DB = path.join(__dirname, "data", "shared-carts.json");

// LINE Pay Online API v4
const LINEPAY_CHANNEL_ID = process.env.LINEPAY_CHANNEL_ID || "";
const LINEPAY_CHANNEL_SECRET = process.env.LINEPAY_CHANNEL_SECRET || "";
const LINEPAY_API_BASE = process.env.LINEPAY_API_BASE || "https://api-pay.line.me";

// LINE Messaging API（用於店家收到新訂單通知）
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_NOTIFY_TARGET = process.env.LINE_NOTIFY_TARGET || "";
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || "2011256472";

app.use(express.json({
  limit: "1mb",
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.static(path.join(__dirname, "public")));

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(DB, "utf8"));
  } catch (e) {
    return [];
  }
}

function writeOrders(orders) {
  const dir = path.dirname(DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB, JSON.stringify(orders, null, 2), "utf8");
}

function readSharedCarts() {
  try { return JSON.parse(fs.readFileSync(SHARED_CARTS_DB, "utf8")); }
  catch (e) { return {}; }
}

function writeSharedCarts(data) {
  const dir = path.dirname(SHARED_CARTS_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SHARED_CARTS_DB, JSON.stringify(data, null, 2), "utf8");
}

function sharedCartId() {
  return crypto.randomBytes(6).toString("base64url");
}

function sanitizeSharedCart(cart) {
  if (!Array.isArray(cart) || !cart.length || cart.length > 100) return null;
  return cart.map(x => ({
    name: String(x?.name || "").slice(0, 80),
    price: Number(x?.price || 0),
    sweet: String(x?.sweet || "").slice(0, 30),
    ice: String(x?.ice || "").slice(0, 30),
    tops: Array.isArray(x?.tops) ? x.tops.slice(0, 20).map(t => ({
      name: String(t?.name || "").slice(0, 40),
      p: Number(t?.p || 0)
    })) : []
  })).filter(x => x.name && Number.isFinite(x.price) && x.price >= 0);
}

function id() {
  return "YP" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function verifyLineSignature(req) {
  if (!LINE_CHANNEL_SECRET) return false;
  const signature = req.get("x-line-signature") || "";
  const expected = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(req.rawBody || Buffer.from(""))
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function lineApi(pathname, payload) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN 尚未設定");
  const r = await fetch(`https://api.line.me${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(`LINE API ${r.status}: ${await r.text()}`);
}

async function replyLine(replyToken, text) {
  if (!replyToken) return;
  await lineApi("/v2/bot/message/reply", {
    replyToken,
    messages: [{ type: "text", text }]
  });
}

async function pushLine(to, text) {
  if (!to) return;
  await lineApi("/v2/bot/message/push", {
    to,
    messages: [{ type: "text", text }]
  });
}

function formatOrderForStore(order) {
  const lines = [
    "🔔 一品現泡茶｜新訂單",
    `訂單編號：${order.id}`,
    `取餐方式：${order.method === "外送" ? "外送" : "門市自取"}`,
    `${order.method === "外送" ? "外送時間" : "自取時間"}：${String(order.pickup || "").includes("T") ? String(order.pickup).split("T")[1].slice(0,5) : order.pickup}`,
    `付款方式：${order.paymentMethod || "現場付款"}${order.paymentStatus === "paid" ? "（已付款）" : ""}`,
    `姓名：${order.name}`,
    `電話：${order.phone}`
  ];

  if (order.method === "外送") lines.push(`地址：${order.address || "-"}`);
  lines.push("");

  (order.items || []).forEach((x, i) => {
    const toppings = (x.tops || []).length ? `｜加料：${x.tops.map(t => t.name).join("、")}` : "";
    const price = Number(x.price || 0) + (x.tops || []).reduce((s,t)=>s+Number(t.p||0),0);
    lines.push(`${i+1}. ${x.name}｜${x.sweet}｜${x.ice}${toppings}｜$${price}`);
  });

  lines.push("", `💰 總金額：$${order.total}`);
  if (order.remark) lines.push(`備註：${order.remark}`);
  return lines.join("\n").slice(0, 4500);
}

function notifyStore(order) {
  if (!LINE_NOTIFY_TARGET || !LINE_CHANNEL_ACCESS_TOKEN) {
    console.log("Store LINE notification skipped: LINE_NOTIFY_TARGET or token missing");
    return;
  }
  pushLine(LINE_NOTIFY_TARGET, formatOrderForStore(order))
    .catch(err => console.error("Store LINE notification failed:", err.message));
}


async function verifyLineIdToken(idToken) {
  if (!idToken) return null;

  const body = new URLSearchParams({
    id_token: String(idToken),
    client_id: LINE_LOGIN_CHANNEL_ID
  });

  const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000)
  });

  if (!r.ok) {
    console.error("LINE ID token verify failed:", r.status, await r.text());
    return null;
  }

  const data = await r.json();
  return data && data.sub ? String(data.sub) : null;
}

function notifyCustomerChat(order) {
  if (!order.lineUserId || !LINE_CHANNEL_ACCESS_TOKEN) {
    console.log("Customer chat notification skipped: no lineUserId/token");
    return;
  }

  const text = [
    "🧋 一品現泡茶｜訂單成立",
    "",
    formatOrderForStore(order).replace("🔔 一品現泡茶｜新訂單\n", ""),
    "",
    "如需修改訂單，請直接在這個聊天室聯絡店家。"
  ].join("\n").slice(0, 4500);

  pushLine(order.lineUserId, text)
    .catch(err => console.error("Customer LINE chat push failed:", err.message));
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

function normalizeOrderInput(o = {}) {
  const method = o.method === "外送" ? "外送" : "自取";
  const total = Number(o.total || 0);
  const paymentMethod = o.paymentMethod === "LINE Pay" ? "LINE Pay" : "現場付款";

  if (!o.name || !o.phone || !o.pickup || !Array.isArray(o.items) || !o.items.length) {
    return { error: "缺少必要訂單資料" };
  }
  if (!Number.isFinite(total) || total <= 0) {
    return { error: "訂單金額錯誤" };
  }
  if (method === "外送" && total < 200) {
    return { error: "外送訂單需滿 $200" };
  }
  if (method === "外送" && !String(o.address || "").trim()) {
    return { error: "請填寫外送地址" };
  }

  return {
    value: {
      id: id(),
      createdAt: new Date().toISOString(),
      status: paymentMethod === "LINE Pay" ? "payment_pending" : "new",
      paymentMethod,
      paymentStatus: paymentMethod === "LINE Pay" ? "pending" : "unpaid",
      lineUserId: String(o.lineUserId || "").slice(0, 80),
      name: String(o.name).slice(0, 40),
      phone: String(o.phone).slice(0, 30),
      pickup: String(o.pickup).slice(0, 40),
      address: String(o.address || "").slice(0, 160),
      remark: String(o.remark || "").slice(0, 300),
      method,
      items: o.items,
      total
    }
  };
}

function handleBigInteger(text) {
  // LINE Pay transactionId can exceed JavaScript's safe integer range.
  const processed = text.replace(/:\s*(\d{16,})\b/g, ': "$1"');
  return JSON.parse(processed);
}

function linePaySignature(apiPath, bodyText, nonce) {
  const message = LINEPAY_CHANNEL_SECRET + apiPath + bodyText + nonce;
  return crypto
    .createHmac("sha256", Buffer.from(LINEPAY_CHANNEL_SECRET, "utf8"))
    .update(Buffer.from(message, "utf8"))
    .digest("base64");
}

async function linePayPost(apiPath, data) {
  if (!LINEPAY_CHANNEL_ID || !LINEPAY_CHANNEL_SECRET) {
    throw new Error("LINE Pay 尚未設定 Channel ID / Channel Secret");
  }

  const nonce = crypto.randomUUID();
  const bodyText = JSON.stringify(data);
  const authorization = linePaySignature(apiPath, bodyText, nonce);

  const response = await fetch(`${LINEPAY_API_BASE}${apiPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LINE-ChannelId": LINEPAY_CHANNEL_ID,
      "X-LINE-Authorization-Nonce": nonce,
      "X-LINE-Authorization": authorization
    },
    body: bodyText,
    signal: AbortSignal.timeout(45000)
  });

  const text = await response.text();
  return handleBigInteger(text);
}

function linePayProducts(order) {
  return (order.items || []).map((item, index) => {
    const toppingAmount = (item.tops || []).reduce((sum, t) => sum + Number(t.p || 0), 0);
    const price = Number(item.price || 0) + toppingAmount;
    const details = [
      item.sweet,
      item.ice,
      (item.tops || []).length ? `加料:${item.tops.map(t => t.name).join("、")}` : ""
    ].filter(Boolean).join("/");

    return {
      id: `ITEM-${index + 1}`,
      name: `${String(item.name || "飲品").slice(0, 70)}${details ? ` (${details})` : ""}`.slice(0, 100),
      quantity: 1,
      price
    };
  });
}


// LINE Official Account webhook。
// 對官方帳號傳「取得通知ID」可取得店家通知目標 ID。
app.post("/webhook", async (req, res) => {
  if (!verifyLineSignature(req)) return res.status(401).send("Invalid signature");
  res.sendStatus(200);

  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  for (const event of events) {
    try {
      const source = event.source || {};
      const sourceId = source.userId || source.groupId || source.roomId || "";
      const text = event.message?.type === "text" ? String(event.message.text || "").trim() : "";

      if (event.type === "message" && text === "取得通知ID" && sourceId) {
        await replyLine(event.replyToken, `店家通知 ID：\n${sourceId}\n\n請把這串填到 Render 的 LINE_NOTIFY_TARGET。`);
      } else if (event.type === "message" && text === "測試店家通知") {
        await replyLine(event.replyToken, "✅ LINE Webhook 已連線成功。");
      }
    } catch (err) {
      console.error("LINE webhook error:", err.message);
    }
  }
});

// 分享購物車：建立短連結，讓朋友接著點餐。
app.post("/api/shared-carts", (req, res) => {
  const cart = sanitizeSharedCart(req.body?.cart);
  if (!cart || !cart.length) return res.status(400).json({ error: "購物車是空的或資料格式錯誤" });

  const store = readSharedCarts();
  const now = Date.now();
  // 清除超過 7 天的分享資料。
  for (const [key, value] of Object.entries(store)) {
    if (!value?.createdAt || now - Number(value.createdAt) > 7 * 24 * 60 * 60 * 1000) delete store[key];
  }
  const shareId = sharedCartId();
  store[shareId] = { cart, createdAt: now };
  writeSharedCarts(store);
  res.json({ ok: true, shareId, url: `${baseUrl(req)}/?share=${encodeURIComponent(shareId)}` });
});

app.get("/api/shared-carts/:id", (req, res) => {
  const store = readSharedCarts();
  const shared = store[String(req.params.id || "")];
  if (!shared) return res.status(404).json({ error: "找不到分享購物車，可能已失效" });
  if (Date.now() - Number(shared.createdAt || 0) > 7 * 24 * 60 * 60 * 1000) {
    delete store[String(req.params.id || "")];
    writeSharedCarts(store);
    return res.status(410).json({ error: "分享購物車已超過 7 天失效" });
  }
  res.json({ cart: shared.cart, createdAt: shared.createdAt });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "yipin-order",
    linePayConfigured: Boolean(LINEPAY_CHANNEL_ID && LINEPAY_CHANNEL_SECRET),
    lineNotifyConfigured: Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET && LINE_NOTIFY_TARGET)
  });
});

// 現場付款：直接建立訂單
app.post("/api/orders", async (req, res) => {
  const parsed = normalizeOrderInput({ ...req.body, paymentMethod: "現場付款" });
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const order = parsed.value;
  order.lineUserId = await verifyLineIdToken(req.body?.lineIdToken) || "";
  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);

  io.emit("new-order", order);
  notifyStore(order);
  notifyCustomerChat(order);
  res.json(order);
});

// LINE Pay：建立付款請求，付款成功後才正式變成 new 訂單
app.post("/api/linepay/request", async (req, res) => {
  try {
    const parsed = normalizeOrderInput({ ...req.body, paymentMethod: "LINE Pay" });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const order = parsed.value;
    order.lineUserId = await verifyLineIdToken(req.body?.lineIdToken) || "";
    const origin = baseUrl(req);

    const paymentRequest = {
      amount: order.total,
      currency: "TWD",
      orderId: order.id,
      packages: [{
        id: "YIPIN",
        amount: order.total,
        products: linePayProducts(order)
      }],
      redirectUrls: {
        confirmUrl: `${origin}/linepay/confirm?orderId=${encodeURIComponent(order.id)}`,
        cancelUrl: `${origin}/linepay/cancel?orderId=${encodeURIComponent(order.id)}`
      }
    };

    const result = await linePayPost("/v4/payments/request", paymentRequest);

    if (result.returnCode !== "0000" || !result.info?.paymentUrl) {
      console.error("LINE Pay request failed:", result);
      return res.status(502).json({
        error: `LINE Pay 建立付款失敗：${result.returnMessage || result.returnCode || "Unknown error"}`,
        returnCode: result.returnCode
      });
    }

    order.linePayTransactionId = String(result.info.transactionId || "");
    order.linePayPaymentAccessToken = String(result.info.paymentAccessToken || "");

    const orders = readOrders();
    orders.unshift(order);
    writeOrders(orders);

    res.json({
      ok: true,
      orderId: order.id,
      transactionId: order.linePayTransactionId,
      paymentUrl: result.info.paymentUrl
    });
  } catch (err) {
    console.error("LINE Pay request error:", err);
    res.status(500).json({ error: `LINE Pay 連線失敗：${err.message}` });
  }
});

// LINE Pay 驗證完成後會導回此頁，再由伺服器呼叫 confirm 完成付款。
app.get("/linepay/confirm", async (req, res) => {
  const orderId = String(req.query.orderId || "");
  const incomingTransactionId = String(req.query.transactionId || "");

  const orders = readOrders();
  const order = orders.find(x => x.id === orderId);

  if (!order) {
    return res.redirect(`/?linepay=fail&message=${encodeURIComponent("找不到付款訂單")}`);
  }

  if (order.paymentStatus === "paid") {
    return res.redirect(`/?linepay=success&orderId=${encodeURIComponent(order.id)}`);
  }

  const transactionId = incomingTransactionId || String(order.linePayTransactionId || "");
  if (!transactionId) {
    return res.redirect(`/?linepay=fail&orderId=${encodeURIComponent(order.id)}&message=${encodeURIComponent("缺少 LINE Pay transactionId")}`);
  }

  if (order.linePayTransactionId && incomingTransactionId &&
      String(order.linePayTransactionId) !== incomingTransactionId) {
    return res.redirect(`/?linepay=fail&orderId=${encodeURIComponent(order.id)}&message=${encodeURIComponent("LINE Pay 交易編號不一致")}`);
  }

  try {
    const result = await linePayPost(`/v4/payments/${transactionId}/confirm`, {
      amount: Number(order.total),
      currency: "TWD"
    });

    if (result.returnCode !== "0000") {
      order.paymentStatus = "failed";
      order.paymentError = `${result.returnCode || ""} ${result.returnMessage || ""}`.trim();
      order.updatedAt = new Date().toISOString();
      writeOrders(orders);

      return res.redirect(`/?linepay=fail&orderId=${encodeURIComponent(order.id)}&message=${encodeURIComponent(order.paymentError || "付款確認失敗")}`);
    }

    order.paymentStatus = "paid";
    order.status = "new";
    order.paidAt = new Date().toISOString();
    order.linePayTransactionId = String(result.info?.transactionId || transactionId);
    order.updatedAt = new Date().toISOString();
    delete order.linePayPaymentAccessToken;
    writeOrders(orders);

    io.emit("new-order", order);
    notifyStore(order);
    notifyCustomerChat(order);
    return res.redirect(`/?linepay=success&orderId=${encodeURIComponent(order.id)}`);
  } catch (err) {
    console.error("LINE Pay confirm error:", err);
    return res.redirect(`/?linepay=fail&orderId=${encodeURIComponent(order.id)}&message=${encodeURIComponent("付款確認連線失敗，請聯絡店家")}`);
  }
});

app.get("/linepay/cancel", (req, res) => {
  const orderId = String(req.query.orderId || "");
  const orders = readOrders();
  const order = orders.find(x => x.id === orderId);

  if (order && order.paymentStatus !== "paid") {
    order.paymentStatus = "cancelled";
    order.status = "cancelled";
    order.updatedAt = new Date().toISOString();
    writeOrders(orders);
  }

  res.redirect(`/?linepay=cancel&orderId=${encodeURIComponent(orderId)}`);
});

app.get("/api/orders/:id", (req, res) => {
  const o = readOrders().find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "找不到訂單" });

  res.json({
    id: o.id,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    pickup: o.pickup,
    total: o.total,
    createdAt: o.createdAt
  });
});

// 付款完成後前端用此資料顯示收據及回傳 LINE 訊息
app.get("/api/orders/:id/receipt", (req, res) => {
  const o = readOrders().find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "找不到訂單" });
  if (o.paymentMethod === "LINE Pay" && o.paymentStatus !== "paid") {
    return res.status(409).json({ error: "此訂單尚未完成付款" });
  }

  res.json({
    id: o.id,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    name: o.name,
    phone: o.phone,
    pickup: o.pickup,
    address: o.address,
    remark: o.remark,
    method: o.method,
    items: o.items,
    total: o.total,
    createdAt: o.createdAt,
    paidAt: o.paidAt || null
  });
});

app.post("/api/admin/login", (req, res) => {
  res.json({ ok: String(req.body?.pin || "") === ADMIN_PIN });
});

app.get("/api/admin/orders", (req, res) => {
  // LINE Pay 尚未付款的暫存訂單不顯示在店家正式訂單列表。
  res.json(readOrders().filter(o => o.status !== "payment_pending"));
});

app.post("/api/admin/orders/:id/status", (req, res) => {
  const allowed = ["new", "accepted", "making", "done", "cancelled"];
  const status = req.body?.status;

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "無效狀態" });
  }

  const orders = readOrders();
  const o = orders.find(x => x.id === req.params.id);

  if (!o) return res.status(404).json({ error: "找不到訂單" });

  o.status = status;
  o.updatedAt = new Date().toISOString();
  writeOrders(orders);

  io.emit("order-updated", o);
  res.json(o);
});

io.on("connection", socket => {
  socket.emit("server-ready", { at: new Date().toISOString() });
});

server.listen(PORT, () => {
  console.log(`一品現泡茶 order system listening on :${PORT}`);
  console.log(`LINE Pay configured: ${Boolean(LINEPAY_CHANNEL_ID && LINEPAY_CHANNEL_SECRET)}`);
});
