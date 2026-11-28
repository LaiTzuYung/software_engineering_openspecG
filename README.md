# 課堂搶答系統（OpenSpec 組）

NCU SE6005 2026 軟體工程期末專題「Vibe Coding 課堂搶答系統」OpenSpec 組實作。老師從線上 Google 試算表匯入 Guided Notes 題目，學生依組別即時搶答，活動結束後把各題成功組的答案透過 Google Sheets API 回寫原試算表，並可匯出 CSV。

全部程式由 AI 代理（Codex）依 OpenSpec 流程（Explore → Propose → Apply → Verify → Sync → Archive）產生，開發者負責需求釐清、規格審查與人工驗證。本組為單人開發。

- Demo 影片：（YouTube 連結）

## 功能

| 需求 | 說明 |
|---|---|
| 老師／學生角色 | 老師頁需輸入 PIN；學生頁以 4 位數活動代碼加入並選擇組別，每個分頁各自保有身分 |
| 匯入 Guided Notes | 直接讀取線上 Google 試算表（Google Sheets API），動態定位題號、題組小題與作答格，不寫死儲存格；先預覽再確認 |
| 開始／結束搶答 | 老師控制「準備中 → 搶答中 → 已結束」，所有頁面即時同步 |
| 學生依組作答 | 同組同題只接受第一筆；題組須所有小題填完才能送出；答案上限 200 字；已送出的題目可展開查看本組答案 |
| 最快者成功 | 依伺服器收到順序判定，每題各自排名（順位從 1 起算），最先送出者為成功組 |
| 結束前看不到他組 | 學生只收到本組白名單資料（含本組自己的答案）；他組送出不會推播給本組；結束後才公布各題成功組與答案 |
| 老師檢視作答 | 即時表格顯示各題、各組的送出狀態、順位與答案；可切換是否向學生顯示題目敘述 |
| 回寫原試算表 | 回寫預覽 → 確認回寫；只寫作答格、不動標籤與題目；寫入前重新讀表比對結構，不一致即中止；本機備份並可還原最近一次回寫 |
| 匯入題組（額外） | 支援題組（多個小題一起送出） |
| 匯出 CSV（額外） | 題號、小題、組別、答案、原始順位、最終順位、是否成功、送出時間、說明；UTF-8 含 BOM |
| 介面改善（額外） | 匯入預覽以表格顯示題號、類型與作答格位置；階段徽章、成功組高亮；學生結束畫面標示「本組搶答成功！」 |

## 環境需求

- Windows 10/11 + PowerShell（其他系統亦可，指令需自行對應）
- Node.js 22
- Chrome 最新版
- Google Cloud 服務帳戶（讀寫線上試算表用）

```powershell
npm install
```

## Google 試算表設定

1. 在 Google Cloud 建立專案，啟用 **Google Sheets API**。
2. 建立**服務帳戶**，新增 JSON 金鑰並下載。**金鑰檔請放在 repo 以外的資料夾**（例如 `C:\Users\<你>\secrets\sa-key.json`），不要放進專案。
3. 打開要使用的 Guided Notes 試算表，按「共用」，加入服務帳戶的 email（金鑰 JSON 裡的 `client_email`）：
   - 只匯入：設為「**檢視者**」
   - 需要回寫答案：設為「**編輯者**」
4. 每次開新的 PowerShell 視窗，啟動前先設定金鑰路徑：

```powershell
$env:GOOGLE_SERVICE_ACCOUNT_KEY_FILE = "C:\Users\<你>\secrets\sa-key.json"
```

[`.env.example`](.env.example) 只列出變數名稱與假路徑，不含任何憑證。

## 啟動

```powershell
$env:GOOGLE_SERVICE_ACCOUNT_KEY_FILE = "C:\Users\<你>\secrets\sa-key.json"
npm start
```

終端機會印出老師頁網址、學生頁網址與老師 PIN（預設 `http://127.0.0.1:3000`）。未設定 `TEACHER_PIN` 時，每次啟動隨機產生 PIN；要固定 PIN：

```powershell
$env:TEACHER_PIN = "your-local-teacher-pin"
npm start
```

本系統只在本機運作，以多個瀏覽器分頁模擬老師與各組學生。

## 操作流程

### 1. 匯入題目

1. 開啟老師頁，輸入 PIN。
2. 在「匯入題目集」貼上 Google 試算表網址（可含 `gid` 指定工作表），按「**預覽**」，以表格確認題數、題組、標籤格與作答格位置（原始資料可展開查看）。
3. 按「**確認匯入**」。題目集保存在 `data/guided-notes/`。

### 2. 建立活動與搶答

1. 在「建立活動」選擇題目集（選單顯示工作表名稱、題數、來源與匯入時間，預設為最新一筆）；組名可自訂，每行一組，留白則使用預設四組。
2. 按「建立活動」，把 **4 位數活動代碼**告訴學生。
3. 學生開啟學生頁，輸入活動代碼、選擇組別並加入。
4. 老師按「**開始搶答**」，所有學生頁同步進入作答。
5. 學生作答並送出；老師表格即時顯示各組送出狀態、各題順位與答案。
6. 老師按「**結束活動**」，學生頁每題一張卡片顯示成功組與答案，本組成功時標示「本組搶答成功！」。

### 3. 回寫試算表與匯出

1. 在「結果匯出」按「**回寫預覽**」，檢查每個作答格的座標、目前內容與預計寫入值。
2. 按「**確認回寫**」。系統會再讀一次試算表，結構有變（例如插入列）就中止且不寫入任何格子。
3. 要復原時按「**還原最近一次回寫**」；已被手動修改過的格子會跳過並列出原因。
4. 按「**下載 CSV**」取得活動結果。

## 測試

```powershell
npm test
```

執行型別檢查與全部自動測試（目前 99 項）。自動測試全部使用 mock，不連線 Google；Socket.IO 與 HTTP 整合測試會啟動 localhost 測試伺服器，請在一般 PowerShell 執行。也可分開執行 `npm run typecheck`、`npm run test:unit`。

人工測試紀錄（含截圖）：

- [import-guided-notes.md](docs/manual-tests/import-guided-notes.md)：T1～T5 線上試算表匯入
- [build-live-buzzer.md](docs/manual-tests/build-live-buzzer.md)：搶答流程、同步、R9 隔離（F12 WebSocket 證據）
- [export-results.md](docs/manual-tests/export-results.md)：權限錯誤、回寫、結構變更中止、還原、CSV
- [ui-polish.md](docs/manual-tests/ui-polish.md)：介面各階段畫面檢查

CLI 匯入預覽（除錯用）：

```powershell
npm run import -- <Google 試算表網址>
```

`.xlsx` 路徑僅供離線測試（`tests/fixtures/guided-notes/` 的 T1～T5），主流程一律使用線上 Google 試算表；XLSX 題目集不能回寫，但可下載 CSV。

## 已知限制與設計決定

- **不判斷答案對錯**：依需求「最快搶答者為成功」，以最先送出的組為成功組；老師可在表格看到所有組的答案。
- **活動資料只存在記憶體**：活動、分組、提交與學生身分在伺服器重新啟動後消失；已匯入的題目集與回寫備份會保留。
- **同時只有 1 個活動**。
- **CSV 送出時間為台灣時間 UTC+8**，格式為 `YYYY-MM-DDTHH:mm:ss+08:00`，精確到秒且不含毫秒；伺服器內部仍記錄 UTC ISO 8601 時間。
- **回寫備份只在本機** `data/spreadsheet-export-backups/`，請勿刪除，否則無法還原。
- 最終順位等於原始順位（未實作公平機制）；說明欄留空。
- 不支援 `{{答}}` 佔位符；標籤右側候選格已有內容時取第一格並警告；標籤右側沒有作答格時退回標籤格。

以上預設已告知 SpecKit 組，詳見 [docs/共同需求基準.md](docs/共同需求基準.md)。

## 專案結構

```
src/guided-notes/      試算表讀取、Guided Notes 解析、匯入與回寫比對
src/live-buzzer/       HTTP／Socket.IO 伺服器、活動模型、老師頁與學生頁、CSV
tests/                 自動測試與 T1～T5 fixtures
openspec/specs/        主規格：guided-notes-import、live-buzzer、result-export
openspec/changes/archive/  已封存的四個 change（proposal、spec、design、tasks）
docs/manual-tests/     人工測試紀錄與截圖
docs/ai-logs/          AI 對話紀錄（scripts/export-codex-logs.mjs 轉出，金鑰已遮蔽）
docs/guided-notes-parser.md  解析器資料模型與規則說明
```

## 安全

- 服務帳戶金鑰放在 repo 外，以環境變數指定路徑。
- `.gitignore` 已排除 `secrets/`、`.env`、`*-key.json`、`service-account*.json`、`data/`。
- AI 對話紀錄提交前皆掃描 `PRIVATE KEY`、`private_key` 等字串。
