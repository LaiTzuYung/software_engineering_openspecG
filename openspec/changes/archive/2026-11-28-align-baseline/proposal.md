# Proposal

## Why

目前 Guided Notes 匯入遇到單一無效題號或題號前的說明列便會整份失敗，且解析器、活動與 CSV 行為尚未完整符合兩組對齊規則。這項 change 將明確調整這些使用者可見行為，同時保護既有 T1～T5 解析結果、學生資料隔離及試算表回寫流程。

## What Changes

- 無效題號及第一個有效題號前的內容改為略過並在預覽警告；保留找不到表頭、零題及重複題號的整份失敗行為。
- 表頭題號與作答需位於不同儲存格；擴充小題標籤格式辨識，並對題號缺號提供警告而不限制排列順序。
- 活動組數限制為 2～10 組；老師視圖新增各組線上學生 Socket 數，僅送給老師並隨連線生命週期更新。
- CSV 欄位加入公式注入防護，並為無組別送出的題目輸出指定空白列。
- CSV「送出時間」輸出為台灣時間 UTC+8、精確到秒且不含毫秒；伺服器內部提交時間維持原值。
- 明確維持 T1～T5 預期、學生視圖／R9 隔離及回寫邏輯不變。

## Capabilities

### New Capabilities

無。

### Modified Capabilities

- `guided-notes-import`：調整無效列、表頭、標籤格式及缺號警告規則。
- `live-buzzer`：限制活動組數並在老師視圖提供即時線上人數，維持學生隔離。
- `result-export`：增加 CSV 防公式及無提交題目列。

## Impact

涉及 `src/guided-notes/parser.ts`、匯入預覽與解析測試；`src/live-buzzer/model.ts`、`views.ts`、`socket-server.ts`、老師活動頁及相關 HTTP／Socket／視圖測試；`src/live-buzzer/result-csv.ts` 與 CSV 測試。人工測試須以 T2 新複本驗證解析預覽、老師頁線上人數及 Excel CSV 開啟結果。共同基準文件目前標示草稿 v0.4，未找到獨立的 SpecKit 組 001 規格文件；本提案以本次明列規則與 fixtures README 預期作為可檢視依據。

規則來源為 SpecKit 組 repo 的 PR #7（共同需求基準 v0.6、大組會議決策單 2-14）與 PR #6（001 規格 FR-007、FR-019）及 001 審查討論（CHK014、CHK019、CHK021、CHK028、CHK033）；v0.6 尚未合併至 SpecKit main，本 repo 的 docs/共同需求基準.md 仍為 v0.4。
