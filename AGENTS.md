# AGENTS.md

This repository may use multiple AI agents with different roles during development, review, and maintenance.

Agents should follow the guidance below when operating in this repository.

---

## Project context discovery

在開始任何任務前，先依序從以下來源取得專案上下文：

1. README.md
2. CONTRIBUTING.md
3. package.json / pyproject.toml / go.mod / Cargo.toml 等專案描述檔
4. docs/ 或 doc/ 目錄
5. CI 設定與常用 scripts

若文件與實際程式結構不一致：

- 以目前程式碼與可執行指令為準
- 明確指出文件與實作的差異
- 不要假設文件一定正確

Agents should not assume technology stack, commands, or project conventions without checking these sources first.

---

## Engineering expectations

所有 agent 在進行修改或設計時應遵守以下原則：

- 優先做 **最小可行修改 (minimal safe change)**
- 不要順手進行大規模重構
- 修改前先理解既有模組邊界
- 若需求不明確，先收斂 spec 再實作
- 若涉及 workflow / background job / state transition / data consistency  
  必須進行 **workflow / integrity review**
- 若存在 follow-up，必須清楚列出，不要混入本次 patch

---

## Output expectations

Agent 交付結果時需包含：

- 修改範圍說明
- 哪些既有行為保持不變
- 驗證方式或測試方式
- 若查不到或無法確認，必須明確說明，不要猜測

---

## Review expectations

所有交付內容預設會交由 **reviewer agent 或 reviewer** 進行審查。

在交付前請先自行檢查 reviewer 可能指出的問題：

- 邏輯漏洞
- edge cases
- state transition 風險
- data integrity 問題
- security 風險
- performance 風險
- maintainability 問題

若存在以下情況，需主動標示：

- 已知限制
- 尚未覆蓋的情境
- 需要 follow-up 的問題
- 未驗證假設

不要把未確認資訊當作確定結論。

---

## Agent nickname mapping

Agents should interpret the aliases below as references to the corresponding role names defined in `.codex/config.toml`.

- spec: 範疇寶寶 / 範疇小天使 / 需求寶寶 / 需求小天使 / spec agent / spec
- ux: UX寶寶 / UX小天使 / 流程寶寶 / 流程小天使 / ux agent
- design: 架構寶寶 / 架構小天使 / 架構分析師 / design agent
- build: 工兵寶寶 / 實作小天使 / 工兵 / 苦命勞工 / 苦命鬼 / build / build agent
- qa: 驗收寶寶 / 驗收小天使 / 測試寶寶 / 測試小天使 / 測試小猴 / 小猴子 / qa agent
- integrity: 一致性寶寶 / 一致性小天使 / 一致性巨人 / 巨人 / 流程巨人 / integrity agent / workflow agent
- security: 資安寶寶 / 資安小天使 / security agent
- maintain: 維護寶寶 / 維護小天使 / 重構寶寶 / 重構小天使 / refactor agent
- perf: 效能寶寶 / 效能小天使 / performance agent
- ops: 維運寶寶 / 維運小天使 / ops agent
