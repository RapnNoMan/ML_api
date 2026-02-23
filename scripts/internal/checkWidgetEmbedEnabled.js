async function checkWidgetEmbedEnabled({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/widget_embed?select=id&agent_id=eq.${agentId}&limit=1`;

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
    return {
      ok: false,
      status: 502,
      error: "Widget service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Widget service unavailable",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Widget service unavailable",
    };
  }

  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length === 0) {
    return { ok: false, status: 403, error: "Widget is not enabled for this agent" };
  }

  return { ok: true };
}

module.exports = {
  checkWidgetEmbedEnabled,
};
