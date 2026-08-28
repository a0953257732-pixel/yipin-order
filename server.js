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

// LINE Pay Online API v4
const LINEPAY_CHANNEL_ID = process.env.LINEPAY_CHANNEL_ID || "";
const LINEPAY_CHANNEL_SECRET = process.env.LINEPAY_CHANNEL_SECRET || "";
const LINEPAY_API_BASE = process.env.LINEPAY_API_BASE || "https://api-pay.line.me";

app.use(express.json({ limit: "1mb" }));
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

function id() {
  return "YP" + crypto.randomBytes(4).toString("hex").toUpperCase();
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

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "yipin-order",
    linePayConfigured: Boolean(LINEPAY_CHANNEL_ID && LINEPAY_CHANNEL_SECRET)
  });
});

// 現場付款：直接建立訂單
app.post("/api/orders", (req, res) => {
  const parsed = normalizeOrderInput({ ...req.body, paymentMethod: "現場付款" });
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const order = parsed.value;
  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);

  io.emit("new-order", order);
  res.json(order);
});

// LINE Pay：建立付款請求，付款成功後才正式變成 new 訂單
app.post("/api/linepay/request", async (req, res) => {
  try {
    const parsed = normalizeOrderInput({ ...req.body, paymentMethod: "LINE Pay" });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const order = parsed.value;
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
