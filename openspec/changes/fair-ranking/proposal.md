# Proposal

## Why

純速度會讓同一組在多題活動中連續取得多個成功名額，降低其他組的成功機會。此 change 新增可選的均分上限機制，並讓老師畫面、學生結果、CSV 與試算表回寫使用同一套伺服器重算結果。

## What Changes

- 老師建立活動時選擇「純速度」（預設）或「均分上限」；準備中可更改，搶答開始後鎖定，伺服器拒絕更改並提供中文原因。
- 均分上限依活動總題數與組數計算 `⌈題數 ÷ 組數⌉`，按全活動伺服器序號跨題逐筆處理；達上限提交保留原始順位、跳過且沒有最終順位，後續提交均跳過。
- 為提交結果提供原始順位、最終順位、成功狀態及精確的跳過、遞補和整題無成功組說明；純速度結果維持現行行為。
- 老師結果表與學生結束結果、CSV、回寫統一採用依活動規則重算的成功組；學生搶答中不得取得順位、跳過或成敗資訊。
- **Breaking:** CSV 的最終順位、成功與說明欄在均分上限規則下依新規則輸出；回寫成功答案可能來自遞補組。

## Capabilities

### New Capabilities

（無）

### Modified Capabilities

- `live-buzzer`: 增加活動排名規則設定與開始後鎖定、均分上限計算、老師與學生結果呈現及搶答中資訊隔離。
- `result-export`: CSV 使用原始／最終順位、成功狀態及規則說明；回寫採用規則計算出的成功組。

## Impact

- 主要程式：`src/live-buzzer/model.ts`、`submissions.ts`、`views.ts`、`pages.ts`、`http-server.ts`、`socket-server.ts`、`result-csv.ts`、`result-export.ts`。
- 主要測試：`tests/live-buzzer-activity.test.ts`、`live-buzzer-submissions.test.ts`、`live-buzzer-views.test.ts`、`live-buzzer-http.test.ts`、`live-buzzer-socket.test.ts`、`spreadsheet-export-validation.test.ts`。
- 需求基準來源：使用者提供的 v0.6／v0.7 與 SpecKit 組 005 對齊要求，以及本次訊息所列規則；目前 checkout 的 `docs/共同需求基準.md` 仍標為草稿 v0.4，未提供上述版本或組 005 草稿供逐字比對。
