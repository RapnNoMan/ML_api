const {
  checkHumanAgentsAppEnabled,
  saveHumanMessageToMessages,
} = require("../../scripts/internal/humanHandoff");

function setCorsHeaders(req, res) {
  const originRaw = typeof req?.headers?.origin === "string" ? req.headers.origin : "";
  if (originRaw) {
    res.setHeader("Access-Control-Allow-Origin", originRaw);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function normalizeIdValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function sanitizeOutgoingText(value) {
  const raw = String(value || "").replace(/\0/g, "");
  const trimmed = raw.trim();
  const maxLen = 3500;
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 3).trimEnd()}...`;
}

async function getPortalUserFromToken({ portalId, portalSecretKey, accessToken }) {
  if (!portalId || !portalSecretKey || !accessToken) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const url = `https://${portalId}.supabase.co/auth/v1/user`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Authorization service unavailable" };
  }
  if (!response.ok) return { ok: false, status: 401, error: "Unauthorized" };
  const payload = await response.json().catch(() => null);
  const userId = normalizeIdValue(payload?.id);
  if (!userId) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true, userId };
}

async function validatePortalHumanAgentAccess({ portalId, portalSecretKey, agentId, userId }) {
  if (!portalId || !portalSecretKey || !agentId || !userId) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;

  const agentParams = new URLSearchParams({
    select: "workspace_id",
    id: `eq.${agentId}`,
    limit: "1",
  });
  let agentRows;
  try {
    const response = await fetch(`${baseUrl}/agents?${agentParams.toString()}`, {
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, status: 502, error: "Authorization service unavailable" };
    agentRows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Authorization service unavailable" };
  }

  const workspaceId = normalizeIdValue((Array.isArray(agentRows) ? agentRows[0] : null)?.workspace_id);
  if (!workspaceId) return { ok: false, status: 403, error: "Unauthorized" };

  const memberParams = new URLSearchParams({
    select: "agent_id",
    workspace_id: `eq.${workspaceId}`,
    user_id: `eq.${userId}`,
    active: "eq.true",
    can_access_human_agents: "eq.true",
    limit: "1",
  });
  let memberRows;
  try {
    const response = await fetch(`${baseUrl}/workspace_members?${memberParams.toString()}`, {
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, status: 502, error: "Authorization service unavailable" };
    memberRows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Authorization service unavailable" };
  }

  const memberRow = Array.isArray(memberRows) ? memberRows[0] : null;
  if (!memberRow) return { ok: false, status: 403, error: "Unauthorized" };
  const memberAgentId = normalizeIdValue(memberRow?.agent_id);
  if (memberAgentId && memberAgentId !== agentId) {
    return { ok: false, status: 403, error: "Unauthorized" };
  }
  return { ok: true };
}

async function getAssignedWidgetHandoffChat({ portalId, portalSecretKey, agentId, chatId, anonId, userId }) {
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/human_handoff_chats`);
  url.searchParams.set("select", "id,annon,assigned_human_agent_user_id,status");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("chat_source", "eq.widget");
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("status", "neq.closed");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "1");

  let rows;
  try {
    const response = await fetch(url.toString(), {
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human handoff service unavailable" };
    rows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }

  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { ok: false, status: 404, error: "Handoff chat not found" };
  if (normalizeIdValue(row.assigned_human_agent_user_id) !== userId) {
    return { ok: false, status: 403, error: "Chat is not assigned to this human agent" };
  }
  const rowAnon = normalizeIdValue(row.annon);
  if (anonId && rowAnon && rowAnon !== anonId) {
    return { ok: false, status: 403, error: "Chat anon does not match handoff chat" };
  }
  return { ok: true, chat: row };
}

async function fetchDashboardMessageMetadata({ supId, supKey, agentId, anonId, chatId }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/messages`);
  url.searchParams.set("select", "workspace_id,country,source");
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  if (anonId) url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, status: 502, error: "Message metadata service unavailable" };
    const rows = await response.json();
    return { ok: true, row: Array.isArray(rows) ? rows[0] || null : null };
  } catch (_) {
    return { ok: false, status: 502, error: "Message metadata service unavailable" };
  }
}

async function fetchDashboardAgentWorkspaceId({ supId, supKey, agentId }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/agents`);
  url.searchParams.set("select", "workspace_id");
  url.searchParams.set("id", `eq.${agentId}`);
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return { ok: false, status: 502, error: "Agent service unavailable" };
    const rows = await response.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    return { ok: true, workspaceId: normalizeIdValue(row?.workspace_id) || null };
  } catch (_) {
    return { ok: false, status: 502, error: "Agent service unavailable" };
  }
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authHeader = String(req?.headers?.authorization || "");
  const accessToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (!accessToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body ?? {};
  const agentId = normalizeIdValue(body.agent_id);
  const chatId = normalizeIdValue(body.chat_id);
  const anonId = normalizeIdValue(body.anon_id ?? body.annon);
  const message = sanitizeOutgoingText(body.message ?? body.result);

  const missing = [];
  if (!agentId) missing.push("agent_id");
  if (!chatId) missing.push("chat_id");
  if (!message) missing.push("message");
  if (missing.length > 0) {
    res.status(400).json({ error: "Missing required fields", missing });
    return;
  }

  const authUser = await getPortalUserFromToken({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    accessToken,
  });
  if (!authUser.ok) {
    res.status(authUser.status).json({ error: authUser.error });
    return;
  }

  const accessCheck = await validatePortalHumanAgentAccess({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
    userId: authUser.userId,
  });
  if (!accessCheck.ok) {
    res.status(accessCheck.status).json({ error: accessCheck.error });
    return;
  }

  const handoffAppResult = await checkHumanAgentsAppEnabled({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
  });
  if (!handoffAppResult.ok || !handoffAppResult.enabled) {
    res.status(403).json({ error: "Human handoff is not enabled" });
    return;
  }

  const handoffChatResult = await getAssignedWidgetHandoffChat({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
    chatId,
    anonId,
    userId: authUser.userId,
  });
  if (!handoffChatResult.ok) {
    res.status(handoffChatResult.status).json({ error: handoffChatResult.error });
    return;
  }

  const metadataResult = await fetchDashboardMessageMetadata({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    anonId,
    chatId,
  });
  if (!metadataResult.ok) {
    res.status(metadataResult.status).json({ error: metadataResult.error });
    return;
  }

  let workspaceId = normalizeIdValue(metadataResult.row?.workspace_id) || null;
  if (!workspaceId) {
    const workspaceResult = await fetchDashboardAgentWorkspaceId({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      agentId,
    });
    if (!workspaceResult.ok) {
      res.status(workspaceResult.status).json({ error: workspaceResult.error });
      return;
    }
    workspaceId = workspaceResult.workspaceId;
  }

  const saveResult = await saveHumanMessageToMessages({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    workspaceId,
    anonId: anonId || normalizeIdValue(handoffChatResult.chat?.annon) || null,
    chatId,
    country: normalizeIdValue(body.country) || normalizeIdValue(metadataResult.row?.country) || null,
    source: normalizeIdValue(body.source) || normalizeIdValue(metadataResult.row?.source) || "widget",
    prompt: null,
    result: message,
  });
  if (!saveResult.ok) {
    res.status(saveResult.status).json({ error: saveResult.error });
    return;
  }

  res.status(200).json({ ok: true, logged: true });
};
