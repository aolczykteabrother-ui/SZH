import { GoogleAuth } from "google-auth-library";

const SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

function serviceAccountCredentials() {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!encoded) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not configured.");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_JSON_B64: ${error.message}`);
  }
}

function googleAuth() {
  return new GoogleAuth({
    credentials: serviceAccountCredentials(),
    scopes: [SEARCH_CONSOLE_SCOPE],
  });
}

export function resolveSite(requested) {
  const site = (requested || process.env.DEFAULT_GSC_SITE || "").trim();
  if (!site) throw new Error("No Search Console property configured.");
  const allowed = new Set(
    (process.env.ALLOWED_GSC_SITES || process.env.DEFAULT_GSC_SITE || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  if (allowed.size && !allowed.has(site)) {
    throw new Error(`Search Console property is not allowed: ${site}`);
  }
  return site;
}

async function bearerToken() {
  const client = await googleAuth().getClient();
  const tokenResult = await client.getAccessToken();
  const token = typeof tokenResult === "string" ? tokenResult : tokenResult?.token;
  if (!token) throw new Error("Google did not return an access token.");
  return token;
}

export function serviceAccountIdentity() {
  const creds = serviceAccountCredentials();
  return {
    client_email: creds.client_email || null,
    project_id: creds.project_id || null,
  };
}

export async function listSites() {
  const token = await bearerToken();
  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GSC sites.list failed: ${response.status} ${await response.text()}`);
  return await response.json();
}

export async function queryPerformance(siteUrl, body) {
  const token = await bearerToken();
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GSC searchAnalytics.query failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

export async function inspectUrl(siteUrl, inspectionUrl, languageCode = "pl-PL") {
  const token = await bearerToken();
  const response = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode }),
  });
  if (!response.ok) {
    throw new Error(`GSC URL Inspection failed: ${response.status} ${await response.text()}`);
  }
  return await response.json();
}

export function mergePeriodRows(currentRows = [], previousRows = []) {
  const previous = new Map(previousRows.map((row) => [JSON.stringify(row.keys || []), row]));
  return currentRows.map((current) => {
    const prev = previous.get(JSON.stringify(current.keys || []));
    const c = normalizeMetrics(current);
    const p = normalizeMetrics(prev);
    return {
      keys: current.keys || [],
      current: c,
      previous: p,
      delta: {
        clicks: c.clicks - p.clicks,
        impressions: c.impressions - p.impressions,
        ctr: c.ctr - p.ctr,
        position: c.position - p.position,
      },
    };
  });
}

function normalizeMetrics(row) {
  return {
    clicks: row?.clicks || 0,
    impressions: row?.impressions || 0,
    ctr: row?.ctr || 0,
    position: row?.position || 0,
  };
}

export function rollingRanges(days, lagDays) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - lagDays);
  const currentStart = new Date(end);
  currentStart.setUTCDate(currentStart.getUTCDate() - days + 1);
  const previousEnd = new Date(currentStart);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - days + 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    current: { startDate: iso(currentStart), endDate: iso(end) },
    previous: { startDate: iso(previousStart), endDate: iso(previousEnd) },
  };
}
