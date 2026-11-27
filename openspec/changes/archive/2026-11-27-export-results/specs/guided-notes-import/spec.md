# Spec Delta

## ADDED Requirements

### Requirement: 匯入題目集保留 Google 試算表來源
系統 SHALL 在確認 Google 試算表匯入時，將原試算表 ID 與選用的 gid 保存在題目集資料中，供後續操作識別原始來源。

#### Scenario: 保存指定工作表來源
- **WHEN** 老師確認帶有 gid 的 Google 試算表匯入預覽
- **THEN** 已建立題目集包含該試算表 ID 與 gid

#### Scenario: 保存預設工作表來源
- **WHEN** 老師確認未指定 gid 的 Google 試算表匯入預覽
- **THEN** 已建立題目集包含該試算表 ID，並標示使用匯入時選定的預設工作表

#### Scenario: XLSX 匯入沒有 Google 來源
- **WHEN** 老師確認 XLSX 匯入預覽
- **THEN** 題目集不包含 Google 試算表來源識別資訊
