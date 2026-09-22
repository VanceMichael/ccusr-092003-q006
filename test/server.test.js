"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHarness, seedRace, time, chip } = require("./helpers");

test("健康接口返回服务状态", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const response = await harness.request("GET", "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("亲子组报名必须同时包含监护人和未成年人", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const noMinor = await harness.request("POST", "/events/WANGWU-2026/families", {
    token: "cmd-root-token",
    body: {
      event_ref: undefined,
      group_code: "X",
      public_label: "x",
      contact_channel: "tel:1",
      members: [{ bib: "G1", role: "guardian" }],
    },
  });
  // 赛事尚未创建，先建赛事再测报名约束
  await harness.request("POST", "/events", {
    token: "cmd-root-token",
    body: { event_ref: "WANGWU-2026", title: "测试赛" },
  });
  const failNoMinor = await harness.request("POST", "/events/WANGWU-2026/families", {
    token: "cmd-root-token",
    body: {
      group_code: "X1",
      public_label: "x",
      contact_channel: "tel:1",
      members: [{ bib: "G1", role: "guardian", public_label: "家长" }],
    },
  });
  assert.equal(failNoMinor.status, 400);
  assert.equal(failNoMinor.body.error, "minor_required");
  assert.equal(noMinor.status, 404);
});

test("家长过终点而孩子停在补给站：指挥席立即生成带联系方式的寻找条目", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body, token = seed.cmd) => request("POST", `/events/${E}/facts`, { token, body });

  // 家长一路通过终点
  await post(chip(seed.guardian1, "CP-5K-S", -900, { seq: 1 }));
  await post(chip(seed.guardian1, "CP-5K-A1", -600, { seq: 2 }));
  await post(chip(seed.guardian1, "CP-5K-A2", -300, { seq: 3 }));
  await post(chip(seed.guardian1, "CP-5K-F", -60, { seq: 4 }));
  // 孩子只到一号补给站
  await post(chip(seed.minor1, "CP-5K-S", -890, { seq: 5 }));
  await post(chip(seed.minor1, "CP-5K-A1", -590, { seq: 6 }));

  const find = await request("GET", `/events/${E}/find`, { token: seed.cmd });
  assert.equal(find.status, 200);
  const entry = find.body.list.find((item) => item.runner_ref === seed.minor1);
  assert.ok(entry, "寻找清单必须包含滞留的孩子");
  assert.equal(entry.reason, "supervision_gap");
  assert.deepEqual(entry.flags, ["minor_separated"]);
  assert.equal(entry.last_seen.checkpoint_ref, "CP-5K-A1");
  assert.equal(entry.family.guardian_last_seen.checkpoint_ref, "CP-5K-F");
  assert.match(entry.contact_channel, /^tel:/);
  assert.ok(entry.last_seen.age_seconds >= 0);
  // 家长本人不在寻找清单上
  assert.ok(!find.body.list.some((item) => item.runner_ref === seed.guardian1));
});

test("普通志愿者的寻找清单不含电话、家庭编号与未成年人姓名", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });
  await post(chip(seed.guardian1, "CP-5K-S", -900, { seq: 1 }));
  await post(chip(seed.guardian1, "CP-5K-A1", -600, { seq: 2 }));
  await post(chip(seed.minor1, "CP-5K-S", -890, { seq: 3 }));

  const denied = await request("GET", `/events/${E}/find`, { token: seed.tokens.marshal });
  assert.equal(denied.status, 403);

  const list = await request("GET", `/events/${E}/marshal-list`, { token: seed.tokens.marshal });
  assert.equal(list.status, 200);
  const serialized = JSON.stringify(list.body.list);
  assert.ok(!serialized.includes("tel:"), "志愿者清单不得包含联系方式");
  assert.ok(!serialized.includes("family_ref"), "志愿者清单不得包含家庭引用");
  const minorEntry = list.body.list.find((item) => item.bib === "K001");
  assert.ok(minorEntry);
  assert.notEqual(minorEntry.public_label, "小王");
});

test("监护关系持续校验：孩子补刷追上报到后告警解除", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });

  await post(chip(seed.guardian1, "CP-5K-S", -900, { seq: 1 }));
  await post(chip(seed.guardian1, "CP-5K-A1", -600, { seq: 2 }));
  await post(chip(seed.guardian1, "CP-5K-A2", -400, { seq: 3 }));
  await post(chip(seed.minor1, "CP-5K-S", -890, { seq: 4 }));
  await post(chip(seed.minor1, "CP-5K-A1", -590, { seq: 5 }));

  let find = await request("GET", `/events/${E}/find`, { token: seed.cmd });
  assert.ok(find.body.list.some((item) => item.runner_ref === seed.minor1));

  // 补传：孩子实际在家长之前已通过 A2，记录补录后告警应自动解除
  await post(chip(seed.minor1, "CP-5K-A2", -420, { seq: 6, source: "retransmitted" }));
  find = await request("GET", `/events/${E}/find`, { token: seed.cmd });
  assert.ok(!find.body.list.some((item) => item.runner_ref === seed.minor1));

  const family = await request("GET", `/families/${seed.family1.family.family_ref}`, {
    token: seed.tokens.guardian1,
  });
  assert.equal(family.status, 200);
  assert.equal(family.body.open_alerts.length, 0);
});

test("重复刷卡保留全部原始事实，但每个检查点只有一个到达状态", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;

  const first = await request("POST", `/events/${E}/facts`, {
    token: seed.cmd,
    body: chip(seed.individual1, "CP-10K-S", -500, { seq: 1 }),
  });
  const second = await request("POST", `/events/${E}/facts`, {
    token: seed.cmd,
    body: chip(seed.individual1, "CP-10K-S", -480, { seq: 2 }),
  });
  assert.equal(first.body.duplicate, false);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.source, "duplicate");

  const timeline = await request("GET", `/runners/${seed.individual1}/timeline`, { token: seed.cmd });
  const raws = timeline.body.raw_events.filter((raw) => raw.checkpoint_ref === "CP-10K-S");
  assert.equal(raws.length, 2, "两笔刷卡都必须留痕");
  assert.ok(raws.some((raw) => raw.source === "duplicate"));
  assert.ok(raws.find((raw) => raw.source === "duplicate").duplicate_of);
  const states = timeline.body.arrival_states.filter((s) => s.checkpoint_ref === "CP-10K-S");
  assert.equal(states.length, 1, "到达状态只能有一个");
  // 最早一笔成为到达
  assert.equal(states[0].source_event_id, raws.find((r) => r.source === "live").event_id);
});

test("客户端幂等键阻止网络重放造成重复事实", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const payload = chip(seed.individual1, "CP-10K-S", -500, { seq: 1, client_event_id: "MAT-01-00001" });
  const r1 = await request("POST", `/events/${E}/facts`, { token: seed.cmd, body: payload });
  const r2 = await request("POST", `/events/${E}/facts`, { token: seed.tokens.marshal, body: payload });
  assert.equal(r1.body.recorded, true);
  assert.equal(r2.body.idempotent, true);
  assert.equal(r1.body.event_id, r2.body.event_id);
  const timeline = await request("GET", `/runners/${seed.individual1}/timeline`, { token: seed.cmd });
  assert.equal(timeline.body.raw_events.length, 1);
});

test("人工 void 与 set 更正保留全部原始事实且只形成一个到达状态", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body, token = seed.cmd) => request("POST", `/events/${E}/facts`, { token, body });

  await post(chip(seed.individual1, "CP-10K-S", -500, { seq: 1 }));
  await post(chip(seed.individual1, "CP-10K-A", -200, { seq: 2 }));

  // 志愿者无权做人工更正
  const forbidden = await post(
    {
      kind: "manual",
      runner_ref: seed.individual1,
      checkpoint_ref: "CP-10K-A",
      correction_action: "void",
      occurred_at: time(-190),
      reason: "测试",
      operator_ref: "vol-1",
    },
    seed.tokens.marshal
  );
  assert.equal(forbidden.status, 403);

  await post({
    kind: "manual",
    runner_ref: seed.individual1,
    checkpoint_ref: "CP-10K-A",
    correction_action: "void",
    occurred_at: time(-180),
    operator_ref: "chief-1",
    reason: "查证该读刷属于他人芯片",
  });
  let timeline = (await request("GET", `/runners/${seed.individual1}/timeline`, { token: seed.cmd })).body;
  assert.equal(timeline.arrival_states.filter((s) => s.checkpoint_ref === "CP-10K-A").length, 0);

  await post({
    kind: "manual",
    runner_ref: seed.individual1,
    checkpoint_ref: "CP-10K-A",
    correction_action: "set",
    occurred_at: time(-170),
    operator_ref: "chief-1",
    reason: "补给站裁判目击确认通过",
  });
  timeline = (await request("GET", `/runners/${seed.individual1}/timeline`, { token: seed.cmd })).body;
  const state = timeline.arrival_states.filter((s) => s.checkpoint_ref === "CP-10K-A");
  assert.equal(state.length, 1);
  assert.equal(state[0].arrival_kind, "manual");
  assert.equal(state[0].corrected, true);
  const kinds = timeline.raw_events.map((raw) => raw.kind);
  assert.ok(kinds.includes("chip"));
  assert.deepEqual(
    kinds.filter((kind) => kind === "manual"),
    ["manual", "manual"],
    "作废与更正两笔事实都必须保留"
  );
});

test("十公里个人组独立计时与排名", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });

  for (const [runner, start, aid, finish] of [
    [seed.individual1, -2400, -1500, -600],
    [seed.individual2, -2400, -1700, -1200],
  ]) {
    await post(chip(runner, "CP-10K-S", start, { seq: start }));
    await post(chip(runner, "CP-10K-A", aid, { seq: aid }));
    await post(chip(runner, "CP-10K-F", finish, { seq: finish }));
  }

  const results = await request("GET", `/events/${E}/results`);
  assert.equal(results.status, 200);
  const rows = results.body["individual-10k"];
  assert.deepEqual(
    rows.map((row) => row.bib),
    ["I102", "I101"]
  );
  assert.equal(rows[0].time_ms, 1200 * 1000);
  // 公开成绩只呈现比赛所需字段
  assert.deepEqual(Object.keys(rows[0]).sort(), ["bib", "finished_at", "public_label", "rank", "started_at", "time_ms"]);
  const serialized = JSON.stringify(results.body);
  assert.ok(!serialized.includes("checkpoint"), "公开成绩不得出现检查点信息");
});

test("医疗转运停止成绩计算：转运后补到的终点芯片不再产生成绩", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });

  await post(chip(seed.individual2, "CP-10K-S", -1800, { seq: 1 }));
  await post(chip(seed.individual2, "CP-10K-A", -900, { seq: 2 }));
  await post({
    kind: "medical",
    runner_ref: seed.individual2,
    checkpoint_ref: "CP-10K-A",
    medical_action: "evacuation",
    occurred_at: time(-800),
    operator_ref: "med-7",
    reason: "踝部扭伤",
    detail_text: "选手自述既往病史等敏感细节",
  });
  // 转运后设备补传终点读刷
  await post(chip(seed.individual2, "CP-10K-F", -100, { seq: 3, source: "retransmitted" }));

  const timeline = (await request("GET", `/runners/${seed.individual2}/timeline`, { token: seed.cmd })).body;
  assert.equal(timeline.status.result_status, "medical_evacuation");
  assert.equal(timeline.status.finished_at, null);
  assert.equal(timeline.status.on_course, 0);
  const medical = timeline.raw_events.find((raw) => raw.kind === "medical");
  assert.ok(medical.detail_digest, "敏感细节只能以摘要保存");
  assert.ok(!JSON.stringify(timeline).includes("既往病史"));

  const results = (await request("GET", `/events/${E}/results`)).body["individual-10k"];
  assert.ok(!results.some((row) => row.bib === "I102"), "转运者不得出现在成绩榜");
  assert.ok(!(await request("GET", `/events/${E}/find`, { token: seed.cmd })).body.list
    .some((item) => item.runner_ref === seed.individual2), "转运者不再需要寻找");
});

test("现场简单治疗不停表，选手仍可正常完赛", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });
  await post(chip(seed.individual1, "CP-10K-S", -900, { seq: 1 }));
  await post({
    kind: "medical",
    runner_ref: seed.individual1,
    checkpoint_ref: "CP-10K-A",
    medical_action: "treatment",
    occurred_at: time(-400),
    operator_ref: "med-7",
    reason: "擦伤处理",
  });
  await post(chip(seed.individual1, "CP-10K-F", -100, { seq: 2 }));
  const timeline = (await request("GET", `/runners/${seed.individual1}/timeline`, { token: seed.cmd })).body;
  assert.equal(timeline.status.result_status, "finished");
  assert.equal(timeline.status.finish_ms - timeline.status.start_ms, 800 * 1000);
});

test("离场确认关闭时间线并移出寻找清单", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });

  await post(chip(seed.guardian1, "CP-5K-S", -1600, { seq: 1 }));
  await post(chip(seed.guardian1, "CP-5K-A1", -1300, { seq: 2 }));
  await post(chip(seed.guardian1, "CP-5K-A2", -1000, { seq: 3 }));
  await post(chip(seed.guardian1, "CP-5K-F", -700, { seq: 4 }));
  await post(chip(seed.minor1, "CP-5K-S", -1590, { seq: 5 }));
  await post(chip(seed.minor1, "CP-5K-A1", -1290, { seq: 6 }));
  // 滞留告警存在
  assert.ok((await request("GET", `/events/${E}/find`, { token: seed.cmd })).body.list
    .some((item) => item.runner_ref === seed.minor1));
  // 孩子随后完赛并与家长一同离场
  await post(chip(seed.minor1, "CP-5K-A2", -600, { seq: 7 }));
  await post(chip(seed.minor1, "CP-5K-F", -300, { seq: 8 }));
  await post({ kind: "exit", runner_ref: seed.guardian1, checkpoint_ref: "CP-5K-X", occurred_at: time(-120), operator_ref: "gate-1" });
  await post({ kind: "exit", runner_ref: seed.minor1, checkpoint_ref: "CP-5K-X", occurred_at: time(-60), operator_ref: "gate-1" });

  const find = await request("GET", `/events/${E}/find`, { token: seed.cmd });
  assert.ok(!find.body.list.some((item) => item.runner_ref === seed.minor1));
  const family = (await request("GET", `/families/${seed.family1.family.family_ref}`, {
    token: seed.tokens.guardian1,
  })).body;
  for (const member of family.members) assert.ok(member.status.exited_at);
});

test("家长端只能查看自己的家庭且看不到联系电话字段", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;

  const own = await request("GET", `/families/${seed.family1.family.family_ref}`, {
    token: seed.tokens.guardian1,
  });
  assert.equal(own.status, 200);
  assert.ok(!JSON.stringify(own.body).includes("tel:"), "家长端不需要看到自己的电话库字段");
  assert.ok(own.body.members.some((member) => member.role === "minor"));

  const other = await request("GET", `/families/${seed.family2.family.family_ref}`, {
    token: seed.tokens.guardian1,
  });
  assert.equal(other.status, 403);

  const noToken = await request("GET", `/families/${seed.family1.family.family_ref}`);
  assert.equal(noToken.status, 401);

  // 家长令牌不能触碰指挥与入库接口
  assert.equal((await request("GET", `/events/${seed.eventRef}/find`, { token: seed.tokens.guardian1 })).status, 403);
  assert.equal(
    (
      await request("POST", `/events/${seed.eventRef}/facts`, {
        token: seed.tokens.guardian1,
        body: chip(seed.minor1, "CP-5K-S", -1, { seq: 1 }),
      })
    ).status,
    403
  );
});

test("公开亲子成绩只呈现家庭整体，不呈现未成年人个人路线", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });

  const runFamily = async (guardian, minor, base) => {
    await post(chip(guardian, "CP-5K-S", base, { seq: 1 }));
    await post(chip(minor, "CP-5K-S", base + 5, { seq: 2 }));
    await post(chip(guardian, "CP-5K-A1", base + 300, { seq: 3 }));
    await post(chip(minor, "CP-5K-A1", base + 310, { seq: 4 }));
    await post(chip(guardian, "CP-5K-A2", base + 600, { seq: 5 }));
    await post(chip(minor, "CP-5K-A2", base + 620, { seq: 6 }));
    await post(chip(guardian, "CP-5K-F", base + 900, { seq: 7 }));
    await post(chip(minor, "CP-5K-F", base + 950, { seq: 8 }));
  };
  await runFamily(seed.guardian1, seed.minor1, -2000);
  await runFamily(seed.guardian2, seed.minor2, -2000);

  const results = await request("GET", `/events/${E}/results`);
  const rows = results.body["family-5k"];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.group_code);
    assert.ok(!row.runner_ref && !row.bib, "不得出现个人编号或号码布");
    assert.equal(row.members, 2);
    assert.ok(Number.isInteger(row.time_ms));
  }
  const serialized = JSON.stringify(results.body);
  for (const forbidden of ["K001", "K002", "CP-5K-A1", "补给"]) {
    assert.ok(!serialized.includes(forbidden), `公开成绩不得反推出：${forbidden}`);
  }
});

test("赛后汇总只提供粗粒度计数，无法反推未成年人经过哪些检查点", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  const post = (body) => request("POST", `/events/${E}/facts`, { token: seed.cmd, body });
  await post(chip(seed.minor1, "CP-5K-S", -100, { seq: 1 }));
  await post(chip(seed.minor1, "CP-5K-A1", -50, { seq: 2 }));

  const summary = await request("GET", `/events/${E}/summary`, { token: seed.cmd });
  assert.equal(summary.status, 200);
  const serialized = JSON.stringify(summary.body);
  for (const forbidden of ["checkpoint", "CP-5K", "补给", "K001"]) {
    assert.ok(!serialized.includes(forbidden), "汇总不得包含检查点或个人标识");
  }
  const familyRow = summary.body.by_race_type.find((row) => row.race_type === "family-5k");
  assert.equal(familyRow.registered, 4);
  assert.equal(familyRow.checked_in, 1);
  assert.ok(Number.isInteger(summary.body.open_supervision_alerts));

  // 无令牌或志愿者令牌都不能取汇总
  assert.equal((await request("GET", `/events/${E}/summary`)).status, 401);
  assert.equal((await request("GET", `/events/${E}/summary`, { token: seed.tokens.marshal })).status, 403);
});

test("赛段超时未出现的在途选手进入寻找清单", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness, { sla: 1 });
  const { request } = harness;
  const E = seed.eventRef;
  await request("POST", `/events/${E}/facts`, {
    token: seed.cmd,
    body: { ...chip(seed.individual1, "CP-10K-S", -120, { seq: 1 }), occurred_at: time(-120, Date.now()) },
  });
  const find = await request("GET", `/events/${E}/find`, { token: seed.cmd });
  const entry = find.body.list.find((item) => item.runner_ref === seed.individual1);
  assert.ok(entry);
  assert.equal(entry.reason, "overdue");
  assert.ok(entry.flags.includes("overdue"));
});

test("跨组别的检查点路线互斥", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const { request } = harness;
  const E = seed.eventRef;
  // 5 公里亲子选手刷十公里检查点应被拒绝
  const bad = await request("POST", `/events/${E}/facts`, {
    token: seed.cmd,
    body: chip(seed.minor1, "CP-10K-S", -100, { seq: 1 }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "route_mismatch");
});

test("时间字段必须是带偏移量的 ISO 8601 字符串", async (context) => {
  const harness = await createHarness();
  context.after(harness.stop);
  const seed = await seedRace(harness);
  const bad = await harness.request("POST", `/events/${seed.eventRef}/facts`, {
    token: seed.cmd,
    body: {
      kind: "chip",
      runner_ref: seed.individual1,
      checkpoint_ref: "CP-10K-S",
      occurred_at: "2026-09-22 09:00:00",
      device_sequence: 1,
    },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_time");
});
