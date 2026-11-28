# Proposal

## Why

現行匯入器依表頭和 Q7 標籤推定作答格；版面變動或答案框位置不規則時，老師無法明確指定真正的作答格。共同需求基準 v0.7 的 Q8 提供選用的 `{{答}}` 標記，讓老師以儲存格內容明確定位，同時保留沒有標記時既有解析結果。

## What Changes

- 表頭以下任一格含有正規化後的 `{{答}}` 時，整份試算表進入標記模式，只有含標記的格子作為作答格；沒有標記時沿用現行表頭模式且結果不變。
- 依 Q3 將標記格歸入題目，同題標記依列、欄排序成小題；依 Q8／Q7 解析標籤，並忽略標記本身判定作答格是否已有內容。
- 預覽標示定位方式，並對首個有效題號前的標記、無法歸屬題號的標記及標記模式內沒有作答格標記的題目，列出含座標的警告。
- 回寫以答案取代標記並保留同格其他文字；預覽分別呈現含標記的原文與替換後完整值，仍以 RAW 寫入，還原時恢復原文。
- 對已回寫而標記已消失的工作表，重新定位時以匯入時保存的題號與作答格座標核對；結構一致才沿用匯入定位，否則停止並提示「請先還原再回寫」。
- **Breaking:** 無。沒有標記的試算表維持現行表頭模式。

## Capabilities

### New Capabilities

（無）

### Modified Capabilities

- `guided-notes-import`: 新增 Q8 顯式作答格標記模式、標記正規化與警告、預覽定位方式，以及含標記內容的安全回寫、重新定位和還原行為。
- `result-export`: 回寫預覽及寫入將保留標記格的前後文字、以原始值寫入完整替換結果，並在來源已完成過標記替換時依匯入座標安全重新定位；還原原始含標記值。

## Impact

- 解析：`src/guided-notes/parser.ts`、`src/guided-notes/model.ts`、匯入預覽與解析測試。
- 回寫：`src/guided-notes/spreadsheet-export-validation.ts`、`src/guided-notes/import-service.ts` 及相關 Google Sheets 服務與測試。
- 測試資料與文件：新增 T6 標記版 fixture，更新 `tests/fixtures/guided-notes/README.md` 和 Guided Notes 解析說明。
- 外部寫入仍使用 Google Sheets RAW 值；服務帳戶權限與現有題目集建立流程不變。
