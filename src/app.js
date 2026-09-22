"use strict";

const http = require("node:http");
const { DomainError } = require("./domain");

const MAX_BODY_BYTES = 64 * 1024;

function createApp(domain) {
  return http.createServer(async (request, response) => {
    try {
      await route(domain, request, response);
    } catch (error) {
      sendError(response, error);
    }
  });
}

async function route(domain, request, response) {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "GET" && path === "/health") {
    return json(response, 200, { status: "ok" });
  }

  // 公开成绩：只含名次、号码/公开名、成绩时间，无任何检查点轨迹
  const publicResults = path.match(/^\/events\/([^/]+)\/results$/);
  if (method === "GET" && publicResults) {
    return json(response, 200, domain.results(decodeURIComponent(publicResults[1])));
  }

  if (method === "POST" && path === "/events") {
    const actor = requireActor(domain, request, ["command"]);
    return json(response, 201, domain.createEvent(await readBody(request)));
  }

  const tokenIssue = path.match(/^\/events\/([^/]+)\/tokens$/);
  if (method === "POST" && tokenIssue) {
    const actor = requireActor(domain, request, ["command"]);
    scopeEvent(actor, decodeURIComponent(tokenIssue[1]));
    const body = await readBody(request);
    return json(response, 201, domain.issueToken({ ...body, event_ref: body.event_ref || decodeURIComponent(tokenIssue[1]) }, actor));
  }

  const checkpoints = path.match(/^\/events\/([^/]+)\/checkpoints$/);
  if (method === "POST" && checkpoints) {
    const actor = requireActor(domain, request, ["command"]);
    const eventRef = decodeURIComponent(checkpoints[1]);
    scopeEvent(actor, eventRef);
    return json(response, 201, domain.addCheckpoint({ ...(await readBody(request)), event_ref: eventRef }));
  }

  const registerFamily = path.match(/^\/events\/([^/]+)\/families$/);
  if (method === "POST" && registerFamily) {
    const actor = requireActor(domain, request, ["command"]);
    const eventRef = decodeURIComponent(registerFamily[1]);
    scopeEvent(actor, eventRef);
    return json(response, 201, domain.registerFamily({ ...(await readBody(request)), event_ref: eventRef }));
  }

  const registerIndividual = path.match(/^\/events\/([^/]+)\/individuals$/);
  if (method === "POST" && registerIndividual) {
    const actor = requireActor(domain, request, ["command"]);
    const eventRef = decodeURIComponent(registerIndividual[1]);
    scopeEvent(actor, eventRef);
    return json(response, 201, domain.registerIndividual({ ...(await readBody(request)), event_ref: eventRef }));
  }

  const ingest = path.match(/^\/events\/([^/]+)\/facts$/);
  if (method === "POST" && ingest) {
    const eventRef = decodeURIComponent(ingest[1]);
    const body = await readBody(request);
    const allowed =
      body.kind === "manual"
        ? ["command"]
        : ["command", "marshal"];
    const actor = requireActor(domain, request, allowed);
    scopeEvent(actor, eventRef);
    return json(response, 202, domain.ingest(eventRef, body, actor));
  }

  const find = path.match(/^\/events\/([^/]+)\/find$/);
  if (method === "GET" && find) {
    const actor = requireActor(domain, request, ["command"]);
    const eventRef = decodeURIComponent(find[1]);
    scopeEvent(actor, eventRef);
    return json(response, 200, { generated_at: new Date().toISOString(), list: domain.findList(eventRef) });
  }

  const marshalList = path.match(/^\/events\/([^/]+)\/marshal-list$/);
  if (method === "GET" && marshalList) {
    const actor = requireActor(domain, request, ["command", "marshal"]);
    const eventRef = decodeURIComponent(marshalList[1]);
    scopeEvent(actor, eventRef);
    return json(response, 200, { generated_at: new Date().toISOString(), list: domain.marshalList(eventRef) });
  }

  const summary = path.match(/^\/events\/([^/]+)\/summary$/);
  if (method === "GET" && summary) {
    const actor = requireActor(domain, request, ["command"]);
    const eventRef = decodeURIComponent(summary[1]);
    scopeEvent(actor, eventRef);
    return json(response, 200, domain.summary(eventRef));
  }

  const family = path.match(/^\/families\/([^/]+)$/);
  if (method === "GET" && family) {
    const familyRef = decodeURIComponent(family[1]);
    const actor = requireActor(domain, request, ["guardian", "command"]);
    if (actor.role === "guardian" && actor.subject_ref !== familyRef) {
      throw new DomainError("forbidden", "只能查询自己的家庭", 403);
    }
    return json(response, 200, domain.familyView(familyRef));
  }

  const timeline = path.match(/^\/runners\/([^/]+)\/timeline$/);
  if (method === "GET" && timeline) {
    requireActor(domain, request, ["command"]);
    return json(response, 200, domain.runnerTimeline(decodeURIComponent(timeline[1])));
  }

  return json(response, 404, { error: "not_found" });
}

function requireActor(domain, request, roles) {
  const header = request.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) throw new DomainError("unauthorized", "缺少 Bearer 令牌", 401);
  const actor = domain.resolveToken(match[1].trim());
  if (!actor) throw new DomainError("unauthorized", "令牌无效", 401);
  if (!roles.includes(actor.role)) {
    throw new DomainError("forbidden", `该操作要求角色：${roles.join(" / ")}`, 403);
  }
  return actor;
}

function scopeEvent(actor, eventRef) {
  if (actor.event_ref && actor.event_ref !== eventRef) {
    throw new DomainError("forbidden", "令牌不属于该赛事", 403);
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new DomainError("body_too_large", "请求体过大", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("bad shape");
    }
    return body;
  } catch {
    throw new DomainError("invalid_json", "请求体必须是 JSON 对象");
  }
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof DomainError) {
    return json(response, error.statusCode, { error: error.code, message: error.message });
  }
  response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "internal_error" }));
}

module.exports = { createApp };
