[$openspec-propose](C:/Users/a123h/software_engineering_openspecG//.agents/skills/openspec-propose/SKILL.md) change 名稱：import-guided-notes

請依剛才 Explore 的結論規劃「Guided Notes 匯入」，對應 SpecKit 組的 001。本次先完成提案，暫不實作。所有文件用繁體中文，OpenSpec 結構標題與 SHALL/MUST 保留英文。

【範圍】只含基準 v0.4 的 R2 與 Q1～Q10。Q11～Q13（匯出相關）不在本 change，請在 proposal 的 Impact 註明留給後續匯出 change。Q8 的 {{答}} 不實作，設計預留擴充點。

【設計要求】
1. 解析器只處理內部的「格狀資料」（儲存格值、合併範圍、工作表名稱），與資料來源分離；提供兩個轉接器：Google Sheets API（主流程）與 .xlsx 讀檔（僅供自動測試與備援）。
2. 需有網址解析：取出試算表 ID 與選用的 gid；網址無效為明確錯誤。
3. 多工作表時預設掃第一張，網址帶 gid 時用該張。
4. 技術棧預設 TypeScript（Node.js）。憑證放 repo 以外，以環境變數指定。
5. 基準未規定的項目，請照下列預設寫入 design.md 的「待與 SpecKit 組對齊」：題目敘述有欄就擷取、沒有就留空；候選格都有內容取第一格並顯示警告且可繼續；標籤右側無可用格時作答格退回標籤格；題號無法解析整份失敗並指出座標；表頭下方沒有題目時顯示「沒有偵測到題目」。

【spec 要求】
每個 Requirement 都要有 WHEN/THEN Scenario，必須包含 T1～T5 六份 fixture 各一個 Scenario（用 fixture README 的預期座標），另加：網址無效、沒有權限（含服務帳號 email）、確認前不建立題目集、題號正規化各種寫法、作答格合併取左上角。嚴禁寫死欄位或列號。

【tasks 要求】
每項可勾選，涵蓋格狀資料模型、兩個轉接器、解析器各規則、預覽、錯誤處理、fixture 自動測試、README。並加一項「人工測試：用真的 Google 試算表匯入 T1～T5，結果須與 xlsx 相同」。







上午1:00






處理了 3 分鐘 48 秒

已完成 import-guided-notes 提案，僅建立 OpenSpec 規劃文件，未實作功能。

變更位於 [import-guided-notes](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/)：
- [proposal.md](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/proposal.md)：說明目的、範圍及影響；明列 Q11～Q13 留給後續匯出 change。
- [spec.md](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/specs/guided-notes-import/spec.md)：包含 T1～T5 六份 fixture 的預期結果，以及網址、權限、題號正規化、合併格、確認流程等情境。
- [design.md](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/design.md)：規劃格狀資料模型、Google Sheets API 與 .xlsx 轉接器、TypeScript（Node.js）預設、外部憑證設定，並記錄 Q8 不實作及待與 SpecKit 對齊項目。
- [tasks.md](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/tasks.md)：列出解析器、轉接器、預覽、錯誤處理、fixture 自動驗收、README 與真實 Google 試算表人工測試工作。
openspec validate --strict 通過，狀態為 4/4 artifacts complete。提案已可供審閱；準備實作時再明確要求 apply。

  已編輯 4 個檔案+263-0查看變更復原查看變更

openspec/changes/import-guided-notes/proposal.mdopenspec/changes/import-guided-notes/proposal.md+32-0

openspec/changes/import-guided-notes/specs/guided-notes-import/spec.mdopenspec/changes/import-guided-notes/specs/guided-notes-import/spec.md+113-0

openspec/changes/import-guided-notes/design.mdopenspec/changes/import-guided-notes/design.md+84-0

openspec/changes/import-guided-notes/tasks.mdopenspec/changes/import-guided-notes/tasks.md+34-0

收合檔案



      
上午1:03







[$openspec-update-change](C:/Users/a123h/software_engineering_openspecG//.agents/skills/openspec-update-change/SKILL.md) 請修改 change import-guided-notes，只改 spec.md、design.md、tasks.md，不實作：

spec.md：
1. 新增 Scenario「一般題號重複」：題號 2 出現在兩處時，整份失敗並列出所有重複座標。
2. 新增兩個 Scenario：題號格上下合併時，第二列視為同題下一小題；題號欄空白且題目欄與作答欄皆空時視為空白列略過。
3. 「標籤格與右側空白作答格」Scenario 補上：系統從標籤「（n）」取得小題編號 n 並記錄。
4. 新增 Scenario「無效或不存在的 gid」顯示清楚錯誤且不建立題目集。

design.md：
5. Risks 新增：Google API 合併範圍為 0 起算、結束不含；exceljs 為 1 起算、含結束，轉接器須統一並以測試驗證。
6. 說明 Google Sheets API 取值的格式選項，確保數值題號（如 1.0）與 xlsx 的解析結果一致。
7. Decisions 補充題目集暫定儲存方式（記憶體加 JSON 檔），並列入待與 SpecKit 組對齊。

tasks.md：
8. 3.2 補上合併範圍座標轉換的 mock 測試與無效 gid 測試。
9. 1.4 補上一般重複題號與合併題號延續的單元測試。







上午9:58






處理了 24 秒

Using change: import-guided-notes. 我核對過現有文件；以下修訂不影響 proposal 的範圍，也不涉及實作。依 openspec-update-change 技能要求，需先確認具體草稿才能寫入。

spec.md：在題目與小題辨識需求新增三個 Scenario：
- 「一般題號重複」：題號 2 出現在兩處時，整份匯入失敗，並列出所有重複座標。
- 「題號格上下合併」：合併題號格的第二列，視為同題下一小題。
- 「題號與內容皆空白」：題號欄空白，且題目欄與作答欄皆空時，視為空白列略過。
在「標籤格與右側空白作答格」的 THEN 補上：從標籤「（n）」解析並記錄小題編號 n。另於工作表選擇需求新增「無效或不存在的 gid」Scenario，明確顯示錯誤且不建立題目集。

design.md：在 Risks 新增 Google API 合併範圍是 0 起算、結束不含，而 exceljs 是 1 起算、含結束；兩個轉接器須統一座標表示並由測試驗證。在 API 讀取決策說明格式選項須讓數值題號（例如 1.0）與 XLSX 解析一致。在 Decisions 補上題目集暫以記憶體加 JSON 檔儲存，並列入「待與 SpecKit 組對齊」。

tasks.md：1.4 明列一般重複題號與合併題號延續測試；3.2 明列合併範圍座標轉換的 mock 測試與無效 gid 測試。

請回覆「確認」後，我就只更新 spec.md、`design.md`、`tasks.md`，再檢查 OpenSpec 驗證結果。

      
上午9:58







確認。請依草稿只更新 spec.md、design.md、tasks.md，另外補兩點：
1. 「無效或不存在的 gid」Scenario 的錯誤訊息要明確指出是工作表（gid）找不到，與「網址無效」區分。
2. 題目集暫存方式（記憶體加 JSON 檔）的 JSON 檔路徑要放在 repo 內的 data/ 之類的資料夾，並把該資料夾加入 .gitignore，避免把匯入的題目資料提交進 repo。
改完請執行 openspec validate import-guided-notes --strict 並回報結果。







上午10:01






處理了 3 分鐘 14 秒

已更新並驗證 import-guided-notes。`openspec validate import-guided-notes --strict` 通過。
- [spec.md](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/specs/guided-notes-import/spec.md)：新增一般重複題號、合併題號延續、空白列略過、小題編號記錄，以及明確區分「找不到工作表（gid）」和「網址無效」的情境。
- [design.md](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/design.md)：補充 Google API 數值讀取格式、兩種合併範圍座標慣例的轉換風險，以及記憶體加 JSON 暫存方式。JSON 路徑暫定為 data/guided-notes/，並列入 SpecKit 對齊事項。
- [tasks.md](C:/Users/a123h/software_engineering_openspecG/openspec/changes/import-guided-notes/tasks.md)：補上對應單元與 mock 測試，並列出將 data/guided-notes/ 加入 .gitignore 的待辦。
依「只更新三份 artifacts」的範圍，本次未直接修改 .gitignore；忽略該資料夾已列入 tasks。

  已編輯 3 個檔案+31-4查看變更復原查看變更

openspec/changes/import-guided-notes/specs/guided-notes-import/spec.mdopenspec/changes/import-guided-notes/specs/guided-notes-import/spec.md+17-1

openspec/changes/import-guided-notes/design.mdopenspec/changes/import-guided-notes/design.md+10-0

openspec/changes/import-guided-notes/tasks.mdopenspec/changes/import-guided-notes/tasks.md+4-3





      
上午10:04