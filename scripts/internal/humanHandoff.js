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
const HUMAN_HANDOFF_CONVERSATION_GAP_MINUTES = Math.max(
  1,
  Number.isFinite(Number(process.env.HUMAN_HANDOFF_CONVERSATION_GAP_MINUTES))
    ? Math.floor(Number(process.env.HUMAN_HANDOFF_CONVERSATION_GAP_MINUTES))
    : 240
);

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

async function getActivePortalChat({ portalId, portalSecretKey, chatSource, chatId }) {
  if (!portalId || !portalSecretKey || !chatSource || !chatId) {
    return { ok: true, chat: null };
  }
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "human_handoff_chats", {
    select: "id,agent_id,status,assigned_human_agent_user_id,shift_id",
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
    if (!response.ok) return { ok: false, status: 502, error: "Portal chat service unavailable" };
    const payload = await response.json();
    const row = Array.isArray(payload) ? payload[0] : null;
    return { ok: true, chat: row || null };
  } catch (_) {
    return { ok: false, status: 502, error: "Portal chat service unavailable" };
  }
}

async function createPortalChat({
  portalId,
  portalSecretKey,
  agentId = null,
  chatSource,
  source,
  chatId,
  anonId = null,
  externalUserId = null,
  country = null,
  customerName = null,
  subject = null,
  summery = null,
}) {
  if (!portalId || !portalSecretKey || !chatSource || !chatId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/human_handoff_chats`;
  const payload = {
    agent_id: agentId || null,
    chat_source: chatSource,
    source: source ?? null,
    chat_id: chatId,
    annon: anonId ?? null,
    external_user_id: externalUserId ?? null,
    country: country ?? null,
    customer_name: customerName ?? null,
    subject: subject ?? null,
    summery: summery ?? null,
    assigned_human_agent_user_id: null,
    status: "active",
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: authHeaders(portalSecretKey, {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }),
      body: JSON.stringify(payload),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Portal chat service unavailable" };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: "Portal chat creation failed",
      details: text || null,
    };
  }

  let responsePayload;
  try {
    responsePayload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Portal chat service unavailable" };
  }
  const row = Array.isArray(responsePayload) ? responsePayload[0] : responsePayload;
  return { ok: true, created: true, chat: row || null };
}

async function ensurePortalChat({
  portalId,
  portalSecretKey,
  agentId = null,
  chatSource,
  source,
  chatId,
  anonId = null,
  externalUserId = null,
  country = null,
  customerName = null,
  subject = null,
  summery = null,
}) {
  const existing = await getActivePortalChat({ portalId, portalSecretKey, chatSource, chatId });
  if (!existing.ok) return existing;
  if (existing.chat) return { ok: true, created: false, chat: existing.chat };
  return createPortalChat({
    portalId,
    portalSecretKey,
    agentId,
    chatSource,
    source,
    chatId,
    anonId,
    externalUserId,
    country,
    customerName,
    subject,
    summery,
  });
}

async function checkAvailableHumanAgents({ portalId, portalSecretKey, agentId }) {
  if (!portalId || !portalSecretKey || !agentId) return { ok: true, available: false };
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "human_agents_on_shift", {
    select: "id",
    agent_id: `eq.${agentId}`,
    is_on_shift: "eq.true",
    on_break: "eq.false",
    wrap_up: "eq.false",
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
  workspaceId = null,
  anonId,
  chatId,
  country,
  customerName = null,
  source,
  prompt,
  result = null,
}) {
  if (!supId || !supKey || !chatId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/messages`;
  const payload = {
    agent_id: agentId,
    workspace_id: workspaceId ?? null,
    annon: anonId ?? null,
    chat_id: chatId,
    country: country ?? null,
    customer_name: customerName === null || customerName === undefined ? null : String(customerName),
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
        Prefer: "return=representation",
      }),
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Message service unavailable" };
    const responsePayload = await response.json();
    const row = Array.isArray(responsePayload) ? responsePayload[0] : responsePayload;
    return { ok: true, row: row || null, messageId: row?.id ?? null };
  } catch (_) {
    return { ok: false, status: 502, error: "Message service unavailable" };
  }
}

async function resolveConversationStartMessageId({
  supId,
  supKey,
  agentId,
  anonId,
  chatId,
  latestMessageId = null,
  gapMinutes = HUMAN_HANDOFF_CONVERSATION_GAP_MINUTES,
}) {
  if (!supId || !supKey || !agentId || !anonId || !chatId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "messages", {
    select: "id,created_at",
    agent_id: `eq.${agentId}`,
    annon: `eq.${anonId}`,
    chat_id: `eq.${chatId}`,
    order: "created_at.desc,id.desc",
    limit: "200",
  });

  let response;
  try {
    response = await fetch(url, {
      headers: authHeaders(supKey, { Accept: "application/json" }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Message service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Message service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Message service unavailable" };
  }

  const rowsDesc = Array.isArray(payload) ? payload : [];
  if (rowsDesc.length === 0) return { ok: true, messageStartId: null };

  const latestIndex =
    latestMessageId === null || latestMessageId === undefined
      ? 0
      : rowsDesc.findIndex((row) => Number(row?.id) === Number(latestMessageId));
  const startIndex = latestIndex >= 0 ? latestIndex : 0;
  let messageStartId = Number(rowsDesc[startIndex]?.id) || null;
  let newerCreatedAt = Date.parse(String(rowsDesc[startIndex]?.created_at || ""));
  const maxGapMs = Math.max(1, Number(gapMinutes) || 1) * 60 * 1000;

  for (let index = startIndex + 1; index < rowsDesc.length; index += 1) {
    const row = rowsDesc[index];
    const olderCreatedAt = Date.parse(String(row?.created_at || ""));
    const rowId = Number(row?.id);
    if (!Number.isFinite(olderCreatedAt) || !Number.isFinite(newerCreatedAt) || !Number.isFinite(rowId)) {
      break;
    }
    if (newerCreatedAt - olderCreatedAt > maxGapMs) {
      break;
    }
    messageStartId = Math.floor(rowId);
    newerCreatedAt = olderCreatedAt;
  }

  return {
    ok: true,
    messageStartId: Number.isFinite(Number(messageStartId)) ? Math.floor(Number(messageStartId)) : null,
  };
}

async function updateHumanHandoffChatMessageStart({
  portalId,
  portalSecretKey,
  handoffChatId,
  messageStartId,
}) {
  const numericHandoffChatId = Number(handoffChatId);
  const numericMessageStartId = Number(messageStartId);
  if (!portalId || !portalSecretKey || !Number.isFinite(numericHandoffChatId) || numericHandoffChatId <= 0) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  if (!Number.isFinite(numericMessageStartId) || numericMessageStartId <= 0) {
    return { ok: true, skipped: true };
  }

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "human_handoff_chats", {
    id: `eq.${Math.floor(numericHandoffChatId)}`,
  });

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: authHeaders(portalSecretKey, {
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify({
        message_start_id: Math.floor(numericMessageStartId),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human handoff service unavailable" };
    return { ok: true };
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
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
  if (!portalId || !portalSecretKey || !chatId || !senderType) {
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
  customerName = null,
  messageStartId = null,
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
    p_customer_name: customerName ?? null,
    p_message_start_id: messageStartId ?? null,
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
    if (response.status === 404 && /assign_human_handoff_chat/i.test(text)) {
      return {
        ok: false,
        status: 404,
        error: "assign_human_handoff_chat RPC not found",
        details: text || null,
      };
    }
    return {
      ok: false,
      status: response.status || 502,
      error: "Human handoff assignment failed",
      details: text || null,
    };
  }

  let payloadRows;
  try {
    payloadRows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }
  const row = Array.isArray(payloadRows) ? payloadRows[0] : payloadRows;
  if (!row || typeof row !== "object") {
    return { ok: false, status: 502, error: "Invalid assignment RPC response" };
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
  getActivePortalChat,
  createPortalChat,
  ensurePortalChat,
  checkAvailableHumanAgents,
  saveHumanMessageToMessages,
  saveHumanMessageToPortalFeed,
  resolveConversationStartMessageId,
  updateHumanHandoffChatMessageStart,
  assignHumanHandoffChat,
};
