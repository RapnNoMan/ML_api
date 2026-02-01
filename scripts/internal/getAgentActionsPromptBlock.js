async function getAgentActionsPromptBlock({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;

  let response;
  try {
    response = await fetch(`${baseUrl}/rpc/get_agent_actions_prompt_block`, {
      method: "POST",
      headers: {
        apikey: supKey,
        Authorization: `Bearer ${supKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        p_agent_id: agentId,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Actions service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Actions service unavailable",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Actions service unavailable",
    };
  }

  const actions = Array.isArray(payload) ? payload[0] : payload;

  return {
    ok: true,
    actions: actions?.actions ?? [],
  };
}

module.exports = {
  getAgentActionsPromptBlock,
};
