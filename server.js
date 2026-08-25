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

function normalizeOrderId(input) {
  const m = String(input || "").toUpperCase().match(/YP[A-F0-9]{8}/);
  return m ? m[0] : "";
}

function findOrderById(orderId) {
  if (!orderId) return null;
  return readOrders().find(
    o => String(o.id || "").toUpperCase() === orderId.toUpperCase()
  ) || null;
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

function formatOrderStatusReply(order) {
  const method = order.method === "外送" ? "🛵 外送" : "🏪 門市自取";
  const lines = [
    `訂單編號：${order.id}`,
    `目前狀態：${statusText(order.status)}`,
    method,
    `時間：${order.pickup}`,
    `金額：$${order.total}`
  ];

  if (order.method === "外送" && order.address) {
    lines.push(`地址：${order.address}`);
  }

  if (order.status === "new") lines.push("店家尚未接單，請稍候。");
  if (order.status === "accepted") lines.push("店家已確認訂單，準備開始製作。");
  if (order.status === "making") lines.push("飲品正在製作中，請稍候。");
  if (order.status === "done") lines.push("訂單已完成，請依取餐／配送方式留意通知。");
  if (order.status === "cancelled") lines.push("此訂單已取消，如有疑問請聯絡店家。");

  return lines.join("\n");
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "yipin-order",
    lineConfigured: Boolean(LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET)
  });
});

// LINE Developers Webhook
// LIFF 的文字訊息會以「客人本人」身分送進目前聊天，
// LINE Platform 再把該文字訊息事件送到這個 webhook。
// 這裡用 replyToken 讓「一品現泡茶官方帳號」立即回覆該客人。
app.post("/webhook", async (req, res) => {
  if (!verifyLineSignature(req)) {
    return res.status(401).send("Invalid signature");
  }

  // 先回 200，避免 webhook timeout
  res.sendStatus(200);

  const events = Array.isArray(req.body?.events) ? req.body.events : [];

  for (const event of events) {
    try {
      if (
        event.type !== "message" ||
        event.message?.type !== "text"
      ) {
        continue;
      }

      const message = String(event.message.text || "").trim();

      // 1) LIFF 下單後送回官方帳號聊天室的訂單文字
      if (message.startsWith("🧋 一品現泡茶｜訂單成立")) {
        const orderId = normalizeOrderId(message);
        const order = orderId ? findOrderById(orderId) : null;

        if (order) {
          await replyLineMessage(
            event.replyToken,
            [
              "✅ 一品現泡茶已收到您的訂單",
              `訂單編號：${order.id}`,
              `目前狀態：${statusText(order.status)}`,
              order.method === "外送" ? "🛵 外送" : "🏪 門市自取",
              `金額：$${order.total}`,
              "",
              "店家確認後即可開始製作。",
              `之後可傳「查訂單 ${order.id}」查看最新狀態。`
            ].join("\n")
          );
        } else {
          await replyLineMessage(
            event.replyToken,
            "✅ 一品現泡茶已收到您的訂單訊息。若需要查詢進度，請傳「查訂單 + 訂單編號」。"
          );
        }
        continue;
      }

      // 2) 訂單查詢
      if (
        message === "查訂單" ||
        message === "訂單查詢" ||
        message === "訂單"
      ) {
        await replyLineMessage(
          event.replyToken,
          "請輸入：查訂單 + 訂單編號\n例如：查訂單 YP48CC459E"
        );
        continue;
      }

      if (
        message.startsWith("查訂單") ||
        message.startsWith("訂單查詢")
      ) {
        const orderId = normalizeOrderId(message);

        if (!orderId) {
          await replyLineMessage(
            event.replyToken,
            "找不到訂單編號，請輸入完整格式，例如：\n查訂單 YP48CC459E"
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

        await replyLineMessage(
          event.replyToken,
          formatOrderStatusReply(order)
        );
        continue;
      }

      // 3) 菜單 / 點餐快捷文字
      if (message === "菜單" || message === "查看菜單") {
        await replyLineMessage(
          event.replyToken,
          "📋 一品現泡茶線上菜單：\nhttps://liff.line.me/2011256472-3TidlkYv"
        );
        continue;
      }

      if (message === "點餐" || message === "開始點餐") {
        await replyLineMessage(
          event.replyToken,
          "🧋 點這裡開始點餐：\nhttps://liff.line.me/2011256472-3TidlkYv"
        );
        continue;
      }

      // 4) 測試 Webhook
      if (message === "測試訂單通知") {
        await replyLineMessage(
          event.replyToken,
          "✅ LINE Webhook 已連線成功。"
        );
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

  if (
    !o.name ||
    !o.phone ||
    !o.pickup ||
    !Array.isArray(o.items) ||
    !o.items.length
  ) {
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

  // 不再 Push 到固定私人 LINE。
  // 客人端 LIFF 會把訂單文字送進「客人 ↔ 官方帳號」聊天室，
  // 然後 webhook 透過 replyToken 由官方帳號即時回覆。
  res.json(order);
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
  res.json({
    ok: String(req.body?.pin || "") === ADMIN_PIN
  });
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

  if (!o) {
    return res.status(404).json({ error: "找不到訂單" });
  }

  o.status = status;
  o.updatedAt = new Date().toISOString();
  writeOrders(orders);

  io.emit("order-updated", o);
  res.json(o);
});

io.on("connection", socket => {
  socket.emit("server-ready", {
    at: new Date().toISOString()
  });
});

server.listen(PORT, () => {
  console.log(`一品現泡茶 order system listening on :${PORT}`);
});
