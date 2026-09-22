
const http = require("node:http");
const { DomainError } = require("./race");

/**
 * 路由表：method 与路径模式。路径参数以 :name 标注。
 * access 声明所需角色：
 *   "public"   无需令牌
 *   "guardian" 家长令牌（自动限定本家庭）
 *   其余为工作人员角色集合
 */
const ROUTES = [
  ["GET",    "/health",                                       "public",        "health"],
  ["GET",    "/events/:eventId/results",                      "public",        "results"],

  ["POST",   "/events",                                       ["command"],     "createEvent"],
  ["POST",   "/events/:eventId/checkpoints",                  ["command"],     "addCheckpoint"],
  ["POST",   "/staff/tokens",                                 ["command"],     "issueStaffToken"],
  ["POST",   "/family/tokens",                                ["command"],     "issueFamilyToken"],
  ["POST",   "/events/:eventId/runners",                      ["command"],     "registerRunner"],

  ["POST",   "/runners/:runnerRef/checkin",                   ["command", "staff"], "checkin"],
  ["POST",   "/chip-reads",                                   ["command", "staff"], "recordChipRead"],
  ["POST",   "/runners/:runnerRef/corrections",               ["command"],     "manualCorrect"],
  ["POST",   "/medical-events",                               ["command", "medic"], "recordMedical"],
  ["POST",   "/runners/:runnerRef/departure",                 ["command", "staff"], "confirmDeparture"],

  ["GET",    "/events/:eventId/find-list",                    ["command", "staff", "medic"], "findList"],
  ["GET",    "/events/:eventId/aid-summary",                  ["command"],     "aidSummary"],
  ["GET",    "/runners/:runnerRef/timeline",                  "guardian+staff+command+medic", "timeline"],
  ["GET",    "/runners/:runnerRef/contact",                   ["command", "medic"], "revealContact"],

  ["GET",    "/family/status",                                ["guardian"],    "familyStatus"],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, access, action] of ROUTES) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { access, action, params };
  }
  return null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new DomainError("body_too_large", "请求体过大", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError("bad_json", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function createApp(service) {
  return http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const match = matchRoute(request.method, pathname);
      if (!match) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }

      if (match.access === "public") {
        const body = await dispatchPublic(service, match.action, match.params, request);
        sendJson(response, 200, body);
        return;
      }

      const token = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const principal = service.authenticate(token);
      requireAccess(match.access, principal);

      // 工作人员令牌若绑定赛事，不得跨赛事操作（家长令牌天然绑定）
      if (principal.kind === "staff" && principal.eventId && match.params.eventId
          && principal.eventId !== match.params.eventId) {
        throw new DomainError("forbidden", "令牌不属于该赛事", 403);
      }

      const input = request.method === "GET" ? {} : await readBody(request);
      const url = new URL(request.url, "http://localhost");
      const query = Object.fromEntries(url.searchParams);
      const body = await dispatchAction(service, match.action, match.params, input, query, principal);
      const status = [200, 201].includes(body?.__status) ? body.__status : 200;
      if (body?.__status) delete body.__status;
      sendJson(response, status, body);
    } catch (error) {
      if (error instanceof DomainError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  });
}

function requireAccess(access, principal) {
  if (access === "guardian+staff+command+medic") return; // 任何已认证主体，动作内再细分
  if (access.includes("guardian") && principal.kind === "guardian") return;
  if (principal.kind === "staff" && access.includes(principal.role)) return;
  throw new DomainError("forbidden", "当前角色无权执行该操作", 403);
}

async function dispatchPublic(service, action, params) {
  switch (action) {
    case "health":
      return { status: "ok" };
    case "results":
      return service.results(params.eventId);
    default:
      throw new DomainError("not_found", "未知动作", 404);
  }
}

async function dispatchAction(service, action, params, input, query, principal) {
  switch (action) {
    case "createEvent":
      return service.createEvent(input);
    case "addCheckpoint":
      return service.addCheckpoint({ ...input, event_id: params.eventId });
    case "issueStaffToken":
      return service.issueStaffToken(input, principal);
    case "issueFamilyToken":
      return service.issueFamilyToken(input);
    case "registerRunner":
      return service.registerRunner({ ...input, event_id: params.eventId });

    case "checkin":
      return service.checkin({ ...input, runner_ref: params.runnerRef });
    case "recordChipRead":
      return service.recordChipRead(input);
    case "manualCorrect":
      return service.manualCorrect({ ...input, runner_ref: params.runnerRef });
    case "recordMedical":
      return service.recordMedical(input);
    case "confirmDeparture":
      return service.confirmDeparture({ ...input, runner_ref: params.runnerRef });

    case "findList": {
      const stallMs = query.stall_ms ? Number.parseInt(query.stall_ms, 10) : undefined;
      const list = service.findList(params.eventId, stallMs != null ? { stallMs } : {});
      const eventId = params.eventId;
      if (principal.role === "command" || principal.role === "medic") {
        service.audit(principal, "find_list_full", eventId);
        return list;
      }
      service.audit(principal, "find_list_staff", eventId);
      return service.projectFindListForStaff(list);
    }
    case "aidSummary": {
      const k = query.k ? Number.parseInt(query.k, 10) : undefined;
      const summary = service.aidStationSummary(params.eventId, k != null ? { k } : {});
      service.audit(principal, "aid_summary_export", params.eventId);
      return summary;
    }
    case "timeline": {
      const runner = service.timeline(params.runnerRef, principal);
      service.audit(principal, "timeline_view", service.runnerEventId(params.runnerRef), {
        targetRef: params.runnerRef,
        familyId: principal.kind === "guardian" ? principal.familyId : null,
      });
      return runner;
    }
    case "revealContact": {
      const contact = service.revealContact(params.runnerRef);
      service.audit(principal, "contact_reveal", service.runnerEventId(params.runnerRef), {
        targetRef: params.runnerRef,
      });
      return contact;
    }
    case "familyStatus": {
      const status = service.familyStatus(principal);
      service.audit(principal, "family_status", principal.eventId, { familyId: principal.familyId });
      return status;
    }
    default:
      throw new DomainError("not_found", "未知动作", 404);
  }
}

function queryParams(url) {
  if (!url) return {};
  return Object.fromEntries(new URL(url, "http://localhost").searchParams);
}

module.exports = { createApp, matchRoute };
