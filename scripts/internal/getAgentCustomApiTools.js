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

async function getAgentCustomApiTools({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/custom_api_actions?select=id,title,description,body_template&agent_id=eq.${agentId}`;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, status: 502, error: "Actions service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  const usedNames = new Set();
  const tools = rows.map((row) => {
    const name = sanitizeToolName(row?.title, row?.id, usedNames);
    const description = typeof row?.description === "string" ? row.description : "";
    const parameters = parseBodyTemplate(row?.body_template);
    return {
      type: "function",
      name,
      description,
      parameters,
    };
  });

  return { ok: true, tools };
}

module.exports = {
  getAgentCustomApiTools,
};
