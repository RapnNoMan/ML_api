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

async function getAgentCustomApiActionMap({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/custom_api_actions?select=id,title,description,url,method,headers,body_template&agent_id=eq.${agentId}`;

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
  const actionMap = new Map();

  for (const row of rows) {
    const toolName = sanitizeToolName(row?.title, row?.id, usedNames);
    actionMap.set(toolName, {
      tool_name: toolName,
      id: row?.id ?? null,
      title: row?.title ?? "",
      description: row?.description ?? "",
      url: row?.url ?? "",
      method: String(row?.method || "POST").toUpperCase(),
      headers: row?.headers ?? {},
      body_template: row?.body_template ?? null,
    });
  }

  return { ok: true, actionMap };
}

module.exports = {
  getAgentCustomApiActionMap,
};
