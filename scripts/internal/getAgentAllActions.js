function sanitizeToolName(rawName, id, usedNames) {
  let name = String(rawName || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!name) name = `action_${id}`;
  if (/^[0-9]/.test(name)) name = `action_${name}`;

  if (name.length > 64) name = name.slice(0, 64);

  if (usedNames.has(name)) {
    const suffix = `_${id}`;
    const base = name.slice(0, Math.max(1, 64 - suffix.length));
    name = `${base}${suffix}`;
  }

  usedNames.add(name);
  return name;
}

function parseBodyTemplate(bodyTemplate) {
  if (!bodyTemplate) {
    return { type: "object", properties: {}, additionalProperties: false };
  }

  if (typeof bodyTemplate === "object") {
    return bodyTemplate;
  }

  try {
    const parsed = JSON.parse(bodyTemplate);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) {}

  return { type: "object", properties: {}, additionalProperties: false };
}

async function fetchTable({ supId, supKey, agentId, table, fields }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/${table}?select=${fields}&agent_id=eq.${agentId}`;

  const response = await fetch(url, {
    headers: {
      apikey: supKey,
      Authorization: `Bearer ${supKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  const payload = await response.json();
  return { ok: true, rows: Array.isArray(payload) ? payload : [] };
}

async function getAgentAllActions({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  let customRows = [];
  let zapierRows = [];
  let makeRows = [];
  let slackRows = [];
  let gmailActionsRows = [];
  let gmailConnectionsRows = [];

  try {
    const custom = await fetchTable({
      supId,
      supKey,
      agentId,
      table: "custom_api_actions",
      fields: "id,title,description,url,method,headers,body_template",
    });
    if (!custom.ok) return custom;
    customRows = custom.rows;

    const zapier = await fetchTable({
      supId,
      supKey,
      agentId,
      table: "zapier_actions",
      fields: "id,title,description,url,headers,body_template",
    });
    if (!zapier.ok) return zapier;
    zapierRows = zapier.rows;

    const make = await fetchTable({
      supId,
      supKey,
      agentId,
      table: "make_actions",
      fields: "id,title,description,url,headers,body_template",
    });
    if (!make.ok) return make;
    makeRows = make.rows;

    const slack = await fetchTable({
      supId,
      supKey,
      agentId,
      table: "slack_notifications",
      fields: "id,title,description,webhook_url,username",
    });
    if (!slack.ok) return slack;
    slackRows = slack.rows;

    const gmailActions = await fetchTable({
      supId,
      supKey,
      agentId,
      table: "google_gmail_actions",
      fields: "id,agent_id,send_email",
    });
    if (!gmailActions.ok) return gmailActions;
    gmailActionsRows = gmailActions.rows;

    const gmailConnections = await fetchTable({
      supId,
      supKey,
      agentId,
      table: "google_gmail_connections",
      fields: "id,agent_id,access_token,refresh_token,token_type,expires_at",
    });
    if (!gmailConnections.ok) return gmailConnections;
    gmailConnectionsRows = gmailConnections.rows;
  } catch (error) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  const usedNames = new Set();
  const tools = [];
  const actionMap = new Map();

  const addRows = (rows, defaults = {}) => {
    for (const row of rows) {
      const toolName = sanitizeToolName(row?.title, row?.id, usedNames);
      const description = typeof row?.description === "string" ? row.description : "";
      const parameters =
        defaults.parameters ?? parseBodyTemplate(row?.body_template);

      tools.push({
        type: "function",
        name: toolName,
        description,
        parameters,
      });

      actionMap.set(toolName, {
        tool_name: toolName,
        id: row?.id ?? null,
        title: row?.title ?? "",
        description,
        url: row?.url ?? row?.webhook_url ?? "",
        method: String(row?.method || defaults.method || "POST").toUpperCase(),
        headers: row?.headers ?? {},
        body_template: row?.body_template ?? null,
        kind: defaults.kind ?? "custom",
        username: row?.username ?? null,
      });
    }
  };

  addRows(customRows, { kind: "custom" });
  addRows(zapierRows, { kind: "zapier", method: "POST" });
  addRows(makeRows, { kind: "make", method: "POST" });
  addRows(slackRows, {
    kind: "slack",
    method: "POST",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
  });

  const gmailAction = gmailActionsRows.find((row) => row?.send_email === true);
  const gmailConnection = gmailConnectionsRows.find((row) => row?.agent_id === agentId);
  if (gmailAction && gmailConnection) {
    const toolName = sanitizeToolName("send_gmail_email", gmailAction.id, usedNames);
    tools.push({
      type: "function",
      name: toolName,
      description: "Send an email via Gmail.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          cc: { type: "string" },
          bcc: { type: "string" },
        },
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
    });

    actionMap.set(toolName, {
      tool_name: toolName,
      id: gmailAction.id ?? null,
      title: "Send Gmail Email",
      description: "Send an email via Gmail.",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      method: "POST",
      headers: {},
      body_template: null,
      kind: "gmail_send",
      username: null,
      gmail_connection: {
        access_token: gmailConnection.access_token,
        refresh_token: gmailConnection.refresh_token,
        token_type: gmailConnection.token_type || "Bearer",
        expires_at: gmailConnection.expires_at,
      },
    });
  }

  return { ok: true, tools, actionMap };
}

module.exports = {
  getAgentAllActions,
};
