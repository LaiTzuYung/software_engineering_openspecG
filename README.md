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

格狀資料模型與解析規則見 [Guided Notes 解析器說明](docs/guided-notes-parser.md)。
