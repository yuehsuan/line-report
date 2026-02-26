# 文件索引

此資料夾存放 line-report 專案的規劃紀錄、架構設計與技術決策文件。

## 資料夾結構

```
doc/
├── plan/    # 功能規劃、需求討論紀錄
├── arch/    # 架構設計文件
└── adr/     # Architecture Decision Records（重大技術決策）
```

## 命名規範

```
YYYY-MM-DD_[類型]_[主題].md
```

| 類型 | 資料夾 | 用途 |
|------|--------|------|
| `plan` | `plan/` | 功能規劃、需求討論 |
| `arch` | `arch/` | 架構設計、系統設計 |
| `adr` | `adr/` | 重大技術決策紀錄（不可逆或有明確 trade-off 的選擇） |
| `impl` | `arch/` | 實作細節補充說明 |
| `review` | `plan/` | 回顧、問題與改善紀錄 |

### 範例

```
doc/plan/2026-02-25_plan_初版功能規劃.md
doc/arch/2026-02-25_arch_aws-infrastructure設計.md
doc/adr/2026-02-25_adr-001_選用ECS-Fargate而非Lambda.md
```

## 文件列表

### plan/
- [2026-02-25 初版功能規劃](./plan/2026-02-25_plan_初版功能規劃.md)
- [2026-02-25 建置計畫完整規格](./plan/2026-02-25_plan_建置計畫-完整規格.md)（含任務清單、模組規格、測試策略、架構圖）

### arch/
- [2026-02-25 AWS 基礎設施設計](./arch/2026-02-25_arch_aws-infrastructure設計.md)

### adr/
- [ADR-001 選用 ECS Fargate 而非 Lambda](./adr/2026-02-25_adr-001_選用ECS-Fargate而非Lambda.md)
