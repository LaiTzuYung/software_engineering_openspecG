# Proposal

## Why

課堂投影需要一個不需登入、適合遠距觀看的唯讀結果畫面；目前系統沒有能安全呈現活動階段與結束結果的大螢幕頁。活動結束後，學生也需要看見其他已送出組別的順位，才能理解結果與均分上限跳過情況。

## What Changes

- 新增 `/screen` 投影頁，呈現目前單一活動的準備中、搶答中及已結束畫面，並在終端啟動資訊印出其網址。
- 為大螢幕建立獨立 `screen` Socket 角色及專用白名單視圖；搶答中的視圖只含安全計數，活動結束後才傳送成功組答案及其他組順位，並拒絕狀態變更事件。
- 學生結束結果加入其他已送出組的順位與均分上限跳過標示；成功組才顯示答案，順位採該題原始順位。
- 保留搶答中學生視圖的 R9 隔離，不增加他組提交狀態或順位。
- 增加大螢幕 HTTP／Socket 隔離、即時計數、結束結果與唯讀授權測試，以及老師、兩組學生和大螢幕的三階段人工截圖流程。

## Capabilities

### New Capabilities

- `big-screen`: 大螢幕角色、階段專用視圖、投影頁及唯讀行為。

### Modified Capabilities

- `live-buzzer`: 學生結束結果增加其他組順位與跳過標示，同時維持 R9 搶答中隔離。

## Impact

- 影響 `src/live-buzzer/views.ts`、`socket-server.ts`、`http-server.ts`、`pages.ts`、`src/server.ts` 與啟動輸出；新增或擴充相關 HTTP、Socket、頁面與視圖測試。
- 新增 OpenSpec `big-screen` capability delta，並修改 `live-buzzer` capability delta；人工測試文件記錄四個視窗的三階段截圖。
- 不新增執行期依賴。
