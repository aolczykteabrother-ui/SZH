import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const b64url = (value) => Buffer.from(value).toString("base64url");
const fromB64url = (value) => Buffer.from(value, "base64url");

function signingSecret() {
  const secret = process.env.OAUTH_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("OAUTH_SIGNING_SECRET must be configured and at least 32 characters long.");
  }
  return secret;
}

export function publicBaseUrl() {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

export function resourceUrl() {
  return `${publicBaseUrl()}/mcp`;
}

export function signToken(payload, ttlSeconds, type) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body = {
    ...payload,
    typ: type,
    iat: now,
    exp: now + ttlSeconds,
    jti: randomBytes(12).toString("hex"),
  };
  const encoded = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signature = createHmac("sha256", signingSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyToken(token, expectedType) {
  if (!token || typeof token !== "string") throw new Error("Missing token.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token.");
  const [headerPart, bodyPart, signaturePart] = parts;
  const encoded = `${headerPart}.${bodyPart}`;
  const expected = createHmac("sha256", signingSecret()).update(encoded).digest();
  const actual = fromB64url(signaturePart);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Invalid token signature.");
  }
  const payload = JSON.parse(fromB64url(bodyPart).toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error("Token expired.");
  if (expectedType && payload.typ !== expectedType) throw new Error("Wrong token type.");
  return payload;
}

export function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function allowedEmail(email) {
  const allow = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.length) return false;
  return allow.includes(String(email || "").trim().toLowerCase());
}

export function oauthMetadata() {
  const base = publicBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["gsc:read", "offline_access"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [publicBaseUrl()],
    scopes_supported: ["gsc:read", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "GSC OpenSEO MCP",
  };
}

export function parseScope(scope) {
  return String(scope || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function scopeAllowed(scope) {
  const supported = new Set(["gsc:read", "offline_access"]);
  const requested = parseScope(scope);
  return requested.length > 0 && requested.includes("gsc:read") && requested.every((s) => supported.has(s));
}
