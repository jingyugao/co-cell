/** Offline Bash credential hooks for native Meegle and Lark CLI files. */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function hook(source: string): string {
  return `set -euo pipefail\nnode -e ${shellQuote(source)}`;
}

const meegleLoad = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
function fail(message) { throw new Error(message); }
function bytes(value) {
  if (typeof value !== "string") fail("credential bytes are missing");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value) fail("invalid base64 credential bytes");
  return result;
}
function file(path) {
  const entry = Array.isArray(input.files) && input.files.find(item => item.path === path);
  if (!entry) fail("required companion credential is missing: " + path);
  return bytes(entry.content);
}
function configPath() {
  return input.primaryPath && Array.isArray(input.files) && input.files.some(item => item.path === input.primaryPath)
    ? input.primaryPath : ".meegle/config.json";
}
function hex(value, length) {
  if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(value) || (length && value.length !== length * 2)) fail("invalid Meegle encrypted credential");
  return Buffer.from(value, "hex");
}
function profileName(path) {
  const match = /^\.meegle\/credentials(?:-([A-Za-z0-9_-]{1,100}))?\.enc$/.exec(path);
  if (!match) fail("unsupported Meegle credential path");
  return match[1] || "default";
}
function validIdentity(value) {
  return !!value && typeof value.hostname === "string" && !!value.hostname && typeof value.username === "string" && !!value.username && !/[\u0000-\u001f\u007f]/.test(value.hostname + value.username);
}
function identities() {
  const values = [input.targetIdentity, input.identity].filter(validIdentity);
  const unique = values.filter((value, index) => values.findIndex(other => other.hostname === value.hostname && other.username === value.username) === index);
  if (!unique.length) fail("Meegle encryption identity is unavailable");
  return unique;
}
function decrypt(path, encryptedBytes, configOverride) {
  const config = configOverride || JSON.parse(file(configPath()).toString("utf8"));
  const profile = profileName(path);
  if (!config.profiles || !config.profiles[profile] || config.profiles[profile].user_access_token) fail("Meegle profile does not use native encrypted credentials");
  const machineKey = file(".meegle/.machine-key").toString("utf8");
  hex(machineKey, 32);
  const envelope = JSON.parse(encryptedBytes.toString("utf8"));
  const salt = hex(envelope.salt, 16), iv = hex(envelope.iv, 12), tag = hex(envelope.tag, 16), ciphertext = hex(envelope.data);
  for (const who of identities()) {
    const key = crypto.pbkdf2Sync(who.hostname + ":" + who.username + ":" + machineKey + ":meegle-cli", salt, 100000, 32, "sha256");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const text = plaintext.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(plaintext)) fail("Meegle credential is not valid UTF-8");
      const data = JSON.parse(text);
      if (!data || typeof data.access_token !== "string" || !data.access_token) fail("Meegle credential has no access_token");
      return JSON.stringify(data, null, 2);
    } catch (error) {
      if (error && /^Meegle credential (?:has no access_token|is not valid UTF-8)$/.test(error.message)) throw error;
    } finally { key.fill(0); }
  }
  fail("cannot decrypt Meegle credentials; check the registered source identity, target identity and machine key");
}
try {
  if (!input || typeof input.path !== "string") fail("credential path is missing");
  const raw = bytes(input.content);
  let content, encoding = "utf8";
  if (input.path === configPath() || input.path === ".meegle/config.json") {
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) fail("Meegle config is not valid UTF-8");
    JSON.parse(text);
    content = text;
  } else if (input.path === ".meegle/.machine-key") {
    const text = raw.toString("utf8");
    hex(text, 32);
    content = text;
    encoding = "parsed";
  } else if (/^\.meegle\/credentials(?:-[A-Za-z0-9_-]{1,100})?\.enc$/.test(input.path)) {
    content = decrypt(input.path, raw);
    encoding = "parsed";
  } else {
    content = raw.toString("base64");
    encoding = "base64";
  }
  process.stdout.write(JSON.stringify({ content, encoding }));
} catch (error) { console.error(error && error.message || "Meegle Load hook failed"); process.exitCode = 1; }
`;

const meegleSave = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
function fail(message) { throw new Error(message); }
function bytes(value) {
  if (typeof value !== "string") fail("credential bytes are missing");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value) fail("invalid base64 credential bytes");
  return result;
}
function file(path) {
  const entry = Array.isArray(input.files) && input.files.find(item => item.path === path);
  if (!entry) fail("required companion credential is missing: " + path);
  return bytes(entry.content);
}
function configPath() {
  return input.primaryPath && Array.isArray(input.files) && input.files.some(item => item.path === input.primaryPath)
    ? input.primaryPath : ".meegle/config.json";
}
function hex(value, length) {
  if (typeof value !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(value) || (length && value.length !== length * 2)) fail("invalid Meegle encrypted credential");
  return Buffer.from(value, "hex");
}
function profileName(path) {
  const match = /^\.meegle\/credentials(?:-([A-Za-z0-9_-]{1,100}))?\.enc$/.exec(path);
  if (!match) fail("unsupported Meegle credential path");
  return match[1] || "default";
}
function validIdentity(value) {
  return !!value && typeof value.hostname === "string" && !!value.hostname && typeof value.username === "string" && !!value.username && !/[\u0000-\u001f\u007f]/.test(value.hostname + value.username);
}
function identities() {
  const values = [input.targetIdentity, input.identity].filter(validIdentity);
  const unique = values.filter((value, index) => values.findIndex(other => other.hostname === value.hostname && other.username === value.username) === index);
  if (!unique.length) fail("Meegle encryption identity is unavailable");
  return unique;
}
function targetIdentity() {
  const target = input.targetIdentity || input.identity;
  if (!validIdentity(target)) fail("Meegle target encryption identity is unavailable");
  return target;
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function decrypt(path, envelopeBytes, configOverride) {
  const config = configOverride || JSON.parse(file(configPath()).toString("utf8"));
  const profile = profileName(path);
  if (!config.profiles || !config.profiles[profile] || config.profiles[profile].user_access_token) fail("Meegle profile does not use native encrypted credentials");
  const machineKey = file(".meegle/.machine-key").toString("utf8");
  hex(machineKey, 32);
  const envelope = JSON.parse(envelopeBytes.toString("utf8"));
  const salt = hex(envelope.salt, 16), iv = hex(envelope.iv, 12), tag = hex(envelope.tag, 16), ciphertext = hex(envelope.data);
  for (const who of identities()) {
    const key = crypto.pbkdf2Sync(who.hostname + ":" + who.username + ":" + machineKey + ":meegle-cli", salt, 100000, 32, "sha256");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const text = plaintext.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(plaintext)) fail("Meegle credential is not valid UTF-8");
      const data = JSON.parse(text);
      if (!data || typeof data.access_token !== "string" || !data.access_token) fail("Meegle credential has no access_token");
      return { data, identity: who };
    } catch (error) {
      if (error && /^Meegle credential (?:has no access_token|is not valid UTF-8)$/.test(error.message)) throw error;
    } finally { key.fill(0); }
  }
  fail("cannot decrypt Meegle credentials; check the registered source identity, target identity and machine key");
}
function encrypt(data, path) {
  const config = JSON.parse(file(configPath()).toString("utf8"));
  const profile = profileName(path);
  if (!config.profiles || !config.profiles[profile] || config.profiles[profile].user_access_token) fail("Meegle profile does not use native encrypted credentials");
  const machineKey = file(".meegle/.machine-key").toString("utf8");
  hex(machineKey, 32);
  const who = targetIdentity(), salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(who.hostname + ":" + who.username + ":" + machineKey + ":meegle-cli", salt, 100000, 32, "sha256");
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: ciphertext.toString("hex") }), "utf8");
  } finally { key.fill(0); plaintext.fill(0); }
}
function normalizeCompanions() {
  const target = targetIdentity(), stagedHome = process.env.HOME;
  if (!stagedHome) fail("Meegle credential staging HOME is unavailable");
  for (const entry of input.files || []) {
    if (entry.path === input.path || !/^\.meegle\/credentials(?:-[A-Za-z0-9_-]{1,100})?\.enc$/.test(entry.path)) continue;
    const companion = bytes(entry.content), opened = decrypt(entry.path, companion);
    if (opened.identity.hostname === target.hostname && opened.identity.username === target.username) continue;
    const normalized = encrypt(opened.data, entry.path);
    fs.writeFileSync(require("node:path").join(stagedHome, entry.path), normalized, { mode: 0o600 });
  }
}
function validateConfiguration(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) fail("Meegle config must contain a profiles object");
  const current = config.current || "default";
  if (typeof current !== "string" || !config.profiles[current] || config.profiles[current].user_access_token) fail("Meegle current profile must use native encrypted credentials");
  for (const entry of input.files || []) if (/^\.meegle\/credentials(?:-[A-Za-z0-9_-]{1,100})?\.enc$/.test(entry.path)) decrypt(entry.path, bytes(entry.content), config);
}
try {
  if (!input || typeof input.path !== "string" || typeof input.content !== "string") fail("invalid credential save input");
  const original = bytes(input.original);
  let output;
  if (input.path === configPath() || input.path === ".meegle/config.json") {
    const config = JSON.parse(input.content);
    if (!config || typeof config !== "object" || Array.isArray(config)) fail("Meegle config must be a JSON object");
    validateConfiguration(config);
    const text = input.content;
    output = Buffer.from(text, "utf8");
  } else if (input.path === ".meegle/.machine-key") {
    hex(input.content, 32);
    if (!Buffer.from(input.content, "utf8").equals(original)) fail("Meegle machine key cannot be changed without re-encrypting every profile");
    output = original;
  } else if (/^\.meegle\/credentials(?:-[A-Za-z0-9_-]{1,100})?\.enc$/.test(input.path)) {
    const edited = JSON.parse(input.content);
    if (!edited || typeof edited.access_token !== "string" || !edited.access_token) fail("Meegle credentials require a non-empty access_token");
    const before = decrypt(input.path, original);
    const target = targetIdentity();
    output = canonical(edited) === canonical(before.data) && before.identity.hostname === target.hostname && before.identity.username === target.username
      ? original : encrypt(edited, input.path);
  } else if (input.encoding === "base64") {
    output = Buffer.from(input.content, "base64");
    if (output.toString("base64") !== input.content) fail("invalid base64 file content");
  } else {
    output = Buffer.from(input.content, "utf8");
  }
  if (input.path.startsWith(".meegle/")) normalizeCompanions();
  process.stdout.write(output);
} catch (error) { console.error(error && error.message || "Meegle Save hook failed"); process.exitCode = 1; }
`;

const larkLoad = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
function fail(message) { throw new Error(message); }
function bytes(value) {
  if (typeof value !== "string") fail("credential bytes are missing");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value) fail("invalid base64 credential bytes");
  return result;
}
function file(path) {
  const entry = Array.isArray(input.files) && input.files.find(item => item.path === path);
  if (!entry) fail("required companion credential is missing: " + path);
  return bytes(entry.content);
}
function configPath() {
  return input.primaryPath && Array.isArray(input.files) && input.files.some(item => item.path === input.primaryPath)
    ? input.primaryPath : ".lark-cli/config.json";
}
function config() { return JSON.parse(file(configPath()).toString("utf8")); }
function encryptedAccount(path, configOverride) {
  const root = ".local/share/lark-cli/";
  const name = path.startsWith(root) ? path.slice(root.length) : "";
  if (!name.endsWith(".enc")) fail("unsupported Lark credential path");
  const stem = name.slice(0, -4), conf = configOverride || config(), apps = Array.isArray(conf.apps) ? conf.apps : [];
  if (stem.startsWith("appsecret_")) {
    const appId = stem.slice("appsecret_".length);
    if (!apps.some(app => app && app.appId === appId)) fail("Lark app-secret file is not referenced by config.json");
    return { kind: "appsecret", appId };
  }
  for (const app of apps) {
    if (!app || typeof app.appId !== "string" || !Array.isArray(app.users)) continue;
    for (const user of app.users) if (user && typeof user.userOpenId === "string" && stem === app.appId + "_" + user.userOpenId) return { kind: "user", appId: app.appId, userOpenId: user.userOpenId };
  }
  fail("Lark token file is not referenced by config.json");
}
function validateToken(token, account) {
  if (!token || typeof token !== "object" || Array.isArray(token) || token.appId !== account.appId || token.userOpenId !== account.userOpenId || typeof token.accessToken !== "string" || !token.accessToken) fail("Lark user token must match its app/user file and contain accessToken");
  if (token.refreshToken !== undefined && typeof token.refreshToken !== "string") fail("Lark refreshToken must be text");
  for (const field of ["expiresAt", "refreshExpiresAt", "grantedAt"]) if (token[field] !== undefined && !Number.isSafeInteger(token[field])) fail("Lark token timestamps must be safe integers");
  if (token.scope !== undefined && typeof token.scope !== "string") fail("Lark token scope must be text");
  return token;
}
function decrypt(path, raw, configOverride) {
  const account = encryptedAccount(path, configOverride);
  const key = file(".local/share/lark-cli/master.key");
  if (key.length !== 32 || raw.length < 28) fail("invalid Lark keychain file or master key");
  const nonce = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ciphertext = raw.subarray(12, raw.length - 16);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const text = plaintext.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(plaintext) || !text) fail("Lark keychain value is not non-empty UTF-8 text");
    if (account.kind === "user") return { account, value: validateToken(JSON.parse(text), account) };
    return { account, value: text };
  } catch (error) {
    if (error && error.message === "Lark keychain value is not non-empty UTF-8 text") throw error;
    fail("cannot decrypt Lark credentials; check master.key and the native credential files");
  }
}
try {
  if (!input || typeof input.path !== "string") fail("credential path is missing");
  const raw = bytes(input.content);
  let content, encoding = "utf8";
  if (input.path === configPath() || input.path === ".lark-cli/config.json") {
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) fail("Lark config is not valid UTF-8");
    JSON.parse(text);
    content = text;
  } else if (input.path === ".local/share/lark-cli/master.key") {
    if (raw.length !== 32) fail("Lark master.key must contain exactly 32 bytes");
    content = raw.toString("base64");
    encoding = "base64";
  } else if (/^\.local\/share\/lark-cli\/[A-Za-z0-9_-]+\.enc$/.test(input.path)) {
    const opened = decrypt(input.path, raw);
    content = opened.account.kind === "user" ? JSON.stringify(opened.value, null, 2) : opened.value;
    encoding = "parsed";
  } else {
    content = raw.toString("base64");
    encoding = "base64";
  }
  process.stdout.write(JSON.stringify({ content, encoding }));
} catch (error) { console.error(error && error.message || "Lark Load hook failed"); process.exitCode = 1; }
`;

const larkSave = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
function fail(message) { throw new Error(message); }
function bytes(value) {
  if (typeof value !== "string") fail("credential bytes are missing");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value) fail("invalid base64 credential bytes");
  return result;
}
function file(path) {
  const entry = Array.isArray(input.files) && input.files.find(item => item.path === path);
  if (!entry) fail("required companion credential is missing: " + path);
  return bytes(entry.content);
}
function configPath() {
  return input.primaryPath && Array.isArray(input.files) && input.files.some(item => item.path === input.primaryPath)
    ? input.primaryPath : ".lark-cli/config.json";
}
function config() { return JSON.parse(file(configPath()).toString("utf8")); }
function encryptedAccount(path, configOverride) {
  const root = ".local/share/lark-cli/";
  const name = path.startsWith(root) ? path.slice(root.length) : "";
  if (!name.endsWith(".enc")) fail("unsupported Lark credential path");
  const stem = name.slice(0, -4), conf = configOverride || config(), apps = Array.isArray(conf.apps) ? conf.apps : [];
  if (stem.startsWith("appsecret_")) {
    const appId = stem.slice("appsecret_".length);
    if (!apps.some(app => app && app.appId === appId)) fail("Lark app-secret file is not referenced by config.json");
    return { kind: "appsecret", appId };
  }
  for (const app of apps) {
    if (!app || typeof app.appId !== "string" || !Array.isArray(app.users)) continue;
    for (const user of app.users) if (user && typeof user.userOpenId === "string" && stem === app.appId + "_" + user.userOpenId) return { kind: "user", appId: app.appId, userOpenId: user.userOpenId };
  }
  fail("Lark token file is not referenced by config.json");
}
function validateToken(token, account) {
  if (!token || typeof token !== "object" || Array.isArray(token) || token.appId !== account.appId || token.userOpenId !== account.userOpenId || typeof token.accessToken !== "string" || !token.accessToken) fail("Lark user token must match its app/user file and contain accessToken");
  if (token.refreshToken !== undefined && typeof token.refreshToken !== "string") fail("Lark refreshToken must be text");
  for (const field of ["expiresAt", "refreshExpiresAt", "grantedAt"]) if (token[field] !== undefined && !Number.isSafeInteger(token[field])) fail("Lark token timestamps must be safe integers");
  if (token.scope !== undefined && typeof token.scope !== "string") fail("Lark token scope must be text");
  return token;
}
function decrypt(path, raw, key, configOverride) {
  const account = encryptedAccount(path, configOverride);
  if (key.length !== 32 || raw.length < 28) fail("invalid Lark keychain file or master key");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
    const text = plaintext.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(plaintext) || !text) fail("Lark keychain value is not non-empty UTF-8 text");
    if (account.kind === "user") return { account, value: validateToken(JSON.parse(text), account) };
    return { account, value: text };
  } catch (error) {
    if (error && error.message === "Lark keychain value is not non-empty UTF-8 text") throw error;
    fail("cannot decrypt Lark credentials; check master.key and the native credential files");
  }
}
function encrypt(path, text, key) {
  encryptedAccount(path);
  if (key.length !== 32) fail("Lark master.key must contain exactly 32 bytes");
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function validateConfig(conf) {
  const safe = /^[A-Za-z0-9_-]{1,100}$/;
  if (!conf || typeof conf !== "object" || Array.isArray(conf) || !Array.isArray(conf.apps)) fail("Lark config must contain an apps array");
  const ids = new Set(), aliases = new Set(), required = [];
  for (const app of conf.apps) {
    if (!app || !safe.test(app.appId || "") || ids.has(app.appId)) fail("Lark appId values must be unique native identifiers");
    ids.add(app.appId);
    if (app.name !== undefined && (typeof app.name !== "string" || !app.name)) fail("Lark app profile name is invalid");
    const alias = app.name || app.appId;
    if (aliases.has(alias)) fail("Lark app profile names must be unique");
    aliases.add(alias);
    if (app.defaultAs !== undefined && !["", "user", "bot", "auto"].includes(app.defaultAs)) fail("Lark defaultAs must be user, bot, or auto");
    if (app.appSecret && typeof app.appSecret === "object") {
      if (app.appSecret.source !== "keychain" || app.appSecret.id !== "appsecret:" + app.appId) fail("Lark appSecret keychain reference must match appId");
      required.push(".local/share/lark-cli/appsecret_" + app.appId + ".enc");
    } else if (app.appSecret !== undefined && typeof app.appSecret !== "string") fail("Lark appSecret must be text or a keychain reference");
    const users = app.users === undefined ? [] : app.users;
    if (!Array.isArray(users)) fail("Lark app users must be an array");
    const userIds = new Set();
    for (const user of users) {
      if (!user || !safe.test(user.userOpenId || "") || userIds.has(user.userOpenId)) fail("Lark userOpenId values must be unique native identifiers");
      userIds.add(user.userOpenId);
      required.push(".local/share/lark-cli/" + app.appId + "_" + user.userOpenId + ".enc");
    }
  }
  for (const app of conf.apps) if (app.name && app.name !== app.appId && ids.has(app.name)) fail("Lark app profile names cannot collide with appId values");
  if (conf.currentApp !== undefined && (typeof conf.currentApp !== "string" || !conf.apps.some(app => app && (app.appId === conf.currentApp || (app.name && app.name === conf.currentApp))))) fail("Lark currentApp must reference a configured app");
  if (required.length) {
    const key = file(".local/share/lark-cli/master.key");
    if (key.length !== 32) fail("Lark master.key must contain exactly 32 bytes");
    for (const path of required) {
      const opened = decrypt(path, file(path), key, conf);
      if (opened.account.kind === "appsecret" && !opened.value) fail("Lark app secret must be non-empty text");
    }
  }
}
try {
  if (!input || typeof input.path !== "string" || typeof input.content !== "string") fail("invalid credential save input");
  const original = bytes(input.original);
  let output;
  if (input.path === configPath() || input.path === ".lark-cli/config.json") {
    const config = JSON.parse(input.content);
    validateConfig(config);
    output = Buffer.from(input.content, "utf8");
  } else if (input.path === ".local/share/lark-cli/master.key") {
    const edited = bytes(input.content);
    if (edited.length !== 32) fail("Lark master.key must contain exactly 32 bytes");
    if (!edited.equals(original)) fail("Lark master.key cannot be changed without re-encrypting every keychain item");
    output = original;
  } else if (/^\.local\/share\/lark-cli\/[A-Za-z0-9_-]+\.enc$/.test(input.path)) {
    const key = file(".local/share/lark-cli/master.key");
    const before = decrypt(input.path, original, key);
    if (before.account.kind === "user") {
      const edited = validateToken(JSON.parse(input.content), before.account);
      output = canonical(edited) === canonical(before.value) ? original : encrypt(input.path, JSON.stringify(edited), key);
    } else {
      if (!input.content || input.content.includes("\u0000")) fail("Lark app secret must be non-empty text");
      output = input.content === before.value ? original : encrypt(input.path, input.content, key);
    }
  } else if (input.encoding === "base64") {
    output = Buffer.from(input.content, "base64");
    if (output.toString("base64") !== input.content) fail("invalid base64 file content");
  } else {
    output = Buffer.from(input.content, "utf8");
  }
  process.stdout.write(output);
} catch (error) { console.error(error && error.message || "Lark Save hook failed"); process.exitCode = 1; }
`;

export const meegleLoadHook = hook(meegleLoad);
export const meegleSaveHook = hook(meegleSave);
export const larkLoadHook = hook(larkLoad);
export const larkSaveHook = hook(larkSave);
