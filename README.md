# 亲子健康跑全程到达核验

从报名到离场均可运行的赛事保障服务：

- **五公里亲子组**：报名即建立监护关系，比赛中每次到达持续校验；家长过终点而孩子芯片停在补给站时，指挥席立即得到寻找清单。
- **十公里个人组**：独立报名、独立芯片计时排名。
- **可信时间线**：检录 → 检查点读取 → 医疗处置 → 离场确认，全程留痕。
- **原始事实不改写**：芯片实时读取、设备补传、重复刷卡、人工更正都只追加；每个（人，检查点）只投影出一个到达状态。
- **医疗转运停止成绩**：`transported` 的参赛者立即退出成绩计算。
- **分级可见性**：普通志愿者看不到家庭电话、也看不到未成年人完整轨迹；家长令牌只能查自己的家庭；公开成绩只呈现比赛所需信息；赛后汇总做 k 匿名，无法反推未成年人精确路线。

服务通过 HTTP 交换 JSON，用 SQLite 文件保存状态。

## 本地开发

```bash
make migrate     # 初始化数据文件（DATABASE_PATH，默认 data/app.sqlite3）
make test        # 运行自动化测试（9 个场景）
make run         # 启动服务（PORT，默认 8080）
```

也可 `docker compose up --build`，宿主机端口由 `APP_PORT` 调整；容器启动时自动迁移。

环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` / `DATABASE_PATH` | 监听端口 / 数据文件 |
| `COMMAND_BOOTSTRAP_TOKEN` | 引导令牌，用于发放第一张指挥席令牌；正式环境发放后应吊销 |
| `CONTACT_SEAL_KEY` | 联系方式封存密钥（AES-256-GCM），生产环境必须注入 |
| `BACKFILL_THRESHOLD_MS` | 判定芯片补传的滞后阈值，默认 30000 |

## 端到端用法

```bash
# 1) 用引导令牌建赛事、布置检查点、发放各角色令牌
BOOT=$COMMAND_BOOTSTRAP_TOKEN
curl -s -X POST localhost:8080/events -H "Authorization: Bearer $BOOT" \
  -d '{"event_id":"WANGWU-2026","name":"王吴村亲子健康跑","race_date":"2026-09-22"}'

CMD=$(curl -s -X POST localhost:8080/staff/tokens -H "Authorization: Bearer $BOOT" \
  -d '{"role":"command","operator_ref":"指挥-01","event_id":"WANGWU-2026"}' | jq -r .token)
STAFF=$(curl -s -X POST localhost:8080/staff/tokens -H "Authorization: Bearer $BOOT" \
  -d '{"role":"staff","operator_ref":"志愿-07","event_id":"WANGWU-2026"}' | jq -r .token)
MEDIC=$(curl -s -X POST localhost:8080/staff/tokens -H "Authorization: Bearer $BOOT" \
  -d '{"role":"medic","operator_ref":"医疗-02","event_id":"WANGWU-2026"}' | jq -r .token)

# 2) 报名（先家长后孩子；电话仅封存，返回 contact_ref）
curl -s -X POST localhost:8080/events/WANGWU-2026/runners -H "Authorization: Bearer $CMD" -d '{
  "runner_ref":"RUN-G1","group_code":"family-5k","bib":"F101-A","display_name":"豆包爸爸",
  "family_id":"FAM-1","family_role":"guardian","chip_id":"CHIP-0001",
  "contact":{"channel":"phone","detail":"13900000001"}}'
curl -s -X POST localhost:8080/events/WANGWU-2026/runners -H "Authorization: Bearer $CMD" -d '{
  "runner_ref":"RUN-C1","group_code":"family-5k","bib":"F101-B","display_name":"豆包",
  "is_minor":true,"family_id":"FAM-1","family_role":"child","guardian_ref":"RUN-G1","chip_id":"CHIP-0002"}'

# 3) 检录与芯片读取（志愿者可操作；补传与重复刷卡走同一入口，自动分类）
curl -s -X POST localhost:8080/runners/RUN-C1/checkin -H "Authorization: Bearer $STAFF" \
  -d '{"operator_ref":"志愿-07"}'
curl -s -X POST localhost:8080/chip-reads -H "Authorization: Bearer $STAFF" \
  -d '{"chip_id":"CHIP-0002","checkpoint_ref":"CP-AID","occurred_at":"2026-09-22T08:18:40+08:00","device_sequence":4}'

# 4) 人工更正（仅指挥席；原始读取保留）
curl -s -X POST localhost:8080/runners/RUN-C1/corrections -H "Authorization: Bearer $CMD" -d '{
  "checkpoint_ref":"CP-AID","occurred_at":"2026-09-22T08:19:05+08:00",
  "operator_ref":"指挥-01","reason":"录像核对通过时间"}'

# 5) 医疗转运（医疗席；立即停止成绩）
curl -s -X POST localhost:8080/medical-events -H "Authorization: Bearer $MEDIC" -d '{
  "medical_id":"MED-0231","runner_ref":"RUN-C1","checkpoint_ref":"CP-AID",
  "occurred_at":"2026-09-22T08:25:00+08:00","medic_ref":"医疗-02",
  "disposition":"transported","transported_at":"2026-09-22T08:26:00+08:00"}'

# 6) 寻找清单（?stall_ms= 调整停滞阈值）
curl -s "localhost:8080/events/WANGWU-2026/find-list?stall_ms=90000" -H "Authorization: Bearer $CMD"
# 志愿者视角自动裁剪：只有号码布与最后可信位置
curl -s "localhost:8080/events/WANGWU-2026/find-list" -H "Authorization: Bearer $STAFF"

# 7) 家长自助（令牌只绑定 FAM-1）
FAM=$(curl -s -X POST localhost:8080/family/tokens -H "Authorization: Bearer $CMD" \
  -d '{"runner_ref":"RUN-G1"}' | jq -r .token)
curl -s localhost:8080/family/status -H "Authorization: Bearer $FAM"

# 8) 离场确认 / 公开成绩 / 赛后 k 匿名汇总
curl -s -X POST localhost:8080/runners/RUN-C1/departure -H "Authorization: Bearer $STAFF" \
  -d '{"confirmed_by_ref":"志愿-07"}'
curl -s localhost:8080/events/WANGWU-2026/results            # 无需令牌
curl -s "localhost:8080/events/WANGWU-2026/aid-summary?k=5" -H "Authorization: Bearer $CMD"
```

完整字段与不变量约定见 `contracts/entities.json`，领域规则见 `docs/domain.md`，
不含真实身份的场景示例见 `fixtures/example.json`。
