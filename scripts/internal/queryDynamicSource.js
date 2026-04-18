function parseDateValue(value) {
  if (typeof value !== "string") return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function normalizeByType(value, dataType) {
  if (dataType === "int") {
    const num = Number(value);
    return Number.isInteger(num) ? num : null;
  }
  if (dataType === "float") {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  if (dataType === "bool") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const text = value.trim().toLowerCase();
      if (text === "true") return true;
      if (text === "false") return false;
    }
    return null;
  }
  if (dataType === "date") {
    return parseDateValue(value);
  }
  if (value === null || value === undefined) return "";
  return String(value);
}

function compareValues(a, b, dataType) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (dataType === "bool") {
    if (a === b) return 0;
    return a === false ? -1 : 1;
  }
  if (dataType === "int" || dataType === "float" || dataType === "date") {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  const textA = String(a).toLowerCase();
  const textB = String(b).toLowerCase();
  if (textA === textB) return 0;
  return textA < textB ? -1 : 1;
}

function executeDynamicSourceQuery(actionDef, variables) {
  const rows = Array.isArray(actionDef?.dynamic_source_rows) ? actionDef.dynamic_source_rows : [];
  const allowedColumns = Array.isArray(actionDef?.dynamic_source_columns)
    ? actionDef.dynamic_source_columns
    : [];
  const columnsByKey = new Map();
  for (const column of allowedColumns) {
    const key = typeof column?.key === "string" ? column.key.trim() : "";
    if (!key) continue;
    columnsByKey.set(key, {
      key,
      name: typeof column?.name === "string" ? column.name : key,
      data_type: typeof column?.data_type === "string" ? column.data_type : "text",
    });
  }

  const filtersInput = variables?.filters && typeof variables.filters === "object"
    ? variables.filters
    : {};
  const requestedFilterKeys = Object.keys(filtersInput);
  const invalidFilterKeys = requestedFilterKeys.filter((key) => !columnsByKey.has(key));
  if (invalidFilterKeys.length > 0) {
    return {
      ok: false,
      status: 400,
      error: "Unsupported filters",
      details: {
        unsupported_filters: invalidFilterKeys,
        allowed_filters: Array.from(columnsByKey.keys()),
      },
    };
  }

  let filteredRows = rows;
  for (const key of requestedFilterKeys) {
    const column = columnsByKey.get(key);
    const expectedValue = normalizeByType(filtersInput[key], column.data_type);
    filteredRows = filteredRows.filter((row) => {
      const cells = row?.cells && typeof row.cells === "object" ? row.cells : {};
      const actualValue = normalizeByType(cells[key], column.data_type);
      return compareValues(actualValue, expectedValue, column.data_type) === 0;
    });
  }

  const sortBy = typeof variables?.sort_by === "string" ? variables.sort_by.trim() : "";
  const sortOrderRaw = typeof variables?.sort_order === "string" ? variables.sort_order.trim().toLowerCase() : "";
  const sortOrder = sortOrderRaw === "desc" ? "desc" : "asc";
  if (sortBy) {
    if (!columnsByKey.has(sortBy)) {
      return {
        ok: false,
        status: 400,
        error: "Unsupported sort_by column",
        details: {
          sort_by: sortBy,
          allowed_sort_by: Array.from(columnsByKey.keys()),
        },
      };
    }
    const column = columnsByKey.get(sortBy);
    filteredRows = [...filteredRows].sort((left, right) => {
      const leftCells = left?.cells && typeof left.cells === "object" ? left.cells : {};
      const rightCells = right?.cells && typeof right.cells === "object" ? right.cells : {};
      const leftValue = normalizeByType(leftCells[sortBy], column.data_type);
      const rightValue = normalizeByType(rightCells[sortBy], column.data_type);
      const base = compareValues(leftValue, rightValue, column.data_type);
      return sortOrder === "desc" ? -base : base;
    });
  }

  const resultRows = filteredRows.slice(0, 5).map((row) => ({
    id: row?.row_key ?? row?.id ?? null,
    cells: row?.cells && typeof row.cells === "object" ? row.cells : {},
  }));

  return {
    ok: true,
    status: 200,
    body: {
      table_name: actionDef?.dynamic_source_name || "My New Table",
      rows_returned: resultRows.length,
      rows_matched: filteredRows.length,
      rows: resultRows,
    },
  };
}

module.exports = {
  executeDynamicSourceQuery,
};
