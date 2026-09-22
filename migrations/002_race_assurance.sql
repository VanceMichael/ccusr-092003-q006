-- 赛事保障系统：报名 → 检录 → 检查点 → 医疗处置 → 离场
-- 设计原则：
--   1. raw_events 只追加、永不修改：重复刷卡 / 芯片补传 / 人工更正全部保留为原始事实；
--   2. arrival_states 是每个参赛者在每个检查点的唯一一个到达状态（投影，可由事实重建）；
--   3. runner_status 是生命周期投影（检录、出发、完赛、转运、离场）；
--   4. supervision_alerts 是亲子组监护关系的持续校验投影（落后即开、追到即解）；
--   5. 家庭电话单独存表，仅指挥席角色可读取；公开口径不含任何检查点级数据。

CREATE TABLE IF NOT EXISTS events (
    event_ref         TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    stage_sla_seconds INTEGER NOT NULL DEFAULT 1200,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_ref TEXT PRIMARY KEY,
    event_ref      TEXT NOT NULL REFERENCES events(event_ref),
    code           TEXT NOT NULL,
    label          TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('start', 'aid', 'finish', 'exit')),
    race_type      TEXT NOT NULL CHECK (race_type IN ('family-5k', 'individual-10k', 'both')),
    position       INTEGER NOT NULL,
    UNIQUE (event_ref, code)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_event ON checkpoints(event_ref, race_type, position);

CREATE TABLE IF NOT EXISTS families (
    family_ref      TEXT PRIMARY KEY,
    event_ref       TEXT NOT NULL REFERENCES events(event_ref),
    group_code      TEXT NOT NULL,
    public_label    TEXT NOT NULL,
    contact_channel TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE (event_ref, group_code)
);

CREATE TABLE IF NOT EXISTS participants (
    runner_ref   TEXT PRIMARY KEY,
    event_ref    TEXT NOT NULL REFERENCES events(event_ref),
    family_ref   TEXT REFERENCES families(family_ref),
    bib          TEXT NOT NULL,
    race_type    TEXT NOT NULL CHECK (race_type IN ('family-5k', 'individual-10k')),
    role         TEXT NOT NULL CHECK (role IN ('guardian', 'minor', 'individual')),
    public_label TEXT NOT NULL,
    is_minor     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (event_ref, bib)
);
CREATE INDEX IF NOT EXISTS idx_participants_family ON participants(family_ref);
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_ref);

-- 只保存令牌摘要；明文仅在签发时返回一次
CREATE TABLE IF NOT EXISTS access_tokens (
    token_hash  TEXT PRIMARY KEY,
    role        TEXT NOT NULL CHECK (role IN ('command', 'marshal', 'guardian')),
    subject_ref TEXT,
    event_ref   TEXT,
    label       TEXT,
    issued_at   TEXT NOT NULL
);

-- 不可变原始事实流
CREATE TABLE IF NOT EXISTS raw_events (
    event_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_ref          TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN ('chip', 'checkin', 'manual', 'medical', 'exit')),
    runner_ref         TEXT NOT NULL,
    checkpoint_ref     TEXT,
    device_id          TEXT,
    device_sequence    INTEGER,
    source             TEXT NOT NULL CHECK (source IN ('live', 'retransmitted', 'duplicate', 'manual')),
    occurred_at        TEXT NOT NULL,   -- 原样保留，带偏移量 ISO 8601
    instant_ms         INTEGER NOT NULL,-- 同时保存纪元毫秒用于确定性排序
    received_at        TEXT NOT NULL,
    operator_ref       TEXT,
    reason             TEXT,
    correction_action  TEXT CHECK (correction_action IN ('set', 'void')),
    medical_action     TEXT CHECK (medical_action IN ('treatment', 'evacuation')),
    detail_digest      TEXT,            -- 敏感口述材料只保存 sha256 摘要
    duplicate_of       INTEGER,
    client_event_id    TEXT,
    FOREIGN KEY (duplicate_of) REFERENCES raw_events(event_id)
);
CREATE INDEX IF NOT EXISTS idx_raw_runner_time ON raw_events(runner_ref, instant_ms, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_idempotency
    ON raw_events(event_ref, client_event_id)
    WHERE client_event_id IS NOT NULL;

-- 投影：每个参赛者 × 检查点恰好一条到达状态
CREATE TABLE IF NOT EXISTS arrival_states (
    runner_ref       TEXT NOT NULL,
    checkpoint_ref   TEXT NOT NULL,
    arrival_kind     TEXT NOT NULL CHECK (arrival_kind IN ('chip', 'checkin', 'manual')),
    arrived_at       TEXT NOT NULL,
    instant_ms       INTEGER NOT NULL,
    source_event_id  INTEGER NOT NULL,
    corrected        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (runner_ref, checkpoint_ref),
    FOREIGN KEY (source_event_id) REFERENCES raw_events(event_id)
);

-- 投影：参赛者生命周期状态
CREATE TABLE IF NOT EXISTS runner_status (
    runner_ref                  TEXT PRIMARY KEY,
    event_ref                   TEXT NOT NULL,
    checked_in_at               TEXT,
    checked_in_ms               INTEGER,
    started_at                  TEXT,
    start_ms                    INTEGER,
    finished_at                 TEXT,
    finish_ms                   INTEGER,
    on_course                   INTEGER NOT NULL DEFAULT 0,
    result_status               TEXT NOT NULL DEFAULT 'pending'
        CHECK (result_status IN ('pending', 'finished', 'medical_evacuation')),
    evacuated_at                TEXT,
    evac_ms                     INTEGER,
    exited_at                   TEXT,
    exit_ms                     INTEGER,
    last_trusted_checkpoint_ref TEXT,
    last_trusted_ms             INTEGER,
    updated_event_id             INTEGER
);

-- 投影：亲子组监护关系持续校验告警（落后成员 / 未到达的检查点）
CREATE TABLE IF NOT EXISTS supervision_alerts (
    alert_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    family_ref         TEXT NOT NULL,
    runner_ref         TEXT NOT NULL,
    checkpoint_ref     TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    opened_event_id    INTEGER NOT NULL,
    opened_ms          INTEGER NOT NULL,
    resolved_event_id  INTEGER,
    resolved_ms        INTEGER,
    resolution         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_open_unique
    ON supervision_alerts(family_ref, runner_ref, checkpoint_ref)
    WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_alert_family ON supervision_alerts(family_ref, status);

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_race_assurance');
