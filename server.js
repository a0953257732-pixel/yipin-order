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

// LINE
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_NOTIFY_TARGET = process.env.LINE_NOTIFY_TARGET || "";

// 保留 raw body，供 LINE webhook 驗證簽章使用
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
  fs.writeFileSync(DB, JSON.stringify(orders, null, 2), "utf8");
}

function id() {
  return "YP" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function verifyLineSignature(req) {
  if (!LINE_CHANNEL_SECRET) return false;
  const signature = req.get("x-line-signature") || "";
  const body = req.rawBody || Buffer.from("");
  const expected = crypto
    .createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

async function lineApi(pathname, payload) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN 尚未設定");
  }

  const response = await fetch(`https://api.line.me${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LINE API ${response.status}: ${text}`);
  }

  return true;
}

async function replyLineMessage(replyToken, text) {
  if (!replyToken) return;
  await lineApi("/v2/bot/message/reply", {
    replyToken,
    messages: [{ type: "text", text }]
  });
}

async function pushLineMessage(to, text) {
  if (!to) throw new Error("LINE_NOTIFY_TARGET 尚未設定");
  await lineApi("/v2/bot/message/push", {
    to,
    messages: [{ type: "text", text }]
  });
}

function formatOrderForLine(order) {
  const itemLines = (order.items || []).map((item, idx) => {
    const name = item.name || item.title || item.product || `品項${idx + 1}`;
    const qty = Number(item.qty || item.quantity || 1);
    const sugar = item.sugar ? `｜甜度：${item.sugar}` : "";
    const ice = item.ice ? `｜冰量：${item.ice}` : "";
    const addons = Array.isArray(item.addons) && item.addons.length
      ? `｜加料：${item.addons.map(x => typeof x === "string" ? x : (x.name || "")).filter(Boolean).join("、")}`
      : "";
    return `${idx + 1}. ${name} × ${qty}${sugar}${ice}${addons}`;
  });

  const methodLine = order.method === "外送"
    ? `🛵 外送\n地址：${order.address || "-"}`
    : "🏪 門市自取";

  return [
    "🔔 一品現泡茶｜新訂單",
    `訂單編號：${order.id}`,
    methodLine,
    `姓名：${order.name}`,
    `電話：${order.phone}`,
    `時間：${order.pickup}`,
    "",
    ...itemLines,
    "",
    `💰 總金額：$${order.total}`,
    order.remark ? `備註：${order.remark}` : ""
  ].filter(Boolean).join("\n");
}


function statusText(status) {
  const map = {
    new: "等待店家接單",
    accepted: "店家已接單",
    making: "製作中",
    done: "已完成",
    cancelled: "已取消"
  };
  return map[status] || "狀態更新中";
}

function normalizeOrderId(input) {
  const m = String(input || "").toUpperCase().match(/YP[A-F0-9]{8}/);
  return m ? m[0] : "";
}

function findOrderById(orderId) {
  if (!orderId) return null;
  return readOrders().find(o => String(o.id || "").toUpperCase() === orderId.toUpperCase()) || null;
}

function formatOrderStatusReply(order) {
  const method = order.method === "外送" ? "🛵 外送" : "🏪 門市自取";
  const lines = [
    `訂單編號：${order.id}`,
    `目前狀態：${statusText(order.status)}`,
    method,
    `時間：${order.pickup}`,
    `金額：$${order.total}`
  ];
  if (order.method === "外送" && order.address) lines.push(`地址：${order.address}`);
  if (order.status === "new") lines.push("店家尚未接單，請稍候。");
  if (order.status === "accepted") lines.push("店家已確認訂單，準備開始製作。");
  if (order.status === "making") lines.push("飲品正在製作中，請稍候。");
  if (order.status === "done") lines.push("訂單已完成，請依取餐／配送方式留意通知。");
  if (order.status === "cancelled") lines.push("此訂單已取消，如有疑問請聯絡店家。");
  return lines.join("\\n");
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "yipin-order",
    lineConfigured: Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET)
  });
});

// LINE Developers Webhook 驗證與事件接收
app.post("/webhook", async (req, res) => {
  if (!verifyLineSignature(req)) {
    return res.status(401).send("Invalid signature");
  }

  res.sendStatus(200);

  const events = Array.isArray(req.body?.events) ? req.body.events : [];

  for (const event of events) {
    try {
      const source = event.source || {};
      const sourceId = source.userId || source.groupId || source.roomId || "";

      if (event.type !== "message" || event.message?.type !== "text") continue;

      const message = String(event.message.text || "").trim();
      const lower = message.toLowerCase();

      if (message === "取得通知ID") {
        if (sourceId) {
          await replyLineMessage(
            event.replyToken,
            `你的 LINE 通知 ID：
${sourceId}

請把這串填到 Render 的 LINE_NOTIFY_TARGET。`
          );
        }
        continue;
      }

      if (message === "測試訂單通知") {
        await replyLineMessage(
          event.replyToken,
          "✅ LINE Webhook 已連線成功，可以開始接收網站訂單通知。"
        );
        continue;
      }

      if (message === "菜單" || message === "查看菜單") {
        await replyLineMessage(
          event.replyToken,
          "📋 一品現泡茶線上菜單：
https://yipin-order.onrender.com"
        );
        continue;
      }

      if (message === "點餐" || message === "開始點餐") {
        await replyLineMessage(
          event.replyToken,
          "🧋 點這裡開始點餐：
https://yipin-order.onrender.com"
        );
        continue;
      }

      if (message === "查訂單" || message === "訂單查詢" || message === "訂單") {
        await replyLineMessage(
          event.replyToken,
          "請輸入：查訂單 + 訂單編號
例如：查訂單 YP48CC459E"
        );
        continue;
      }

      if (message.startsWith("查訂單") || message.startsWith("訂單查詢")) {
        const orderId = normalizeOrderId(message);
        if (!orderId) {
          await replyLineMessage(
            event.replyToken,
            "找不到訂單編號，請輸入完整格式，例如：
查訂單 YP48CC459E"
          );
          continue;
        }

        const order = findOrderById(orderId);
        if (!order) {
          await replyLineMessage(
            event.replyToken,
            `查不到訂單 ${orderId}，請確認編號是否正確。`
          );
          continue;
        }

        await replyLineMessage(event.replyToken, formatOrderStatusReply(order));
        continue;
      }

      // 若訊息中直接帶有訂單編號，也幫忙查詢
      const directOrderId = normalizeOrderId(message);
      if (directOrderId) {
        const order = findOrderById(directOrderId);
        if (order) {
          await replyLineMessage(event.replyToken, formatOrderStatusReply(order));
          continue;
        }
      }

    } catch (err) {
      console.error("LINE webhook event error:", err.message);
    }
  }
});

app.post("/api/orders", (req, res) => {
  const o = req.body || {};
  const method = o.method === "外送" ? "外送" : "自取";
  const total = Number(o.total || 0);

  if (!o.name || !o.phone || !o.pickup || !Array.isArray(o.items) || !o.items.length) {
    return res.status(400).json({ error: "缺少必要訂單資料" });
  }

  if (method === "外送" && total < 200) {
    return res.status(400).json({ error: "外送訂單需滿 $200" });
  }

  if (method === "外送" && !String(o.address || "").trim()) {
    return res.status(400).json({ error: "請填寫外送地址" });
  }

  const order = {
    id: id(),
    createdAt: new Date().toISOString(),
    status: "new",
    name: String(o.name).slice(0, 40),
    phone: String(o.phone).slice(0, 30),
    pickup: o.pickup,
    address: String(o.address || "").slice(0, 160),
    remark: String(o.remark || "").slice(0, 300),
    method,
    items: o.items,
    total
  };

  const orders = readOrders();
  orders.unshift(order);
  writeOrders(orders);

  io.emit("new-order", order);
  res.json(order);

  // LINE 通知失敗不影響客人下單
  if (LINE_NOTIFY_TARGET && LINE_CHANNEL_ACCESS_TOKEN) {
    pushLineMessage(LINE_NOTIFY_TARGET, formatOrderForLine(order))
      .catch(err => console.error("LINE order push failed:", err.message));
  } else {
    console.log("LINE push skipped: LINE_NOTIFY_TARGET 或 LINE_CHANNEL_ACCESS_TOKEN 尚未設定");
  }
});

app.get("/api/orders/:id", (req, res) => {
  const o = readOrders().find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "找不到訂單" });

  res.json({
    id: o.id,
    status: o.status,
    pickup: o.pickup,
    total: o.total,
    createdAt: o.createdAt
  });
});

app.post("/api/admin/login", (req, res) => {
  res.json({ ok: String(req.body?.pin || "") === ADMIN_PIN });
});

app.get("/api/admin/orders", (req, res) => {
  res.json(readOrders());
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
});
