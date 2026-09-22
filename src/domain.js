"use strict";

const crypto = require("node:crypto");

const STAGE_SLA_DEFAULT = 1200;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

class DomainError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseOccurredAt(value) {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) {
    throw new DomainError("invalid_time", "occurred_at 必须是带偏移量的 ISO 8601 字符串");
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new DomainError("invalid_time", "occurred_at 无法解析");
  return ms;
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function withTransaction(database, work) {
  database.exec("BEGIN");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createDomain(database, options = {}) {
  const stageSlaDefault = options.stageSlaSeconds || STAGE_SLA_DEFAULT;
  const bootstrapCommandToken = options.commandToken || process.env.COMMAND_TOKEN || "";
  if (bootstrapCommandToken) {
    database
      .prepare(
        `INSERT OR IGNORE INTO access_tokens(token_hash, role, subject_ref, event_ref, label, issued_at)
         VALUES (?, 'command', NULL, NULL, '启动指挥席令牌', ?)`
      )
      .run(sha256(bootstrapCommandToken), nowIso());
  }

  const prepared = {
    getEvent: database.prepare("SELECT * FROM events WHERE event_ref = ?"),
    getCheckpoint: database.prepare("SELECT * FROM checkpoints WHERE checkpoint_ref = ?"),
    eventCheckpoints: database.prepare(
      "SELECT * FROM checkpoints WHERE event_ref = ? ORDER BY position"
    ),
    getParticipant: database.prepare("SELECT * FROM participants WHERE runner_ref = ?"),
    getFamily: database.prepare("SELECT * FROM families WHERE family_ref = ?"),
    familyMembers: database.prepare(
      "SELECT * FROM participants WHERE family_ref = ? ORDER BY role, bib"
    ),
    eventParticipants: database.prepare("SELECT * FROM participants WHERE event_ref = ?"),
    stateAt: database.prepare(
      "SELECT * FROM arrival_states WHERE runner_ref = ? AND checkpoint_ref = ?"
    ),
    runnerStates: database.prepare(
      `SELECT s.*, c.kind AS checkpoint_kind, c.position, c.label AS checkpoint_label, c.code AS checkpoint_code
       FROM arrival_states s JOIN checkpoints c ON c.checkpoint_ref = s.checkpoint_ref
       WHERE s.runner_ref = ? ORDER BY c.position`
    ),
    runnerRaws: database.prepare(
      "SELECT * FROM raw_events WHERE runner_ref = ? ORDER BY instant_ms, event_id"
    ),
    deleteStates: database.prepare("DELETE FROM arrival_states WHERE runner_ref = ?"),
    getStatus: database.prepare("SELECT * FROM runner_status WHERE runner_ref = ?"),
    deleteStatus: database.prepare("DELETE FROM runner_status WHERE runner_ref = ?"),
    openAlertsForFamily: database.prepare(
      "SELECT * FROM supervision_alerts WHERE family_ref = ? AND status = 'open'"
    ),
  };

  // ---------------------------------------------------------------- 配置与报名

  function createEvent(input) {
    const eventRef = requireText(input.event_ref, "event_ref");
    const title = requireText(input.title, "title");
    const sla = Number.isInteger(input.stage_sla_seconds) ? input.stage_sla_seconds : stageSlaDefault;
    try {
      database
        .prepare("INSERT INTO events(event_ref, title, stage_sla_seconds, created_at) VALUES (?, ?, ?, ?)")
        .run(eventRef, title, sla, nowIso());
    } catch (error) {
      throw uniqueOr(error, "event_exists", "赛事编号已存在");
    }
    return prepared.getEvent.get(eventRef);
  }

  function addCheckpoint(input) {
    const cpRef = requireText(input.checkpoint_ref, "checkpoint_ref");
    const eventRef = requireText(input.event_ref, "event_ref");
    const event = prepared.getEvent.get(eventRef);
    if (!event) throw new DomainError("event_not_found", "赛事不存在", 404);
    const code = requireText(input.code, "code");
    const label = requireText(input.label || input.code, "label");
    const kind = requireEnum(input.kind, ["start", "aid", "finish", "exit"], "kind");
    const raceType = requireEnum(input.race_type, ["family-5k", "individual-10k", "both"], "race_type");
    const position = Number.isInteger(input.position) ? input.position : null;
    if (position === null) throw new DomainError("invalid_position", "position 必须是整数");
    try {
      database
        .prepare(
          `INSERT INTO checkpoints(checkpoint_ref, event_ref, code, label, kind, race_type, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(cpRef, eventRef, code, label, kind, raceType, position);
    } catch (error) {
      throw uniqueOr(error, "checkpoint_exists", "检查点编号或代码已存在");
    }
    return prepared.getCheckpoint.get(cpRef);
  }

  function registerFamily(input) {
    const eventRef = requireText(input.event_ref, "event_ref");
    const event = prepared.getEvent.get(eventRef);
    if (!event) throw new DomainError("event_not_found", "赛事不存在", 404);
    const groupCode = requireText(input.group_code, "group_code");
    const familyRef = input.family_ref || `FAM-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
    const publicLabel = requireText(input.public_label, "public_label");
    const contactChannel = requireText(input.contact_channel, "contact_channel");
    const members = Array.isArray(input.members) ? input.members : null;
    if (!members || members.length === 0) throw new DomainError("members_required", "家庭成员不能为空");
    const guardians = members.filter((m) => m.role === "guardian");
    const minors = members.filter((m) => m.role === "minor");
    if (guardians.length === 0) throw new DomainError("guardian_required", "亲子组至少需要一名监护人");
    if (minors.length === 0) throw new DomainError("minor_required", "亲子组至少需要一名未成年人");
    if (members.some((m) => !["guardian", "minor"].includes(m.role))) {
      throw new DomainError("invalid_role", "家庭成员角色只能是 guardian 或 minor");
    }

    const inserted = [];
    withTransaction(database, () => {
      try {
        database
          .prepare(
            `INSERT INTO families(family_ref, event_ref, group_code, public_label, contact_channel, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(familyRef, eventRef, groupCode, publicLabel, contactChannel, nowIso());
      } catch (error) {
        throw uniqueOr(error, "family_exists", "家庭组编号或 group_code 已存在");
      }
      for (const member of members) {
        const bib = requireText(member.bib, "members[].bib");
        const runnerRef = member.runner_ref || `RUN-${eventRef}-${bib}`;
        const label = requireText(member.public_label || (member.role === "minor" ? "小选手" : bib), "public_label");
        try {
          database
            .prepare(
              `INSERT INTO participants(runner_ref, event_ref, family_ref, bib, race_type, role, public_label, is_minor)
               VALUES (?, ?, ?, ?, 'family-5k', ?, ?, ?)`
            )
            .run(runnerRef, eventRef, familyRef, bib, member.role, label, member.role === "minor" ? 1 : 0);
        } catch (error) {
          throw uniqueOr(error, "runner_exists", `参赛者或号码布已存在：${bib}`);
        }
        inserted.push({ runner_ref: runnerRef, bib, role: member.role, public_label: label });
      }
    });
    return { family: prepared.getFamily.get(familyRef), members: inserted };
  }

  function registerIndividual(input) {
    const eventRef = requireText(input.event_ref, "event_ref");
    if (!prepared.getEvent.get(eventRef)) throw new DomainError("event_not_found", "赛事不存在", 404);
    const bib = requireText(input.bib, "bib");
    const runnerRef = requireText(input.runner_ref || `RUN-${eventRef}-${bib}`, "runner_ref");
    const publicLabel = requireText(input.public_label || bib, "public_label");
    try {
      database
        .prepare(
          `INSERT INTO participants(runner_ref, event_ref, family_ref, bib, race_type, role, public_label, is_minor)
           VALUES (?, ?, NULL, ?, 'individual-10k', 'individual', ?, 0)`
        )
        .run(runnerRef, eventRef, bib, publicLabel);
    } catch (error) {
      throw uniqueOr(error, "runner_exists", "参赛者或号码布已存在");
    }
    return prepared.getParticipant.get(runnerRef);
  }

  // ---------------------------------------------------------------- 令牌

  function issueToken(input, actor) {
    const role = requireEnum(input.role, ["command", "marshal", "guardian"], "role");
    let subjectRef = null;
    let eventRef = input.event_ref || null;
    if (role === "guardian") {
      subjectRef = requireText(input.subject_ref, "subject_ref 必须是 family_ref");
      const family = prepared.getFamily.get(subjectRef);
      if (!family) throw new DomainError("family_not_found", "家庭不存在", 404);
      eventRef = family.event_ref;
    }
    if (role === "marshal") {
      eventRef = requireText(input.event_ref, "marshal 令牌必须绑定 event_ref");
      if (!prepared.getEvent.get(eventRef)) throw new DomainError("event_not_found", "赛事不存在", 404);
    }
    if (actor && actor.event_ref && eventRef && actor.event_ref !== eventRef) {
      throw new DomainError("scope_violation", "不能为其他赛事签发令牌", 403);
    }
    const plain = crypto.randomBytes(24).toString("base64url");
    const row = {
      token_hash: sha256(plain),
      role,
      subject_ref: subjectRef,
      event_ref: eventRef,
      label: input.label || null,
      issued_at: nowIso(),
    };
    database
      .prepare(
        "INSERT INTO access_tokens(token_hash, role, subject_ref, event_ref, label, issued_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(row.token_hash, row.role, row.subject_ref, row.event_ref, row.label, row.issued_at);
    return { token: plain, role, subject_ref: subjectRef, event_ref: eventRef, label: row.label };
  }

  function resolveToken(plain) {
    if (!plain) return null;
    return database
      .prepare("SELECT role, subject_ref, event_ref, label FROM access_tokens WHERE token_hash = ?")
      .get(sha256(plain)) || null;
  }

  // ---------------------------------------------------------------- 原始事实入库

  /**
   * 任何现场事件都走这里：
   * - raw_events 始终追加一行（重复刷卡也不例外）；
   * - 只有第一笔可信到达形成/维持唯一的 arrival_states 行；
   * - 人工 set/void 只改投影，不改任何旧事实；
   * - 入库后在同一事务内重放该参赛者全部事实，重建其投影与家庭监护告警。
   */
  function ingest(eventRef, payload, actor) {
    const event = prepared.getEvent.get(eventRef);
    if (!event) throw new DomainError("event_not_found", "赛事不存在", 404);
    const kind = requireEnum(payload.kind, ["chip", "checkin", "manual", "medical", "exit"], "kind");
    const runner = prepared.getParticipant.get(requireText(payload.runner_ref, "runner_ref"));
    if (!runner || runner.event_ref !== eventRef) {
      throw new DomainError("runner_not_found", "参赛者不属于该赛事", 404);
    }
    const instantMs = parseOccurredAt(payload.occurred_at);
    const operatorRef = textOrNull(payload.operator_ref);
    const reason = textOrNull(payload.reason);

    let checkpoint = null;
    if (payload.checkpoint_ref) {
      checkpoint = prepared.getCheckpoint.get(payload.checkpoint_ref);
      if (!checkpoint || checkpoint.event_ref !== eventRef) {
        throw new DomainError("checkpoint_not_found", "检查点不存在或不属于该赛事", 404);
      }
      if (checkpoint.race_type !== "both" && checkpoint.race_type !== runner.race_type) {
        throw new DomainError("route_mismatch", "该检查点不属于此参赛者的组别路线");
      }
    }

    if (["chip", "checkin", "manual"].includes(kind) && !checkpoint) {
      throw new DomainError("checkpoint_required", `${kind} 事件必须指定检查点`);
    }
    if (kind === "manual") {
      requireEnum(payload.correction_action, ["set", "void"], "correction_action");
      if (!operatorRef) throw new DomainError("operator_required", "人工更正必须记录操作人");
      if (!reason) throw new DomainError("reason_required", "人工更正必须记录原因");
    }
    if (kind === "medical") {
      requireEnum(payload.medical_action, ["treatment", "evacuation"], "medical_action");
      if (!operatorRef) throw new DomainError("operator_required", "医疗处置必须记录操作人");
    }
    if (kind === "exit" && checkpoint && checkpoint.kind !== "exit") {
      throw new DomainError("checkpoint_kind", "离场确认只能发生在 exit 检查点");
    }
    if (checkpoint && (kind === "chip" || kind === "checkin")) {
      if (checkpoint.kind === "exit") {
        throw new DomainError("checkpoint_kind", "离场闸机只接受 exit 事件");
      }
    }

    // 客户端幂等键：网络重放时原样返回第一次入库的事实
    if (payload.client_event_id) {
      const existing = database
        .prepare("SELECT event_id FROM raw_events WHERE event_ref = ? AND client_event_id = ?")
        .get(eventRef, String(payload.client_event_id));
      if (existing) {
        return { recorded: false, duplicate: true, event_id: existing.event_id, idempotent: true };
      }
    }

    // 重复刷卡：该检查点已有到达投影，新的 chip/checkin 只留事实、不动状态。
    let isDuplicate = false;
    let duplicateOf = null;
    if (checkpoint && (kind === "chip" || kind === "checkin")) {
      const current = prepared.stateAt.get(runner.runner_ref, checkpoint.checkpoint_ref);
      if (current) {
        isDuplicate = true;
        duplicateOf = current.source_event_id;
      }
    }

    const claimedSource = payload.source === "retransmitted" ? "retransmitted" : "live";
    let source;
    if (kind === "manual") source = "manual";
    else if (isDuplicate && claimedSource === "live") source = "duplicate";
    else source = claimedSource;

    const detailDigest = payload.detail_text ? sha256(payload.detail_text) : null;

    const eventId = withTransaction(database, () => {
      const result = database
        .prepare(
          `INSERT INTO raw_events(
             event_ref, kind, runner_ref, checkpoint_ref, device_id, device_sequence,
             source, occurred_at, instant_ms, received_at, operator_ref, reason,
             correction_action, medical_action, detail_digest, duplicate_of, client_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          eventRef,
          kind,
          runner.runner_ref,
          checkpoint ? checkpoint.checkpoint_ref : null,
          textOrNull(payload.device_id),
          Number.isInteger(payload.device_sequence) ? payload.device_sequence : null,
          source,
          payload.occurred_at,
          instantMs,
          nowIso(),
          operatorRef,
          reason,
          kind === "manual" ? payload.correction_action : null,
          kind === "medical" ? payload.medical_action : null,
          detailDigest,
          duplicateOf,
          payload.client_event_id ? String(payload.client_event_id) : null
        );
      const insertedId = Number(result.lastInsertRowid);
      replayRunner(runner.runner_ref, insertedId);
      if (runner.family_ref) evaluateFamily(runner.family_ref, insertedId, instantMs);
      return insertedId;
    });
    return { recorded: true, duplicate: isDuplicate, event_id: eventId, source };
  }

  // ---------------------------------------------------------------- 投影重放

  function replayRunner(runnerRef, triggerEventId) {
    const runner = prepared.getParticipant.get(runnerRef);
    const raws = prepared.runnerRaws.all(runnerRef);
    prepared.deleteStates.run(runnerRef);
    prepared.deleteStatus.run(runnerRef);

    // 按检查点收集全部事实，纯函数式推导唯一到达：
    //   - chip/checkin（含补传）按发生时间取最早一笔；重复刷卡天然被折叠；
    //   - manual void 是作废锚点：此前的到达全部作废，此后的真实读刷重新成立；
    //   - manual set 是人工权威锚点：同段内压过芯片读；
    // 推导只依赖事实本身，因此无论以何种顺序补录，重建结果一致。
    const byTime = (a, b) => a.instant_ms - b.instant_ms || a.event_id - b.event_id;
    const arrivals = new Map();
    const voids = new Map();
    const sets = new Map();
    const collect = (map, raw) => {
      if (!map.has(raw.checkpoint_ref)) map.set(raw.checkpoint_ref, []);
      map.get(raw.checkpoint_ref).push(raw);
    };
    for (const raw of raws) {
      if (!raw.checkpoint_ref) continue;
      if (raw.kind === "chip" || raw.kind === "checkin") collect(arrivals, raw);
      else if (raw.kind === "manual") collect(raw.correction_action === "void" ? voids : sets, raw);
    }

    const cpState = new Map();
    for (const cpRef of new Set([...arrivals.keys(), ...voids.keys(), ...sets.keys()])) {
      const voidList = (voids.get(cpRef) || []).slice().sort(byTime);
      const setList = (sets.get(cpRef) || []).slice().sort(byTime);
      const arrivalList = (arrivals.get(cpRef) || []).slice().sort(byTime);
      const lastVoid = voidList[voidList.length - 1];
      const inCurrentSegment = (raw) => !lastVoid || raw.instant_ms >= lastVoid.instant_ms;
      const segmentSets = setList.filter(inCurrentSegment);
      const segmentArrivals = arrivalList.filter(inCurrentSegment);
      let winner = null;
      if (segmentSets.length > 0) {
        const anchor = segmentSets[segmentSets.length - 1];
        winner = {
          checkpoint_ref: cpRef,
          arrival_kind: "manual",
          arrived_at: anchor.occurred_at,
          instant_ms: anchor.instant_ms,
          source_event_id: anchor.event_id,
          corrected: 1,
        };
      } else if (segmentArrivals.length > 0) {
        const first = segmentArrivals[0];
        winner = {
          checkpoint_ref: cpRef,
          arrival_kind: first.kind,
          arrived_at: first.occurred_at,
          instant_ms: first.instant_ms,
          source_event_id: first.event_id,
          corrected: 0,
        };
      }
      if (winner) cpState.set(cpRef, winner);
    }

    const insertState = database.prepare(
      `INSERT INTO arrival_states(runner_ref, checkpoint_ref, arrival_kind, arrived_at, instant_ms, source_event_id, corrected)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    let startState = null;
    let finishState = null;
    for (const state of cpState.values()) {
      const cp = prepared.getCheckpoint.get(state.checkpoint_ref);
      insertState.run(
        runnerRef,
        state.checkpoint_ref,
        state.arrival_kind,
        state.arrived_at,
        state.instant_ms,
        state.source_event_id,
        state.corrected
      );
      if (cp.kind === "start" && (!startState || state.instant_ms < startState.instant_ms)) startState = state;
      if (cp.kind === "finish" && (!finishState || state.instant_ms < finishState.instant_ms)) finishState = state;
    }

    // 生命周期重放：医疗转运对成绩是终局，之后的终点芯片不再产生成绩，
    // 最后可信位置也冻结在转运点（转运后的读刷视为设备异常，只留事实审计）。
    let checkedIn = null;
    let evacuated = null;
    let exited = null;
    let lastTrusted = null;
    for (const raw of raws) {
      if ((raw.kind === "chip" || raw.kind === "checkin") && raw.checkpoint_ref) {
        const cp = prepared.getCheckpoint.get(raw.checkpoint_ref);
        if (cp.kind === "start" && (!checkedIn || raw.instant_ms < checkedIn.instant_ms)) {
          checkedIn = raw;
        }
        if (!evacuated) {
          // 只有这笔读刷确实是该检查点的投影来源（最早到达或被锚定的一笔），才算可信位置
          const state = cpState.get(raw.checkpoint_ref);
          if (state && state.source_event_id === raw.event_id) {
            if (!lastTrusted || raw.instant_ms >= lastTrusted.instant_ms) {
              lastTrusted = { checkpoint_ref: raw.checkpoint_ref, instant_ms: raw.instant_ms };
            }
          }
        }
      }
      if (raw.kind === "manual" && raw.correction_action === "set" && raw.checkpoint_ref && !evacuated) {
        const state = cpState.get(raw.checkpoint_ref);
        if (state && state.source_event_id === raw.event_id) {
          if (!lastTrusted || raw.instant_ms >= lastTrusted.instant_ms) {
            lastTrusted = { checkpoint_ref: raw.checkpoint_ref, instant_ms: raw.instant_ms };
          }
        }
      }
      if (raw.kind === "medical") {
        if (raw.medical_action === "evacuation" && !evacuated) {
          evacuated = raw;
        }
        if (raw.checkpoint_ref && (!lastTrusted || raw.instant_ms >= lastTrusted.instant_ms)) {
          lastTrusted = { checkpoint_ref: raw.checkpoint_ref, instant_ms: raw.instant_ms };
        }
      }
      if (raw.kind === "exit") {
        if (!exited || raw.instant_ms < exited.instant_ms) exited = raw;
      }
    }

    const onCourse = startState && !finishState && !evacuated && !exited ? 1 : 0;
    const resultStatus = evacuated
      ? "medical_evacuation"
      : startState && finishState
        ? "finished"
        : "pending";
    database
      .prepare(
        `INSERT INTO runner_status(
           runner_ref, event_ref, checked_in_at, checked_in_ms, started_at, start_ms,
           finished_at, finish_ms, on_course, result_status, evacuated_at, evac_ms,
           exited_at, exit_ms, last_trusted_checkpoint_ref, last_trusted_ms, updated_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        runnerRef,
        runner.event_ref,
        checkedIn ? checkedIn.occurred_at : null,
        checkedIn ? checkedIn.instant_ms : null,
        startState ? startState.arrived_at : null,
        startState ? startState.instant_ms : null,
        !evacuated && finishState ? finishState.arrived_at : null,
        !evacuated && finishState ? finishState.instant_ms : null,
        onCourse,
        resultStatus,
        evacuated ? evacuated.occurred_at : null,
        evacuated ? evacuated.instant_ms : null,
        exited ? exited.occurred_at : null,
        exited ? exited.instant_ms : null,
        lastTrusted ? lastTrusted.checkpoint_ref : null,
        lastTrusted ? lastTrusted.instant_ms : null,
        triggerEventId
      );
  }

  /**
   * 亲子组监护关系持续校验：
   * 以本家庭最远监护人到达位置为基准，未成年人未到达的每个前置检查点都是一笔开放告警；
   * 追到、全家完赛或全家离场时告警关闭。
   */
  function evaluateFamily(familyRef, triggerEventId, triggerMs) {
    const family = prepared.getFamily.get(familyRef);
    if (!family) return;
    const members = prepared.familyMembers.all(familyRef);
    const route = prepared.eventCheckpoints
      .all(family.event_ref)
      .filter((c) => c.race_type === "family-5k" || c.race_type === "both");

    const statuses = new Map();
    const positions = new Map();
    for (const member of members) {
      statuses.set(member.runner_ref, prepared.getStatus.get(member.runner_ref));
      const reached = new Set(
        prepared.runnerStates.all(member.runner_ref).map((s) => s.position)
      );
      positions.set(member.runner_ref, reached);
    }

    const guardians = members.filter((m) => m.role === "guardian");
    let guardianMaxPosition = 0;
    for (const guardian of guardians) {
      for (const position of positions.get(guardian.runner_ref) || []) {
        if (position > guardianMaxPosition) guardianMaxPosition = position;
      }
    }
    const routeUpToGuardian = route.filter((c) => c.position <= guardianMaxPosition);

    const insertOpen = database.prepare(
      `INSERT INTO supervision_alerts(family_ref, runner_ref, checkpoint_ref, status, opened_event_id, opened_ms)
       VALUES (?, ?, ?, 'open', ?, ?)
       ON CONFLICT DO NOTHING`
    );
    const resolveOpen = database.prepare(
      `UPDATE supervision_alerts SET status = 'resolved', resolved_event_id = ?, resolved_ms = ?, resolution = ?
       WHERE alert_id = ?`
    );
    const existingOpen = prepared.openAlertsForFamily.all(familyRef);

    for (const member of members.filter((m) => m.role === "minor")) {
      const status = statuses.get(member.runner_ref);
      const reached = positions.get(member.runner_ref) || new Set();
      const offCourse = (s) => s && (s.exited_at || s.result_status !== "pending");
      const familyDone = members.every((m) => offCourse(statuses.get(m.runner_ref)));
      const expectedMissing = [];
      for (const cp of routeUpToGuardian) {
        if (!reached.has(cp.position)) expectedMissing.push(cp);
      }
      const minorClosed = offCourse(status);
      const missingKeys = new Set(expectedMissing.map((c) => c.checkpoint_ref));

      for (const cp of expectedMissing) {
        insertOpen.run(familyRef, member.runner_ref, cp.checkpoint_ref, triggerEventId, triggerMs || Date.now());
      }
      for (const alert of existingOpen.filter((a) => a.runner_ref === member.runner_ref)) {
        if (familyDone) {
          resolveOpen.run(triggerEventId, triggerMs || Date.now(), "family_closed", alert.alert_id);
        } else if (minorClosed) {
          resolveOpen.run(triggerEventId, triggerMs || Date.now(), "minor_finished", alert.alert_id);
        } else if (!missingKeys.has(alert.checkpoint_ref)) {
          resolveOpen.run(triggerEventId, triggerMs || Date.now(), "reunited", alert.alert_id);
        }
      }
    }
  }

  // ---------------------------------------------------------------- 查询口径

  function checkpointLabel(ref) {
    return ref ? prepared.getCheckpoint.get(ref) : null;
  }

  function findList(eventRef, options = {}) {
    const event = prepared.getEvent.get(eventRef);
    if (!event) throw new DomainError("event_not_found", "赛事不存在", 404);
    const now = options.nowMs || Date.now();
    const openAlerts = database
      .prepare(
        `SELECT a.*, p.public_label AS minor_label, p.bib AS minor_bib, p.is_minor,
                f.family_ref, f.public_label AS family_label, f.contact_channel
         FROM supervision_alerts a
         JOIN participants p ON p.runner_ref = a.runner_ref
         JOIN families f ON f.family_ref = a.family_ref
         WHERE a.status = 'open' AND f.event_ref = ?`
      )
      .all(eventRef);

    const entries = new Map();
    const pushEntry = (key, entry) => {
      const existing = entries.get(key);
      if (!existing) {
        entries.set(key, entry);
        return;
      }
      if (entry.reason === "supervision_gap") existing.reason = "supervision_gap";
      existing.flags = new Set([...(existing.flags || []), ...(entry.flags || [])]);
    };

    for (const alert of openAlerts) {
      const status = prepared.getStatus.get(alert.runner_ref);
      if (!status || status.exited_at || status.result_status === "medical_evacuation") continue;
      const lastCp = status.last_trusted_checkpoint_ref
        ? checkpointLabel(status.last_trusted_checkpoint_ref)
        : null;
      const guardianRow = database
        .prepare(
          `SELECT p.runner_ref, s.last_trusted_checkpoint_ref, s.last_trusted_ms
           FROM participants p JOIN runner_status s ON s.runner_ref = p.runner_ref
           WHERE p.family_ref = ? AND p.role = 'guardian'
           ORDER BY s.last_trusted_ms DESC LIMIT 1`
        )
        .get(alert.family_ref);
      const guardianCp = guardianRow && guardianRow.last_trusted_checkpoint_ref
        ? checkpointLabel(guardianRow.last_trusted_checkpoint_ref)
        : null;
      pushEntry(alert.runner_ref, {
        runner_ref: alert.runner_ref,
        bib: alert.minor_bib,
        public_label: alert.minor_label,
        race_type: "family-5k",
        is_minor: 1,
        last_seen: {
          checkpoint_ref: lastCp ? lastCp.checkpoint_ref : null,
          label: lastCp ? lastCp.label : "尚未经过检查点",
          at: status.last_trusted_ms ? new Date(status.last_trusted_ms).toISOString() : null,
          age_seconds: status.last_trusted_ms ? Math.round((now - status.last_trusted_ms) / 1000) : null,
        },
        reason: "supervision_gap",
        flags: new Set(["minor_separated"]),
        family: {
          family_ref: alert.family_ref,
          public_label: alert.family_label,
          guardian_last_seen: guardianCp
            ? { checkpoint_ref: guardianCp.checkpoint_ref, label: guardianCp.label }
            : null,
        },
        contact_channel: alert.contact_channel,
      });
    }

    // 超时未通过下一个检查点（含十公里个人组）
    const overdue = database
      .prepare(
        `SELECT p.*, s.last_trusted_checkpoint_ref, s.last_trusted_ms
         FROM participants p JOIN runner_status s ON s.runner_ref = p.runner_ref
         WHERE p.event_ref = ? AND s.on_course = 1`
      )
      .all(eventRef);
    for (const row of overdue) {
      if (!row.last_trusted_ms) continue;
      const age = Math.round((now - row.last_trusted_ms) / 1000);
      if (age <= event.stage_sla_seconds) continue;
      const lastCp = row.last_trusted_checkpoint_ref
        ? checkpointLabel(row.last_trusted_checkpoint_ref)
        : null;
      const base = entries.get(row.runner_ref);
      if (base) {
        base.flags.add("overdue");
        continue;
      }
      const family = row.family_ref ? prepared.getFamily.get(row.family_ref) : null;
      pushEntry(row.runner_ref, {
        runner_ref: row.runner_ref,
        bib: row.bib,
        public_label: row.public_label,
        race_type: row.race_type,
        is_minor: row.is_minor,
        last_seen: {
          checkpoint_ref: lastCp ? lastCp.checkpoint_ref : null,
          label: lastCp ? lastCp.label : "起点",
          at: new Date(row.last_trusted_ms).toISOString(),
          age_seconds: age,
        },
        reason: "overdue",
        flags: new Set(["overdue"]),
        family: family ? { family_ref: family.family_ref, public_label: family.public_label } : null,
        contact_channel: family ? family.contact_channel : null,
      });
    }

    return [...entries.values()].map((entry) => ({ ...entry, flags: [...entry.flags] }));
  }

  // 志愿者口径：无联系方式、无未成年人轨迹，只有当前位置与要找的人
  function marshalList(eventRef, options = {}) {
    return findList(eventRef, options).map((entry) => ({
      bib: entry.bib,
      public_label: entry.is_minor ? "同组小选手" : entry.public_label,
      race_type: entry.race_type,
      last_seen: entry.last_seen,
      reason: entry.reason,
      flags: entry.flags,
    }));
  }

  function familyView(familyRef) {
    const family = prepared.getFamily.get(familyRef);
    if (!family) throw new DomainError("family_not_found", "家庭不存在", 404);
    const members = prepared.familyMembers.all(familyRef).map((member) => {
      const status = prepared.getStatus.get(member.runner_ref) || null;
      const states = prepared.runnerStates.all(member.runner_ref).map((s) => ({
        checkpoint_code: s.checkpoint_code,
        label: s.checkpoint_label,
        kind: s.checkpoint_kind,
        arrived_at: s.arrived_at,
        arrival_kind: s.arrival_kind,
        corrected: !!s.corrected,
      }));
      return {
        runner_ref: member.runner_ref,
        bib: member.bib,
        role: member.role,
        public_label: member.public_label,
        status: status
          ? {
              checked_in_at: status.checked_in_at,
              started_at: status.started_at,
              finished_at: status.finished_at,
              result_status: status.result_status,
              evacuated_at: status.evacuated_at,
              exited_at: status.exited_at,
              last_seen: status.last_trusted_checkpoint_ref
                ? {
                    label: checkpointLabel(status.last_trusted_checkpoint_ref).label,
                    at: new Date(status.last_trusted_ms).toISOString(),
                  }
                : null,
            }
          : null,
        checkpoints: states,
      };
    });
    const alerts = database
      .prepare("SELECT * FROM supervision_alerts WHERE family_ref = ? AND status = 'open'")
      .all(familyRef)
      .map((alert) => ({
        runner_ref: alert.runner_ref,
        checkpoint_ref: alert.checkpoint_ref,
        opened_at: new Date(alert.opened_ms).toISOString(),
      }));
    return {
      family_ref: family.family_ref,
      group_code: family.group_code,
      public_label: family.public_label,
      members,
      open_alerts: alerts,
    };
  }

  function results(eventRef) {
    const event = prepared.getEvent.get(eventRef);
    if (!event) throw new DomainError("event_not_found", "赛事不存在", 404);

    const individuals = database
      .prepare(
        `SELECT p.runner_ref, p.bib, p.public_label, s.*
         FROM participants p JOIN runner_status s ON s.runner_ref = p.runner_ref
         WHERE p.event_ref = ? AND p.race_type = 'individual-10k' AND s.result_status = 'finished'
         ORDER BY (s.finish_ms - s.start_ms)`
      )
      .all(eventRef);
    const individualRows = individuals.map((row, index) => ({
      rank: index + 1,
      bib: row.bib,
      public_label: row.public_label,
      time_ms: row.finish_ms - row.start_ms,
      started_at: row.started_at,
      finished_at: row.finished_at,
    }));

    // 亲子组只公布家庭整体成绩，不拆到未成年人个人
    const families = database
      .prepare("SELECT * FROM families WHERE event_ref = ?").all(eventRef);
    const familyRows = [];
    for (const family of families) {
      const members = prepared.familyMembers.all(family.family_ref);
      const statuses = members.map((m) => prepared.getStatus.get(m.runner_ref));
      if (statuses.some((s) => !s || s.result_status !== "finished")) continue;
      const minStart = Math.min(...statuses.map((s) => s.start_ms));
      const maxFinish = Math.max(...statuses.map((s) => s.finish_ms));
      familyRows.push({
        group_code: family.group_code,
        public_label: family.public_label,
        members: members.length,
        time_ms: maxFinish - minStart,
        started_at: new Date(minStart).toISOString(),
        finished_at: new Date(maxFinish).toISOString(),
      });
    }
    familyRows.sort((a, b) => a.time_ms - b.time_ms);
    familyRows.forEach((row, index) => {
      row.rank = index + 1;
    });

    return {
      event_ref: eventRef,
      "individual-10k": individualRows,
      "family-5k": familyRows,
    };
  }

  function summary(eventRef) {
    const event = prepared.getEvent.get(eventRef);
    if (!event) throw new DomainError("event_not_found", "赛事不存在", 404);
    const counts = database
      .prepare(
        `SELECT p.race_type,
                COUNT(*) AS registered,
                SUM(CASE WHEN s.checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS checked_in,
                SUM(CASE WHEN s.on_course = 1 THEN 1 ELSE 0 END) AS on_course,
                SUM(CASE WHEN s.result_status = 'finished' THEN 1 ELSE 0 END) AS finished,
                SUM(CASE WHEN s.result_status = 'medical_evacuation' THEN 1 ELSE 0 END) AS evacuated,
                SUM(CASE WHEN s.exited_at IS NOT NULL THEN 1 ELSE 0 END) AS exited
         FROM participants p LEFT JOIN runner_status s ON s.runner_ref = p.runner_ref
         WHERE p.event_ref = ? GROUP BY p.race_type`
      )
      .all(eventRef);
    // 刻意只给粗粒度计数：不提供未成年人在各检查点的分布，避免反推精确路线
    const openAlerts = database
      .prepare(
        `SELECT COUNT(*) AS n FROM supervision_alerts a
         JOIN families f ON f.family_ref = a.family_ref
         WHERE a.status = 'open' AND f.event_ref = ?`
      )
      .get(eventRef).n;
    return { event_ref: eventRef, open_supervision_alerts: openAlerts, by_race_type: counts };
  }

  function runnerTimeline(runnerRef) {
    const runner = prepared.getParticipant.get(runnerRef);
    if (!runner) throw new DomainError("runner_not_found", "参赛者不存在", 404);
    return {
      runner: {
        runner_ref: runner.runner_ref,
        bib: runner.bib,
        race_type: runner.race_type,
        role: runner.role,
        family_ref: runner.family_ref,
      },
      raw_events: prepared.runnerRaws.all(runnerRef).map((raw) => ({
        event_id: raw.event_id,
        kind: raw.kind,
        source: raw.source,
        checkpoint_ref: raw.checkpoint_ref,
        device_id: raw.device_id,
        device_sequence: raw.device_sequence,
        occurred_at: raw.occurred_at,
        received_at: raw.received_at,
        operator_ref: raw.operator_ref,
        reason: raw.reason,
        correction_action: raw.correction_action,
        medical_action: raw.medical_action,
        detail_digest: raw.detail_digest,
        duplicate_of: raw.duplicate_of,
      })),
      arrival_states: prepared.runnerStates.all(runnerRef).map((s) => ({
        checkpoint_ref: s.checkpoint_ref,
        checkpoint_code: s.checkpoint_code,
        arrived_at: s.arrived_at,
        arrival_kind: s.arrival_kind,
        corrected: !!s.corrected,
        source_event_id: s.source_event_id,
      })),
      status: prepared.getStatus.get(runnerRef),
    };
  }

  return {
    createEvent,
    addCheckpoint,
    registerFamily,
    registerIndividual,
    issueToken,
    resolveToken,
    ingest,
    findList,
    marshalList,
    familyView,
    results,
    summary,
    runnerTimeline,
  };
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("invalid_field", `${field} 必填且必须是非空字符串`);
  }
  return value.trim();
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new DomainError("invalid_enum", `${field} 必须是 ${allowed.join(" / ")} 之一`);
  }
  return value;
}

function uniqueOr(error, code, message) {
  if (String(error.message).includes("UNIQUE")) return new DomainError(code, message, 409);
  throw error;
}

module.exports = { createDomain, DomainError, sha256, parseOccurredAt };
