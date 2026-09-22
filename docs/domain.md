# 领域资料

亲子健康跑现场保障：五公里亲子组持续校验监护关系，十公里个人组独立计时；
检录、检查点读取、医疗处置与离场确认串成一条可信时间线。

## 身份与最小化

- 外部主体一律使用不含真实身份的受控引用：`runner_ref`、`guardian_ref`、`checkpoint_ref`、`chip_id`、`family_id`。
- 交换时间采用带偏移量的 ISO 8601 字符串；内部排序使用归一化纪元毫秒。
- 家庭电话号码不进入普通业务记录：报名时写入 `contact_registry`（AES-256-GCM 封存，密钥来自 `CONTACT_SEAL_KEY`），
  参赛者只持有 `contact_ref`。普通志愿者（staff）永远拿不到号码，只有指挥席（command）与医疗席（medic）可解封，且每次解封写入 `access_audit`。
- 原始报文不保存正文，只保存 `raw_digest`（sha256）与备注摘要。

## 事实流与唯一直达状态

“谁在何时经过哪里”全部先进只追加表 `arrival_events`，来源有四类：

| source | 含义 |
| --- | --- |
| `chip_realtime` | 芯片实时读取 |
| `chip_backfill` | 设备离线后的补传（接收时间晚于发生时间超过 `BACKFILL_THRESHOLD_MS`，默认 30 秒） |
| `chip_repeat` | 同一读取重发，或同人同点再次经过 |
| `manual` | 人工更正，`supersedes_seq` 指向被更正事实 |

规则：

- 事实永不修改、永不删除，被人工更正的芯片记录仍保留可追溯；
- `arrival_status` 是投影：每个 `(runner_ref, checkpoint_ref)` 恰好一行，
  补传、重复刷卡、更正都只更新这一行，不存在第二个到达状态；
- 重复刷卡累加 `pass_count`；人工更正累加 `corrected_count` 并把采信来源置为 `manual`；
- 设备去重键（`chip|checkpoint|occurred`）保证同一报文重发只产生 `chip_repeat`。

## 监护关系（family-5k）

- 报名即建立关系：孩子必须 `is_minor=true` 且 `guardian_ref` 指向同家庭的家长；个人组不允许携带家庭字段。
- 每次家庭成员产生到达，系统按各自“最远可信检查点序号”重算一次 `custody_checks`：
  `together` / `ahead_child` / `split_alert`（家长越过孩子最后位点，含已过终点）。
- 指挥席寻找清单按**最后可信位置**生成：孩子 `split_alert` 且位置停滞超过阈值 →
  `child_stalled_guardian_ahead`；家长落后停滞 → `guardian_stalled_child_ahead`。
  离场确认后人员移出清单。

## 成绩与医疗

- 十公里独立计时排名（起点/检录 → 终点的芯片时间）。
- 五公里以家庭为单位：全员过终点方计成绩，家长计时，公开结果只给 `children_count`，不出现任何未成年人标识。
- 医疗 `disposition=transported`（带转运时间）立即停止该参赛者成绩计算，并从成绩中剔除；
  现场处置 `treated_on_site` 不影响成绩。

## 角色与可见性

| 能力 | command 指挥席 | staff 普通志愿者 | medic 医疗席 | guardian 家长 |
| --- | --- | --- | --- | --- |
| 报名/建赛/发令牌/人工更正/赛后汇总 | ✅ | — | — | — |
| 检录、芯片读取、离场确认 | ✅ | ✅ | — | — |
| 医疗处置与转运 | ✅ | — | ✅ | — |
| 解封家庭电话 | ✅ | — | ✅ | — |
| 寻找清单 | 全量 | 仅号码布+最后可信位置 | 全量 | 无 |
| 时间线 | 全量含原始事实 | 未成年人禁止；成年人仅按点到达 | 全量 | 仅本家庭、按点到达 |
| 家庭状态 | — | — | — | 仅本家庭 |

首张指挥令牌通过启动环境变量 `COMMAND_BOOTSTRAP_TOKEN` 引导发放，发放后即可吊销引导值。

## 赛后隐私

`GET /events/:id/aid-summary?k=` 输出补给站停留分布：
仅按 `(检查点 × 组别 × 5 分钟停留带)` 聚合人数，人数不足 k 的整桶抑制；
不接受任何个人过滤参数，不含标识、号码或精确时间，无法反推出未成年人的精确路线。
未完赛者不进入停留计算，避免其滞留点被推断。

`contracts/entities.json` 中的字段名称属于稳定接口约定；`fixtures/example.json` 为不含真实身份的示例。
