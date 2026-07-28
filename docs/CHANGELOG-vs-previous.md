# 本版相對上一版 push 的差異

- **基準（上一版已 push）**：`2f7389a` — Merge pull request #4（admin 指定犯人合併至 main）
- **本版主題**：固定「工作人員」身分（9 位），不進遊戲抽籤，角色池改依可抽籤名額重算
- **日期**：2026-07-28

## 摘要

相對上一版 GitHub `origin/main`，本版新增固定工作人員流程：雙重標記（`is_staff` + `role: 工作人員`）、腳本維護、Cloud Functions 防護，以及前後台顯示。

## 行為變更

| 項目 | 上一版 | 本版 |
| --- | --- | --- |
| 工作人員身分 | 無 | 9 人固定為工作人員，可 PIN 登入直接看到身分 |
| 遊戲抽籤 | 出席者皆可抽 | 工作人員不可抽遊戲角色 |
| 角色池 | 依出席人數（例：69） | 依出席且非工作人員的可抽籤名額（例：60） |
| 後台重置 | 已抽者可重置 | 工作人員不可重置（固定身分） |
| 指定犯人 | 出席者皆可被指定 | 工作人員不可被指定為犯人 |

## 工作人員名單（`scripts/data/staff.csv`）

| 編號 | 姓名 |
| --- | --- |
| 0 | 林上哲 |
| 2 | 邱品瑄 |
| 3 | 顏靖衡 |
| 27 | 吳畇臻 |
| 128 | 呂允仁 |
| 227 | 王舶宇 |
| 311 | 黃聖威 |
| 331 | 曾亞玲 |
| 367 | 黃湘吟 |

資料標記（寫入 Firestore）：

```bash
cd scripts && npm run mark-staff
```

## 檔案異動

### 新增

- `scripts/data/staff.csv` — 固定工作人員名單
- `scripts/markStaff.js` — 標記 `is_staff` / `role` / `is_drawn`，並重算 `role_pool`
- `docs/CHANGELOG-vs-previous.md` — 本說明檔

### 修改

- `functions/index.js` — `verifyCheckin` / `drawRole` / `resetAmbassador` / `setKiller` 工作人員防護；`publicPayload` 回傳 `is_staff`
- `public/js/admin.js` — 總表／統計顯示工作人員；排除犯人選單；禁用重置
- `public/js/app.js` — 「工作人員」標籤樣式
- `scripts/lib/common.js` — `loadStaffIds` / `isStaffRecord` 等共用輔助
- `scripts/seed.js` / `scripts/markAttendance.js` — 尊重 `staff.csv`，角色池排除工作人員
- `scripts/package.json` — 新增 `npm run mark-staff`
- `README.md` — 補上記錄指令

### 未納入本次 commit

- `.agents/`、`skills-lock.json`（本機 agent 設定）
- `scripts/data/nuvacampus_結業典禮參加者名單_2026-07-13.csv`（未追蹤的資料備份）

## 部署狀態（備註）

- Functions + Hosting 曾於本機部署至 `nuva-guraduation`
- Firestore 工作人員標記需另跑 `npm run mark-staff`（需有效 Firebase / 服務帳號憑證）
