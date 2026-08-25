# 一品現泡茶｜LINE → 線上點餐 → 回到 LINE

## 目標流程
官方 LINE
→ 點「線上點餐」
→ 開啟一品現泡茶點餐網站
→ 選飲料／加料／甜度／冰量
→ 購物車
→ 選自取時間
→ 送出訂單
→ 店家後台收到 🔔 新訂單
→ 客人按「完成訂單／回到 LINE」
→ 如果網站是在 LINE App 內以 LIFF 開啟，會直接關閉 LIFF 視窗回到 LINE。

## 重要
要做到「從 LINE 開啟網站，完成後自動回到 LINE」，正式上線時需要：
1. 建立 LINE LIFF App
2. 將正式網站網址設定為 LIFF Endpoint URL
3. 把 LIFF ID 寫入前端
4. 在 LINE 官方帳號的圖文選單／Rich Menu／訊息按鈕放入 LIFF URL

目前程式已加入 LIFF SDK 與回到 LINE 的邏輯，但尚未填入正式 LIFF ID；因此不能在未設定 LIFF 的狀態下保證自動回 LINE。

## 店家後台
新訂單 🔔 → 接單 → 製作中 → 已完成。

## QR Code
已依需求從點餐網站刪除官方 LINE QR Code。
