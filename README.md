# 亲子健康跑全程到达核验

覆盖**报名 → 检录 → 检查点 → 医疗处置 → 离场**的赛事保障服务：五公里亲子组持续校验监护关系，十公里个人组独立计时；事实只追加、状态可重建；医疗转运停止成绩计算；指挥席、志愿者、家长、公开四种口径各自最小化信息。

本服务通过 HTTP 接口交换业务记录，并使用 SQLite 文件保存状态。`PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件；启动时若设置 `COMMAND_TOKEN`，会自动写入一枚全局指挥席令牌（只存摘要）。`fixtures/example.json` 提供不含真实身份的本地示例，`contracts/entities.json` 记录字段约定，`docs/domain.md` 记录领域规则。

## 本地开发

```bash
make migrate   # 初始化/升级数据文件（src/db.js 启动时也会自动迁移）
make test      # 执行自动化检查
make run       # 启动服务
```

也可以使用 `docker compose up --build` 在隔离容器中运行，宿主机端口由 `APP_PORT` 调整。

## 角色与鉴权

除 `GET /health` 与公开成绩外，所有接口都要求 `Authorization: Bearer <token>`：

- `command`：指挥/保障席，可配置赛事、报名、人工更正、读取含联系方式的寻找清单、完整时间线与汇总；
- `marshal`：普通志愿者，绑定赛事，可上报现场事实，只读脱敏寻找清单；
- `guardian`：家长，绑定家庭，只能读自己家庭的进度。

令牌只保存 `sha256` 摘要，明文仅在签发响应中出现一次。

## 接口

约定：时间字段均为带偏移量的 ISO 8601（如 `2026-09-22T08:05:20+08:00`）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/events` | command | 建赛事（`event_ref`、`title`、`stage_sla_seconds`） |
| POST | `/events/:ref/checkpoints` | command | 定义检查点（`kind`: start/aid/finish/exit） |
| POST | `/events/:ref/families` | command | 亲子组报名（监护人 + 未成年人） |
| POST | `/events/:ref/individuals` | command | 十公里个人报名 |
| POST | `/events/:ref/tokens` | command | 签发 marshal / guardian 令牌 |
| POST | `/events/:ref/facts` | command / marshal | 上报现场事实（`manual` 仅 command） |
| GET | `/events/:ref/find` | command | 寻找清单（含家庭联系方式） |
| GET | `/events/:ref/marshal-list` | command / marshal | 脱敏寻找清单 |
| GET | `/events/:ref/results` | 公开 | 成绩榜 |
| GET | `/events/:ref/summary` | command | 粗粒度赛后汇总 |
| GET | `/families/:family_ref` | guardian（仅本家庭）/ command | 家庭进度视图 |
| GET | `/runners/:runner_ref/timeline` | command | 原始事实 + 到达状态 + 生命周期 |

### 事实上报

```json
{
  "kind": "chip",
  "runner_ref": "RUN-WANGWU-2026-K001",
  "checkpoint_ref": "CP-5K-A1",
  "occurred_at": "2026-09-22T08:05:20+08:00",
  "device_id": "MAT-01",
  "device_sequence": 17,
  "source": "retransmitted",
  "client_event_id": "MAT-01-00017"
}
```

- `chip` / `checkin`：检查点到达；同检查点重复刷卡返回 `"source": "duplicate"`，事实留痕、状态不变；
- `manual`：`correction_action` 为 `set` 或 `void`，必须带 `operator_ref` 与 `reason`；
- `medical`：`medical_action` 为 `treatment`（不停表）或 `evacuation`（成绩终局）；敏感口述放在 `detail_text`，服务端只保存其 `sha256`；
- `exit`：离场确认，只能发生在 `kind = exit` 的检查点。

## 数据模型要点

- `raw_events` 只追加；`arrival_states`（每参赛者 × 检查点唯一到达）、`runner_status`（检录/出发/完赛/转运/离场/最后可信位置）、`supervision_alerts`（监护分离告警）都是可由事实重建的投影；
- 五公里成绩只公布家庭整体，十公里成绩独立计时排名；
- 公开成绩与汇总不含检查点级数据，汇总只有分组计数，无法反推未成年人路线。
