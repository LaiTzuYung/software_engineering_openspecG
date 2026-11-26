# Proposal

## Why

匯入功能已能建立並保存 Guided Notes 題目集，但目前沒有老師建立活動、學生以組別搶答及老師即時檢視作答的流程。此 change 對應 SpecKit 組 002＋003，依共同需求基準 v0.4 建立可在本機啟動的活動與搶答核心。

## What Changes

- 新增活動與搶答 capability，涵蓋活動階段、組別加入、答案提交與順位、即時同步、學生資料隔離、老師檢視及學生結果。
- 以 HTTP 提供老師頁、學生頁及沿用既有 `import-service` 的匯入預覽與確認介面。
- 透過 Socket.IO 同步階段、同組已送出狀態及老師作答檢視；學生端伺服器回應遵守 R9 隔離要求。
- 使用記憶體保存活動與提交，重啟後歸零；題目集由 `data/guided-notes/` 讀取。
- 介面使用純 HTML、CSS 與少量瀏覽器端 JavaScript，不引入前端框架。

## Capabilities

### New Capabilities

- `live-buzzer`: 本機活動建立、分組加入、搶答提交、順位判定、即時同步及結果檢視。

### Modified Capabilities

無。既有 `guided-notes-import` capability 不變；本 change 僅為既有匯入服務增加 HTTP 介面。

## Impact

- 在現有 TypeScript／Node.js 22 專案加入單一 HTTP 伺服器與 Socket.IO，提供老師頁、學生頁及即時通訊；頁面使用原生 HTML/CSS/少量 JS。
- 新增活動及提交的記憶體狀態，伺服器重啟後清空；讀取既有 `data/guided-notes/` JSON 題目集，並透過 HTTP 呼叫既有 import-service。
- R5 答案回寫與 E2 CSV、E3 公平機制、E4-1 判錯遞補、E4-2 倒數、E4-3 大螢幕、E4-4 XLSX 備援不在本 change，留給後續 change。
