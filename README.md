# Nuva Graduation — 命案遊戲大使身份查詢系統

大使掃 QR → 輸入編號／姓名／PIN → 後端抽籤分發角色。  
機密邏輯只在 Cloud Functions（Admin SDK），前端只負責送請求與顯示結果。

---

## 專案架構一覽

```
nuva_graduation/
│
├── README.md                 ← 你正在看的架構說明
├── .env.example              ← 本機環境變數範本
├── .firebaserc               ← Firebase 專案綁定
├── firebase.json             ← Hosting / Functions / Firestore 設定
├── firestore.rules           ← 安全規則（誰能讀寫什麼）
├── firestore.indexes.json    ← Firestore 索引
│
├── docs/                     ← 文件（規格，不進部署）
│   └── PRD.md
│
├── public/                   ← 前端（Firebase Hosting 對外網站）
│   ├── index.html            ← 大使抽籤前台  /
│   ├── admin.html            ← 管理後台      /admin.html
│   ├── print.html            ← PIN 列印頁    /print.html
│   ├── qr.html               ← QR 展示頁     /qr.html
│   ├── 404.html
│   ├── js/                   ← 前端腳本
│   │   ├── app.js            ← 前台抽籤邏輯
│   │   ├── admin.js          ← 後台即時監控
│   │   ├── config.js         ← Firebase Web 設定（可提交）
│   │   └── config.example.js ← 設定範本
│   └── assets/               ← 靜態圖檔
│       └── qr.png
│
├── functions/                ← 後端 Cloud Functions（抽籤／驗證／管理）
│   ├── index.js              ← 全部 callable 函式
│   └── package.json
│
└── scripts/                  ← 本機維運腳本（不部署）
    ├── seed.js               ← 匯入大使名單、產生 PIN、初始化角色池
    ├── createAdmin.js        ← 建立管理員帳號
    ├── package.json
    ├── data/                 ← 輸入資料（CSV 名單）
    │   └── ambassadors.csv
    └── output/               ← 腳本產出（機密，已 gitignore）
        ├── pin-roster.csv
        ├── pin-roster.txt
        └── admin-credentials.txt
```

---

## 各資料夾負責什麼

| 路徑 | 職責 | 會不會上線 |
| --- | --- | --- |
| `public/` | 使用者看到的網頁 | ✅ Hosting |
| `functions/` | 抽籤、PIN 驗證、兇手判定、角色池扣庫存 | ✅ Cloud Functions |
| `scripts/` | 種子資料、建管理員 | ❌ 只在本機跑 |
| `docs/` | PRD／規格文件 | ❌ |
| 根目錄 `firebase*` / `firestore*` | 部署與安全設定 | ✅ 部署時讀取 |

---

## 頁面對照

| URL | 檔案 | 給誰用 |
| --- | --- | --- |
| `/` | `public/index.html` + `js/app.js` | 大使抽籤 |
| `/admin.html` | `public/admin.html` + `js/admin.js` | 管理員（需登入） |
| `/print.html` | `public/print.html` | 列印報到 PIN |
| `/qr.html` | `public/qr.html` + `assets/qr.png` | 現場展示 QR |

---

## 資料流（維護時最重要）

```
大使 CSV (scripts/data/)
        │
        ▼  npm run seed
Firestore
  • ambassadors_public   ← 前端可讀（姓名、角色、是否已抽）
  • ambassadors_secret   ← 僅 Functions 可讀（兇手等機密）
  • checkin_codes        ← PIN 驗證
  • system_config        ← 角色池剩餘名額
        │
        ▼  前台呼叫 Cloud Functions
抽籤結果回傳前端顯示
```

**鐵則**：抽籤、兇手、扣庫存，只能在 `functions/index.js` 發生，前端不得自行判定。

---

## 常用指令

```bash
# 部署全站
npx firebase-tools@latest deploy

# 只部署前端
npx firebase-tools@latest deploy --only hosting

# 只部署後端函式
npx firebase-tools@latest deploy --only functions

# 種子資料（匯入名單 + 產生 PIN）
cd scripts && npm install && npm run seed

# 依 attendees.csv 標記實體出席（不重發 PIN；建議加 --sync-pool）
cd scripts && npm run mark-attendance -- --create-missing --sync-pool

# 建立管理員
cd scripts && npm run create-admin
```

種子跑完後，PIN 對照表會寫到 `scripts/output/`（勿提交、勿外流）。

---

## 機密與不要動錯的地方

- `scripts/output/` — PIN、管理員密碼，已忽略 git
- `serviceAccountKey.json` — Admin SDK 金鑰，放根目錄本機用，勿提交
- `firestore.rules` — 改錯會讓機密 collection 外洩
- `functions/index.js` — 業務核心；改前台不會改變抽籤結果

詳細產品規格見 [`docs/PRD.md`](docs/PRD.md)。
