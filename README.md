# 課堂搶答系統

## 開發環境

- Node.js 22
- npm

安裝專案相依套件：

```sh
npm install
```

## Guided Notes 解析與 XLSX fixtures

Guided Notes 解析器只處理來源無關的格狀資料。`exceljs` 4.4.0 轉接器將 XLSX 工作表值與合併範圍轉換成內部格狀資料；合併格只有左上角保留值。自動驗收使用 `tests/fixtures/guided-notes/` 的 T1～T5 六份 XLSX，不連線 Google。預期題數、類型與作答格座標見 [fixture README](tests/fixtures/guided-notes/README.md)。

Google Sheets 線上轉接器使用 Google 官方 `googleapis` 189.0.0 套件，並以 `UNFORMATTED_VALUE` 讀取值。執行時只需設定環境變數 `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`，值為 repo 外的服務帳號 JSON 檔路徑；[`.env.example`](.env.example) 只提供變數名稱與假路徑，不含憑證內容。自動測試全部使用 mock，不連線 Google。

執行型別檢查及解析器／fixture 測試：

```sh
npm test
```

僅執行測試：

```sh
npm run test:unit
```

## 活動與搶答

### 啟動伺服器

Node.js 22 安裝相依套件後，在專案根目錄以單一指令啟動：

```powershell
npm install
npm start
```

啟動時終端會列出老師登入頁、學生頁與老師 PIN。未設定 `TEACHER_PIN` 時，伺服器每次啟動會隨機產生 PIN 並印出；也可在 PowerShell 指定固定 PIN：

```powershell
$env:TEACHER_PIN = 'your-local-teacher-pin'
npm start
```

網址預設使用 `http://127.0.0.1:3000`。只把老師 PIN 輸入老師登入頁；學生只使用學生頁與活動代碼。

### 老師與學生操作流程

1. 老師開啟終端列出的老師登入頁，輸入 PIN。
2. 如尚未有題目集，老師在「匯入題目集」輸入既有來源網址，先預覽再確認；Google Sheets 匯入須設定 `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`。確認後的題目集 JSON 保存在 `data/guided-notes/`。
3. 老師選取題目集，可選擇組名（每行一組；留白時使用預設四組），再建立活動並把活動代碼提供給學生。
4. 學生輸入活動代碼、選擇組別並加入。老師開始後學生可作答；題組須填完所有小題再一次送出。老師可切換題目敘述顯示，並即時查看各題、各組的提交、順位與答案。
5. 老師結束活動後，學生頁顯示各題成功組與答案。

### 結果匯出與回寫

1. 活動結束後，老師在「結果匯出」區塊按「回寫預覽」，檢查每個作答格的 A1、目前內容、預計值與狀態，再按「確認回寫」。老師確認即同意覆蓋預覽中的不同內容。
2. 需要復原時按「還原最近一次回寫」。系統只還原目前內容仍等於當次回寫值的格子；被另行修改的格子會跳過並列出原因。
3. 按「下載 CSV」可下載活動結果，包含每筆已接受提交的每個小題。送出時間為伺服器 UTC 時間（ISO 8601）；系統依最快送出判定成功組，不判斷答案對錯。

Google Sheets 回寫使用讀寫權限，首次部署或 scope 變更後須重新授權。服務帳戶必須先共用到要回寫的試算表，並設為「編輯者」；只有檢視權限可讀取但不能回寫。每次回寫的 JSON 備份存於 `data/spreadsheet-export-backups/`，請保留此資料夾以供還原。XLSX 題目集不能回寫線上試算表，但仍可下載 CSV。

活動、分組、提交與學生分頁身分只存在伺服器記憶體；重新啟動伺服器會清空活動及提交。已確認匯入的題目集 JSON 會保留。

### 驗證

在專案根目錄執行完整型別檢查與測試：

```powershell
npm test
```

也可分開執行：

```powershell
npm run typecheck
npm run test:unit
```

Socket.IO 與 HTTP 整合測試會啟動 localhost 測試伺服器；請在允許本機 loopback 的一般 PowerShell 環境執行 `npm test`。測試匯入使用 mock 來源，匯入與活動測試資料使用暫存目錄，不連線 Google，也不在 repo 留下測試用 `data/`。

手動執行一次匯入並查看預覽：

```sh
npm run import -- <Google 試算表網址>
```

CLI 先列出題數、單題／題組、小題標籤格與作答格位置及警告，再詢問是否建立題目集。輸入 `y` 才會把預覽寫入 `data/guided-notes/`；其他輸入會取消且不建立 JSON。Google 試算表匯入需設定 `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`。`.xlsx` 路徑模式僅供離線測試：

```sh
npm run import -- tests/fixtures/guided-notes/T1-single.xlsx
```

預覽與題目集服務只接收解析器的來源無關解析結果。測試使用作業系統暫存目錄，結束時會清除，不會在 repo 留下 `data/` 測試檔。

### 待與 SpecKit 組對齊

- 題目敘述欄存在時擷取，沒有題目欄時留空。
- 標籤右側候選格都有內容時，選第一格並顯示警告，老師仍可確認。
- 標籤右側沒有可用作答格時，作答格退回標籤格。
- 題目集確認後暫存於記憶體，並保存為 `data/guided-notes/` 下的 JSON；請確認此儲存方式與路徑。

格狀資料模型與解析規則見 [Guided Notes 解析器說明](docs/guided-notes-parser.md)。
