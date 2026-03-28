async function checkChatPageAccess({ supId, supKey, agentId, password }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url =
    `${baseUrl}/chat_page_settings?select=agent_id,access_password` +
    `&agent_id=eq.${agentId}&limit=1`;

  let response;
  try {
    response = await fetch(url, {
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        Accept: "application/json",
      },
    });
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Chat page service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Chat page service unavailable",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_) {
    return {
      ok: false,
      status: 502,
      error: "Chat page service unavailable",
    };
  }

  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length === 0) {
    return { ok: false, status: 403, error: "Chat page is not enabled for this agent" };
  }

  const storedPassword =
    typeof rows[0]?.access_password === "string" ? rows[0].access_password : "";
  if (storedPassword.trim()) {
    const providedPassword = typeof password === "string" ? password : "";
    if (providedPassword !== storedPassword) {
      return { ok: false, status: 403, error: "Wrong password" };
    }
  }

  return { ok: true };
}

module.exports = {
  checkChatPageAccess,
};
