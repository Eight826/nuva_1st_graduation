# 命案遊戲大使身份查詢系統 — 開發需求規範 (PRD)

> **專案目標**：提供命案遊戲大使透過手機掃描 QR Code，輸入個人編號與姓名後，**點擊按鈕隨機抽籤分發角色**之網頁系統，具備比例控制、防呆機制與後端安全防護。

---

## 🛠️ 1. 系統架構與技術選型 (Tech Stack)

* **前端 (Frontend)**：原生 HTML5 + Tailwind CSS (via CDN) + Vanilla JavaScript (ES6+)
* **後端與資料庫 (Backend & DB)**：Firebase (Firestore Database + **Cloud Functions，抽籤與比對邏輯一律在此執行，前端不得自行判定結果**)
* **身分驗證 (Auth)**：Firebase Authentication（僅限管理員登入 admin.html 使用）
* **部署平台 (Hosting)**：Vercel / Firebase Hosting

> ⚠️ **架構鐵則**：抽籤演算法、兇手判定、角色池扣庫存，這三件事**只能發生在 Cloud Functions（Admin SDK 環境）**，前端與 Client SDK 完全不得參與決策，只能發出「請求」與接收「結果」。

---

## 🎨 2. UI/UX 風格規範 (Design Guidelines)

> 視覺風格參考：nuva (https://www.meetnuva.com/) — 極簡深色科技感

* **視覺風格 (Theme)**：極簡深色模式 (Dark Mode)，大量留白、低對比灰階為主體，以單一飽和藍作為唯一強調色，營造科技感與專注感。
* **主色調 (Primary Color)**：`#3B6FE8`（科技藍，用於主要 CTA 按鈕，如「抽取我的遊戲身分」）
* **輔助色 (Secondary Color)**：`#1F1F1F`（次要按鈕、卡片背景，用於「課程詳情」類次要動作）
* **背景顏色 (Background Color)**：`#0A0A0A`（近全黑背景）
* **文字色 (Text Color)**：
  - 主文字（標題）：`#FFFFFF`
  - 次文字（說明、輔助資訊）：`#A3A3A3`
* **邊框/分隔線 (Border Color)**：`#2A2A2A`（極低對比，僅用於區隔卡片邊界）
* **標籤色系 (Tag/Badge Colors)**（用於角色標籤，如「大力士」「品味家」「判斷家」）：
  - 藍色標籤：底 `#1E2A4A` / 字 `#7FA8F5`
  - 綠色標籤：底 `#1B3B2A` / 字 `#6FCB9F`
  - 建議延伸第三色（例如琥珀色）供「判斷家」使用，維持深底淺字的一致調性
* **字體設定 (Typography)**：無襯線體 (Sans-serif)，例如 `Noto Sans TC` 或 `Inter`
* **抽籤/動效需求**：翻牌動畫搭配主色藍光暈 (glow) 效果，卡片邊框以低對比灰階為主、翻牌瞬間邊框短暫亮起藍色，增加科技感的儀式感

---

## 🗄️ 3. 資料庫結構設計 (Firestore Data Schema)

> ⚠️ **關鍵安全設計**：兇手身分與角色池，**必須拆分成前端完全不可讀的獨立 Collection**，而非依賴前端 if/else 判斷是否顯示。Firestore 的欄位級權限管控無法做到條件式過濾，唯一可靠的方式是資料分離。

### Collection 1: `ambassadors_public`（前端可讀，僅含非機密資訊）

| 欄位名稱 (Field) | 型態 (Type) | 說明 (Description) | 範例 (Example) |
| --- | --- | --- | --- |
| `id` | string (Doc ID) | 大使編號 (唯一值) | `"A001"` |
| `name` | string | 大使姓名 | `"張小明"` |
| `role` | string | 分發到的角色名稱 | `"大力士"` |
| `is_drawn` | boolean | 是否已完成抽取/分發 | `true` |
| `drawn_at` | timestamp | 抽籤分發時間 | `2026-07-22 10:00:00` |

**注意：此 Collection 不含 `is_killer` 或任何兇手判定相關欄位。**

### Collection 2: `ambassadors_secret`（前端完全無讀寫權限，僅 Cloud Function 用 Admin SDK 存取）

| 欄位名稱 (Field) | 型態 (Type) | 說明 (Description) |
| --- | --- | --- |
| `id` | string (Doc ID) | 對應大使編號 |
| `is_killer` | boolean | 是否為兇手身分 |
| `role` | string | 角色名稱（供後台核對用） |

Firestore Security Rules：
```
match /ambassadors_secret/{id} {
  allow read, write: if false; // 前端與用戶端一律拒絕，只能透過 Cloud Function (Admin SDK) 存取
}
```

### Collection 3: `system_config`（角色池庫存，Transaction 專用）

* `role_pool.remaining`: `{ "大力士": 2, "品味家": 1, "判斷家": 1 }`（依比例預先設定的剩餘名額）
* 扣庫存**只能透過 Cloud Function 內的 `runTransaction` 執行**，禁止前端直接寫入

### Collection 4: `checkin_codes`（防代抽驗證碼，取代不可靠的 device_id）

| 欄位名稱 (Field) | 型態 (Type) | 說明 (Description) |
| --- | --- | --- |
| `ambassador_id` | string | 對應大使編號 |
| `pin` | string | 報到時發放的一次性 PIN 碼 |
| `used` | boolean | 是否已使用 |

> **已移除 `device_id` 欄位**：device_id 僅為前端 localStorage 產生的 UUID，清除瀏覽器資料、換裝置、無痕模式皆可繞過，屬於「假防呆」。真正防重複抽籤與防代抽，改用以下兩層機制：
> 1. **`is_drawn` 狀態鎖**（伺服器端 transaction 判定，防止重複抽籤）
> 2. **`checkin_codes` 一次性 PIN**（報到時紙本發放，防止他人代抽）

---

## 🖥️ 4. 頁面與詳細功能規格 (Pages & Features)

### 📄 頁面一：前台大使登入與抽籤頁面 (`index.html`)

#### 步驟

1. **步驟 1：身份輸入區**
   * 大使編號、大使姓名、報到 PIN 碼（三個輸入框）
   * 「進入驗證」按鈕：呼叫 Cloud Function 檢查編號、PIN 是否正確且未使用過

2. **步驟 2：隨機抽籤互動區**
   * 驗證通過且 PIN 未使用、`is_drawn == false` 時，顯示「🎲 抽取我的遊戲身分」按鈕
   * 點擊後呼叫 `drawRole` Cloud Function（見第 5 節邏輯），前端**只發送請求，不參與運算**

3. **步驟 3：身份結果顯示卡片**
   * 顯示：大使編號、大使姓名、抽到的角色
   * Cloud Function 回傳內容**本來就不包含 `is_killer`**，前端無需也無法做任何遮蔽判斷——因為這個欄位從未被送到前端

#### 防呆與限制機制

* **一人限抽一次**：Cloud Function transaction 內判定 `is_drawn`，伺服器端鎖定，不受裝置、瀏覽器影響
* **PIN 碼防代抽**：PIN 使用後立即標記 `used = true`，同一 PIN 無法重複使用
* **重複登入處理**：若編號已抽過牌，直接從 `ambassadors_public` 讀取已抽到的角色顯示，不再顯示抽籤按鈕

---

### 📄 頁面二：後台管理員頁面 (`admin.html`)

> ⚠️ **必須登入才能存取**：整頁需 Firebase Authentication 保護，非管理員帳號一律導回登入頁。

#### 身分驗證機制

* 管理員以 Email/密碼登入 Firebase Authentication
* 後端用 Custom Claims 標記 `{ admin: true }`
* 所有管理操作（重置、調整角色池、匯出）皆由 Cloud Function 執行，並在函式內檢查：
  ```javascript
  if (!context.auth || context.auth.token.admin !== true) {
    throw new functions.https.HttpsError('permission-denied', '無權限');
  }
  ```
* Firestore Security Rules 亦同步限制：`allow write: if request.auth.token.admin == true;`

#### 功能

1. **即時抽籤統計儀表板**：顯示已分發人數、各角色分發比例（讀取 `ambassadors_public` + `system_config`，不涉及機密欄位）
2. **大使資料總表**：編號、姓名、抽到角色、抽籤時間（來自 `ambassadors_public`）
3. **【重置單一大使】**：呼叫 Cloud Function 重置 `is_drawn`，並同步作廢舊 PIN、核發新 PIN
4. **【調整角色池】**：透過 Cloud Function 修改 `system_config`，避免前端直接寫入造成資料不一致
5. **【匯出名單】**（見下方風險說明）

#### 匯出功能的劇透風險控管

* **預設匯出**：僅匯出 `ambassadors_public`（編號、姓名、角色、抽籤時間），**不含兇手身分**，可安全在遊戲進行中使用（如核對報到）
* **完整結局匯出**（含 `is_killer`）：獨立按鈕「匯出完整結局名單（含兇手身分）」，點擊後需二次確認彈窗：
  > 「此檔案包含兇手身分，請勿在遊戲進行中外流，是否確定匯出？」
* 此匯出功能對應的 Cloud Function 同樣需驗證 `context.auth.token.admin == true`，前端不得直接讀取 `ambassadors_secret` 自行拼裝檔案

---

## 🔄 5. 詳細業務邏輯與流程圖 (Business Logic Flowchart)

```text
==================================================================================
【前台大使登入 -> 點擊按鈕隨機分發身分 流程圖】
==================================================================================

                   [ 1. 大使掃描 QR Code 開啟網頁 ]
                                  │
                                  ▼
              [ 輸入 大使編號 + 大使姓名 + 報到 PIN 碼 ]
                                  │
                                  ▼
                       [ 點擊「進入驗證」按鈕 ]
                                  │
                                  ▼
           [ Cloud Function 查詢 ambassadors_public + checkin_codes ]
                                  │
                  ┌───────────────┴───────────────┐
            (PIN 錯誤/已使用)              (PIN 正確且未使用)
                  │                               │
                  ▼                               ▼
        [ 阻擋！顯示驗證失敗 ]          [ 檢查 is_drawn 狀態 ]
                                                    │
                                    ┌───────────────┴───────────────┐
                              (已抽過)                        (未抽過)
                                    │                               │
                                    ▼                               ▼
                       [ 直接顯示已抽到的角色 ]      [ 顯示「隨機抽取身分」按鈕 ]
                                                                    │
                                                                    ▼
                                          [ 2. 大使點擊「隨機抽取身分」按鈕 ]
                                                                    │
                                                                    ▼
                                    [ 呼叫 drawRole Cloud Function ]
                                    - runTransaction 讀取 system_config 角色池
                                    - 依 2:1:1 比例隨機抽取角色（伺服器端運算）
                                    - 扣除角色池庫存並寫回（transaction 保證原子性）
                                    - 寫入 ambassadors_public（role, is_drawn, drawn_at）
                                    - 寫入 ambassadors_secret（is_killer，前端不可讀）
                                    - PIN 標記為 used
                                    - 僅回傳角色名稱給前端
                                                                    │
                                                                    ▼
                                      [ 3. 前端渲染角色卡片 ]
                                      （前端從未收到 is_killer，無需也無法判斷遮蔽）


==================================================================================
【後台主辦方管理流程圖】
==================================================================================

                [ 管理員以 Email/密碼登入 Firebase Auth ]
                                  │
                        ┌─────────┴─────────┐
                   (驗證失敗)              (驗證成功 + admin claim)
                        │                       │
                        ▼                       ▼
              [ 導回登入頁，拒絕存取 ]   [ 進入 admin.html 後台 ]
                                                  │
                                                  ▼
                              [ Firestore 監聽 ambassadors_public ]
                                                  │
                              [ 即時監控各角色分發比例 ]
                                                  │
             ┌────────────────────┬──────────────┴──────┬────────────────────┐
             ▼                    ▼                     ▼                    ▼
     【重置單一大使】      【調整角色池名額】      【匯出一般名單】     【匯出完整結局名單】
             │                    │                     │                    │
             ▼                    ▼                     ▼                    ▼
   [ Cloud Function：     [ Cloud Function：    [ 匯出 ambassadors_    [ 二次確認彈窗 ]
     重置 is_drawn、        更新 role_pool        public，不含           │
     作廢舊PIN、發新PIN ]   庫存數 ]              is_killer ]             ▼
                                                                  [ 驗證 admin claim
                                                                    後匯出含 is_killer
                                                                    的完整名單 ]
```

---

## 🎯 6. 給 Cursor 的 Prompt 範例

將這份規格檔案存為 `PRD.md` 後，在 Cursor 中直接貼上以下指令：

> *"請閱讀 `@PRD.md`。請幫我實作 `index.html`（大使抽籤前台）、`admin.html`（管理員後台）與對應的 Cloud Functions（`drawRole`、`resetAmbassador`、`adjustRolePool`、`exportRoster`、`exportFinalRoster`）。*
>
> *關鍵要求：*
> *1. 抽籤演算法、角色池扣庫存、兇手判定，全部只能在 Cloud Functions 內用 Admin SDK 執行，前端不得接觸未過濾的完整角色資料，也不得自行運算抽籤結果。*
> *2. 角色池扣庫存使用 Firestore `runTransaction`，避免並發競態導致比例跑掉。*
> *3. 兇手身分資料存在獨立的 `ambassadors_secret` Collection，Security Rules 設為前端完全不可讀寫。*
> *4. 防重複抽籤與防代抽，使用『is_drawn 狀態鎖 + 報到 PIN 碼一次性驗證』，不要使用 device_id/localStorage 這類前端可繞過的機制。*
> *5. admin.html 需要 Firebase Authentication + Custom Claims 保護，未登入管理員帳號一律拒絕存取與寫入。*
> *6. 匯出功能預設不含兇手身分，若要匯出含兇手的完整結局名單，需要二次確認彈窗且伺服器端驗證管理員權限。"*
