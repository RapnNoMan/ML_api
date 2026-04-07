function getServiceHeaders(supKey) {
  return {
    apikey: supKey,
    Authorization: `Bearer ${supKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function fetchWorkspaceIdByAgent({ baseUrl, supKey, agentId }) {
  const params = new URLSearchParams({
    select: "workspace_id",
    id: `eq.${agentId}`,
    limit: "1",
  });
  const response = await fetch(`${baseUrl}/agents?${params.toString()}`, {
    method: "GET",
    headers: getServiceHeaders(supKey),
  });
  if (!response.ok) return { ok: false };

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false };
  }

  const agent = Array.isArray(payload) ? payload[0] : payload;
  const workspaceId = String(agent?.workspace_id || "").trim();
  if (!workspaceId) return { ok: false };
  return { ok: true, workspaceId };
}

async function consumeOneExtraCreditByWorkspaceId({ baseUrl, supKey, workspaceId }) {
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const pickParams = new URLSearchParams({
      select: "id,credits",
      workspace_id: `eq.${workspaceId}`,
      credits: "gt.0",
      order: "created_at.asc,id.asc",
      limit: "1",
    });
    const pickResponse = await fetch(`${baseUrl}/extra_messages?${pickParams.toString()}`, {
      method: "GET",
      headers: getServiceHeaders(supKey),
    });
    if (!pickResponse.ok) return { ok: false, reason: "service_error" };

    let pickPayload;
    try {
      pickPayload = await pickResponse.json();
    } catch (error) {
      return { ok: false, reason: "service_error" };
    }

    const row = Array.isArray(pickPayload) ? pickPayload[0] : null;
    const id = Number(row?.id);
    const credits = Number(row?.credits);

    if (!Number.isFinite(id) || !Number.isFinite(credits) || credits <= 0) {
      return { ok: false, reason: "no_credits" };
    }

    const updateParams = new URLSearchParams({
      id: `eq.${Math.floor(id)}`,
      credits: `eq.${Math.floor(credits)}`,
      select: "id",
    });
    const updateResponse = await fetch(`${baseUrl}/extra_messages?${updateParams.toString()}`, {
      method: "PATCH",
      headers: {
        ...getServiceHeaders(supKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({ credits: Math.floor(credits) - 1 }),
    });
    if (!updateResponse.ok) return { ok: false, reason: "service_error" };

    let updatePayload;
    try {
      updatePayload = await updateResponse.json();
    } catch (error) {
      return { ok: false, reason: "service_error" };
    }

    const updatedRows = Array.isArray(updatePayload) ? updatePayload : [];
    if (updatedRows.length > 0) {
      const updatedRow = updatedRows[0];
      const updatedId = Number(updatedRow?.id);
      if (Number.isFinite(updatedId) && updatedId > 0) {
        return { ok: true, rowId: Math.floor(updatedId) };
      }
      return { ok: true, rowId: Math.floor(id) };
    }
  }

  return { ok: false, reason: "conflict" };
}

async function consumeOneExtraCredit({ baseUrl, supKey, agentId }) {
  const workspace = await fetchWorkspaceIdByAgent({ baseUrl, supKey, agentId });
  if (!workspace.ok) return { ok: false, reason: "service_error" };

  const consumed = await consumeOneExtraCreditByWorkspaceId({
    baseUrl,
    supKey,
    workspaceId: workspace.workspaceId,
  });

  return consumed;
}

async function refundExtraMessageCredit({ supId, supKey, rowId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const numericRowId = Number(rowId);
  if (!Number.isFinite(numericRowId) || numericRowId <= 0) {
    return { ok: false, status: 400, error: "Invalid extra credit row id" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const safeRowId = Math.floor(numericRowId);
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let selectResponse;
    try {
      const selectParams = new URLSearchParams({
        select: "id,credits",
        id: `eq.${safeRowId}`,
        limit: "1",
      });
      selectResponse = await fetch(`${baseUrl}/extra_messages?${selectParams.toString()}`, {
        method: "GET",
        headers: getServiceHeaders(supKey),
      });
    } catch (error) {
      return { ok: false, status: 502, error: "Usage service unavailable" };
    }

    if (!selectResponse.ok) {
      return { ok: false, status: 502, error: "Usage service unavailable" };
    }

    let selectedRows;
    try {
      selectedRows = await selectResponse.json();
    } catch (error) {
      return { ok: false, status: 502, error: "Usage service unavailable" };
    }

    const row = Array.isArray(selectedRows) ? selectedRows[0] : null;
    const currentCredits = Number(row?.credits);
    if (!row || !Number.isFinite(currentCredits)) {
      return { ok: false, status: 502, error: "Usage service unavailable" };
    }

    let updateResponse;
    try {
      const updateParams = new URLSearchParams({
        id: `eq.${safeRowId}`,
        credits: `eq.${Math.floor(currentCredits)}`,
        select: "id",
      });
      updateResponse = await fetch(`${baseUrl}/extra_messages?${updateParams.toString()}`, {
        method: "PATCH",
        headers: {
          ...getServiceHeaders(supKey),
          Prefer: "return=representation",
        },
        body: JSON.stringify({ credits: Math.floor(currentCredits) + 1 }),
      });
    } catch (error) {
      return { ok: false, status: 502, error: "Usage service unavailable" };
    }

    if (!updateResponse.ok) {
      return { ok: false, status: 502, error: "Usage service unavailable" };
    }

    let updatedRows;
    try {
      updatedRows = await updateResponse.json();
    } catch (error) {
      return { ok: false, status: 502, error: "Usage service unavailable" };
    }

    if (Array.isArray(updatedRows) && updatedRows.length > 0) {
      return { ok: true };
    }
  }

  return { ok: false, status: 502, error: "Usage service unavailable" };
}

async function checkMessageCap({ supId, supKey, agentId }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const baseUrl = `https://${supId}.supabase.co/rest/v1`;

  let response;
  try {
    response = await fetch(`${baseUrl}/rpc/get_message_usage_service`, {
      method: "POST",
      headers: getServiceHeaders(supKey),
      body: JSON.stringify({ p_agent_id: agentId }),
    });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Usage service unavailable",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      error: "Usage service unavailable",
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: "Usage service unavailable",
    };
  }

  const usage = Array.isArray(payload) ? payload[0] : payload;
  const messages = Number(usage?.messages);
  const cap = Number(usage?.cap);
  const extraCredits = Number(usage?.extra_credits);

  if (Number.isFinite(cap) && Number.isFinite(messages) && messages >= cap) {
    if (Number.isFinite(extraCredits) && extraCredits > 0) {
      try {
        const consumeResult = await consumeOneExtraCredit({
          baseUrl,
          supKey,
          agentId,
        });

        if (consumeResult.ok) {
          return {
            ok: true,
            extraCreditUsed: true,
            extraCreditRowId: consumeResult.rowId ?? null,
          };
        }
        if (consumeResult.reason === "no_credits") {
          return { ok: false, status: 429, error: "Message limit reached" };
        }
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: "Usage service unavailable",
        };
      }

      return {
        ok: false,
        status: 502,
        error: "Usage service unavailable",
      };
    }
    return { ok: false, status: 429, error: "Message limit reached" };
  }

  return { ok: true };
}

module.exports = {
  checkMessageCap,
  refundExtraMessageCredit,
};
