
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createApp } = require("../src/http");
const { RaceService } = require("../src/race");

// ── 测试夹具：可控时钟 + 临时数据库 + 内存 HTTP 服务 ──────────
const BASE = Date.parse("2026-09-22T08:00:00+08:00");
function iso(minuteOffset, secondOffset = 0) {
  return new Date(BASE + minuteOffset * 60_000 + secondOffset * 1000).toISOString();
}

function makeHarness() {
  const dbPath = `/tmp/race-test-${process.pid}-${Math.random().toString(16).slice(2)}.sqlite3`;
  fs.rmSync(dbPath, { force: true });
  let currentMs = BASE;
  const db = new DatabaseSync(dbPath);
  const { migrate } = require("../src/db");
  migrate(db);
  const service = new RaceService(db, () => ({
    iso: new Date(currentMs).toISOString(),
    epochMs: currentMs,
  }));
  const server = createApp(service);
  let port;
  const track = {
    bootstrap: "boot-test",
    db,
    setClock(offsetMinutes) {
      currentMs = BASE + offsetMinutes * 60_000;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = server.address().port;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dbPath, { force: true });
    },
  };
  async function request(method, urlPath, { token, body } = {}) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }
  track.request = request;
  return track;
}

async function seedCourse(h, eventId = "WANGWU-2026") {
  await h.request("POST", "/events", {
    token: h.bootstrap,
    body: { event_id: eventId, name: "王吴村亲子健康跑", race_date: "2026-09-22" },
  });
  const cps = [
    ["CP-START", "起点线", 0, "start"],
    ["CP-AID", "补给站", 1, "aid_station"],
    ["CP-AID-2", "二号补给站", 2, "aid_station"],
    ["CP-2", "滨河路口", 3, "checkpoint"],
    ["CP-FINISH", "终点线", 4, "finish"],
  ];
  for (const [checkpoint_ref, title, sequence, kind] of cps) {
    await h.request("POST", `/events/${eventId}/checkpoints`, {
      token: h.bootstrap,
      body: { checkpoint_ref, title, sequence, kind },
    });
  }
  const tokens = {};
  for (const [role, ref] of [["command", "CMD-1"], ["staff", "VOL-1"], ["medic", "MED-1"]]) {
    const res = await h.request("POST", "/staff/tokens", {
      token: h.bootstrap,
      body: { role, operator_ref: ref, event_id: eventId },
    });
    assert.equal(res.status, 200, res.body?.message);
    tokens[role] = res.body.token;
  }
  return tokens;
}

async function registerFamily(h, token, { familyId, guardianRef, childRef, guardianPhone }) {
  await h.request("POST", "/events/WANGWU-2026/runners", {
    token,
    body: {
      runner_ref: guardianRef, group_code: "family-5k", bib: `G-${guardianRef}`,
      display_name: "家长(公开名)", is_minor: false, family_id: familyId,
      family_role: "guardian", chip_id: `CHIP-${guardianRef}`,
      contact: guardianPhone ? { channel: "phone", detail: guardianPhone } : undefined,
    },
  });
  await h.request("POST", "/events/WANGWU-2026/runners", {
    token,
    body: {
      runner_ref: childRef, group_code: "family-5k", bib: `K-${childRef}`,
      display_name: "小朋友(真实昵称)", is_minor: true, family_id: familyId,
      family_role: "child", guardian_ref: guardianRef, chip_id: `CHIP-${childRef}`,
    },
  });
}

async function chip(h, token, chipId, cp, at, extra = {}) {
  return h.request("POST", "/chip-reads", {
    token,
    body: { chip_id: chipId, checkpoint_ref: cp, occurred_at: at, ...extra },
  });
}

// ── 场景一：家长过终点、孩子芯片停在补给站 ───────────────────
test("5k：家长过终点孩子滞留补给站 → 指挥席产生寻找清单，志愿者看不到电话与全名", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);
  await registerFamily(h, tokens.command, {
    familyId: "FAM-1", guardianRef: "RUN-G1", childRef: "RUN-C1",
    guardianPhone: "13900000001",
  });
  const familyToken = (await h.request("POST", "/family/tokens", {
    token: tokens.command,
    body: { runner_ref: "RUN-G1" },
  })).body.token;

  // 检录
  for (const ref of ["RUN-G1", "RUN-C1"]) {
    const res = await h.request("POST", `/runners/${ref}/checkin`, {
      token: tokens.staff,
      body: { operator_ref: "VOL-1", at: iso(-20) },
    });
    assert.equal(res.status, 200);
  }

  // 家长一路通过并过终点；孩子只刷到补给站
  h.setClock(0);
  await chip(h, tokens.staff, "CHIP-RUN-G1", "CP-START", iso(0));
  await chip(h, tokens.staff, "CHIP-RUN-C1", "CP-START", iso(0, 20));
  h.setClock(5);
  await chip(h, tokens.staff, "CHIP-RUN-G1", "CP-AID", iso(5));
  await chip(h, tokens.staff, "CHIP-RUN-C1", "CP-AID", iso(6));
  h.setClock(10);
  await chip(h, tokens.staff, "CHIP-RUN-G1", "CP-2", iso(10));
  h.setClock(15);
  await chip(h, tokens.staff, "CHIP-RUN-G1", "CP-FINISH", iso(15));

  // 又过了 3 分钟，孩子仍停在补给站
  h.setClock(18);
  const commandList = await h.request("GET", "/events/WANGWU-2026/find-list?stall_ms=60000", {
    token: tokens.command,
  });
  assert.equal(commandList.status, 200);
  const alert = commandList.body.alerts.find((a) => a.runner_ref === "RUN-C1");
  assert.ok(alert, "滞留孩子必须出现在指挥席清单");
  assert.equal(alert.reason, "child_stalled_guardian_ahead");
  assert.equal(alert.last_trusted_position.checkpoint_ref, "CP-AID");
  assert.ok(alert.stalled_seconds >= 60);

  // 普通志愿者：同一清单，只剩号码布与最后位点，没有未成年人姓名/联系方式
  const staffList = await h.request("GET", "/events/WANGWU-2026/find-list?stall_ms=60000", {
    token: tokens.staff,
  });
  const staffAlert = staffList.body.alerts.find((a) => a.bib === "K-RUN-C1");
  assert.ok(staffAlert);
  assert.equal(staffAlert.display_name, undefined);
  assert.equal(staffAlert.runner_ref, undefined);
  assert.equal(staffAlert.contact_ref, undefined);

  // 志愿者尝试取家庭电话 → 拒绝；指挥席可以（并留痕）
  const denied = await h.request("GET", "/runners/RUN-G1/contact", { token: tokens.staff });
  assert.equal(denied.status, 403);
  const revealed = await h.request("GET", "/runners/RUN-G1/contact", { token: tokens.command });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.detail, "13900000001");
  const audit = h.db.prepare(
    "SELECT action FROM access_audit WHERE actor_role = 'command' AND action = 'contact_reveal'"
  ).get();
  assert.ok(audit);

  // 监护快照被持续重算，最终为 split_alert
  const custody = h.db.prepare(
    "SELECT status FROM custody_checks WHERE child_ref = 'RUN-C1' ORDER BY check_id DESC LIMIT 1"
  ).get();
  assert.equal(custody.status, "split_alert");

  // 家长自助：只查自己的家庭，看到孩子停在补给站
  const mine = await h.request("GET", "/family/status", { token: familyToken });
  assert.equal(mine.status, 200);
  const child = mine.body.members.find((m) => m.family_role === "child");
  assert.equal(child.last_trusted_position.checkpoint_ref, "CP-AID");
  assert.equal(child.finished, false);

  // 离场确认后孩子移出寻找清单
  const dep = await h.request("POST", "/runners/RUN-C1/departure", {
    token: tokens.staff,
    body: { confirmed_by_ref: "VOL-1", at: iso(19) },
  });
  assert.equal(dep.status, 200);
  const afterDep = await h.request("GET", "/events/WANGWU-2026/find-list?stall_ms=60000", {
    token: tokens.command,
  });
  assert.equal(afterDep.body.alerts.find((a) => a.runner_ref === "RUN-C1"), undefined);
});

// ── 场景二：家长令牌越权与志愿者轨迹限制 ─────────────────────
test("访问控制：家长只查本家庭，志愿者拿不到未成年人完整轨迹", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);
  await registerFamily(h, tokens.command, {
    familyId: "FAM-1", guardianRef: "RUN-G1", childRef: "RUN-C1",
  });
  await registerFamily(h, tokens.command, {
    familyId: "FAM-2", guardianRef: "RUN-G2", childRef: "RUN-C2",
  });
  const token1 = (await h.request("POST", "/family/tokens", {
    token: tokens.command, body: { runner_ref: "RUN-G1" },
  })).body.token;

  // 家长查别家孩子时间线 → 403
  const cross = await h.request("GET", "/runners/RUN-C2/timeline", { token: token1 });
  assert.equal(cross.status, 403);
  // 家长查自家孩子 → 允许，但只有按点的一个到达，看不到原始事实
  const own = await h.request("GET", "/runners/RUN-C1/timeline", { token: token1 });
  assert.equal(own.status, 200);
  assert.equal(own.body.raw_facts, undefined);

  // 志愿者查未成年人轨迹 → 403；查成年家长 → 允许但无 raw_facts
  const minorDenied = await h.request("GET", "/runners/RUN-C1/timeline", { token: tokens.staff });
  assert.equal(minorDenied.status, 403);
  const adultTl = await h.request("GET", "/runners/RUN-G1/timeline", { token: tokens.staff });
  assert.equal(adultTl.status, 200);
  assert.equal(adultTl.body.raw_facts, undefined);

  // 指挥席可见全部原始事实
  const full = await h.request("GET", "/runners/RUN-G1/timeline", { token: tokens.command });
  assert.equal(full.status, 200);
  assert.ok(Array.isArray(full.body.raw_facts));
});

// ── 场景三：补传 / 重复刷卡 / 人工更正只形成一个到达状态 ──────
test("事实流：重复刷卡、芯片补传、人工更正均保留原始事实且只投影一个到达", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);
  await h.request("POST", "/events/WANGWU-2026/runners", {
    token: tokens.command,
    body: {
      runner_ref: "RUN-S1", group_code: "individual-10k", bib: "1001",
      display_name: "十公里选手甲", is_minor: false, chip_id: "CHIP-S1",
    },
  });

  // 起点实时读取，同一报文重发一次
  h.setClock(0);
  const first = await chip(h, tokens.staff, "CHIP-S1", "CP-START", iso(0));
  assert.equal(first.body.source, "chip_realtime");
  const dup = await chip(h, tokens.staff, "CHIP-S1", "CP-START", iso(0));
  assert.equal(dup.body.source, "chip_repeat");
  assert.equal(dup.body.duplicate, true);

  // 设备离线：实时刷过滨河路口，之后设备补传更早的补给站读取
  h.setClock(10);
  const cp2 = await chip(h, tokens.staff, "CHIP-S1", "CP-2", iso(10));
  assert.equal(cp2.body.source, "chip_realtime");
  h.setClock(13);
  const backfill = await chip(h, tokens.staff, "CHIP-S1", "CP-AID", iso(8), { device_sequence: 7 });
  assert.equal(backfill.body.source, "chip_backfill");
  assert.equal(backfill.body.checkpoint_ref, "CP-AID");

  // 人工更正补给站时间：志愿者无权，指挥席执行
  const staffCorrect = await h.request("POST", "/runners/RUN-S1/corrections", {
    token: tokens.staff,
    body: { checkpoint_ref: "CP-AID", occurred_at: iso(8, 30), operator_ref: "VOL-1", reason: "x" },
  });
  assert.equal(staffCorrect.status, 403);
  const corrected = await h.request("POST", "/runners/RUN-S1/corrections", {
    token: tokens.command,
    body: {
      checkpoint_ref: "CP-AID", occurred_at: iso(8, 45),
      operator_ref: "CMD-1", reason: "现场录像核对，补给站通过时间更正",
    },
  });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.corrected, true);

  // 每个检查点在投影表中只有一行
  const rows = h.db.prepare(
    "SELECT checkpoint_ref, pass_count, corrected_count, accepted_source FROM arrival_status ORDER BY checkpoint_ref"
  ).all();
  const byCp = Object.fromEntries(rows.map((r) => [r.checkpoint_ref, r]));
  assert.equal(byCp["CP-START"].pass_count, 2, "重复刷卡计入次数");
  assert.equal(byCp["CP-AID"].accepted_source, "manual");
  assert.equal(byCp["CP-AID"].corrected_count, 1);
  assert.equal(rows.length, 3, "三个检查点恰好三行状态");

  // 原始事实全部保留（含被更正的补传），且只有一条被采信
  const facts = h.db.prepare(
    "SELECT source, COUNT(*) AS n FROM arrival_events GROUP BY source"
  ).all();
  const counts = Object.fromEntries(facts.map((f) => [f.source, f.n]));
  assert.equal(counts.chip_realtime, 2);
  assert.equal(counts.chip_repeat, 1);
  assert.equal(counts.chip_backfill, 1);
  assert.equal(counts.manual, 1);
  const accepted = h.db.prepare(
    `SELECT e.seq FROM arrival_events e
       JOIN arrival_status s ON s.accepted_seq = e.seq
      WHERE e.runner_ref = 'RUN-S1' AND e.checkpoint_ref = 'CP-AID'`
  ).get();
  const manual = h.db.prepare(
    "SELECT seq FROM arrival_events WHERE source = 'manual' AND runner_ref = 'RUN-S1'"
  ).get();
  assert.equal(accepted.seq, manual.seq, "采信的是人工更正事实");
  const superseded = h.db.prepare(
    "SELECT seq FROM arrival_events WHERE source = 'chip_backfill' AND runner_ref = 'RUN-S1'"
  ).get();
  assert.notEqual(superseded.seq, accepted.seq);
  assert.ok(superseded.seq, "被更正的补传事实仍然存在");
});

// ── 场景四：十公里独立计时 + 医疗转运停止成绩 ────────────────
test("10k 独立计时排名；医疗转运者退出成绩；个人组不得携带监护字段", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);

  const bad = await h.request("POST", "/events/WANGWU-2026/runners", {
    token: tokens.command,
    body: {
      runner_ref: "RUN-BAD", group_code: "individual-10k", bib: "9999",
      display_name: "错", chip_id: "CHIP-BAD", family_id: "FAM-X", family_role: "child",
    },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "individual_no_family");

  for (const [ref, bib, name, finishMin, transported] of [
    ["RUN-A", "1001", "选手甲", 50, false],
    ["RUN-B", "1002", "选手乙", 46, false],
    ["RUN-C", "1003", "选手丙", 40, true],
  ]) {
    await h.request("POST", "/events/WANGWU-2026/runners", {
      token: tokens.command,
      body: {
        runner_ref: ref, group_code: "individual-10k", bib,
        display_name: name, chip_id: `CHIP-${ref}`,
      },
    });
    await h.request("POST", `/runners/${ref}/checkin`, {
      token: tokens.staff, body: { operator_ref: "VOL-1", at: iso(0) },
    });
    h.setClock(0);
    await chip(h, tokens.staff, `CHIP-${ref}`, "CP-START", iso(0));
    h.setClock(finishMin);
    await chip(h, tokens.staff, `CHIP-${ref}`, "CP-FINISH", iso(finishMin));
    if (transported) {
      const med = await h.request("POST", "/medical-events", {
        token: tokens.medic,
        body: {
          medical_id: `MED-${ref}`, runner_ref: ref, checkpoint_ref: "CP-2",
          occurred_at: iso(finishMin - 5), medic_ref: "MED-1",
          disposition: "transported", transported_at: iso(finishMin - 4),
          note: "疑似骨折",
        },
      });
      assert.equal(med.status, 200);
      assert.equal(med.body.scoring_stopped, true);
    }
  }

  // 志愿者不能录医疗
  const staffMed = await h.request("POST", "/medical-events", {
    token: tokens.staff,
    body: {
      medical_id: "MED-X", runner_ref: "RUN-A", checkpoint_ref: "CP-2",
      occurred_at: iso(1), medic_ref: "VOL-1", disposition: "treated_on_site",
    },
  });
  assert.equal(staffMed.status, 403);

  const results = await h.request("GET", "/events/WANGWU-2026/results");
  assert.equal(results.status, 200);
  const solo = results.body["individual-10k"];
  assert.equal(solo.length, 2, "转运者不进成绩");
  assert.deepEqual(solo.map((r) => r.bib), ["1002", "1001"]);
  assert.equal(solo[0].chip_time_text, "46:00");
  // 公开成绩不含身份/芯片/联系方式字段
  for (const row of solo) {
    assert.equal(row.chip_id, undefined);
    assert.equal(row.contact_ref, undefined);
    assert.equal(row.is_minor, undefined);
  }
});

// ── 场景五：5k 以家庭计成绩，家长孩子须同到终点 ──────────────
test("5k 家庭成绩：全员完赛才计时，未成年人不单独出现", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);
  await registerFamily(h, tokens.command, {
    familyId: "FAM-1", guardianRef: "RUN-G1", childRef: "RUN-C1",
  });
  await registerFamily(h, tokens.command, {
    familyId: "FAM-2", guardianRef: "RUN-G2", childRef: "RUN-C2",
  });

  async function finishFamily(guardianRef, childRef, guardianMin, childMin) {
    for (const [ref, min] of [[guardianRef, guardianMin], [childRef, childMin]]) {
      h.setClock(min);
      for (const [cp, atMin] of [["CP-START", 0], ["CP-AID", Math.floor(min / 2)], ["CP-FINISH", min]]) {
        await chip(h, tokens.staff, `CHIP-${ref}`, cp, iso(atMin));
      }
    }
  }
  await finishFamily("RUN-G1", "RUN-C1", 35, 36);
  await finishFamily("RUN-G2", "RUN-C2", 30, 31);

  const results = await h.request("GET", "/events/WANGWU-2026/results");
  const families = results.body["family-5k"];
  assert.equal(families.length, 2);
  assert.equal(families[0].family_id, "FAM-2");
  assert.equal(families[0].children_count, 1);
  // 公开结果中没有孩子的名字、号码或分段时间
  assert.equal(JSON.stringify(families).includes("K-RUN-C1"), false);
  assert.equal(JSON.stringify(families).includes("真实昵称"), false);
});

// ── 场景六：报名监护关系约束 ─────────────────────────────────
test("报名：亲子组孩子必须登记同家庭家长；十公里独立报名", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);
  const noGuardian = await h.request("POST", "/events/WANGWU-2026/runners", {
    token: tokens.command,
    body: {
      runner_ref: "RUN-X", group_code: "family-5k", bib: "X1", display_name: "x",
      is_minor: true, family_id: "FAM-X", family_role: "child", chip_id: "CHIP-X",
    },
  });
  assert.equal(noGuardian.status, 400);
  assert.equal(noGuardian.body.error, "guardian_required");

  const volunteerRegister = await h.request("POST", "/events/WANGWU-2026/runners", {
    token: tokens.staff,
    body: {
      runner_ref: "RUN-Y", group_code: "individual-10k", bib: "Y1",
      display_name: "y", chip_id: "CHIP-Y",
    },
  });
  assert.equal(volunteerRegister.status, 403);
});

// ── 场景七：赛后汇总 k 匿名，无法反推未成年人精确路线 ────────
test("赛后补给站汇总：小样本桶抑制，输出不含任何个人标识", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);
  await registerFamily(h, tokens.command, {
    familyId: "FAM-1", guardianRef: "RUN-G1", childRef: "RUN-C1",
  });
  // 两名成年 10k 选手在补给站停留落在同一 5 分钟带（k=2）
  for (const ref of ["RUN-A", "RUN-B"]) {
    await h.request("POST", "/events/WANGWU-2026/runners", {
      token: tokens.command,
      body: {
        runner_ref: ref, group_code: "individual-10k", bib: ref,
        display_name: ref, chip_id: `CHIP-${ref}`,
      },
    });
    h.setClock(0);
    await chip(h, tokens.staff, `CHIP-${ref}`, "CP-START", iso(0));
    await chip(h, tokens.staff, `CHIP-${ref}`, "CP-AID", iso(5));
    await chip(h, tokens.staff, `CHIP-${ref}`, "CP-2", iso(8)); // 停留 3 分钟
  }
  // 孩子独自一人的亲子组桶（人数 < k）
  h.setClock(0);
  await chip(h, tokens.staff, "CHIP-RUN-C1", "CP-AID", iso(5));
  await chip(h, tokens.staff, "CHIP-RUN-C1", "CP-2", iso(12)); // 停留 7 分钟

  const summary = await h.request("GET", "/events/WANGWU-2026/aid-summary?k=2", {
    token: tokens.command,
  });
  assert.equal(summary.status, 200);
  assert.ok(summary.body.suppressed_buckets >= 1, "不足 k 人的桶必须抑制");
  const published = summary.body.cells;
  assert.ok(published.length >= 1);
  for (const cell of published) {
    assert.ok(cell.runners >= 2);
    assert.equal(cell.runner_ref, undefined);
    assert.equal(cell.display_name, undefined);
    assert.equal(cell.bib, undefined);
  }
  // 汇总里无法找到孩子的标识
  assert.equal(JSON.stringify(summary.body).includes("RUN-C1"), false);
  assert.equal(JSON.stringify(summary.body).includes("CHIP-RUN-C1"), false);

  // 公开不能导出汇总
  const anon = await h.request("GET", "/events/WANGWU-2026/aid-summary?k=2");
  assert.equal(anon.status, 401);
});

// ── 场景八：十公里滞留者进入 overdue 清单 ─────────────────────
test("10k：已检录未完赛且位置停滞者进入 overdue", async (t) => {
  const h = makeHarness();
  process.env.COMMAND_BOOTSTRAP_TOKEN = "boot-test";
  await h.start();
  t.after(() => h.close());

  const tokens = await seedCourse(h);
  await h.request("POST", "/events/WANGWU-2026/runners", {
    token: tokens.command,
    body: {
      runner_ref: "RUN-LATE", group_code: "individual-10k", bib: "1099",
      display_name: "落后选手", chip_id: "CHIP-LATE",
    },
  });
  await h.request("POST", "/runners/RUN-LATE/checkin", {
    token: tokens.staff, body: { operator_ref: "VOL-1", at: iso(-5) },
  });
  h.setClock(5);
  await chip(h, tokens.staff, "CHIP-LATE", "CP-AID", iso(5));
  h.setClock(10);
  const list = await h.request("GET", "/events/WANGWU-2026/find-list?stall_ms=120000", {
    token: tokens.command,
  });
  const found = list.body.overdue.find((o) => o.runner_ref === "RUN-LATE");
  assert.ok(found);
  assert.equal(found.last_trusted_position.checkpoint_ref, "CP-AID");
});
