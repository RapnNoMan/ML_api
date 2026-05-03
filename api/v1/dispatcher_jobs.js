const channels = require("./channels");

function authHeaders(secret, extra = {}) {
  return {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    ...extra,
  };
}

async function fetchJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function updateJob({ supId, supKey, jobId, payload }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/dispatcher_scheduled_jobs`);
  url.searchParams.set("id", `eq.${jobId}`);
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: authHeaders(supKey, {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Dispatcher job update failed" };
  return { ok: true };
}

async function claimDueJobs({ supId, supKey, limit = 5 }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/dispatcher_scheduled_jobs`);
  url.searchParams.set("select", "*");
  url.searchParams.set("status", "eq.pending");
  url.searchParams.set("run_at", `lte.${new Date().toISOString()}`);
  url.searchParams.set("order", "run_at.asc,id.asc");
  url.searchParams.set("limit", String(Math.max(1, Math.floor(Number(limit) || 5))));

  const response = await fetch(url.toString(), {
    headers: authHeaders(supKey, { Accept: "application/json" }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Dispatcher job service unavailable" };
  const rows = await fetchJson(response);
  const claimed = [];
  for (const job of Array.isArray(rows) ? rows : []) {
    const claimUrl = new URL(`${baseUrl}/dispatcher_scheduled_jobs`);
    claimUrl.searchParams.set("id", `eq.${job.id}`);
    claimUrl.searchParams.set("status", "eq.pending");
    const claimResponse = await fetch(claimUrl.toString(), {
      method: "PATCH",
      headers: authHeaders(supKey, {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      }),
      body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() }),
    });
    if (!claimResponse.ok) continue;
    const claimedRows = await fetchJson(claimResponse);
    const claimedJob = Array.isArray(claimedRows) ? claimedRows[0] : claimedRows;
    if (claimedJob?.id) claimed.push(claimedJob);
  }
  return { ok: true, jobs: claimed };
}

async function getPortalChatById({ portalId, portalSecretKey, chatId }) {
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/human_handoff_chats`);
  url.searchParams.set("select", "id,status,agent_id,assigned_human_agent_user_id,subject,summery,message_start_id,contact_id,updated_at");
  url.searchParams.set("id", `eq.${chatId}`);
  url.searchParams.set("limit", "1");
  const response = await fetch(url.toString(), {
    headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Portal chat service unavailable" };
  const rows = await fetchJson(response);
  return { ok: true, chat: Array.isArray(rows) ? rows[0] || null : null };
}

async function getRecentlyClosedPortalChat({ portalId, portalSecretKey, workspaceId, anonId, chatId, updatedAfter }) {
  if (!workspaceId || !anonId || !chatId || !updatedAfter) return { ok: true, chat: null };
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/human_handoff_chats`);
  url.searchParams.set("select", "id,status,updated_at");
  url.searchParams.set("workspace_id", `eq.${workspaceId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("status", "eq.closed");
  url.searchParams.set("updated_at", `gt.${updatedAfter}`);
  url.searchParams.set("order", "updated_at.desc,id.desc");
  url.searchParams.set("limit", "1");
  const response = await fetch(url.toString(), {
    headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Portal closed chat lookup failed" };
  const rows = await fetchJson(response);
  return { ok: true, chat: Array.isArray(rows) ? rows[0] || null : null };
}

async function getPortalCustomerMessages({ portalId, portalSecretKey, workspaceId, anonId, chatId, createdAfter }) {
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/widget_human_messages`);
  url.searchParams.set("select", "id,prompt,created_at");
  url.searchParams.set("workspace_id", `eq.${workspaceId}`);
  url.searchParams.set("annon", `eq.${anonId}`);
  url.searchParams.set("chat_id", `eq.${chatId}`);
  url.searchParams.set("sender_type", "eq.customer");
  if (createdAfter) url.searchParams.set("created_at", `gte.${createdAfter}`);
  url.searchParams.set("order", "created_at.asc,id.asc");
  url.searchParams.set("limit", "50");
  const response = await fetch(url.toString(), {
    headers: authHeaders(portalSecretKey, { Accept: "application/json" }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Portal message service unavailable" };
  const rows = await fetchJson(response);
  return { ok: true, messages: Array.isArray(rows) ? rows : [] };
}

async function markUnansweredChat({ portalId, portalSecretKey, portalChatId }) {
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/human_handoff_chats`);
  url.searchParams.set("id", `eq.${portalChatId}`);
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: authHeaders(portalSecretKey, {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify({
      status: "active",
      assigned_human_agent_user_id: null,
      shift_id: null,
      subject: "Unanswered conversation",
      summery: "Unanswered conversation. The dispatcher did not hand this chat off within one hour.",
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) return { ok: false, status: 502, error: "Portal chat update failed" };
  return { ok: true };
}

async function sendChannelReply({ connection, event, reply }) {
  if (connection?.kind === "whatsapp") {
    return channels.sendWhatsAppTextReply({
      accessToken: connection.access_token,
      phoneNumberId: connection.phone_number_id,
      recipientId: event.senderId,
      text: reply,
    });
  }
  if (connection?.kind === "telegram") {
    return channels.sendTelegramTextReply({
      botToken: connection.bot_token,
      chatId: event.recipientId,
      text: reply,
    });
  }
  return channels.sendMetaTextReply({
    pageAccessToken: connection.access_token,
    recipientId: event.senderId,
    text: reply,
  });
}

function isAlreadyHandedOff(chat) {
  if (!chat) return true;
  if (String(chat.status || "") === "closed") return true;
  if (chat.assigned_human_agent_user_id) return true;
  if (chat.agent_id) return true;
  if (chat.message_start_id !== null && chat.message_start_id !== undefined) return true;
  if (chat.contact_id !== null && chat.contact_id !== undefined) return true;
  const summery = String(chat.summery || "").trim();
  return Boolean(summery && summery !== "Incoming channel conversation.");
}

async function processInitialJob(job) {
  const chatResult = await getPortalChatById({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    chatId: job.portal_chat_id,
  });
  if (!chatResult.ok) return chatResult;
  if (isAlreadyHandedOff(chatResult.chat)) return { ok: true, skipped: true };

  const messagesResult = await getPortalCustomerMessages({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    workspaceId: job.workspace_id,
    anonId: job.annon,
    chatId: job.chat_id,
    createdAfter: job.created_at,
  });
  if (!messagesResult.ok) return messagesResult;
  const customerMessages = messagesResult.messages
    .map((message) => String(message?.prompt || "").trim())
    .filter(Boolean);
  if (customerMessages.length === 0) return { ok: true, skipped: true };
  const latestMessageId = messagesResult.messages[messagesResult.messages.length - 1]?.id ?? job.portal_customer_message_id ?? null;

  const event = {
    ...(job.raw_event && typeof job.raw_event === "object" ? job.raw_event : {}),
    text: customerMessages.join("\n"),
  };
  const connection = job.raw_connection && typeof job.raw_connection === "object" ? job.raw_connection : {};
  const handled = await channels.processIncomingMessage({
    event,
    connection,
    headers: {},
    skipDispatcherInitialDelay: true,
    skipPortalCustomerLog: true,
    scheduledPortalCustomerMessageId: latestMessageId,
  });
  if (!handled.ok) return handled;
  if (!handled.reply) return { ok: true, skipped: true };
  const sendResult = await sendChannelReply({ connection, event, reply: handled.reply });
  if (!sendResult.ok) return sendResult;
  return { ok: true, sent: true };
}

async function processUnansweredJob(job) {
  const chatResult = await getPortalChatById({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    chatId: job.portal_chat_id,
  });
  if (!chatResult.ok) return chatResult;
  const chat = chatResult.chat;
  if (!chat || String(chat.status || "") === "closed" || chat.assigned_human_agent_user_id || chat.agent_id || isAlreadyHandedOff(chat)) {
    return { ok: true, skipped: true };
  }

  const closedChatResult = await getRecentlyClosedPortalChat({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    workspaceId: job.workspace_id,
    anonId: job.annon,
    chatId: job.chat_id,
    updatedAfter: job.created_at,
  });
  if (!closedChatResult.ok) return closedChatResult;
  if (closedChatResult.chat) return { ok: true, skipped: true };

  const messagesResult = await getPortalCustomerMessages({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    workspaceId: job.workspace_id,
    anonId: job.annon,
    chatId: job.chat_id,
    createdAfter: job.created_at,
  });
  if (!messagesResult.ok) return messagesResult;
  const latestMessageId = messagesResult.messages[messagesResult.messages.length - 1]?.id ?? null;
  if (String(latestMessageId || "") !== String(job.portal_customer_message_id || "")) {
    return { ok: true, skipped: true };
  }
  return markUnansweredChat({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    portalChatId: job.portal_chat_id,
  });
}

module.exports = async function handler(req, res) {
  const authHeader = String(req?.headers?.authorization || "");
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  if (!process.env.CRON_SECRET || authHeader !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const claimed = await claimDueJobs({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    limit: 5,
  });
  if (!claimed.ok) {
    res.status(claimed.status || 502).json({ error: claimed.error });
    return;
  }

  const results = [];
  for (const job of claimed.jobs) {
    const result = job.job_type === "initial_dispatcher_reply"
      ? await processInitialJob(job)
      : await processUnansweredJob(job);
    if (result.ok) {
      await updateJob({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        jobId: job.id,
        payload: { status: "done", error: null },
      });
    } else {
      await updateJob({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        jobId: job.id,
        payload: { status: "failed", error: String(result.error || "Job failed").slice(0, 1000) },
      });
    }
    results.push({ id: job.id, type: job.job_type, ok: Boolean(result.ok), skipped: Boolean(result.skipped), sent: Boolean(result.sent) });
  }

  res.status(200).json({ ok: true, processed: results.length, results });
};
