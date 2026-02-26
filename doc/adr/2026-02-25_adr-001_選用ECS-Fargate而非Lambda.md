# ADR-001：選用 ECS Fargate 而非 Lambda

**日期**：2026-02-25
**狀態**：已採用

---

## 背景

排程執行快照與回報需要一個無伺服器運算平台。主要候選方案為 AWS Lambda 與 AWS ECS Fargate。

## 決策

採用 **ECS Fargate**。

## 理由


| 面向     | Lambda                     | ECS Fargate          |
| ------ | -------------------------- | -------------------- |
| 執行時間限制 | 最長 15 分鐘                   | 無限制                  |
| 套件大小   | 50MB（直接）/ 250MB（Layer）     | 無限制（Docker image）    |
| 環境一致性  | Node.js runtime 版本受 AWS 管理 | 完全由 Dockerfile 控制    |
| 本機測試   | 需 SAM / localstack         | `docker run` 即可      |
| 計費     | 執行次數 × 時間                  | vCPU + Memory × 執行時間 |
| 冷啟動    | 有（VPC 時更明顯）                | 無（容器預熱後）             |


**核心考量**：

- 此服務執行邏輯相對固定，不需要 Lambda 的彈性擴展
- Docker 化後本機 dry-run 與正式環境完全一致，降低除錯成本
- 未來若需增加多帳號支援或更複雜的計算，不受 Lambda 執行時間限制

## 取捨

- ECS Fargate 每次冷啟動（從排程觸發到容器就緒）約需 20–60 秒，但因任務本身執行時間 < 30 秒，可接受
- 成本略高於 Lambda（每月執行約 35 次，差異可忽略）

