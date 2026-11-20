# Proposal

## Why

老師目前沒有可依 Guided Notes 試算表自動建立題目集的流程；若手動逐題輸入，容易漏題，也難以保證不同版面都能正確辨識題號與題組。此 change 對應 SpecKit 組 001，定義 Google 試算表匯入、解析預覽與確認建立題目集的行為，並以共同需求基準 v0.4 和 T1～T5 fixtures 作為一致的驗收依據。

## What Changes

- 新增 Guided Notes 匯入能力：接受 Google 試算表網址，讀取表格並依表頭與儲存格結構偵測題目，不假設固定欄位或列號。
- 匯入預覽列出總題數、單題或題組、各小題作答格位置及警告；老師確認前不得建立題目集。
- 定義可供不同來源共用的格狀資料解析，以及 Google Sheets API 主流程與 `.xlsx` 測試／備援讀取來源。
- 對網址、權限、表頭、題數及重複或無法解析題號提供明確錯誤；服務帳號 email 須顯示於權限錯誤。
- `{{答}}` 標記不在本 change 實作，解析設計保留未來擴充點。
- Q11～Q13 的重新定位、寫回、備份與還原行為不在本 change，留給後續匯出 change。

## Capabilities

### New Capabilities

- `guided-notes-import`: 從 Google 試算表偵測 Guided Notes 題目，呈現預覽並在老師確認後建立題目集。

### Modified Capabilities

無。專案目前沒有既有 capability spec。

## Impact

- 新增匯入解析器、來源轉接器、預覽與題目集建立流程；技術棧預設 TypeScript（Node.js）。
- Google Sheets API 為主要線上來源；Google 服務帳號憑證置於 repo 外，使用環境變數指定。`.xlsx` 轉接器供離線自動測試與備援使用。
- 自動化驗收使用 `tests/fixtures/guided-notes/` 的六份 `.xlsx` 檔案；另安排人工測試，將真實 Google 試算表 T1～T5 與相應 `.xlsx` 解析結果比對。
- 題目敘述擷取、候選格已填滿、標籤右側無可用格、無法解析題號及零題時的處置，列為待與 SpecKit 組對齊的預設，詳見 `design.md`。
- 不包含答案回寫；Q11～Q13 留待後續匯出 change。
