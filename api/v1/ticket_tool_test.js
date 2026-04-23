const { getAgentAllActions } = require("../../scripts/internal/getAgentAllActions");
const { createPortalTicket } = require("../../scripts/internal/ticketsPortal");

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function normalizeIdValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseAgentIdFromRequest(req) {
  const queryValue = req?.query?.agent_id;
  const bodyValue = req?.body?.agent_id;
  const value = queryValue || bodyValue;
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function getRequestCountry(headers) {
  const fromHeader =
    headers?.["x-vercel-ip-country"] ||
    headers?.["cf-ipcountry"] ||
    headers?.["x-country-code"] ||
    "";
  return String(fromHeader).trim().toUpperCase() || "UN";
}

function deriveSubjectFromIssue(issueText) {
  const issue = normalizeText(issueText);
  if (!issue) return "";
  const singleLine = issue.replace(/\s+/g, " ");
  return singleLine.length > 80 ? singleLine.slice(0, 80).trim() : singleLine;
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const startedAt = Date.now();
  const body = req.body ?? {};
  const agentId = parseAgentIdFromRequest(req);
  const anonId = normalizeIdValue(body.anon_id);
  const chatId = normalizeIdValue(body.chat_id);
  const requestCountry = getRequestCountry(req.headers);
  const issue = normalizeText(body.issue);
  const subject = normalizeText(body.subject) || deriveSubjectFromIssue(issue);
  const summary =
    normalizeText(body.summary ?? body.summery) || normalizeText(issue) || subject;
  const customerName = normalizeText(body.customer_name);
  const customerEmail = normalizeText(body.customer_email ?? body.email);
  const customerPhone = normalizeText(body.customer_phone ?? body.phone);
  const chatSource = normalizeText(body.chat_source) || "ticket_tool_test";

  if (!agentId) {
    res.status(400).json({
      ok: false,
      error: "Missing required fields",
      missing: ["agent_id (query or body)"],
    });
    return;
  }

  const toolsResult = await getAgentAllActions({
    supId: process.env.SUP_ID,
    supKey: process.env.SUP_KEY,
    agentId,
    includePortalTickets: true,
  });

  if (!toolsResult.ok) {
    res.status(toolsResult.status || 500).json({
      ok: false,
      stage: "getAgentAllActions",
      error: toolsResult.error || "Failed to fetch actions",
      diagnostics: {
        includePortalTickets: true,
        hasPortalId: Boolean(process.env.PORTAL_ID),
        hasPortalSecretKey: Boolean(process.env.PORTAL_SECRET_KEY),
        elapsed_ms: Date.now() - startedAt,
      },
    });
    return;
  }

  const ticketActionEntry = [...toolsResult.actionMap.entries()].find(
    ([, actionDef]) => actionDef?.kind === "ticket_create"
  );
  if (!ticketActionEntry) {
    res.status(400).json({
      ok: false,
      stage: "ticket_action_lookup",
      error: "Ticket tool is not available for this agent/workspace.",
      diagnostics: {
        includePortalTickets: true,
        tools_count: Array.isArray(toolsResult.tools) ? toolsResult.tools.length : 0,
        elapsed_ms: Date.now() - startedAt,
      },
    });
    return;
  }

  const [ticketToolName, ticketActionDef] = ticketActionEntry;
  const missingTicketFields = [];
  if (!subject) missingTicketFields.push("subject");
  if (!summary) missingTicketFields.push("summary");
  if (!customerName) missingTicketFields.push("customer_name");
  if (ticketActionDef.ticket_email_required === true && !customerEmail) {
    missingTicketFields.push("customer_email");
  }
  if (ticketActionDef.ticket_phone_required === true && !customerPhone) {
    missingTicketFields.push("customer_phone");
  }
  if (!customerEmail && !customerPhone) {
    missingTicketFields.push("customer_email_or_customer_phone");
  }

  const requestPayload = {
    subject: subject || null,
    summary: summary || null,
    customer_name: customerName || null,
    customer_email: customerEmail || null,
    customer_phone: customerPhone || null,
    anon_id: anonId || null,
    chat_id: chatId || null,
    chat_source: chatSource,
    country: requestCountry,
    agent_id: agentId,
  };

  if (missingTicketFields.length > 0) {
    res.status(400).json({
      ok: false,
      stage: "preflight_validation",
      error: "Missing required tool arguments",
      missing_required_fields: missingTicketFields,
      tool: {
        name: ticketToolName,
        ticket_email_required: ticketActionDef.ticket_email_required === true,
        ticket_phone_required: ticketActionDef.ticket_phone_required === true,
      },
      request_payload: requestPayload,
      diagnostics: {
        elapsed_ms: Date.now() - startedAt,
      },
    });
    return;
  }

  const ticketResult = await createPortalTicket({
    portalId: process.env.PORTAL_ID,
    portalSecretKey: process.env.PORTAL_SECRET_KEY,
    agentId,
    chatId: chatId || null,
    anonId: anonId || null,
    chatSource,
    country: requestCountry,
    subject,
    summary,
    customerName,
    customerEmail: customerEmail || null,
    customerPhone: customerPhone || null,
  });

  const responsePayload = {
    ok: ticketResult.ok,
    stage: "createPortalTicket",
    tool: {
      name: ticketToolName,
      ticket_email_required: ticketActionDef.ticket_email_required === true,
      ticket_phone_required: ticketActionDef.ticket_phone_required === true,
    },
    request_payload: requestPayload,
    ticket_result: ticketResult,
    diagnostics: {
      elapsed_ms: Date.now() - startedAt,
      hasPortalId: Boolean(process.env.PORTAL_ID),
      hasPortalSecretKey: Boolean(process.env.PORTAL_SECRET_KEY),
    },
  };

  if (!ticketResult.ok) {
    res.status(ticketResult.status || 500).json(responsePayload);
    return;
  }

  res.status(200).json(responsePayload);
};
