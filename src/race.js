
const { parseTime, toIso, nowParts, sha256, randomToken, seal, open } = require("./util");

const GROUPS = {
  "family-5k": { requiresGuardian: true },
  "individual-10k": { requiresGuardian: false },
};

// 补传判定阈值：发生时间早于接收时间超过该窗口视为设备离线补传
const BACKFILL_THRESHOLD_MS = Number.parseInt(process.env.BACKFILL_THRESHOLD_MS || "30000", 10);

class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class RaceService {
  constructor(db, clock = nowParts) {
    this.db = db;
    this.clock = clock;
  }

  // ── 内部工具 ───────────────────────────────────────────────
  #now() {
    return this.clock();
  }

  #get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  #all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  #run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  #audit(principal, action, eventId, { targetRef = null, familyId = null } = {}) {
    const { epochMs } = this.#now();
    this.#run(
      `INSERT INTO access_audit(event_id, actor_role, actor_ref, action, target_ref, family_id, at_epoch_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      principal?.role || "anonymous",
      principal?.operatorRef || principal?.runnerRef || "unknown",
      action,
      targetRef,
      familyId,
      epochMs
    );
  }

  /** 访问留痕（HTTP 层在查看敏感信息时调用）。 */
  audit(principal, action, eventId, options = {}) {
    this.#audit(principal, action, eventId, options);
  }

  // ── 赛事搭建（管理/指挥席）──────────────────────────────────
  createEvent({ event_id, name, race_date }) {
    if (!event_id || !name || !race_date) {
      throw new DomainError("missing_field", "event_id/name/race_date 必填");
    }
    parseTime(new Date(race_date).toISOString()); // 仅校验日期可解析
    const { iso } = this.#now();
    this.#run(
      "INSERT INTO events(event_id, name, race_date, created_at) VALUES (?, ?, ?, ?)",
      event_id, name, race_date, iso
    );
    return { event_id, name, race_date };
  }

  addCheckpoint({ event_id, checkpoint_ref, title, sequence, kind }) {
    this.#requireEvent(event_id);
    if (!checkpoint_ref || !title || !Number.isInteger(sequence)) {
      throw new DomainError("missing_field", "checkpoint_ref/title/sequence 必填");
    }
    const kindValue = kind || "checkpoint";
    if (!["checkpoint", "aid_station", "start", "finish"].includes(kindValue)) {
      throw new DomainError("bad_kind", "检查点类型不合法");
    }
    this.#run(
      `INSERT INTO checkpoints(event_id, checkpoint_ref, title, sequence, kind)
       VALUES (?, ?, ?, ?, ?)`,
      event_id, checkpoint_ref, title, sequence, kindValue
    );
    return { event_id, checkpoint_ref, title, sequence, kind: kindValue };
  }

  #requireEvent(eventId) {
    const event = this.#get("SELECT * FROM events WHERE event_id = ?", eventId);
    if (!event) throw new DomainError("unknown_event", "赛事不存在", 404);
    return event;
  }

  // ── 令牌发放 ────────────────────────────────────────────────
  issueStaffToken({ event_id = null, role, operator_ref }, scope = {}) {
    if (!["command", "staff", "medic"].includes(role)) {
      throw new DomainError("bad_role", "工作人员角色必须为 command/staff/medic");
    }
    if (!operator_ref) throw new DomainError("missing_field", "operator_ref 必填");
    if (event_id) this.#requireEvent(event_id);
    // 赛事级指挥令牌不得为其他赛事发放令牌；普通志愿者/医疗席无权发令牌（由路由层拦截）
    if (scope.eventId && event_id && scope.eventId !== event_id) {
      throw new DomainError("forbidden", "不能为其他赛事发放令牌", 403);
    }
    const token = randomToken();
    const { iso } = this.#now();
    this.#run(
      `INSERT INTO staff_tokens(token_hash, event_id, role, operator_ref, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      sha256(token), event_id, role, operator_ref, iso
    );
    return { token, role, operator_ref, event_id };
  }

  /** 家长令牌：只有亲子组的家长本人可领取，且令牌只绑定其家庭。 */
  issueFamilyToken({ runner_ref }) {
    const runner = this.#get("SELECT * FROM runners WHERE runner_ref = ?", runner_ref);
    if (!runner) throw new DomainError("unknown_runner", "参赛者不存在", 404);
    if (runner.group_code !== "family-5k" || runner.family_role !== "guardian" || !runner.family_id) {
      throw new DomainError("not_a_guardian", "只有亲子组家长可以领取家庭查询令牌", 403);
    }
    const token = randomToken();
    const { iso } = this.#now();
    this.#run(
      `INSERT INTO family_tokens(token_hash, event_id, family_id, issued_to_ref, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      sha256(token), runner.event_id, runner.family_id, runner.runner_ref, iso
    );
    return { token, family_id: runner.family_id, runner_ref };
  }

  authenticate(token) {
    if (!token) throw new DomainError("unauthorized", "缺少令牌", 401);

    // 引导令牌：仅在设置了 COMMAND_BOOTSTRAP_TOKEN 时可用，用于发放首张工作人员令牌
    const bootstrap = process.env.COMMAND_BOOTSTRAP_TOKEN;
    if (bootstrap && token === bootstrap) {
      return { kind: "staff", role: "command", operatorRef: "bootstrap-command", eventId: null };
    }

    const hash = sha256(token);
    const staff = this.#get(
      "SELECT * FROM staff_tokens WHERE token_hash = ? AND revoked_at IS NULL", hash
    );
    if (staff) {
      return { kind: "staff", role: staff.role, operatorRef: staff.operator_ref, eventId: staff.event_id };
    }
    const family = this.#get(
      "SELECT * FROM family_tokens WHERE token_hash = ? AND revoked_at IS NULL", hash
    );
    if (family) {
      return {
        kind: "guardian",
        role: "guardian",
        runnerRef: family.issued_to_ref,
        familyId: family.family_id,
        eventId: family.event_id,
      };
    }
    throw new DomainError("unauthorized", "令牌无效", 401);
  }

  // ── 报名：写入监护关系与联系方式封存 ────────────────────────
  registerRunner(input) {
    const {
      runner_ref, event_id, group_code, bib, display_name,
      is_minor = false, family_id = null, guardian_ref = null, family_role = null,
      chip_id, contact = null,
    } = input;
    this.#requireEvent(event_id);
    if (!GROUPS[group_code]) throw new DomainError("bad_group", "未知组别");
    if (!runner_ref || !bib || !display_name || !chip_id) {
      throw new DomainError("missing_field", "runner_ref/bib/display_name/chip_id 必填");
    }
    if (family_role && !["guardian", "child"].includes(family_role)) {
      throw new DomainError("bad_family_role", "family_role 必须为 guardian 或 child");
    }

    if (group_code === "family-5k") {
      // 五公里亲子组：监护关系在报名时建立并持续校验
      if (!family_id || !family_role) {
        throw new DomainError("family_required", "亲子组必须归属家庭并声明家庭角色");
      }
      if (family_role === "child") {
        if (!is_minor) throw new DomainError("minor_required", "亲子组孩子必须标记为未成年人");
        if (!guardian_ref) throw new DomainError("guardian_required", "孩子必须登记监护人");
        const guardian = this.#get("SELECT * FROM runners WHERE runner_ref = ?", guardian_ref);
        if (!guardian) throw new DomainError("unknown_guardian", "监护人尚未报名");
        if (guardian.family_id !== family_id || guardian.family_role !== "guardian") {
          throw new DomainError("guardian_mismatch", "监护人不属于同一家庭或不是家长角色");
        }
      }
      if (family_role === "guardian" && (is_minor || guardian_ref)) {
        throw new DomainError("guardian_invalid", "家长不能标记为未成年人或再挂监护人");
      }
    } else {
      // 十公里个人组：独立计时，不允许监护关系字段
      if (family_id || guardian_ref || family_role) {
        throw new DomainError("individual_no_family", "个人组不得携带家庭/监护字段");
      }
    }

    let contactRef = null;
    if (contact) {
      if (!contact.channel || !contact.detail) {
        throw new DomainError("bad_contact", "联系方式需要 channel 与 detail");
      }
      contactRef = `CONTACT-${sha256(runner_ref).slice(0, 16)}`;
      this.#run(
        `INSERT INTO contact_registry(contact_ref, channel, detail_digest, detail_cipher)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(contact_ref) DO UPDATE SET
           channel=excluded.channel,
           detail_digest=excluded.detail_digest,
           detail_cipher=excluded.detail_cipher`,
        contactRef, contact.channel, sha256(contact.detail), seal(contact.detail)
      );
    }

    const { iso } = this.#now();
    this.#run(
      `INSERT INTO runners
        (runner_ref, event_id, group_code, bib, display_name, is_minor, family_id,
         guardian_ref, family_role, chip_id, contact_ref, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runner_ref, event_id, group_code, bib, display_name, is_minor ? 1 : 0,
      family_id, guardian_ref, family_role, chip_id, contactRef, iso
    );
    return {
      runner_ref, event_id, group_code, bib, display_name,
      is_minor: !!is_minor, family_id, guardian_ref, family_role, chip_id,
      contact_ref: contactRef, // 只回引用，不回内容
    };
  }

  // ── 可信时间线：检录 / 芯片 / 更正 / 医疗 / 离场 ────────────
  checkin({ runner_ref, operator_ref, at = null }) {
    const runner = this.#requireRunner(runner_ref);
    if (!operator_ref) throw new DomainError("missing_field", "operator_ref 必填");
    const time = at ? parseTime(at) : this.#now();
    try {
      this.#run(
        `INSERT INTO checkins(event_id, runner_ref, checked_at, checked_epoch_ms, operator_ref)
         VALUES (?, ?, ?, ?, ?)`,
        runner.event_id, runner_ref, time.iso, time.epochMs, operator_ref
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new DomainError("already_checked_in", "该参赛者已检录", 409);
      }
      throw error;
    }
    return { runner_ref, checked_at: time.iso };
  }

  #requireRunner(runnerRef) {
    const runner = this.#get("SELECT * FROM runners WHERE runner_ref = ?", runnerRef);
    if (!runner) throw new DomainError("unknown_runner", "参赛者不存在", 404);
    return runner;
  }

  runnerEventId(runnerRef) {
    const runner = this.#get("SELECT event_id FROM runners WHERE runner_ref = ?", runnerRef);
    return runner?.event_id ?? null;
  }

  #checkpoint(eventId, checkpointRef) {
    const cp = this.#get(
      "SELECT * FROM checkpoints WHERE event_id = ? AND checkpoint_ref = ?",
      eventId, checkpointRef
    );
    if (!cp) throw new DomainError("unknown_checkpoint", "检查点不存在", 404);
    return cp;
  }

  /**
   * 芯片读取入口（实时或设备补传统一走这里）。
   * 保证：
   *  - 同一读取（芯片+检查点+发生时间）重复上报 → 只追加 chip_repeat 事实，不改状态；
   *  - 同人同点再次经过 → pass_count 增加，到达时间仍以最早一次为准；
   *  - 迟到的补传只影响“尚未建立”的到达，不产生第二个到达状态；
   *  - 每个 (人, 检查点) 在 arrival_status 中始终只有一行。
   */
  recordChipRead({ chip_id, checkpoint_ref, occurred_at, device_sequence = null, idempotency_key = null }) {
    const runner = this.#get("SELECT * FROM runners WHERE chip_id = ?", chip_id);
    if (!runner) throw new DomainError("unknown_chip", "芯片未绑定参赛者", 404);
    this.#checkpoint(runner.event_id, checkpoint_ref);
    const occurred = parseTime(occurred_at);
    const received = this.#now();
    const key = idempotency_key || sha256(`${chip_id}|${checkpoint_ref}|${occurred.epochMs}`);
    const rawDigest = sha256(`${chip_id}|${checkpoint_ref}|${occurred.iso}|${device_sequence ?? ""}`);

    this.db.exec("BEGIN");
    let result;
    try {
      const duplicate = this.#get(
        "SELECT seq FROM arrival_events WHERE ingest_idempotency_key = ?",
        key
      );
      const existing = this.#get(
        "SELECT * FROM arrival_status WHERE runner_ref = ? AND checkpoint_ref = ?",
        runner.runner_ref, checkpoint_ref
      );

      let source;
      let heldKey = null;
      const lateBy = received.epochMs - occurred.epochMs > BACKFILL_THRESHOLD_MS;
      const earlierThanStatus = existing && occurred.epochMs < existing.believed_epoch_ms;
      if (duplicate) {
        source = "chip_repeat"; // 同一读取重发：独立留痕
      } else if (existing && earlierThanStatus && lateBy) {
        source = "chip_backfill"; // 迟到的更早事实：补传，将采信时间前移
        heldKey = key;
      } else if (existing) {
        source = "chip_repeat"; // 同点再次经过（更晚时间）
      } else if (lateBy) {
        source = "chip_backfill"; // 设备离线补传，首次建立到达
        heldKey = key;
      } else {
        source = "chip_realtime";
        heldKey = key;
      }

      const seq = this.#nextSeq(runner.event_id);
      this.#run(
        `INSERT INTO arrival_events
          (event_id, seq, runner_ref, checkpoint_ref, source, occurred_at, occurred_epoch_ms,
           received_at, received_epoch_ms, device_sequence, ingest_idempotency_key, raw_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runner.event_id, seq, runner.runner_ref, checkpoint_ref, source,
        occurred.iso, occurred.epochMs, received.iso, received.epochMs,
        device_sequence, heldKey, rawDigest
      );

      if (!existing) {
        // 首个到达：建立唯一状态行
        this.#run(
          `INSERT INTO arrival_status
            (runner_ref, checkpoint_ref, event_id, believed_occurred_at, believed_epoch_ms,
             accepted_source, accepted_seq, pass_count, corrected_count, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
          runner.runner_ref, checkpoint_ref, runner.event_id,
          occurred.iso, occurred.epochMs, source, seq, received.iso
        );
      } else {
        // 已有状态：重复/补传都只更新这一行的计数；采信时间保持最早，人工更正除外
        const takeEarlier = !duplicate && occurred.epochMs < existing.believed_epoch_ms
          && existing.accepted_source !== "manual";
        this.#run(
          `UPDATE arrival_status
              SET pass_count = pass_count + 1,
                  accepted_source = CASE WHEN ? THEN ? ELSE accepted_source END,
                  accepted_seq = CASE WHEN ? THEN ? ELSE accepted_seq END,
                  believed_occurred_at = CASE WHEN ? THEN ? ELSE believed_occurred_at END,
                  believed_epoch_ms = CASE WHEN ? THEN ? ELSE believed_epoch_ms END,
                  updated_at = ?
            WHERE runner_ref = ? AND checkpoint_ref = ?`,
          takeEarlier ? 1 : 0, source,
          takeEarlier ? 1 : 0, seq,
          takeEarlier ? 1 : 0, occurred.iso,
          takeEarlier ? 1 : 0, occurred.epochMs,
          received.iso, runner.runner_ref, checkpoint_ref
        );
      }

      if (runner.group_code === "family-5k") {
        this.#recomputeCustodyLocked(runner.event_id, runner.family_id, checkpoint_ref);
      }

      result = {
        runner_ref: runner.runner_ref,
        checkpoint_ref,
        source,
        occurred_at: occurred.iso,
        duplicate: !!duplicate,
        pass_count: existing ? existing.pass_count + 1 : 1,
      };
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return result;
  }

  #nextSeq(eventId) {
    const row = this.#get(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM arrival_events WHERE event_id = ?",
      eventId
    );
    return row.next_seq;
  }

  /**
   * 人工更正：原始读取不删除不修改；追加一条 manual 事实并把唯一直达状态改写到它。
   */
  manualCorrect({ runner_ref, checkpoint_ref, occurred_at, operator_ref, reason, supersedes_seq = null }) {
    const runner = this.#requireRunner(runner_ref);
    this.#checkpoint(runner.event_id, checkpoint_ref);
    if (!operator_ref || !reason) {
      throw new DomainError("missing_field", "人工更正需要 operator_ref 与 reason");
    }
    const occurred = parseTime(occurred_at);
    const received = this.#now();

    this.db.exec("BEGIN");
    try {
      const existing = this.#get(
        "SELECT * FROM arrival_status WHERE runner_ref = ? AND checkpoint_ref = ?",
        runner_ref, checkpoint_ref
      );
      const targetSeq = supersedes_seq ?? existing?.accepted_seq ?? null;
      if (supersedes_seq) {
        const target = this.#get(
          "SELECT seq FROM arrival_events WHERE event_id = ? AND seq = ? AND runner_ref = ?",
          runner.event_id, supersedes_seq, runner_ref
        );
        if (!target) throw new DomainError("unknown_target", "被更正的原始事实不存在");
      }
      const seq = this.#nextSeq(runner.event_id);
      this.#run(
        `INSERT INTO arrival_events
          (event_id, seq, runner_ref, checkpoint_ref, source, occurred_at, occurred_epoch_ms,
           received_at, received_epoch_ms, operator_ref, reason, supersedes_seq)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
        runner.event_id, seq, runner_ref, checkpoint_ref,
        occurred.iso, occurred.epochMs, received.iso, received.epochMs,
        operator_ref, reason, targetSeq
      );
      if (!existing) {
        this.#run(
          `INSERT INTO arrival_status
            (runner_ref, checkpoint_ref, event_id, believed_occurred_at, believed_epoch_ms,
             accepted_source, accepted_seq, pass_count, corrected_count, updated_at)
           VALUES (?, ?, ?, ?, ?, 'manual', ?, 0, 1, ?)`,
          runner_ref, checkpoint_ref, runner.event_id,
          occurred.iso, occurred.epochMs, seq, received.iso
        );
      } else {
        this.#run(
          `UPDATE arrival_status
              SET believed_occurred_at = ?, believed_epoch_ms = ?,
                  accepted_source = 'manual', accepted_seq = ?,
                  corrected_count = corrected_count + 1, updated_at = ?
            WHERE runner_ref = ? AND checkpoint_ref = ?`,
          occurred.iso, occurred.epochMs, seq, received.iso,
          runner_ref, checkpoint_ref
        );
      }
      if (runner.group_code === "family-5k") {
        this.#recomputeCustodyLocked(runner.event_id, runner.family_id, checkpoint_ref);
      }
      this.db.exec("COMMIT");
      return {
        runner_ref, checkpoint_ref, occurred_at: occurred.iso,
        corrected: true, supersedes_seq: targetSeq, accepted_seq: seq,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 依据当前唯一直达状态重算家庭监护快照。
   * guardian_seq 为家长已通过的最大检查点序号；child_seq 为孩子的。
   * guardian_seq > child_seq 即孩子芯片滞留、家长已越过该位点 → split_alert。
   */
  #recomputeCustodyLocked(eventId, familyId, triggerCheckpoint) {
    const members = this.#all(
      "SELECT * FROM runners WHERE event_id = ? AND family_id = ?",
      eventId, familyId
    );
    const guardian = members.find((m) => m.family_role === "guardian");
    const children = members.filter((m) => m.family_role === "child");
    if (!guardian) return;
    const { iso } = this.#now();
    for (const child of children) {
      const g = this.#furthestLocked(guardian.runner_ref);
      const c = this.#furthestLocked(child.runner_ref);
      let status = "together";
      if ((c?.sequence ?? -1) > (g?.sequence ?? -1)) status = "ahead_child";
      else if ((g?.sequence ?? -1) > (c?.sequence ?? -1)) status = "split_alert";
      this.#run(
        `INSERT INTO custody_checks
          (event_id, family_id, checkpoint_ref, checked_at, guardian_ref, child_ref,
           guardian_seq, child_seq, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventId, familyId, triggerCheckpoint, iso,
        guardian.runner_ref, child.runner_ref,
        g?.sequence ?? null, c?.sequence ?? null, status
      );
    }
  }

  #furthestLocked(runnerRef) {
    return this.#get(
      `SELECT c.checkpoint_ref, c.title, c.sequence, c.kind,
              s.believed_occurred_at AS believed_at, s.believed_epoch_ms
         FROM arrival_status s
         JOIN checkpoints c ON c.event_id = s.event_id AND c.checkpoint_ref = s.checkpoint_ref
        WHERE s.runner_ref = ?
        ORDER BY c.sequence DESC, s.believed_epoch_ms ASC
        LIMIT 1`,
      runnerRef
    );
  }

  /** 医疗处置；disposition=transported 立即标记停止成绩计算。 */
  recordMedical(input) {
    const {
      medical_id, runner_ref, checkpoint_ref, occurred_at,
      medic_ref, disposition, note = null, transported_at = null,
    } = input;
    const runner = this.#requireRunner(runner_ref);
    this.#checkpoint(runner.event_id, checkpoint_ref);
    if (!medical_id || !medic_ref) {
      throw new DomainError("missing_field", "medical_id/medic_ref 必填");
    }
    if (!["treated_on_site", "transported"].includes(disposition)) {
      throw new DomainError("bad_disposition", "处置类型必须为 treated_on_site/transported");
    }
    const occurred = parseTime(occurred_at);
    let transported = null;
    if (disposition === "transported") {
      transported = parseTime(transported_at || occurred_at);
    }
    try {
      this.#run(
        `INSERT INTO medical_events
          (medical_id, event_id, runner_ref, checkpoint_ref, occurred_at, occurred_epoch_ms,
           medic_ref, disposition, transported_at, transported_epoch_ms, note_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        medical_id, runner.event_id, runner_ref, checkpoint_ref,
        occurred.iso, occurred.epochMs, medic_ref, disposition,
        transported ? transported.iso : null, transported ? transported.epochMs : null,
        note ? sha256(note) : null
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new DomainError("duplicate_medical", "同一参赛者同一时刻的医疗记录已存在", 409);
      }
      throw error;
    }
    return {
      medical_id, runner_ref, disposition,
      occurred_at: occurred.iso,
      transported_at: transported ? transported.iso : null,
      scoring_stopped: disposition === "transported",
    };
  }

  /** 离场确认：每人仅一次，闭环可信时间线。 */
  confirmDeparture({ runner_ref, confirmed_by_ref, at = null }) {
    const runner = this.#requireRunner(runner_ref);
    if (!confirmed_by_ref) throw new DomainError("missing_field", "confirmed_by_ref 必填");
    const time = at ? parseTime(at) : this.#now();
    try {
      this.#run(
        `INSERT INTO departures(event_id, runner_ref, departed_at, departed_epoch_ms, confirmed_by_ref)
         VALUES (?, ?, ?, ?, ?)`,
        runner.event_id, runner_ref, time.iso, time.epochMs, confirmed_by_ref
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw new DomainError("already_departed", "该参赛者已确认离场", 409);
      }
      throw error;
    }
    return { runner_ref, departed_at: time.iso };
  }

  // ── 查询：最后可信位置 / 寻找清单 ──────────────────────────
  lastTrustedPosition(runnerRef) {
    const furthest = this.#furthestLocked(runnerRef);
    if (!furthest) return null;
    return {
      checkpoint_ref: furthest.checkpoint_ref,
      title: furthest.title,
      sequence: furthest.sequence,
      kind: furthest.kind,
      believed_at: furthest.believed_at,
      believed_epoch_ms: furthest.believed_epoch_ms,
    };
  }

  /** 对外位置视图：去掉内部排序字段，只给检查点与 ISO 时间。 */
  static publicPosition(pos) {
    if (!pos) return null;
    return {
      checkpoint_ref: pos.checkpoint_ref,
      title: pos.title,
      sequence: pos.sequence,
      kind: pos.kind,
      believed_at: pos.believed_at,
    };
  }

  #isTransported(runnerRef) {
    const row = this.#get(
      "SELECT 1 AS x FROM medical_events WHERE runner_ref = ? AND disposition = 'transported' LIMIT 1",
      runnerRef
    );
    return !!row;
  }

  #isDeparted(runnerRef) {
    return !!this.#get("SELECT 1 AS x FROM departures WHERE runner_ref = ?", runnerRef);
  }

  #latestCustody(childRef) {
    return this.#get(
      `SELECT * FROM custody_checks WHERE child_ref = ?
        ORDER BY check_id DESC LIMIT 1`,
      childRef
    );
  }

  /**
   * 指挥席寻找清单：按“最后可信位置”生成。
   * 5k：家长已越过孩子最后位点（split_alert）且孩子位置停滞超过 stall_ms；
   * 10k：已检录、未过终点、最后可信位置停滞超过 stall_ms；
   * 另列转运后未离场的医疗个案。已离场/已转运离场者一律不出现。
   */
  findList(eventId, { stallMs = 90_000, now = null } = {}) {
    this.#requireEvent(eventId);
    const nowMs = now ?? this.#now().epochMs;
    const checkedIn = this.#all(
      `SELECT r.* FROM runners r
        JOIN checkins ci ON ci.runner_ref = r.runner_ref
       WHERE r.event_id = ?`,
      eventId
    );

    const alerts = [];
    const overdue = [];
    const medical = [];

    for (const runner of checkedIn) {
      if (this.#isDeparted(runner.runner_ref)) continue;
      const pos = this.lastTrustedPosition(runner.runner_ref);

      if (runner.group_code === "family-5k" && runner.family_role === "child") {
        const custody = this.#latestCustody(runner.runner_ref);
        if (custody?.status === "split_alert" && pos) {
          const ageMs = nowMs - pos.believed_epoch_ms;
          if (ageMs >= stallMs) {
            const guardian = this.#get(
              "SELECT runner_ref, bib, display_name, contact_ref FROM runners WHERE runner_ref = ?",
              runner.guardian_ref
            );
            alerts.push({
              reason: "child_stalled_guardian_ahead",
              runner_ref: runner.runner_ref,
              bib: runner.bib,
              is_minor: true,
              family_id: runner.family_id,
              last_trusted_position: pos,
              stalled_seconds: Math.round(ageMs / 1000),
              guardian: guardian ? {
                runner_ref: guardian.runner_ref,
                bib: guardian.bib,
                display_name: guardian.display_name,
              } : null,
            });
          }
        }
      } else if (runner.group_code === "family-5k" && runner.family_role === "guardian") {
        // 反向失散：孩子已越过家长最后位点，家长停滞
        const custody = this.#get(
          `SELECT * FROM custody_checks WHERE guardian_ref = ?
            ORDER BY check_id DESC LIMIT 1`,
          runner.runner_ref
        );
        const finishedGuardian = pos?.kind === "finish";
        if (custody?.status === "ahead_child" && pos && !finishedGuardian) {
          const ageMs = nowMs - pos.believed_epoch_ms;
          if (ageMs >= stallMs) {
            alerts.push({
              reason: "guardian_stalled_child_ahead",
              runner_ref: runner.runner_ref,
              bib: runner.bib,
              display_name: runner.display_name,
              is_minor: false,
              family_id: runner.family_id,
              last_trusted_position: pos,
              stalled_seconds: Math.round(ageMs / 1000),
            });
          }
        }
      } else if (runner.group_code === "individual-10k") {
        const finish = this.#get(
          `SELECT 1 AS x FROM arrival_status s
             JOIN checkpoints c ON c.event_id = s.event_id AND c.checkpoint_ref = s.checkpoint_ref
            WHERE s.runner_ref = ? AND c.kind = 'finish'`,
          runner.runner_ref
        );
        if (!finish && pos) {
          const ageMs = nowMs - pos.believed_epoch_ms;
          if (ageMs >= stallMs) {
            overdue.push({
              reason: "solo_runner_overdue",
              runner_ref: runner.runner_ref,
              bib: runner.bib,
              display_name: runner.display_name,
              last_trusted_position: pos,
              stalled_seconds: Math.round(ageMs / 1000),
            });
          }
        }
      }

      if (this.#isTransported(runner.runner_ref)) {
        const med = this.#get(
          `SELECT * FROM medical_events WHERE runner_ref = ? AND disposition = 'transported'
            ORDER BY occurred_epoch_ms DESC LIMIT 1`,
          runner.runner_ref
        );
        medical.push({
          reason: "transported_pending_departure",
          runner_ref: runner.runner_ref,
          bib: runner.bib,
          is_minor: !!runner.is_minor,
          checkpoint_ref: med.checkpoint_ref,
          transported_at: med.transported_at,
        });
      }
    }

    alerts.sort((a, b) => b.stalled_seconds - a.stalled_seconds);
    const clean = RaceService.publicPosition;
    return {
      generated_at: toIso(nowMs),
      stall_ms: stallMs,
      alerts: alerts.map((a) => ({ ...a, last_trusted_position: clean(a.last_trusted_position) })),
      overdue: overdue.map((o) => ({ ...o, last_trusted_position: clean(o.last_trusted_position) })),
      medical,
    };
  }

  /**
   * 工作人员视图裁剪：普通志愿者不得接触未成年人姓名与家庭联系方式，
   * 也拿不到完整轨迹，只有执行寻找所必需的最后位点。
   */
  projectFindListForStaff(list) {
    const clean = RaceService.publicPosition;
    return {
      ...list,
      alerts: list.alerts.map((a) => {
        if (!a.is_minor) {
          // 成年家长滞留：公开名可保留，无监护人子对象
          return {
            reason: a.reason,
            bib: a.bib,
            is_minor: false,
            family_id: a.family_id,
            display_name: a.display_name,
            last_trusted_position: clean(a.last_trusted_position),
            stalled_seconds: a.stalled_seconds,
          };
        }
        return {
          reason: a.reason,
          bib: a.bib,                 // 用号码布识别，足够现场核对
          is_minor: true,
          family_id: a.family_id,
          last_trusted_position: clean(a.last_trusted_position),
          stalled_seconds: a.stalled_seconds,
          guardian: a.guardian && { bib: a.guardian.bib },
        };
      }),
      overdue: list.overdue.map((o) => ({
        reason: o.reason,
        bib: o.bib,
        display_name: o.display_name, // 成年人公开名可保留
        last_trusted_position: clean(o.last_trusted_position),
        stalled_seconds: o.stalled_seconds,
      })),
      medical: list.medical.map((m) => ({
        reason: m.reason,
        bib: m.bib,
        checkpoint_ref: m.checkpoint_ref,
        transported_at: m.transported_at,
      })),
    };
  }

  // ── 联系方式解封：仅指挥/医疗席 ─────────────────────────────
  revealContact(runnerRef) {
    const runner = this.#requireRunner(runnerRef);
    if (!runner.contact_ref) return null;
    const record = this.#get(
      "SELECT * FROM contact_registry WHERE contact_ref = ?",
      runner.contact_ref
    );
    return {
      runner_ref: runnerRef,
      contact_ref: record.contact_ref,
      channel: record.channel,
      detail: open(record.detail_cipher),
    };
  }

  // ── 家长自助：只能查自己家庭 ────────────────────────────────
  familyStatus(principal) {
    if (principal.kind !== "guardian") {
      throw new DomainError("forbidden", "仅家长令牌可查询家庭状态", 403);
    }
    const members = this.#all(
      "SELECT * FROM runners WHERE event_id = ? AND family_id = ? ORDER BY family_role DESC, bib",
      principal.eventId, principal.familyId
    );
    return {
      family_id: principal.familyId,
      members: members.map((m) => {
        const pos = this.lastTrustedPosition(m.runner_ref);
        const finish = this.#hasFinished(m.runner_ref);
        const med = this.#get(
          "SELECT disposition, transported_at FROM medical_events WHERE runner_ref = ? ORDER BY occurred_epoch_ms DESC LIMIT 1",
          m.runner_ref
        );
        return {
          runner_ref: m.runner_ref,
          bib: m.bib,
          display_name: m.display_name,
          family_role: m.family_role,
          checked_in: !!this.#get("SELECT 1 AS x FROM checkins WHERE runner_ref = ?", m.runner_ref),
          last_trusted_position: RaceService.publicPosition(pos),
          finished: finish,
          departed: this.#isDeparted(m.runner_ref),
          medical: med ? { disposition: med.disposition, transported_at: med.transported_at } : null,
        };
      }),
    };
  }

  #hasFinished(runnerRef) {
    return !!this.#get(
      `SELECT 1 AS x FROM arrival_status s
         JOIN checkpoints c ON c.event_id = s.event_id AND c.checkpoint_ref = s.checkpoint_ref
        WHERE s.runner_ref = ? AND c.kind = 'finish'`,
      runnerRef
    );
  }

  // ── 可信时间线查询（按角色裁剪）─────────────────────────────
  timeline(runnerRef, principal) {
    const runner = this.#requireRunner(runnerRef);

    // 家长只能查本家庭成员
    if (principal.kind === "guardian") {
      if (runner.family_id !== principal.familyId || runner.event_id !== principal.eventId) {
        throw new DomainError("forbidden", "家长只能查询自己的家庭", 403);
      }
    } else if (principal.role === "staff") {
      // 普通志愿者不得获取未成年人完整轨迹
      if (runner.is_minor) {
        throw new DomainError("forbidden", "志愿者不得查看未成年人完整轨迹", 403);
      }
    } else if (!["command", "medic"].includes(principal.role)) {
      throw new DomainError("forbidden", "无权查看时间线", 403);
    }

    const full = ["command", "medic"].includes(principal.role);
    const rows = this.#all(
      `SELECT e.seq, e.checkpoint_ref, e.source, e.occurred_at, e.occurred_epoch_ms,
              e.received_at, e.device_sequence, e.operator_ref, e.reason,
              e.supersedes_seq, s.accepted_seq
         FROM arrival_events e
         LEFT JOIN arrival_status s
           ON s.runner_ref = e.runner_ref AND s.checkpoint_ref = e.checkpoint_ref
        WHERE e.runner_ref = ?
        ORDER BY e.occurred_epoch_ms, e.seq`,
      runnerRef
    );

    // 普通志愿者与家长只看到“每个检查点一个到达”，看不到补传/重复/被更正事实的内部细节
    const checkin = this.#get("SELECT * FROM checkins WHERE runner_ref = ?", runnerRef);
    const departure = this.#get("SELECT * FROM departures WHERE runner_ref = ?", runnerRef);
    const statuses = this.#all(
      `SELECT s.*, c.title, c.sequence, c.kind
         FROM arrival_status s
         JOIN checkpoints c ON c.event_id = s.event_id AND c.checkpoint_ref = s.checkpoint_ref
        WHERE s.runner_ref = ? ORDER BY c.sequence`,
      runnerRef
    );

    const base = {
      runner_ref: runnerRef,
      bib: runner.bib,
      group_code: runner.group_code,
      checked_in_at: checkin?.checked_at ?? null,
      departed_at: departure?.departed_at ?? null,
      arrivals: statuses.map((s) => ({
        checkpoint_ref: s.checkpoint_ref,
        title: s.title,
        sequence: s.sequence,
        kind: s.kind,
        arrived_at: s.believed_occurred_at,
      })),
    };

    if (!full) return base;

    return {
      ...base,
      display_name: runner.display_name,
      is_minor: !!runner.is_minor,
      family_id: runner.family_id,
      guardian_ref: runner.guardian_ref,
      contact_ref: runner.contact_ref,
      raw_facts: rows.map((r) => ({
        seq: r.seq,
        checkpoint_ref: r.checkpoint_ref,
        source: r.source,
        occurred_at: r.occurred_at,
        received_at: r.received_at,
        device_sequence: r.device_sequence,
        operator_ref: r.operator_ref,
        reason: r.reason,
        supersedes_seq: r.supersedes_seq,
        is_accepted: r.accepted_seq === r.seq,
      })),
      medical: this.#all(
        `SELECT medical_id, checkpoint_ref, occurred_at, medic_ref, disposition,
                transported_at, note_digest
           FROM medical_events WHERE runner_ref = ? ORDER BY occurred_epoch_ms`,
        runnerRef
      ),
    };
  }

  // ── 公开成绩：仅比赛所需信息 ────────────────────────────────
  #chipWindow(runnerRef) {
    const start = this.#get(
      `SELECT s.believed_epoch_ms FROM arrival_status s
         JOIN checkpoints c ON c.event_id = s.event_id AND c.checkpoint_ref = s.checkpoint_ref
        WHERE s.runner_ref = ? AND c.kind = 'start'`,
      runnerRef
    );
    const checkin = this.#get(
      "SELECT checked_epoch_ms FROM checkins WHERE runner_ref = ?", runnerRef
    );
    const finish = this.#get(
      `SELECT s.believed_epoch_ms FROM arrival_status s
         JOIN checkpoints c ON c.event_id = s.event_id AND c.checkpoint_ref = s.checkpoint_ref
        WHERE s.runner_ref = ? AND c.kind = 'finish'`,
      runnerRef
    );
    const startMs = start?.believed_epoch_ms ?? checkin?.checked_epoch_ms ?? null;
    return { startMs, finishMs: finish?.believed_epoch_ms ?? null };
  }

  results(eventId) {
    this.#requireEvent(eventId);

    // 十公里个人组：独立计时排名；转运者剔除（医疗停止成绩计算）
    const individual = [];
    const soloRunners = this.#all(
      "SELECT * FROM runners WHERE event_id = ? AND group_code = 'individual-10k'",
      eventId
    );
    for (const runner of soloRunners) {
      if (this.#isTransported(runner.runner_ref)) continue;
      const { startMs, finishMs } = this.#chipWindow(runner.runner_ref);
      if (startMs == null || finishMs == null) continue; // 未完赛不进成绩
      individual.push({
        bib: runner.bib,
        display_name: runner.display_name,
        chip_time_ms: finishMs - startMs,
        chip_time_text: formatDuration(finishMs - startMs),
      });
    }
    individual.sort((a, b) => a.chip_time_ms - b.chip_time_ms);
    individual.forEach((row, index) => {
      row.rank = index + 1;
    });

    // 五公里亲子组：以家庭为单位，家长计时；家长与孩子均过终点且无转运才计成绩。
    // 未成年人不以个人名义出现，只给人数——公开渠道无法重建孩子的路线。
    const families = this.#all(
      `SELECT family_id,
              SUM(CASE WHEN family_role = 'guardian' THEN 1 ELSE 0 END) AS guardians,
              SUM(CASE WHEN family_role = 'child' THEN 1 ELSE 0 END) AS children,
              COUNT(*) AS members
         FROM runners WHERE event_id = ? AND group_code = 'family-5k'
        GROUP BY family_id`,
      eventId
    );
    const familyResults = [];
    for (const family of families) {
      const members = this.#all(
        "SELECT * FROM runners WHERE event_id = ? AND family_id = ?",
        eventId, family.family_id
      );
      if (members.some((m) => this.#isTransported(m.runner_ref))) continue;
      const allFinished = members.every((m) => this.#hasFinished(m.runner_ref));
      if (!allFinished) continue;
      const guardian = members.find((m) => m.family_role === "guardian");
      const { startMs, finishMs } = this.#chipWindow(guardian.runner_ref);
      if (startMs == null || finishMs == null) continue;
      familyResults.push({
        family_id: family.family_id,
        guardian_bib: guardian.bib,
        guardian_name: guardian.display_name,
        children_count: family.children,
        chip_time_ms: finishMs - startMs,
        chip_time_text: formatDuration(finishMs - startMs),
      });
    }
    familyResults.sort((a, b) => a.chip_time_ms - b.chip_time_ms);
    familyResults.forEach((row, index) => {
      row.rank = index + 1;
    });

    return {
      event_id: eventId,
      generated_at: this.#now().iso,
      "individual-10k": individual,
      "family-5k": familyResults,
    };
  }

  // ── 赛后汇总：k 匿名，防止反推未成年人精确路线 ──────────────
  /**
   * 补给站停留分布：只输出 (检查点 × 5 分钟停留带 × 组别) 的人数。
   * - 不接受任何参赛者/家庭/未成年人过滤参数（无法定位到个人）；
   * - 人数小于 k 的桶整桶抑制；
   * - 仅使用检查点粒度时间，不输出任何分段成绩或原始时间戳。
   */
  aidStationSummary(eventId, { k = 5, bucketMs = 5 * 60_000 } = {}) {
    this.#requireEvent(eventId);
    const stations = this.#all(
      "SELECT * FROM checkpoints WHERE event_id = ? AND kind = 'aid_station' ORDER BY sequence",
      eventId
    );
    const buckets = new Map();
    for (const station of stations) {
      // 停留 = 离开下一个检查点的采信时间 - 到达本站采信时间
      const arrivals = this.#all(
        `SELECT s.runner_ref, r.group_code, r.is_minor, s.believed_epoch_ms AS at_ms
           FROM arrival_status s
           JOIN runners r ON r.runner_ref = s.runner_ref
          WHERE s.event_id = ? AND s.checkpoint_ref = ?`,
        eventId, station.checkpoint_ref
      );
      for (const arrival of arrivals) {
        const next = this.#get(
          `SELECT s.believed_epoch_ms AS at_ms FROM arrival_status s
             JOIN checkpoints c ON c.event_id = s.event_id AND c.checkpoint_ref = s.checkpoint_ref
            WHERE s.runner_ref = ? AND c.sequence > ?
            ORDER BY c.sequence LIMIT 1`,
          arrival.runner_ref, station.sequence
        );
        if (!next) continue; // 未完赛者不进停留汇总，避免暴露滞留点
        const dwell = Math.max(0, next.at_ms - arrival.at_ms);
        const band = Math.floor(dwell / bucketMs);
        const key = `${station.checkpoint_ref}|${arrival.group_code}|${band}`;
        const cell = buckets.get(key) || {
          checkpoint_ref: station.checkpoint_ref,
          title: station.title,
          group_code: arrival.group_code,
          dwell_band_minutes: [band * (bucketMs / 60000), (band + 1) * (bucketMs / 60000)],
          runners: 0,
          minors: 0,
        };
        cell.runners += 1;
        cell.minors += arrival.is_minor ? 1 : 0;
        buckets.set(key, cell);
      }
    }
    const published = [];
    const suppressed = [];
    for (const cell of buckets.values()) {
      if (cell.runners >= k) {
        published.push(cell);
      } else {
        suppressed.push({ checkpoint_ref: cell.checkpoint_ref, group_code: cell.group_code });
      }
    }
    return {
      event_id: eventId,
      generated_at: this.#now().iso,
      k,
      bucket_minutes: bucketMs / 60000,
      cells: published.sort((a, b) =>
        a.checkpoint_ref.localeCompare(b.checkpoint_ref) || a.group_code.localeCompare(b.group_code)
      ),
      suppressed_buckets: suppressed.length,
      note: "不足 k 人的桶已抑制；汇总不含任何参赛者标识与精确时间",
    };
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

module.exports = { RaceService, DomainError, formatDuration, GROUPS, BACKFILL_THRESHOLD_MS };
