-- 赛事保障系统核心结构
-- 设计原则：
-- 1. 原始事实（芯片读取、补传、重复刷卡、人工更正）只追加，不修改不删除；
-- 2. 每个 (参赛者, 检查点) 只投影出一个到达状态（arrival_status 唯一键）；
-- 3. 时间线事实按 occurred_at 重排，迟到的补传/更正不产生第二个到达；
-- 4. 联系方式与未成年人完整轨迹对普通志愿者不可见（由服务层按角色裁剪）。

PRAGMA foreign_keys = ON;

-- ── 赛事与组别 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
    event_id        TEXT PRIMARY KEY,                 -- 受控引用编号，不含真实身份
    name            TEXT NOT NULL,
    race_date       TEXT NOT NULL,                    -- ISO 8601 日期
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS race_groups (
    group_code      TEXT PRIMARY KEY,                 -- family-5k / individual-10k
    label           TEXT NOT NULL,
    requires_guardian INTEGER NOT NULL,               -- 5k=1 持续校验监护关系；10k=0
    distance_m      INTEGER NOT NULL
);

INSERT OR IGNORE INTO race_groups(group_code, label, requires_guardian, distance_m) VALUES
    ('family-5k',     '五公里亲子组', 1, 5000),
    ('individual-10k', '十公里个人组', 0, 10000);

-- 检查点：sequence 决定赛道先后；kind 区分普通点/补给站/起终点
CREATE TABLE IF NOT EXISTS checkpoints (
    event_id        TEXT NOT NULL REFERENCES events(event_id),
    checkpoint_ref  TEXT NOT NULL,
    title           TEXT NOT NULL,
    sequence        INTEGER NOT NULL,                 -- 赛道顺序，0=起点检录线
    kind            TEXT NOT NULL DEFAULT 'checkpoint', -- checkpoint|aid_station|start|finish
    PRIMARY KEY (event_id, checkpoint_ref)
);

-- ── 参赛者与监护关系 ─────────────────────────────────────────
-- 参赛者只保存受控引用；is_minor 决定隐私策略；
-- contact_ref 是联系方式的间接引用（指向 contact_registry），
-- 普通志愿者拿到的只是引用，服务层绝不向其下发号码本身。
CREATE TABLE IF NOT EXISTS runners (
    runner_ref      TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL REFERENCES events(event_id),
    group_code      TEXT NOT NULL REFERENCES race_groups(group_code),
    bib             TEXT NOT NULL,
    display_name    TEXT NOT NULL,                    -- 公开名（可为昵称），非法定姓名
    is_minor        INTEGER NOT NULL DEFAULT 0,
    family_id       TEXT,                             -- 家庭组同属一个 family_id
    guardian_ref    TEXT,                             -- family-5k 孩子指向其家长
    family_role     TEXT,                             -- guardian|child（仅亲子组）
    chip_id         TEXT NOT NULL UNIQUE,
    contact_ref     TEXT,                             -- 联系方式间接引用，仅指挥/医疗席可解析
    registered_at   TEXT NOT NULL,
    UNIQUE (event_id, bib)
);

-- 家长自助查询令牌：一个令牌绑定且仅绑定一个家庭
CREATE TABLE IF NOT EXISTS family_tokens (
    token_hash      TEXT PRIMARY KEY,                  -- sha256(令牌)
    event_id        TEXT NOT NULL,
    family_id       TEXT NOT NULL,
    issued_to_ref   TEXT NOT NULL,                     -- 家长 runner_ref
    created_at      TEXT NOT NULL,
    revoked_at      TEXT
);

-- 工作人员令牌：command 指挥席 / staff 普通志愿者 / medic 医疗席
CREATE TABLE IF NOT EXISTS staff_tokens (
    token_hash      TEXT PRIMARY KEY,
    event_id        TEXT,                              -- NULL 表示可跨赛事（管理用途）
    role            TEXT NOT NULL,                     -- command|staff|medic
    operator_ref    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    revoked_at      TEXT
);

-- 联系方式集中保管：普通志愿者永远拿不到通道字段，只能看到 contact_ref；
-- 号码经封存（可逆密钥取自 CONTACT_SEAL_KEY），只有指挥席与医疗席可解封。
-- detail_digest 用于去重/核对，任何接口都不回传明文摘要之外的内容。
CREATE TABLE IF NOT EXISTS contact_registry (
    contact_ref     TEXT PRIMARY KEY,
    channel         TEXT NOT NULL,                      -- phone 等通道类型
    detail_digest   TEXT NOT NULL,                      -- sha256(原始号码)
    detail_cipher   TEXT NOT NULL                       -- 封存值
);

-- ── 原始事实流（只追加）──────────────────────────────────────
-- 任何“谁在什么时候经过哪里”的材料都先落本表，且永不修改：
--   source=chip_realtime  芯片实时刷到
--   source=chip_backfill  设备离线后补传（occurred 明显早于 received）
--   source=chip_repeat    同一人同一点的重复刷卡（独立留痕）
--   source=manual         人工更正/人工登记
-- 人工更正用 supersedes_seq 指向被更正的原始读取；
-- 被更正的事实仍然保留，只是投影时不再采信。
CREATE TABLE IF NOT EXISTS arrival_events (
    event_id            TEXT NOT NULL REFERENCES events(event_id),
    seq                 INTEGER NOT NULL,              -- 赛事内入库顺序（事务内递增）
    runner_ref          TEXT NOT NULL REFERENCES runners(runner_ref),
    checkpoint_ref      TEXT NOT NULL,
    source              TEXT NOT NULL,                  -- chip_realtime|chip_backfill|chip_repeat|manual
    occurred_at         TEXT NOT NULL,                  -- 事实发生时间（ISO 8601 带偏移，原样保留）
    occurred_epoch_ms   INTEGER NOT NULL,               -- 归一化纪元毫秒，排序唯一依据
    received_at         TEXT NOT NULL,                  -- 服务收到时间
    received_epoch_ms   INTEGER NOT NULL,
    device_sequence     INTEGER,                        -- 设备/批次序号，补传追溯用
    ingest_idempotency_key TEXT,                        -- 设备去重键；仅首条采信事实持有
    operator_ref        TEXT,                           -- 人工受理人（人工更正时必填）
    reason              TEXT,                           -- 人工更正说明
    supersedes_seq      INTEGER,                        -- 被更正的目标事实 seq（可空）
    raw_digest          TEXT,                           -- 原始报文 sha256 摘要（不留原文）
    PRIMARY KEY (event_id, seq)
);

-- 同一去重键只受理一次为“新事实”，重复的转记 chip_repeat（不再占用去重键）
CREATE UNIQUE INDEX IF NOT EXISTS idx_arrival_idempotent
    ON arrival_events(ingest_idempotency_key)
    WHERE ingest_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_arrival_runner
    ON arrival_events(event_id, runner_ref, occurred_epoch_ms);

-- ── 唯一直达状态（投影）──────────────────────────────────────
-- 每个 (参赛者, 检查点) 只有一行；
-- 芯片补传、重复刷卡、人工更正都只更新这一行，绝不新增第二行。
CREATE TABLE IF NOT EXISTS arrival_status (
    runner_ref          TEXT NOT NULL REFERENCES runners(runner_ref),
    checkpoint_ref      TEXT NOT NULL,
    event_id            TEXT NOT NULL,
    believed_occurred_at TEXT NOT NULL,                 -- 当前采信的到达时间（原文）
    believed_epoch_ms   INTEGER NOT NULL,               -- 当前采信时间
    accepted_source     TEXT NOT NULL,                  -- 采信来源
    accepted_seq        INTEGER NOT NULL,               -- 采信的原始事实 seq
    pass_count          INTEGER NOT NULL DEFAULT 1,     -- 该点刷卡总次数（含重复刷卡）
    corrected_count     INTEGER NOT NULL DEFAULT 0,     -- 被人工更正次数
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (runner_ref, checkpoint_ref)
);

-- ── 监护关系校验快照（5 公里亲子组持续校验）──────────────────
-- 每当家庭成员到达一个检查点就重算一次：家长是否也已通过同序位点。
-- split_alert：家长已越过孩子最后位点之后的检查点（含终点），
-- 孩子芯片仍停在该点（如补给站）——即“家长过终点、孩子滞留”。
CREATE TABLE IF NOT EXISTS custody_checks (
    check_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT NOT NULL,
    family_id       TEXT NOT NULL,
    checkpoint_ref  TEXT NOT NULL,
    checked_at      TEXT NOT NULL,
    guardian_ref    TEXT NOT NULL,
    child_ref       TEXT NOT NULL,
    guardian_seq    INTEGER,
    child_seq       INTEGER,
    status          TEXT NOT NULL                       -- together|ahead_child|split_alert
);
CREATE INDEX IF NOT EXISTS idx_custody_family
    ON custody_checks(event_id, family_id, check_id);

-- ── 检录 / 医疗处置 / 离场（可信时间线的独立事实）─────────────
CREATE TABLE IF NOT EXISTS checkins (
    event_id        TEXT NOT NULL,
    runner_ref      TEXT NOT NULL REFERENCES runners(runner_ref),
    checked_at      TEXT NOT NULL,
    checked_epoch_ms INTEGER NOT NULL,
    operator_ref    TEXT NOT NULL,
    PRIMARY KEY (runner_ref)                            -- 每人只检录一次
);

CREATE TABLE IF NOT EXISTS medical_events (
    medical_id      TEXT PRIMARY KEY,
    event_id        TEXT NOT NULL,
    runner_ref      TEXT NOT NULL REFERENCES runners(runner_ref),
    checkpoint_ref  TEXT NOT NULL,
    occurred_at     TEXT NOT NULL,
    occurred_epoch_ms INTEGER NOT NULL,
    medic_ref       TEXT NOT NULL,
    disposition     TEXT NOT NULL,                       -- treated_on_site|transported
    transported_at  TEXT,                                -- 一旦有转运时间即停止成绩计算
    transported_epoch_ms INTEGER,
    note_digest     TEXT,                                -- 病情原文只存摘要
    UNIQUE (event_id, runner_ref, occurred_epoch_ms)
);
CREATE INDEX IF NOT EXISTS idx_medical_runner ON medical_events(event_id, runner_ref);

CREATE TABLE IF NOT EXISTS departures (
    event_id        TEXT NOT NULL,
    runner_ref      TEXT NOT NULL REFERENCES runners(runner_ref),
    departed_at     TEXT NOT NULL,
    departed_epoch_ms INTEGER NOT NULL,
    confirmed_by_ref TEXT NOT NULL,
    PRIMARY KEY (runner_ref)                            -- 每人只确认离场一次
);

-- 涉及定位/联系方式/未成年人轨迹的访问全部留痕
CREATE TABLE IF NOT EXISTS access_audit (
    audit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        TEXT NOT NULL,
    actor_role      TEXT NOT NULL,                       -- command|staff|medic|guardian
    actor_ref       TEXT NOT NULL,
    action          TEXT NOT NULL,
    target_ref      TEXT,
    family_id       TEXT,
    at_epoch_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runners_event ON runners(event_id);
