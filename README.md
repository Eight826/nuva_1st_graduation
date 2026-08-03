# Nuva Graduation — 命案遊戲大使身份查詢系統

大使掃 QR → PIN 驗證 → 後端抽籤 → 組隊解謎多幕 → 終場／證書。  
**抽籤、兇手、角色池、組進度只在 Cloud Functions（Admin SDK）判定**；前端只送請求與顯示。

更細的廢碼審計與呼叫矩陣見 [`docs/architecture-and-dead-code.md`](docs/architecture-and-dead-code.md)。  
產品規格背景：[`docs/PRD.md`](docs/PRD.md)（部分章節可能落後，以本 README／架構文件為準）。

```text
前端 public/  ──httpsCallable──►  後端 functions/
       │                              │
       └── 公開讀 onSnapshot ────────►│
                                      ▼
                              Firestore 資料庫
                                      ▲
                              scripts/（本機維運）
```

---

## 一、前端（`public/` → Firebase Hosting）

原生 HTML + Tailwind CDN + Vanilla JS（Firebase compat SDK）。

### 頁面

| URL | 用途 |
| --- | --- |
| `/` | 導向 `/certificate.html`（領取證書） |
| `/certificate.html` | 活動結束後領取證書（僅編號＋姓名，無需 PIN） |
| `/join.html` | 組隊大廳 |
| `/opening.html` → `/act1.html` → `/act2.html` → `/act3.html` → `/act4.html` → `/waiting.html` → `/finale.html` | 解謎各幕 |
| `/admin.html` | 管理後台（需 Auth + admin claim） |
| `/print.html` | PIN 列印 |
| `/qr.html` | 現場 QR |
| `/404.html` | 錯誤頁 |

幕順序：`lobby` → `opening` → `act1` → `act2` → `act3` → `act4` → `waiting` → `finale`

### 腳本

| 檔案 | 職責 |
| --- | --- |
| `js/config.js` | Firebase Web 設定 |
| `js/app.js` | 驗證／抽籤／結果／觸發證書 |
| `js/certificate.js` | 客戶端產生證書 PDF |
| `js/cert-claim.js` | 領取證書頁：編號＋姓名驗證後下載 |
| `js/puzzle.js` | 解謎 session、幕守衛、進度、組狀態 |
| `js/act-page.js` | 敘事幕共用（opening／act1／act3） |
| `js/admin.js` | 後台監控與操作 |

### 靜態資產（`assets/`）

- `qr.png` — QR 頁
- `第二幕判斷家謎題.png` — 第二幕
- `電子證書正式版.pdf` + `fonts/NotoSansTC-Bold-subset.ttf` — 證書

第二幕現況：玩家看謎題、現場回報；**後台 `passAct2Role` 一鍵通過**各角色任務。

---

## 二、後端（`functions/` → Cloud Functions，`asia-east1`）

全部業務在 `functions/index.js`。

### 抽籤／身分

| 函式 | 說明 |
| --- | --- |
| `verifyCheckin` | 編號＋姓名＋PIN；已抽回查；工作人員固定身分 |
| `drawRole` | Transaction 抽角色／兇手 |
| `createPuzzleSession` | 發解謎 session（工作人員為 preview） |

### 管理（需 admin claim）

| 函式 | 說明 |
| --- | --- |
| `ensureAdminClaim` | 提升 admin claim |
| `resetAmbassador` | 重置抽籤／PIN |
| `exportPinRoster` | PIN 列印資料 |
| `getKillerAssignment` / `setKiller` | 查／指定犯人 |
| `adjustRolePool` | 調角色池 |
| `exportRoster` / `exportFinalRoster` | 匯出名單（後者含兇手） |

### 解謎／組別

| 函式 | 說明 |
| --- | --- |
| `initPuzzleGroups` | 建立／重置 G01–G15 |
| `unlockOpening` / `unlockFinale` | 全場開場／終場閘門 |
| `designateSilencersAndUnlockAct4` | 指定滅口者並解鎖第四幕 |
| `listPuzzleGroups` | 後台組列表 |
| `getPuzzleState` | 玩家狀態＋組＋全域旗標 |
| `joinGroup` / `leaveGroup` | 入組／退組 |
| `adminMoveMember` | 後台調組 |
| `advanceAct` | 推進組進度 |
| `submitAct4Accusation` | 第四幕指認 |
| `passAct2Role` | 後台通過第二幕某角色任務 |
| `submitAct2Answer` / `setPuzzleAnswers` | 舊線上驗答路徑（前端現況未用） |
| `health` | HTTP 探活 |

### 本機維運（不上線）

| 指令 | 作用 |
| --- | --- |
| `cd scripts && npm run seed` | 匯入大使、PIN、角色池 |
| `npm run mark-attendance` | 標記出席 |
| `npm run mark-staff` | 固定工作人員 |
| `npm run create-admin` | 建管理員帳號 |

輸入：`scripts/data/ambassadors.csv`（fallback：`大使名單-工作表1.csv`）、`attendees.csv`、`staff.csv`。  
機密產出：`scripts/output/`（gitignore）。

---

## 三、資料庫（Firestore）

規則：`firestore.rules`。專案：`nuva-guraduation`。

| Collection | Client 讀 | Client 寫 | 用途 |
| --- | --- | --- | --- |
| `ambassadors_public` | 公開 | 禁止 | 姓名、角色、`is_drawn`、`is_attending`、`is_staff`、`group_id` |
| `ambassadors_secret` | 禁止 | 禁止 | `is_killer` 等 |
| `checkin_codes` | 禁止 | 禁止 | PIN、`used` |
| `system_config/main` | 僅 admin | 禁止 | 角色池、犯人設定、`puzzle.*` |
| `groups/{G01–G15}` | 公開 | 禁止 | 組碼、槽位、成員、`currentAct`、`act2`、`act4` |
| `group_codes/{code}` | 禁止 | 禁止 | code → `group_id` |
| `puzzle_sessions/{token}` | 禁止 | 禁止 | 解謎短時登入（TTL 12h） |

`system_config/main` 重點：`role_pool.remaining`、`killer.*`、`puzzle.openingUnlocked`／`act4Unlocked`／`finaleUnlocked`、`silencers`、`answers`。

---

## 常用指令

```bash
# 部署全站
npx firebase-tools@latest deploy

# 只部署前端
npx firebase-tools@latest deploy --only hosting

# 只部署後端函式
npx firebase-tools@latest deploy --only functions

# 種子／出席／工作人員／管理員（見上方「本機維運」）
cd scripts && npm install && npm run seed
cd scripts && npm run mark-attendance -- --create-missing --sync-pool
cd scripts && npm run mark-staff
cd scripts && npm run create-admin
```

---

## 機密與不要動錯的地方

- `scripts/output/` — PIN、管理員密碼，已忽略 git
- `serviceAccountKey.json` — Admin SDK 金鑰，勿提交
- `firestore.rules` — 改錯會讓機密 collection 外洩
- `functions/index.js` — 業務核心；改前台不會改變抽籤結果
