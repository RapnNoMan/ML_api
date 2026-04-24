const {
  checkHumanAgentsAppEnabled,
  saveHumanMessageToMessages,
  saveHumanMessageToPortalFeed,
} = require("../../scripts/internal/humanHandoff");

const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";

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

function parseChannelChatId(chatId) {
  const value = String(chatId || "").trim();
  const firstSep = value.indexOf(":");
  const secondSep = value.indexOf(":", firstSep + 1);
  if (firstSep <= 0 || secondSep <= firstSep + 1 || secondSep >= value.length - 1) {
    return { ok: false, error: "Invalid channel chat_id format" };
  }
  const channel = value.slice(0, firstSep);
  const threadId = value.slice(firstSep + 1, secondSep);
  const recipientId = value.slice(secondSep + 1);
  if (!channel || !threadId || !recipientId) {
    return { ok: false, error: "Invalid channel chat_id format" };
  }
  return { ok: true, channel, threadId, recipientId };
}

function mapChatSourceToMessageSource(chatSource) {
  if (chatSource === "messenger" || chatSource === "instagram" || chatSource === "whatsapp" || chatSource === "telegram") {
    return `meta_${chatSource}`;
  }
  return "meta_messenger";
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
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const userId = normalizeIdValue(payload?.id);
  if (!userId) return { ok: false, status: 401, error: "Unauthorized" };
  return { ok: true, userId };
}

async function validatePortalHumanAgentAccess({ portalId, portalSecretKey, agentId, userId }) {
  if (!portalId || !portalSecretKey || !agentId || !userId) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;

  let agentRows;
  try {
    const agentParams = new URLSearchParams({
      select: "workspace_id",
      id: `eq.${agentId}`,
      limit: "1",
    });
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
  const agentRow = Array.isArray(agentRows) ? agentRows[0] : null;
  const workspaceId = normalizeIdValue(agentRow?.workspace_id);
  if (!workspaceId) return { ok: false, status: 403, error: "Unauthorized" };

  let memberRows;
  try {
    const memberParams = new URLSearchParams({
      select: "agent_id",
      workspace_id: `eq.${workspaceId}`,
      user_id: `eq.${userId}`,
      active: "eq.true",
      can_access_human_agents: "eq.true",
      limit: "1",
    });
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

async function getActiveHandoffChat({ portalId, portalSecretKey, agentId, chatSource, chatId }) {
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/human_handoff_chats`);
  url.searchParams.set(
    "select",
    "id,assigned_human_agent_user_id,status,chat_source,chat_id,agent_id"
  );
  url.searchParams.set("agent_id", `eq.${agentId}`);
  url.searchParams.set("chat_source", `eq.${chatSource}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("status", "neq.closed");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "1");

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }
  if (!response.ok) return { ok: false, status: 502, error: "Human handoff service unavailable" };
  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Human handoff service unavailable" };
  }
  const row = Array.isArray(payload) ? payload[0] : null;
  if (!row) return { ok: false, status: 404, error: "Handoff chat not found" };
  return { ok: true, chat: row };
}

async function fetchChannelConnectionForSend({ supId, supKey, agentId, chatSource, threadId }) {
  if (chatSource === "telegram") {
    const baseUrl = `https://${supId}.supabase.co/rest/v1`;
    const url = new URL(`${baseUrl}/telegram_channel_connections`);
    url.searchParams.set("select", "agent_id,bot_token,bot_id,bot_username,connected,webhook_enabled");
    url.searchParams.set("agent_id", `eq.${agentId}`);
    url.searchParams.set("limit", "1");
    let response;
    try {
      response = await fetch(url.toString(), {
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Accept: "application/json" },
      });
    } catch (_) {
      return { ok: false, status: 502, error: "Telegram channel service unavailable" };
    }
    if (!response.ok) return { ok: false, status: 502, error: "Telegram channel service unavailable" };
    const payload = await response.json().catch(() => []);
    const row = (Array.isArray(payload) ? payload : []).find(
      (item) =>
        Boolean(item?.connected) &&
        Boolean(item?.webhook_enabled) &&
        String(item?.agent_id || "").trim() === agentId
    );
    if (!row?.bot_token) return { ok: false, status: 404, error: "Telegram connection not found" };
    const thread = String(row?.bot_id || row?.bot_username || row?.agent_id || "").trim();
    if (threadId && thread && threadId !== thread) {
      return { ok: false, status: 409, error: "Telegram thread mismatch" };
    }
    return { ok: true, connection: { kind: "telegram", botToken: String(row.bot_token) } };
  }

  if (chatSource === "whatsapp") {
    const baseUrl = `https://${supId}.supabase.co/rest/v1`;
    const numbersUrl = new URL(`${baseUrl}/whatsapp_channel_numbers`);
    numbersUrl.searchParams.set("select", "agent_id,phone_number_id,connected");
    numbersUrl.searchParams.set("phone_number_id", `eq.${threadId}`);
    numbersUrl.searchParams.set("limit", "1");
    let numbersResponse;
    try {
      numbersResponse = await fetch(numbersUrl.toString(), {
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Accept: "application/json" },
      });
    } catch (_) {
      return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    }
    if (!numbersResponse.ok) return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    const numbersPayload = await numbersResponse.json().catch(() => []);
    const numberRow = (Array.isArray(numbersPayload) ? numbersPayload : []).find(
      (row) => Boolean(row?.connected) && String(row?.agent_id || "").trim() === agentId
    );
    if (!numberRow) return { ok: false, status: 404, error: "WhatsApp number not connected" };

    const connUrl = new URL(`${baseUrl}/whatsapp_channel_connections`);
    connUrl.searchParams.set("select", "agent_id,business_access_token,connected");
    connUrl.searchParams.set("agent_id", `eq.${agentId}`);
    connUrl.searchParams.set("limit", "1");
    let connResponse;
    try {
      connResponse = await fetch(connUrl.toString(), {
        headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Accept: "application/json" },
      });
    } catch (_) {
      return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    }
    if (!connResponse.ok) return { ok: false, status: 502, error: "WhatsApp channel service unavailable" };
    const connPayload = await connResponse.json().catch(() => []);
    const connRow = (Array.isArray(connPayload) ? connPayload : []).find((row) => Boolean(row?.connected));
    if (!connRow?.business_access_token) {
      return { ok: false, status: 404, error: "WhatsApp connection not found" };
    }
    return {
      ok: true,
      connection: {
        kind: "whatsapp",
        accessToken: String(connRow.business_access_token),
        phoneNumberId: String(numberRow.phone_number_id || ""),
      },
    };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/meta_channel_pages`);
  url.searchParams.set(
    "select",
    "agent_id,page_id,page_access_token,instagram_connected,messenger_connected,supports_instagram,supports_messenger"
  );
  url.searchParams.set("page_id", `eq.${threadId}`);
  url.searchParams.set("limit", "1");
  let response;
  try {
    response = await fetch(url.toString(), {
      headers: { apikey: supKey, Authorization: `Bearer ${supKey}`, Accept: "application/json" },
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Channel page service unavailable" };
  }
  if (!response.ok) return { ok: false, status: 502, error: "Channel page service unavailable" };
  const payload = await response.json().catch(() => []);
  const row = (Array.isArray(payload) ? payload : []).find((item) => {
    if (String(item?.agent_id || "").trim() !== agentId) return false;
    if (chatSource === "instagram") return Boolean(item?.instagram_connected && item?.supports_instagram);
    return Boolean(item?.messenger_connected && item?.supports_messenger);
  });
  if (!row?.page_access_token) return { ok: false, status: 404, error: "Channel page not found" };
  return { ok: true, connection: { kind: "meta", pageAccessToken: String(row.page_access_token) } };
}

async function sendMetaTextReply({ pageAccessToken, recipientId, text }) {
  const endpoint = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/messages`);
  endpoint.searchParams.set("access_token", pageAccessToken);
  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Meta send API unavailable" };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status || 502, error: body || "Meta send API error" };
  }
  return { ok: true };
}

async function sendWhatsAppTextReply({ accessToken, phoneNumberId, recipientId, text }) {
  const endpoint = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipientId,
        type: "text",
        text: { body: String(text || "") },
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "WhatsApp send API unavailable" };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status || 502, error: body || "WhatsApp send API error" };
  }
  return { ok: true };
}

async function sendTelegramTextReply({ botToken, chatId, text }) {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || ""),
        parse_mode: "Markdown",
      }),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Telegram sendMessage unavailable" };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status || 502, error: body || "Telegram sendMessage error" };
  }
  return { ok: true };
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
  const message = sanitizeOutgoingText(body.message);
  const chatSource = normalizeIdValue(body.chat_source).toLowerCase();

  const missing = [];
  if (!agentId) missing.push("agent_id");
  if (!chatId) missing.push("chat_id");
  if (!message) missing.push("message");
  if (!chatSource) missing.push("chat_source");
  if (missing.length > 0) {
    res.status(400).json({ error: "Missing required fields", missing });
    return;
  }
  if (!["messenger", "instagram", "whatsapp", "telegram"].includes(chatSource)) {
    res.status(400).json({ error: "Invalid chat_source" });
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

  const handoffChatResult = await getActiveHandoffChat({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
    chatSource,
    chatId,
  });
  if (!handoffChatResult.ok) {
    res.status(handoffChatResult.status).json({ error: handoffChatResult.error });
    return;
  }

  const handoffChat = handoffChatResult.chat;
  const assignedUserId = normalizeIdValue(handoffChat?.assigned_human_agent_user_id);
  if (!assignedUserId || assignedUserId !== authUser.userId) {
    res.status(403).json({ error: "Chat is not assigned to this human agent" });
    return;
  }

  const parsed = parseChannelChatId(chatId);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.channel !== chatSource) {
    res.status(400).json({ error: "chat_source does not match chat_id" });
    return;
  }

  const connectionResult = await fetchChannelConnectionForSend({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    chatSource,
    threadId: parsed.threadId,
  });
  if (!connectionResult.ok) {
    res.status(connectionResult.status).json({ error: connectionResult.error });
    return;
  }

  const sendResult =
    connectionResult.connection.kind === "whatsapp"
      ? await sendWhatsAppTextReply({
          accessToken: connectionResult.connection.accessToken,
          phoneNumberId: connectionResult.connection.phoneNumberId,
          recipientId: parsed.recipientId,
          text: message,
        })
      : connectionResult.connection.kind === "telegram"
        ? await sendTelegramTextReply({
            botToken: connectionResult.connection.botToken,
            chatId: parsed.recipientId,
            text: message,
          })
        : await sendMetaTextReply({
            pageAccessToken: connectionResult.connection.pageAccessToken,
            recipientId: parsed.recipientId,
            text: message,
          });
  if (!sendResult.ok) {
    res.status(sendResult.status).json({ error: sendResult.error });
    return;
  }

  const messageSource = mapChatSourceToMessageSource(chatSource);
  const saveDashboardResult = await saveHumanMessageToMessages({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    anonId: normalizeIdValue(body.anon_id) || `${chatSource}:${parsed.recipientId}`,
    chatId,
    country: normalizeIdValue(body.country) || null,
    source: messageSource,
    prompt: null,
    result: message,
  });
  if (!saveDashboardResult.ok) {
    res.status(saveDashboardResult.status).json({ error: saveDashboardResult.error });
    return;
  }

  const savePortalResult = await saveHumanMessageToPortalFeed({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
    anonId: normalizeIdValue(body.anon_id) || `${chatSource}:${parsed.recipientId}`,
    chatId,
    source: messageSource,
    senderType: "human_agent",
    assignedHumanAgentUserId: assignedUserId,
    prompt: null,
    result: message,
  });
  if (!savePortalResult.ok) {
    res.status(savePortalResult.status).json({ error: savePortalResult.error });
    return;
  }

  res.status(200).json({ ok: true, sent: true });
};

