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
