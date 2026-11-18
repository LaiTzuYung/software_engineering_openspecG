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

執行型別檢查及解析器／fixture 測試：

```sh
npm test
```

僅執行測試：

```sh
npm run test:unit
```

格狀資料模型與解析規則見 [Guided Notes 解析器說明](docs/guided-notes-parser.md)。
