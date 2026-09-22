"use strict";

const { openDatabase } = require("../src/db");
const { createServer } = require("../src/server");

// 赛事时钟基准：每个测试夹具建立时重置一次
let harnessClock = Date.now();

async function createHarness() {
  const database = openDatabase(":memory:");
  const server = createServer({ database, commandToken: "cmd-root-token" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // 每个测试夹具建立时取一次当前时刻作为赛事时钟：
  // 同一场测试内时间差断言精确，且事件足够贴近“当前”，不干扰超时语义。
  harnessClock = Date.parse(new Date().toISOString());

  async function request(method, urlPath, options = {}) {
    const headers = options.headers || {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(base + urlPath, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body, headers: response.headers };
  }

  const stop = () => new Promise((resolve) => server.close(resolve));

  return { database, server, base, request, stop };
}

// 相对赛事时钟生成带偏移量的 ISO 8601 字符串
function time(offsetSeconds, base = harnessClock) {
  return new Date(base + offsetSeconds * 1000).toISOString();
}

/**
 * 建好一场同时含 5 公里亲子路线与 10 公里个人路线的赛事，
 * 返回常用编号与已签发令牌。
 */
async function seedRace(harness, overrides = {}) {
  const { request } = harness;
  const cmd = "cmd-root-token";
  const E = overrides.event_ref || "WANGWU-2026";
  await request("POST", "/events", {
    token: cmd,
    body: { event_ref: E, title: "王吴村亲子健康跑", stage_sla_seconds: overrides.sla || 1800 },
  });
  const cps = [
    ["CP-5K-S", "5S", "检录起点", "start", "family-5k", 1],
    ["CP-5K-A1", "5A1", "一号补给站", "aid", "family-5k", 2],
    ["CP-5K-A2", "5A2", "二号补给站", "aid", "family-5k", 3],
    ["CP-5K-F", "5F", "五公里终点", "finish", "family-5k", 4],
    ["CP-5K-X", "5X", "离场闸机", "exit", "family-5k", 5],
    ["CP-10K-S", "10S", "十公里起点", "start", "individual-10k", 1],
    ["CP-10K-A", "10A", "十公里补给", "aid", "individual-10k", 2],
    ["CP-10K-F", "10F", "十公里终点", "finish", "individual-10k", 3],
  ];
  for (const [checkpoint_ref, code, label, kind, race_type, position] of cps) {
    await request("POST", `/events/${E}/checkpoints`, {
      token: cmd,
      body: { checkpoint_ref, code, label, kind, race_type, position },
    });
  }

  const family1 = await request("POST", `/events/${E}/families`, {
    token: cmd,
    body: {
      group_code: "A-001",
      public_label: "阳光一队",
      contact_channel: "tel:13800000001",
      members: [
        { bib: "G001", role: "guardian", public_label: "王女士" },
        { bib: "K001", role: "minor", public_label: "小王" },
      ],
    },
  });
  const family2 = await request("POST", `/events/${E}/families`, {
    token: cmd,
    body: {
      group_code: "A-002",
      public_label: "春风二队",
      contact_channel: "tel:13800000002",
      members: [
        { bib: "G002", role: "guardian", public_label: "李先生" },
        { bib: "K002", role: "minor", public_label: "小李" },
      ],
    },
  });

  const individual1 = await request("POST", `/events/${E}/individuals`, {
    token: cmd,
    body: { bib: "I101", public_label: "赵一" },
  });
  const individual2 = await request("POST", `/events/${E}/individuals`, {
    token: cmd,
    body: { bib: "I102", public_label: "钱二" },
  });

  const guardianToken1 = (
    await request("POST", `/events/${E}/tokens`, {
      token: cmd,
      body: { role: "guardian", subject_ref: family1.body.family.family_ref, label: "王女士家长端" },
    })
  ).body.token;
  const marshalToken = (
    await request("POST", `/events/${E}/tokens`, {
      token: cmd,
      body: { role: "marshal", label: "补给站志愿者" },
    })
  ).body.token;

  return {
    eventRef: E,
    cmd,
    family1: family1.body,
    family2: family2.body,
    guardian1: family1.body.members.find((m) => m.role === "guardian").runner_ref,
    minor1: family1.body.members.find((m) => m.role === "minor").runner_ref,
    guardian2: family2.body.members.find((m) => m.role === "guardian").runner_ref,
    minor2: family2.body.members.find((m) => m.role === "minor").runner_ref,
    individual1: individual1.body.runner_ref,
    individual2: individual2.body.runner_ref,
    tokens: { guardian1: guardianToken1, marshal: marshalToken },
  };
}

function chip(runnerRef, checkpointRef, offsetSeconds, extra = {}) {
  return {
    kind: "chip",
    runner_ref: runnerRef,
    checkpoint_ref: checkpointRef,
    occurred_at: time(offsetSeconds),
    device_id: "MAT-01",
    device_sequence: extra.seq || 1,
    ...extra,
  };
}

module.exports = { createHarness, seedRace, time, chip };
