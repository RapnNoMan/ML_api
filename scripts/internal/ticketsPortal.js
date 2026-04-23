function toNonEmptyText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function parseTicketCodeNumber(ticketCode) {
  const match = /^TK-(\d+)$/i.exec(String(ticketCode || "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

async function fetchLatestTicketForChatAnon({
  portalId,
  portalSecretKey,
  agentId,
  chatId,
  anonId,
}) {
  const cleanChatId = toNonEmptyText(chatId);
  const cleanAnonId = toNonEmptyText(anonId);
  if (!cleanChatId || !cleanAnonId) {
    return { ok: true, ticket: null };
  }

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const endpoint = new URL(`${baseUrl}/tickets`);
  endpoint.searchParams.set("select", "id,ticket_code,created_at,status");
  endpoint.searchParams.set("agent_id", `eq.${agentId}`);
  endpoint.searchParams.set("chat_id", `eq.${cleanChatId}`);
  endpoint.searchParams.set("anon_id", `eq.${cleanAnonId}`);
  endpoint.searchParams.set("order", "created_at.desc");
  endpoint.searchParams.set("limit", "1");

  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  return { ok: true, ticket: rows[0] || null };
}

async function fetchRecentTicketsForAnon({
  portalId,
  portalSecretKey,
  agentId,
  anonId,
  sinceIso,
  limit = 2,
}) {
  const cleanAnonId = toNonEmptyText(anonId);
  if (!cleanAnonId) return { ok: true, rows: [] };

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const endpoint = new URL(`${baseUrl}/tickets`);
  endpoint.searchParams.set("select", "id,created_at");
  endpoint.searchParams.set("agent_id", `eq.${agentId}`);
  endpoint.searchParams.set("anon_id", `eq.${cleanAnonId}`);
  endpoint.searchParams.set("created_at", `gte.${sinceIso}`);
  endpoint.searchParams.set("order", "created_at.desc");
  endpoint.searchParams.set("limit", String(Math.max(1, Number(limit) || 2)));

  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  return { ok: true, rows: Array.isArray(payload) ? payload : [] };
}

async function fetchNextTicketCode({ portalId, portalSecretKey, agentId }) {
  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const endpoint = new URL(`${baseUrl}/tickets`);
  endpoint.searchParams.set("select", "ticket_code");
  endpoint.searchParams.set("agent_id", `eq.${agentId}`);
  endpoint.searchParams.set("order", "created_at.desc");
  endpoint.searchParams.set("limit", "100");

  let response;
  try {
    response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        apikey: portalSecretKey,
        Authorization: `Bearer ${portalSecretKey}`,
        Accept: "application/json",
      },
    });
  } catch {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  if (!response.ok) {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, status: 502, error: "Tickets service unavailable" };
  }

  const rows = Array.isArray(payload) ? payload : [];
  let maxCode = 1000;
  for (const row of rows) {
    const value = parseTicketCodeNumber(row?.ticket_code);
    if (value !== null && value > maxCode) maxCode = value;
  }

  return { ok: true, ticketCode: `TK-${maxCode + 1}` };
}

async function createPortalTicket({
  portalId,
  portalSecretKey,
  agentId,
  chatId,
  anonId,
  chatSource,
  country,
  subject,
  summary,
  customerName,
  customerEmail,
  customerPhone,
}) {
  if (!portalId || !portalSecretKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  const cleanSubject = toNonEmptyText(subject);
  const cleanSummary = toNonEmptyText(summary) || "";
  const cleanCustomerName = toNonEmptyText(customerName);
  const cleanCustomerEmail = toNonEmptyText(customerEmail);
  const cleanCustomerPhone = toNonEmptyText(customerPhone);
  const cleanAnonId = toNonEmptyText(anonId);
  const cleanChatId = toNonEmptyText(chatId);
  const cleanChatSource = toNonEmptyText(chatSource) || "api";
  const cleanCountry = toNonEmptyText(country) || "UN";

  if (!cleanSubject || !cleanCustomerName) {
    return { ok: false, status: 400, error: "Missing required ticket fields" };
  }

  if (!cleanCustomerEmail && !cleanCustomerPhone) {
    return {
      ok: false,
      status: 400,
      error: "At least one contact method is required",
    };
  }

  const baseUrl = `https://${portalId}.supabase.co/rest/v1`;
  const endpoint = `${baseUrl}/tickets`;

  const latestTicketResult = await fetchLatestTicketForChatAnon({
    portalId,
    portalSecretKey,
    agentId,
    chatId: cleanChatId,
    anonId: cleanAnonId,
  });
  if (!latestTicketResult.ok) return latestTicketResult;

  const latestTicket = latestTicketResult.ticket;
  if (latestTicket) {
    const createdAtMs = Date.parse(String(latestTicket.created_at || ""));
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs < twelveHoursMs) {
      return {
        ok: false,
        status: 409,
        error: "A ticket has already been created.",
        details: {
          ticket_id: latestTicket.id ?? null,
          ticket_code: latestTicket.ticket_code ?? null,
          created_at: latestTicket.created_at ?? null,
          status: latestTicket.status ?? null,
        },
      };
    }
  }

  const anonWindowSinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentAnonTicketsResult = await fetchRecentTicketsForAnon({
    portalId,
    portalSecretKey,
    agentId,
    anonId: cleanAnonId,
    sinceIso: anonWindowSinceIso,
    limit: 2,
  });
  if (!recentAnonTicketsResult.ok) return recentAnonTicketsResult;
  if (Array.isArray(recentAnonTicketsResult.rows) && recentAnonTicketsResult.rows.length >= 2) {
    return {
      ok: false,
      status: 429,
      error: "User has created too many tickets in the past 24 horus",
      details: {
        anon_id: cleanAnonId,
        recent_ticket_count: recentAnonTicketsResult.rows.length,
        window_hours: 24,
      },
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const codeResult = await fetchNextTicketCode({
      portalId,
      portalSecretKey,
      agentId,
    });
    if (!codeResult.ok) return codeResult;

    const payload = {
      ticket_code: codeResult.ticketCode,
      subject: cleanSubject,
      summary: cleanSummary,
      customer_name: cleanCustomerName,
      customer_email: cleanCustomerEmail,
      customer_phone: cleanCustomerPhone,
      anon_id: cleanAnonId,
      chat_id: cleanChatId,
      assignee_name: null,
      chat_source: cleanChatSource,
      country: cleanCountry,
      status: "open",
      high_priority: false,
      agent_id: agentId,
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          apikey: portalSecretKey,
          Authorization: `Bearer ${portalSecretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      return { ok: false, status: 502, error: "Tickets service unavailable" };
    }

    const text = await response.text();

    if (response.ok) {
      let rows = [];
      try {
        const parsed = JSON.parse(text);
        rows = Array.isArray(parsed) ? parsed : [];
      } catch {
        rows = [];
      }

      return {
        ok: true,
        status: response.status,
        ticket: rows[0] || null,
      };
    }

    let errorPayload = null;
    try {
      errorPayload = text ? JSON.parse(text) : null;
    } catch {
      errorPayload = null;
    }

    const isDuplicateTicketCode =
      response.status === 409 ||
      String(errorPayload?.code || "") === "23505" ||
      String(errorPayload?.message || "").toLowerCase().includes("ticket_code_key");

    if (isDuplicateTicketCode) {
      continue;
    }

    return {
      ok: false,
      status: response.status,
      error: errorPayload?.message || "Ticket creation failed",
      details: errorPayload,
    };
  }

  return {
    ok: false,
    status: 409,
    error: "Ticket creation failed due to duplicate ticket code",
  };
}

module.exports = {
  createPortalTicket,
};
