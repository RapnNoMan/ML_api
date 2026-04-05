const { checkMessageCap } = require("../../scripts/internal/checkMessageCap");
const { SKIP_VECTOR_MESSAGES } = require("../../scripts/internal/skipVectorMessages");
const { getAgentInfo } = require("../../scripts/internal/getAgentInfo");
const { getChatHistory } = require("../../scripts/internal/getChatHistory");
const { getRelevantKnowledgeChunks } = require("../../scripts/internal/getRelevantKnowledgeChunks");
const { saveMessage } = require("../../scripts/internal/saveMessage");

const XAI_RESPONSES_API_URL = "https://api.x.ai/v1/responses";
const PRIMARY_MODEL = process.env.XAI_PRIMARY_MODEL || "grok-4.1-fast-non-reasoning";
const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";

function toOpenAiInputItems(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const text = String(message?.content ?? "");
    return {
      type: "message",
      role,
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        },
      ],
    };
  });
}

function extractResponseText(payload) {
  if (!payload) return "";
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (
        (part?.type === "output_text" || part?.type === "text") &&
        typeof part?.text === "string" &&
        part.text.trim()
      ) {
        return part.text;
      }
    }
  }

  return "";
}

async function getXAiChatCompletion({ apiKey, model, instructions, messages }) {
  if (!apiKey) return { ok: false, status: 500, error: "Server configuration error" };

  const requestBody = {
    model,
    instructions: String(instructions || ""),
    input: toOpenAiInputItems(messages),
    text: { verbosity: "low" },
  };

  let response;
  try {
    response = await fetch(XAI_RESPONSES_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Network error calling xAI" };
  }

  if (!response.ok) {
    let errText = "";
    try {
      errText = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: errText || "xAI request failed",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Invalid JSON from xAI" };
  }

  const rawText = extractResponseText(payload);
  if (!rawText) return { ok: false, status: 502, error: "Empty model output" };

  return {
    ok: true,
    data: { reply: rawText },
    usage: payload?.usage ?? null,
  };
}

function normalizeIncomingMessage(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^[\s"'`.,!?(){}\[\]<>-]+|[\s"'`.,!?(){}\[\]<>-]+$/g, "")
    .replace(/\s+/g, " ");
}

function toWebhookEvents(payload) {
  const objectType = String(payload?.object || "").toLowerCase();
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const events = [];

  for (const entry of entries) {
    const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
    const entryId = String(entry?.id || "").trim();
    const field = String(entry?.changes?.[0]?.field || "messaging").trim();

    for (const item of messaging) {
      const isEcho = Boolean(item?.message?.is_echo);
      const text = typeof item?.message?.text === "string" ? item.message.text.trim() : "";
      const hasAttachment =
        Array.isArray(item?.message?.attachments) && item.message.attachments.length > 0;
      if (!item?.message || isEcho || (!text && !hasAttachment)) continue;

      const senderId = String(item?.sender?.id || "").trim();
      if (!senderId) continue;

      events.push({
        eventId: String(item?.message?.mid || item?.timestamp || "").trim(),
        object: objectType,
        field,
        channel: objectType === "instagram" ? "instagram" : "messenger",
        lookupId: entryId || String(item?.recipient?.id || "").trim(),
        senderId,
        recipientId: String(item?.recipient?.id || "").trim(),
        messageId: String(item?.message?.mid || "").trim(),
        text: text || "[User sent an attachment]",
        rawItem: item,
      });
    }
  }

  return events;
}

async function insertMetaWebhookDebugMessage({ supId, supKey, event, raw }) {
  if (!supId || !supKey) return;

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/meta_webhook_debug_messages`;
  const payload = {
    object: String(event?.object || ""),
    field: String(event?.field || ""),
    entry_id: String(event?.lookupId || ""),
    sender_id: String(event?.senderId || ""),
    recipient_id: String(event?.recipientId || ""),
    message_id: String(event?.messageId || event?.eventId || ""),
    message_text: String(event?.text || ""),
    raw: raw && typeof raw === "object" ? raw : { note: String(raw || "") },
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
  } catch (_) {}
}

async function fetchChannelPage({ supId, supKey, channel, lookupId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }
  if (!lookupId) {
    return { ok: false, status: 404, error: "Channel page not found" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = new URL(`${baseUrl}/meta_channel_pages`);
  url.searchParams.set(
    "select",
    "agent_id,page_id,page_access_token,instagram_business_account_id,instagram_connected,messenger_connected,supports_instagram,supports_messenger"
  );

  if (channel === "instagram") {
    url.searchParams.set(
      "or",
      `(instagram_business_account_id.eq.${lookupId},page_id.eq.${lookupId})`
    );
  } else {
    url.searchParams.set("page_id", `eq.${lookupId}`);
  }
  url.searchParams.set("limit", "5");

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch (_) {
    return { ok: false, status: 502, error: "Channel page service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Channel page service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return { ok: false, status: 502, error: "Channel page service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  const row = rows.find((item) => {
    if (channel === "instagram") {
      return Boolean(item?.instagram_connected) && Boolean(item?.supports_instagram);
    }
    return Boolean(item?.messenger_connected) && Boolean(item?.supports_messenger);
  });

  if (!row) return { ok: false, status: 404, error: "Channel page not found" };
  if (!row?.agent_id) return { ok: false, status: 404, error: "Agent not found" };
  if (!row?.page_access_token) return { ok: false, status: 400, error: "Missing page access token" };

  return {
    ok: true,
    page: {
      agent_id: row.agent_id,
      page_id: String(row.page_id || ""),
      page_access_token: String(row.page_access_token || ""),
    },
  };
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
    let body = "";
    try {
      body = await response.text();
    } catch (_) {}
    return {
      ok: false,
      status: response.status || 502,
      error: body || "Meta send API error",
    };
  }

  return { ok: true };
}

async function handleIncomingMessage({ supId, supKey, event, page }) {
  const agentId = page.agent_id;
  const anonId = `${event.channel}:${event.senderId}`;
  const chatId = `${event.channel}:${page.page_id}:${event.senderId}`;

  const normalizedMessage = normalizeIncomingMessage(event.text);

  const usageCheckPromise = checkMessageCap({
    supId,
    supKey,
    agentId,
  });

  const historyPromise = getChatHistory({
    supId,
    supKey,
    agentId,
    anonId,
    chatId,
    maxRows: 3,
  });

  const ragPromise =
    normalizedMessage && !SKIP_VECTOR_MESSAGES.has(normalizedMessage)
      ? getRelevantKnowledgeChunks({
          supId,
          supKey,
          voyageApiKey: process.env.VOYAGE_API_KEY,
          outputDimension: process.env.VOYAGE_OUTPUT_DIMENSION,
          agentId,
          anonId,
          chatId,
          message: event.text,
        })
      : Promise.resolve({ ok: true, chunks: [] });

  const agentInfoPromise = getAgentInfo({
    supId,
    supKey,
    agentId,
  });

  const [usageCheck, historyResult, vectorResult, agentInfo] = await Promise.all([
    usageCheckPromise,
    historyPromise,
    ragPromise,
    agentInfoPromise,
  ]);

  if (!usageCheck.ok) return { ok: false, status: usageCheck.status, error: usageCheck.error };
  if (!historyResult.ok) return { ok: false, status: historyResult.status, error: historyResult.error };
  if (!vectorResult.ok) return { ok: false, status: vectorResult.status, error: vectorResult.error };
  if (!agentInfo.ok) return { ok: false, status: agentInfo.status, error: agentInfo.error };

  const promptSections = [];
  if (typeof agentInfo.role === "string" && agentInfo.role.trim()) {
    promptSections.push(agentInfo.role.trim());
  }
  promptSections.push(
    [
      "SYSTEM RULES",
      "Reply in plain text suitable for messaging apps.",
      "Do not claim capabilities you cannot execute.",
    ].join("\n")
  );
  promptSections.push(["CURRENT DATE", new Date().toISOString()].join("\n"));
  if (Array.isArray(vectorResult.chunks) && vectorResult.chunks.length > 0) {
    promptSections.push(["KNOWLEDGE CHUNKS", ...vectorResult.chunks].join("\n"));
  }

  const messages = [
    ...(Array.isArray(historyResult.messages) ? historyResult.messages : []),
    { role: "user", content: String(event.text || "") },
  ];

  const completion = await getXAiChatCompletion({
    apiKey: process.env.XAI_API_KEY,
    model: PRIMARY_MODEL,
    instructions: promptSections.join("\n\n"),
    messages,
  });
  if (!completion.ok) return { ok: false, status: completion.status, error: completion.error };

  const reply = completion.data?.reply ?? "";
  if (!reply) return { ok: false, status: 502, error: "Empty model output" };

  const saveResult = await saveMessage({
    supId,
    supKey,
    agentId,
    workspaceId: agentInfo.workspace_id,
    anonId,
    chatId,
    country: null,
    prompt: String(event.text || ""),
    result: reply,
    source: `meta_${event.channel}`,
    action: false,
  });
  if (!saveResult.ok) return { ok: false, status: saveResult.status, error: saveResult.error };

  return { ok: true, reply };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const mode = String(req.query["hub.mode"] || "");
      const token = String(req.query["hub.verify_token"] || "");
      const challenge = req.query["hub.challenge"];
      const expectedToken = String(process.env.META_WEBHOOK_VERIFY_TOKEN || "");

      if (mode === "subscribe" && expectedToken && token === expectedToken) {
        res.status(200).send(String(challenge || ""));
        return;
      }

      res.status(403).json({ error: "Invalid verify token" });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const payload = req.body ?? {};
    const events = toWebhookEvents(payload);
    if (events.length === 0) {
      res.status(200).json({ ok: true, processed: 0 });
      return;
    }

    const pageCache = new Map();
    const processedEventIds = new Set();
    let processedCount = 0;

    for (const event of events) {
      if (event.eventId && processedEventIds.has(event.eventId)) continue;
      if (event.eventId) processedEventIds.add(event.eventId);

      await insertMetaWebhookDebugMessage({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        event,
        raw: {
          stage: "received",
          channel: event.channel,
          lookup_id: event.lookupId,
          webhook_object: payload?.object ?? null,
          raw_item: event.rawItem ?? null,
        },
      });

      const cacheKey = `${event.channel}:${event.lookupId}`;
      let pageResult = pageCache.get(cacheKey);
      if (!pageResult) {
        pageResult = await fetchChannelPage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          channel: event.channel,
          lookupId: event.lookupId,
        });
        pageCache.set(cacheKey, pageResult);
      }
      if (!pageResult?.ok) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "page_lookup_failed",
            channel: event.channel,
            lookup_id: event.lookupId,
            status: pageResult?.status ?? null,
            error: pageResult?.error ?? "Unknown page lookup error",
          },
        });
        continue;
      }

      await insertMetaWebhookDebugMessage({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        event,
        raw: {
          stage: "page_lookup_ok",
          channel: event.channel,
          lookup_id: event.lookupId,
          agent_id: pageResult.page?.agent_id ?? null,
          page_id: pageResult.page?.page_id ?? null,
        },
      });

      const handled = await handleIncomingMessage({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        event,
        page: pageResult.page,
      });
      if (!handled.ok) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "handle_failed",
            channel: event.channel,
            status: handled?.status ?? null,
            error: handled?.error ?? "Unknown processing error",
          },
        });
        continue;
      }

      await insertMetaWebhookDebugMessage({
        supId: process.env.SUP_ID,
        supKey: process.env.SUP_KEY,
        event,
        raw: {
          stage: "reply_generated",
          channel: event.channel,
          reply: handled.reply ?? "",
        },
      });

      const sendResult = await sendMetaTextReply({
        pageAccessToken: pageResult.page.page_access_token,
        recipientId: event.senderId,
        text: handled.reply,
      });
      if (sendResult.ok) {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "send_ok",
            channel: event.channel,
            recipient_id: event.senderId,
          },
        });
        processedCount += 1;
      } else {
        await insertMetaWebhookDebugMessage({
          supId: process.env.SUP_ID,
          supKey: process.env.SUP_KEY,
          event,
          raw: {
            stage: "send_failed",
            channel: event.channel,
            recipient_id: event.senderId,
            status: sendResult?.status ?? null,
            error: sendResult?.error ?? "Unknown send error",
          },
        });
      }
    }

    res.status(200).json({ ok: true, processed: processedCount });
  } catch (error) {
    await insertMetaWebhookDebugMessage({
      supId: process.env.SUP_ID,
      supKey: process.env.SUP_KEY,
      event: {
        object: String(req?.body?.object || ""),
        field: "",
        lookupId: "",
        senderId: "",
        recipientId: "",
        messageId: "",
        text: "",
      },
      raw: {
        stage: "handler_exception",
        error: String(error?.message || error || "Unknown error"),
        request_body: req?.body ?? null,
      },
    });
    res.status(200).json({
      ok: true,
      processed: 0,
      error: String(error?.message || error || "Unknown error"),
    });
  }
};
