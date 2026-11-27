# Proposal

## Why

活動結束後，老師目前無法將成功組答案安全地寫回原始 Guided Notes 試算表，也無法下載完整活動紀錄。此 change 補足結果交付流程，同時以重新定位、回寫預覽與本機備份降低修改錯誤試算表的風險。

## What Changes

- 活動結束後提供成功組答案回寫原 Google 試算表的預覽、確認、備份及最近一次回寫還原；XLSX 匯入來源不提供試算表回寫。
- 回寫確認時重新讀表、重新解析及比對題號、小題與答案格位置；預覽與確認時狀態不一致時中止。
- 只寫作答格，跳過沒有成功組的題目；使用 RAW 批次寫入。原格內容不同時，回寫預覽明列目前值與預計值，老師確認即同意覆蓋。
- 活動結束後提供每筆已接受提交、每小題一列的 UTF-8 BOM CSV，含 E2 欄位；最終順位等於原始順位，說明欄留空。
- 匯入題目集保存來源試算表 ID 與 gid；提交紀錄保存伺服器 ISO 送出時間，題組各小題共用時間。
- 不持久化活動與提交；伺服器重啟後結果消失，於 README 與介面說明。

## Capabilities

### New Capabilities

- `result-export`: 活動結束後將成功答案安全地回寫 Google 試算表，提供備份還原與 CSV 匯出。

### Modified Capabilities

- `guided-notes-import`: Google 試算表匯入結果保存來源試算表 ID 與 gid，以供後續回寫原表。
- `live-buzzer`: 被接受的提交記錄伺服器 ISO 時間，題組小題共用同一提交時間。

## Impact

- 影響 Guided Notes 匯入模型與 Google Sheets adapter、Live Buzzer 提交與活動結果、老師頁 HTTP/API、CSV 下載、`data/` 本機備份及 README。
- Google Sheets OAuth scope 從唯讀調整為讀寫；部署環境需重新授權，且服務帳號需有目標試算表寫入權限。
- 不增加外部服務；活動與提交仍僅存在記憶體，程序重啟後不保留。
