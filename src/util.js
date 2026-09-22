
const crypto = require("node:crypto");

/** 解析带偏移量的 ISO 8601；返回原文与归一化纪元毫秒。非法时间抛错。 */
function parseTime(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error("时间必须为 ISO 8601 字符串"), { code: "bad_time" });
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw Object.assign(new Error(`无法解析时间：${value}`), { code: "bad_time" });
  }
  return { iso: value, epochMs: ms };
}

/** 纪元毫秒转 UTC ISO（Z 结尾，无歧义）。 */
function toIso(epochMs) {
  return new Date(epochMs).toISOString();
}

function nowParts() {
  const epochMs = Date.now();
  return { iso: toIso(epochMs), epochMs };
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * 联系方式封存：AES-256-GCM，密钥由 CONTACT_SEAL_KEY 派生。
 * 数据库泄露时号码不可直接读取；解封只发生在服务层授权路径。
 * 固定盐仅用于确定性解封，机密性来自 CONTACT_SEAL_KEY（生产环境必须注入）。
 */
const SEAL_KEY = process.env.CONTACT_SEAL_KEY || "dev-seal-key-change-me";
const SEAL_SALT = "family-run-contact-v1";

function sealKey() {
  return crypto.scryptSync(SEAL_KEY, SEAL_SALT, 32);
}

function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function open(packed) {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", sealKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = { parseTime, toIso, nowParts, sha256, randomToken, seal, open };
