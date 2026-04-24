const HUMAN_HANDOFF_TOOL_NAME = "request_human_handoff";
const HUMAN_HANDOFF_CONFIRMATION_REPLY =
  "I have connected you with a human agent. Please wait for their reply.";

const HUMAN_HANDOFF_TOOL = {
  type: "function",
  name: HUMAN_HANDOFF_TOOL_NAME,
  description:
    "Escalate this conversation to a human support agent when the user asks for a human or escalation is needed.",
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "Short issue subject in 3-8 words.",
      },
      summery: {
        type: "string",
        description: "Concise summary for the assigned human agent.",
      },
    },
    required: ["subject", "summery"],
    additionalProperties: false,
  },
};

const HUMAN_HANDOFF_PROMPT_BLOCK = [
  "HUMAN HANDOFF TOOL RULES",
  `If the user asks to talk to a human, asks for an agent, or wants escalation, call ${HUMAN_HANDOFF_TOOL_NAME}.`,
  "Fill both subject and summery yourself from the conversation.",
  "Do not ask the user to provide subject or summery.",
  "If context is limited but user asks for a human, still call the tool with best-effort values.",
].join("\n");

function buildRestUrl(baseUrl, table, searchParams) {
  const url = new URL(`${baseUrl}/${table}`);
  if (searchParams && typeof searchParams === "object") {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function authHeaders(secret, extra = {}) {
  return {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    ...extra,
  };
}

async function checkHumanAgentsAppEnabled({ supId, supKey, agentId }) {
  if (!supId || !supKey || !agentId) return { ok: true, enabled: false };
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "workspace_apps", {
    select: "enabled,human_agents_enabled",
    agent_id: `eq.${agentId}`,
    limit: "1",
  });

  try {
    const response = await fetch(url, {
      headers: authHeaders(supKey, { Accept: "application/json" }),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Workspace apps service unavailable" };
    const payload = await response.json();
    const row = Array.isArray(payload) ? payload[0] : null;
    const enabled = Boolean(row?.enabled) && Boolean(row?.human_agents_enabled);
    return { ok: true, enabled };
  } catch (_) {
    return { ok: false, status: 502, error: "Workspace apps service unavailable" };
  }
}

async function getOpenHumanHandoffChat({ portalId, portalSecretKey, agentId, chatSource, chatId }) {
  if (!portalId || !portalSecretKey || !agentId || !chatSource || !chatId) {
    return { ok: true, chat: null };
  }
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "human_handoff_chats", {
    select: "id,status,assigned_human_agent_user_id",
    agent_id: `eq.${agentId}`,
    chat_source: `eq.${chatSource}`,
    chat_id: `eq.${chatId}`,
    status: "neq.closed",
    order: "created_at.desc",
    limit: "1",
  });

  try {
    const response = await fetch(url, {
      headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human handoff service unavailable" };
    const payload = await response.json();
    const row = Array.isArray(payload) ? payload[0] : null;
    return { ok: true, chat: row || null };
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }
}

async function checkAvailableHumanAgents({ portalId, portalSecretKey, agentId }) {
  if (!portalId || !portalSecretKey || !agentId) return { ok: true, available: false };
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "human_agents_on_shift", {
    select: "id",
    agent_id: `eq.${agentId}`,
    is_on_shift: "eq.true",
    on_break: "eq.false",
    limit: "1",
  });

  try {
    const response = await fetch(url, {
      headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human handoff service unavailable" };
    const payload = await response.json();
    return { ok: true, available: Array.isArray(payload) && payload.length > 0 };
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }
}

async function saveHumanMessageToMessages({
  supId,
  supKey,
  agentId,
  anonId,
  chatId,
  country,
  source,
  prompt,
  result = null,
}) {
  if (!supId || !supKey || !agentId || !chatId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/messages`;
  const payload = {
    agent_id: agentId,
    annon: anonId ?? null,
    chat_id: chatId,
    country: country ?? null,
    prompt: prompt === null || prompt === undefined ? null : String(prompt),
    result: result === null || result === undefined ? null : String(result),
    source: source || "api",
    action: false,
    human_reply: true,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(supKey, {
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Message service unavailable" };
    return { ok: true };
  } catch (_) {
    return { ok: false, status: 502, error: "Message service unavailable" };
  }
}

async function saveHumanMessageToPortalFeed({
  portalId,
  portalSecretKey,
  agentId,
  anonId,
  chatId,
  source,
  senderType,
  assignedHumanAgentUserId = null,
  prompt,
  result = null,
}) {
  if (!portalId || !portalSecretKey || !agentId || !chatId || !senderType) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/widget_human_messages`;
  const payload = {
    agent_id: agentId,
    annon: anonId ?? null,
    chat_id: chatId,
    prompt: prompt === null || prompt === undefined ? null : String(prompt),
    result: result === null || result === undefined ? null : String(result),
    source: source || "widget",
    human_reply: true,
    sender_type: senderType,
    assigned_human_agent_user_id: assignedHumanAgentUserId,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: authHeaders(portalSecretKey, {
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human message service unavailable" };
    return { ok: true };
  } catch (_) {
    return { ok: false, status: 502, error: "Human message service unavailable" };
  }
}

async function assignHumanHandoffChat({
  portalId,
  portalSecretKey,
  agentId,
  chatSource,
  source,
  chatId,
  anonId = null,
  externalUserId = null,
  country = null,
  subject = null,
  summery = null,
}) {
  if (!portalId || !portalSecretKey || !agentId || !chatSource || !chatId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/rpc/assign_human_handoff_chat`;

  const payload = {
    p_agent_id: agentId,
    p_chat_source: chatSource,
    p_source: source ?? null,
    p_chat_id: chatId,
    p_annon: anonId ?? null,
    p_external_user_id: externalUserId ?? null,
    p_country: country ?? null,
    p_subject: subject ?? null,
    p_summery: summery ?? null,
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(portalSecretKey, {
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: JSON.stringify(payload),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch (_) {}
    if (/NO_AVAILABLE_HUMAN_AGENT/i.test(text)) {
      return { ok: false, status: 409, error: "No human agents available" };
    }
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }

  let payloadRows;
  try {
    payloadRows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }
  const row = Array.isArray(payloadRows) ? payloadRows[0] : payloadRows;
  if (!row || typeof row !== "object") {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }

  return {
    ok: true,
    created: Boolean(row.created),
    handoffChatId: row.handoff_chat_id ?? null,
    assignedHumanAgentUserId: row.assigned_human_agent_user_id ?? null,
    shiftId: row.shift_id ?? null,
    status: row.status ?? "active",
  };
}

module.exports = {
  HUMAN_HANDOFF_TOOL_NAME,
  HUMAN_HANDOFF_TOOL,
  HUMAN_HANDOFF_PROMPT_BLOCK,
  HUMAN_HANDOFF_CONFIRMATION_REPLY,
  checkHumanAgentsAppEnabled,
  getOpenHumanHandoffChat,
  checkAvailableHumanAgents,
  saveHumanMessageToMessages,
  saveHumanMessageToPortalFeed,
  assignHumanHandoffChat,
};
