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

function normalizeDynamicSourceType(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "int" || text === "float" || text === "bool" || text === "date") {
    return text;
  }
  return "text";
}

function toDynamicSourceParameterSchema(dataType) {
  if (dataType === "int") return { type: "integer" };
  if (dataType === "float") return { type: "number" };
  if (dataType === "bool") return { type: "boolean" };
  return { type: "string" };
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

async function fetchWorkspaceAppsRow({ supId, supKey, agentId }) {
  const baseUrl = `https://${supId}.supabase.co/rest/v1`;
  const url = `${baseUrl}/workspace_apps?select=workspace_id,tickets_enabled,ticket_email_required,ticket_phone_required&agent_id=eq.${agentId}&limit=1`;

  const response = await fetch(url, {
    headers: {
      apikey: supKey,
      Authorization: `Bearer ${supKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    return { ok: false, status: 502, error: "Apps service unavailable" };
  }

  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : [];
  return { ok: true, row: rows[0] || null };
}

async function getAgentAllActions({ supId, supKey, agentId, includePortalTickets = false }) {
  if (!supId || !supKey) {
    return { ok: false, status: 500, error: "Server configuration error" };
  }

  let customRows = [];
  let zapierRows = [];
  let makeRows = [];
  let slackRows = [];
  let gmailActionsRows = [];
  let gmailConnectionsRows = [];
  let calendarActionsRows = [];
  let calendarConnectionsRows = [];
  let dynamicSourcesRows = [];
  let dynamicSourceColumnsRows = [];
  let dynamicSourceRowsRows = [];
  let workspaceAppsRow = null;

  try {
    const requests = [
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "custom_api_actions",
        fields: "id,title,description,url,method,headers,body_template",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "zapier_actions",
        fields: "id,title,description,url,headers,body_template",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "make_actions",
        fields: "id,title,description,url,headers,body_template",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "slack_notifications",
        fields: "id,title,description,webhook_url,username",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "google_gmail_actions",
        fields: "id,agent_id,send_email",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "google_gmail_connections",
        fields: "id,agent_id,access_token,refresh_token,token_type,expires_at",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "google_calendar_actions",
        fields: "id,agent_id,create_event,list_events,duration_mins,location,timezone,open_hour,close_hour,attendees_required,event_type",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "google_calendar_connections",
        fields: "id,agent_id,access_token,refresh_token,token_type,expires_at",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "dynamic_sources",
        fields: "id,agent_id,name,enabled",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "dynamic_source_columns",
        fields: "id,agent_id,source_id,column_key,name,data_type,filter_sort_enabled,position",
      }),
      fetchTable({
        supId,
        supKey,
        agentId,
        table: "dynamic_source_rows",
        fields: "id,agent_id,source_id,row_key,cells,position",
      }),
    ];
    if (includePortalTickets) {
      requests.push(
        fetchWorkspaceAppsRow({
          supId,
          supKey,
          agentId,
        })
      );
    }

    const results = await Promise.all(requests);
    const [
      custom,
      zapier,
      make,
      slack,
      gmailActions,
      gmailConnections,
      calendarActions,
      calendarConnections,
      dynamicSources,
      dynamicSourceColumns,
      dynamicSourceRows,
      workspaceApps,
    ] = results;

    const statusResults = [
      custom,
      zapier,
      make,
      slack,
      gmailActions,
      gmailConnections,
      calendarActions,
      calendarConnections,
      dynamicSources,
      dynamicSourceColumns,
      dynamicSourceRows,
    ];
    if (includePortalTickets) statusResults.push(workspaceApps);

    const firstFailed = statusResults.find((result) => !result?.ok);
    if (firstFailed) return firstFailed;

    customRows = custom.rows;
    zapierRows = zapier.rows;
    makeRows = make.rows;
    slackRows = slack.rows;
    gmailActionsRows = gmailActions.rows;
    gmailConnectionsRows = gmailConnections.rows;
    calendarActionsRows = calendarActions.rows;
    calendarConnectionsRows = calendarConnections.rows;
    dynamicSourcesRows = dynamicSources.rows;
    dynamicSourceColumnsRows = dynamicSourceColumns.rows;
    dynamicSourceRowsRows = dynamicSourceRows.rows;
    workspaceAppsRow = workspaceApps?.row || null;
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

  const calendarAction = calendarActionsRows.find(
    (row) => row?.create_event === true || row?.list_events === true
  );
  const calendarConnection = calendarConnectionsRows.find(
    (row) => row?.agent_id === agentId
  );
  if (calendarAction && calendarConnection) {
    if (calendarAction.create_event === true) {
      const toolName = sanitizeToolName("book_event", calendarAction.id, usedNames);
      const attendeesRequired = calendarAction.attendees_required === true;
      const requiredFields = attendeesRequired
        ? ["start_time", "attendees"]
        : ["start_time"];
      const attendeesText = attendeesRequired
        ? "Attendees required (emails). "
        : "Attendees optional (emails). ";
      const calendarTimeZone = calendarAction.timezone ?? "UTC";
      const durationMins =
        Number.isFinite(Number(calendarAction.duration_mins)) && Number(calendarAction.duration_mins) > 0
          ? Number(calendarAction.duration_mins)
          : 30;
      const openHour = Number(calendarAction.open_hour);
      const closeHour = Number(calendarAction.close_hour);
      const hoursText =
        Number.isFinite(openHour) && Number.isFinite(closeHour)
          ? `Open hours: ${openHour}:00-${closeHour}:00. `
          : "";
      const eventTypeText = calendarAction.event_type
        ? `Event type: ${calendarAction.event_type}. `
        : "";

      tools.push({
        type: "function",
        name: toolName,
        description: `Book an event. ${attendeesText}${eventTypeText}Timezone: ${calendarTimeZone}. Duration: ${durationMins} minutes. ${hoursText}`.trim(),
        parameters: {
          type: "object",
          properties: {
            start_time: { type: "string" },
            attendees: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: requiredFields,
          additionalProperties: false,
        },
      });

      actionMap.set(toolName, {
        tool_name: toolName,
        id: calendarAction.id ?? null,
        title: "Book Event",
        description: `Book an event. ${attendeesText}${eventTypeText}Timezone: ${calendarTimeZone}. Duration: ${durationMins} minutes. ${hoursText}`.trim(),
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        method: "POST",
        headers: {},
        body_template: null,
        kind: "calendar_create",
        username: null,
        duration_mins: calendarAction.duration_mins ?? null,
        location: calendarAction.location ?? null,
        timezone: calendarAction.timezone ?? null,
        open_hour: calendarAction.open_hour ?? null,
        close_hour: calendarAction.close_hour ?? null,
        attendees_required: attendeesRequired,
        event_type: calendarAction.event_type ?? null,
        calendar_connection: {
          access_token: calendarConnection.access_token,
          refresh_token: calendarConnection.refresh_token,
          token_type: calendarConnection.token_type || "Bearer",
          expires_at: calendarConnection.expires_at,
        },
      });
    }

    if (calendarAction.list_events === true) {
      const toolName = sanitizeToolName("check_calendar_schedule", calendarAction.id, usedNames);
      const calendarTimeZone = calendarAction.timezone ?? "UTC";
      const openHour = Number(calendarAction.open_hour);
      const closeHour = Number(calendarAction.close_hour);
      const hoursText =
        Number.isFinite(openHour) && Number.isFinite(closeHour)
          ? `Open hours: ${openHour}:00-${closeHour}:00. `
          : "";
      tools.push({
        type: "function",
        name: toolName,
        description: `Check schedule availability (no event details). Timezone: ${calendarTimeZone}. ${hoursText}`.trim(),
        parameters: {
          type: "object",
          properties: {
            time_min: { type: "string" },
            time_max: { type: "string" },
            max_results: { type: "integer" },
          },
          required: ["time_min", "time_max"],
          additionalProperties: false,
        },
      });

      actionMap.set(toolName, {
        tool_name: toolName,
        id: calendarAction.id ?? null,
        title: "Check Calendar Schedule",
        description: `Check schedule availability (no event details). Timezone: ${calendarTimeZone}. ${hoursText}`.trim(),
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        method: "GET",
        headers: {},
        body_template: null,
        kind: "calendar_list",
        username: null,
        timezone: calendarAction.timezone ?? null,
        open_hour: calendarAction.open_hour ?? null,
        close_hour: calendarAction.close_hour ?? null,
        calendar_connection: {
          access_token: calendarConnection.access_token,
          refresh_token: calendarConnection.refresh_token,
          token_type: calendarConnection.token_type || "Bearer",
          expires_at: calendarConnection.expires_at,
        },
      });
    }
  }

  const dynamicSource = dynamicSourcesRows.find((row) => row?.enabled === true);
  if (dynamicSource) {
    const sourceId = dynamicSource.id;
    const sourceName =
      typeof dynamicSource.name === "string" && dynamicSource.name.trim()
        ? dynamicSource.name.trim()
        : "My New Table";
    const sourceColumns = dynamicSourceColumnsRows
      .filter((row) => row?.source_id === sourceId)
      .sort((a, b) => Number(a?.position ?? 0) - Number(b?.position ?? 0));
    const sourceRows = dynamicSourceRowsRows
      .filter((row) => row?.source_id === sourceId)
      .sort((a, b) => Number(a?.position ?? 0) - Number(b?.position ?? 0));
    const filterSortColumns = sourceColumns
      .filter((row) => row?.filter_sort_enabled === true)
      .map((row) => {
        const key =
          typeof row?.column_key === "string" && row.column_key.trim()
            ? row.column_key.trim()
            : "";
        const label =
          typeof row?.name === "string" && row.name.trim() ? row.name.trim() : key;
        const dataType = normalizeDynamicSourceType(row?.data_type);
        return {
          key,
          name: label || key,
          data_type: dataType,
          filter_sort_enabled: true,
        };
      })
      .filter((column) => column.key);

    const dynamicFiltersProperties = {};
    for (const column of filterSortColumns) {
      dynamicFiltersProperties[column.key] = toDynamicSourceParameterSchema(column.data_type);
    }

    const toolName = sanitizeToolName("query_dynamic_source", dynamicSource.id, usedNames);
    const filterSortLabel = filterSortColumns
      .map((column) => `${column.name} (${column.key}: ${column.data_type})`)
      .join(", ");
    const description = filterSortColumns.length > 0
      ? `Query Dynamic Source table "${sourceName}". Filter and sort only by: ${filterSortLabel}. Always returns up to 5 rows.`
      : `Query Dynamic Source table "${sourceName}". No filter/sort columns are enabled. Always returns up to 5 rows.`;

    const parameters = {
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: dynamicFiltersProperties,
          additionalProperties: false,
        },
      },
      required: [],
      additionalProperties: false,
    };
    if (filterSortColumns.length > 0) {
      parameters.properties.sort_by = {
        type: "string",
        enum: filterSortColumns.map((column) => column.key),
      };
      parameters.properties.sort_order = {
        type: "string",
        enum: ["asc", "desc"],
      };
    }

    tools.push({
      type: "function",
      name: toolName,
      description,
      parameters,
    });

    actionMap.set(toolName, {
      tool_name: toolName,
      id: dynamicSource.id ?? null,
      title: `Query Dynamic Source: ${sourceName}`,
      description,
      url: "",
      method: "LOCAL",
      headers: {},
      body_template: null,
      kind: "dynamic_source_query",
      dynamic_source_name: sourceName,
      dynamic_source_columns: filterSortColumns,
      dynamic_source_rows: sourceRows.map((row) => ({
        id: row?.id ?? null,
        row_key: row?.row_key ?? null,
        position: row?.position ?? null,
        cells: row?.cells && typeof row.cells === "object" ? row.cells : {},
      })),
    });
  }

  if (includePortalTickets && workspaceAppsRow && workspaceAppsRow.tickets_enabled === true) {
    if (!process.env.PORTAL_ID || !process.env.PORTAL_SECRET_KEY) {
      return { ok: false, status: 500, error: "Server configuration error" };
    }

    const toolName = sanitizeToolName("create_support_ticket", "tickets", usedNames);
    const ticketEmailRequired = workspaceAppsRow.ticket_email_required !== false;
    const ticketPhoneRequired = workspaceAppsRow.ticket_phone_required === true;
    const requiredFields = ["subject", "summary", "customer_name"];
    if (ticketEmailRequired) requiredFields.push("customer_email");
    if (ticketPhoneRequired) requiredFields.push("customer_phone");

    tools.push({
      type: "function",
      name: toolName,
      description:
        "Create a new customer support ticket. Ask only for missing required fields before calling.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string" },
          summary: { type: "string" },
          summery: { type: "string" },
          customer_name: { type: "string" },
          customer_email: { type: "string" },
          email: { type: "string" },
          customer_phone: { type: "string" },
          phone: { type: "string" },
        },
        required: requiredFields,
        additionalProperties: false,
      },
    });

    actionMap.set(toolName, {
      tool_name: toolName,
      id: workspaceAppsRow.workspace_id ?? null,
      title: "Create Support Ticket",
      description: "Create a new customer support ticket.",
      url: "",
      method: "POST",
      headers: {},
      body_template: null,
      kind: "ticket_create",
      ticket_email_required: ticketEmailRequired,
      ticket_phone_required: ticketPhoneRequired,
    });
  }

  return { ok: true, tools, actionMap };
}

module.exports = {
  getAgentAllActions,
};
