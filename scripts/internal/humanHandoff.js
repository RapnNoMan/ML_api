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
    select: "id,agent_id,workspace_id,status,assigned_human_agent_user_id,shift_id",
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
  workspaceId = null,
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
    workspace_id: workspaceId || null,
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
  workspaceId = null,
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
    workspaceId,
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

function normalizeNullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.floor(number);
}

function postgrestIn(values) {
  const cleaned = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return `in.(${cleaned.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")})`;
}

async function upsertDispatcherContact({
  portalId,
  portalSecretKey,
  workspaceId,
  chatSource,
  source,
  externalIdentifier,
  customerName = null,
  phoneNumber = null,
  gender = null,
  age = null,
  email = null,
  country = null,
  customFields = null,
}) {
  if (!portalId || !portalSecretKey || !workspaceId || !chatSource || !externalIdentifier) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/contacts`);
  url.searchParams.set("on_conflict", "workspace_id,chat_source,external_identifier");

  const payload = {
    workspace_id: workspaceId,
    agent_id: null,
    chat_source: chatSource,
    source: source ?? null,
    external_identifier: externalIdentifier,
  };
  if (normalizeNullableText(customerName)) payload.customer_name = normalizeNullableText(customerName);
  if (normalizeNullableText(phoneNumber)) payload.phone_number = normalizeNullableText(phoneNumber);
  if (normalizeNullableText(gender)) payload.gender = normalizeNullableText(gender);
  if (normalizePositiveInteger(age)) payload.age = normalizePositiveInteger(age);
  if (normalizeNullableText(email)) payload.email = normalizeNullableText(email);
  if (normalizeNullableText(country)) payload.country = normalizeNullableText(country);
  if (customFields && typeof customFields === "object" && !Array.isArray(customFields)) {
    payload.custom_fields = customFields;
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: authHeaders(portalSecretKey, {
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      }),
      body: JSON.stringify(payload),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Contact service unavailable" };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch (_) {}
    return { ok: false, status: response.status || 502, error: "Contact upsert failed", details: text || null };
  }

  let rows;
  try {
    rows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Contact service unavailable" };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { ok: true, contact: row || null, contactId: row?.id ?? null };
}

async function getDispatcherCandidateMembers({ portalId, portalSecretKey, workspaceId, categoryName }) {
  if (!portalId || !portalSecretKey || !workspaceId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "workspace_members", {
    select: "user_id,user_category",
    workspace_id: `eq.${workspaceId}`,
    active: "eq.true",
    can_access_human_agents: "eq.true",
    user_category: normalizeNullableText(categoryName) ? `eq.${normalizeNullableText(categoryName)}` : undefined,
    order: "created_at.asc",
  });

  try {
    const response = await fetch(url, {
      headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human agent member service unavailable" };
    const rows = await response.json();
    return { ok: true, members: Array.isArray(rows) ? rows : [] };
  } catch (_) {
    return { ok: false, status: 502, error: "Human agent member service unavailable" };
  }
}

async function getDispatcherActiveShifts({ portalId, portalSecretKey, candidateUserIds }) {
  const userIds = (Array.isArray(candidateUserIds) ? candidateUserIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!portalId || !portalSecretKey || userIds.length === 0) {
    return { ok: true, shifts: [] };
  }

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "human_agents_on_shift", {
    select: "id,human_agent_user_id,max_concurrent_chats,updated_at",
    human_agent_user_id: postgrestIn(userIds),
    is_on_shift: "eq.true",
    on_break: "eq.false",
    wrap_up: "eq.false",
    order: "updated_at.asc,id.asc",
  });

  try {
    const response = await fetch(url, {
      headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human agent shift service unavailable" };
    const rows = await response.json();
    return { ok: true, shifts: Array.isArray(rows) ? rows : [] };
  } catch (_) {
    return { ok: false, status: 502, error: "Human agent shift service unavailable" };
  }
}

async function getHumanAgentActiveChatCounts({ portalId, portalSecretKey, workspaceId, userIds }) {
  const cleanedUserIds = (Array.isArray(userIds) ? userIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!portalId || !portalSecretKey || !workspaceId || cleanedUserIds.length === 0) {
    return { ok: true, counts: new Map() };
  }

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = buildRestUrl(baseUrl, "human_handoff_chats", {
    select: "assigned_human_agent_user_id",
    workspace_id: `eq.${workspaceId}`,
    assigned_human_agent_user_id: postgrestIn(cleanedUserIds),
    status: "eq.active",
  });

  try {
    const response = await fetch(url, {
      headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
    });
    if (!response.ok) return { ok: false, status: 502, error: "Human handoff service unavailable" };
    const rows = await response.json();
    const counts = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const userId = String(row?.assigned_human_agent_user_id || "").trim();
      if (!userId) continue;
      counts.set(userId, (counts.get(userId) || 0) + 1);
    }
    return { ok: true, counts };
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }
}

function chooseLeastLoaded(candidates, counts) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((item) =>
    String(item?.userId || "").trim()
  );
  if (list.length === 0) return null;
  return [...list].sort((a, b) => {
    const countDiff = (counts.get(a.userId) || 0) - (counts.get(b.userId) || 0);
    if (countDiff !== 0) return countDiff;
    return String(a.userId).localeCompare(String(b.userId));
  })[0];
}

async function chooseDispatcherHumanAgent({ portalId, portalSecretKey, workspaceId, categoryName }) {
  const membersResult = await getDispatcherCandidateMembers({
    portalId,
    portalSecretKey,
    workspaceId,
    categoryName,
  });
  if (!membersResult.ok) return membersResult;

  const members = membersResult.members;
  const userIds = members.map((member) => String(member?.user_id || "").trim()).filter(Boolean);
  if (userIds.length === 0) {
    return {
      ok: true,
      assignedHumanAgentUserId: null,
      shiftId: null,
      usedShift: false,
      unassigned: true,
    };
  }

  const countsResult = await getHumanAgentActiveChatCounts({
    portalId,
    portalSecretKey,
    workspaceId,
    userIds,
  });
  if (!countsResult.ok) return countsResult;

  const shiftsResult = await getDispatcherActiveShifts({
    portalId,
    portalSecretKey,
    candidateUserIds: userIds,
  });
  if (!shiftsResult.ok) return shiftsResult;

  const counts = countsResult.counts || new Map();
  const shiftedCandidates = [];
  for (const shift of shiftsResult.shifts) {
    const userId = String(shift?.human_agent_user_id || "").trim();
    if (!userId) continue;
    const activeCount = counts.get(userId) || 0;
    const maxConcurrentChats = normalizePositiveInteger(shift?.max_concurrent_chats);
    if (maxConcurrentChats !== null && activeCount >= maxConcurrentChats) continue;
    shiftedCandidates.push({ userId, shiftId: shift?.id ?? null });
  }

  const shiftedChoice = chooseLeastLoaded(shiftedCandidates, counts);
  if (shiftedChoice) {
    return {
      ok: true,
      assignedHumanAgentUserId: shiftedChoice.userId,
      shiftId: shiftedChoice.shiftId ?? null,
      usedShift: true,
    };
  }

  const fallbackChoice = chooseLeastLoaded(
    userIds.map((userId) => ({ userId, shiftId: null })),
    counts
  );
  if (!fallbackChoice) {
    return {
      ok: true,
      assignedHumanAgentUserId: null,
      shiftId: null,
      usedShift: false,
      unassigned: true,
    };
  }
  return {
    ok: true,
    assignedHumanAgentUserId: fallbackChoice.userId,
    shiftId: null,
    usedShift: false,
  };
}

async function assignDispatcherHandoffChat({
  portalId,
  portalSecretKey,
  workspaceId,
  chatSource,
  source,
  chatId,
  anonId = null,
  externalUserId = null,
  country = null,
  customerName = null,
  categoryName,
  subject = null,
  summery = null,
  phoneNumber = null,
  gender = null,
  age = null,
  email = null,
  customFields = null,
  messageStartId = null,
}) {
  if (!portalId || !portalSecretKey || !workspaceId || !chatSource || !chatId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const assignmentResult = await chooseDispatcherHumanAgent({
    portalId,
    portalSecretKey,
    workspaceId,
    categoryName,
  });
  if (!assignmentResult.ok) return assignmentResult;

  const externalIdentifier =
    normalizeNullableText(externalUserId) || normalizeNullableText(anonId) || normalizeNullableText(chatId);
  const contactResult = await upsertDispatcherContact({
    portalId,
    portalSecretKey,
    workspaceId,
    chatSource,
    source,
    externalIdentifier,
    customerName,
    phoneNumber,
    gender,
    age,
    email,
    country,
    customFields,
  });
  if (!contactResult.ok) return contactResult;

  const existingResult = await getActivePortalChat({ portalId, portalSecretKey, chatSource, chatId });
  if (!existingResult.ok) return existingResult;

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const payload = {
    workspace_id: workspaceId,
    agent_id: null,
    chat_source: chatSource,
    source: source ?? null,
    chat_id: chatId,
    annon: anonId ?? null,
    external_user_id: externalUserId ?? null,
    country: country ?? null,
    customer_name: normalizeNullableText(customerName),
    subject: normalizeNullableText(subject) || "Human support request",
    summery: normalizeNullableText(summery) || "Dispatcher routed this conversation to a human agent.",
    assigned_human_agent_user_id: assignmentResult.assignedHumanAgentUserId,
    shift_id: assignmentResult.shiftId ?? null,
    contact_id: contactResult.contactId ?? null,
    message_start_id: messageStartId ?? null,
    status: "active",
    updated_at: new Date().toISOString(),
  };

  let response;
  try {
    if (existingResult.chat?.id) {
      response = await fetch(
        buildRestUrl(baseUrl, "human_handoff_chats", { id: `eq.${existingResult.chat.id}` }),
        {
          method: "PATCH",
          headers: authHeaders(portalSecretKey, {
            "Content-Type": "application/json",
            Accept: "application/json",
            Prefer: "return=representation",
          }),
          body: JSON.stringify(payload),
        }
      );
    } else {
      response = await fetch(`${baseUrl}/human_handoff_chats`, {
        method: "POST",
        headers: authHeaders(portalSecretKey, {
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "return=representation",
        }),
        body: JSON.stringify(payload),
      });
    }
  } catch (_) {
    return { ok: false, status: 502, error: "Dispatcher handoff service unavailable" };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: "Dispatcher handoff assignment failed",
      details: text || null,
    };
  }

  let rows;
  try {
    rows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Dispatcher handoff service unavailable" };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    ok: true,
    created: !existingResult.chat?.id,
    handoffChatId: row?.id ?? null,
    assignedHumanAgentUserId: row?.assigned_human_agent_user_id ?? assignmentResult.assignedHumanAgentUserId,
    shiftId: row?.shift_id ?? assignmentResult.shiftId ?? null,
    contactId: row?.contact_id ?? contactResult.contactId ?? null,
    status: row?.status ?? "active",
  };
}

async function assignDispatcherAiAgentChat({
  portalId,
  portalSecretKey,
  workspaceId,
  aiAgentId,
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
  if (!portalId || !portalSecretKey || !workspaceId || !aiAgentId || !chatSource || !chatId) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const existingResult = await getActivePortalChat({ portalId, portalSecretKey, chatSource, chatId });
  if (!existingResult.ok) return existingResult;

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const payload = {
    workspace_id: workspaceId,
    agent_id: aiAgentId,
    chat_source: chatSource,
    source: source ?? null,
    chat_id: chatId,
    annon: anonId ?? null,
    external_user_id: externalUserId ?? null,
    country: country ?? null,
    customer_name: normalizeNullableText(customerName),
    subject: normalizeNullableText(subject) || "AI agent handoff",
    summery: normalizeNullableText(summery) || "Dispatcher routed this conversation to an AI agent.",
    assigned_human_agent_user_id: null,
    shift_id: null,
    status: "active",
    updated_at: new Date().toISOString(),
  };

  let response;
  try {
    if (existingResult.chat?.id) {
      response = await fetch(
        buildRestUrl(baseUrl, "human_handoff_chats", { id: `eq.${existingResult.chat.id}` }),
        {
          method: "PATCH",
          headers: authHeaders(portalSecretKey, {
            "Content-Type": "application/json",
            Accept: "application/json",
            Prefer: "return=representation",
          }),
          body: JSON.stringify(payload),
        }
      );
    } else {
      response = await fetch(`${baseUrl}/human_handoff_chats`, {
        method: "POST",
        headers: authHeaders(portalSecretKey, {
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "return=representation",
        }),
        body: JSON.stringify(payload),
      });
    }
  } catch (_) {
    return { ok: false, status: 502, error: "AI handoff service unavailable" };
  }

  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: "AI handoff assignment failed",
      details: text || null,
    };
  }

  let rows;
  try {
    rows = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "AI handoff service unavailable" };
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    ok: true,
    created: !existingResult.chat?.id,
    handoffChatId: row?.id ?? null,
    assignedAiAgentId: row?.agent_id ?? aiAgentId,
    status: row?.status ?? "active",
  };
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
  assignDispatcherHandoffChat,
  assignDispatcherAiAgentChat,
};
