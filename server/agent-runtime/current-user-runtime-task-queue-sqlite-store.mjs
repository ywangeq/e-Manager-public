import { currentUserQueueRevision, normalizeExcludedTaskTypes } from "./current-user-runtime-task-queue-contract-v1.mjs";

function createRuntimeTaskQueueSchemaV15(database) {
  database.exec(`
    ALTER TABLE execution_tasks ADD COLUMN queue_order INTEGER NOT NULL DEFAULT 0
      CHECK (queue_order >= 0);
    UPDATE execution_tasks SET queue_order = enqueue_seq;
    CREATE UNIQUE INDEX execution_tasks_queue_order_idx
      ON execution_tasks(tenant_scope, queue_order ASC);
  `);
}

function validateRuntimeTaskQueueSchemaV15(database) {
  const columns = database.prepare("PRAGMA table_info(execution_tasks)").all();
  const queueOrder = columns.find((column) => column.name === "queue_order");
  const tableSql = normalizeSchemaSql(database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_tasks'
  `).get()?.sql);
  const index = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'execution_tasks_queue_order_idx'
  `).get();
  const invalidOrders = database.prepare(`
    SELECT COUNT(*) AS count FROM execution_tasks
    WHERE queue_order IS NULL OR queue_order <= 0
  `).get().count;
  const duplicateOrders = database.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT tenant_scope, queue_order FROM execution_tasks
      GROUP BY tenant_scope, queue_order HAVING COUNT(*) > 1
    )
  `).get().count;
  const validIndex = normalizeSchemaSql(index?.sql) === normalizeSchemaSql(`
    CREATE UNIQUE INDEX execution_tasks_queue_order_idx ON execution_tasks(tenant_scope, queue_order ASC)
  `);
  const validColumn = queueOrder && String(queueOrder.type).toUpperCase() === "INTEGER" &&
    queueOrder.notnull === 1 && String(queueOrder.dflt_value) === "0" &&
    tableSql.includes("queue_order integer not null default 0 check (queue_order >= 0)");
  if (!validColumn || invalidOrders !== 0 || duplicateOrders !== 0 || !validIndex) {
    throw queueError(
      "execution_task_schema_unsupported",
      "execution task SQLite schema v15 queue authority is invalid",
    );
  }
}

function listCurrentUserRuntimeTaskRows(database, {
  tenantScope,
  actorIssuer,
  actorSubjectDigest,
  employeeIds = null,
  statuses = null,
  excludedTaskTypes = [],
  order = "queue",
  limit = 100,
} = {}) {
  const safeTenantScope = requiredToken(tenantScope, "tenantScope", 160);
  const safeActorIssuer = requiredToken(actorIssuer, "actorIssuer", 160);
  const safeActorSubjectDigest = requiredDigest(actorSubjectDigest, "actorSubjectDigest");
  const safeEmployeeIds = employeeIds === null
    ? null
    : Array.from(new Set((Array.isArray(employeeIds) ? employeeIds : []).map((value) =>
      requiredToken(value, "employeeId", 160)
    )));
  if (safeEmployeeIds !== null && safeEmployeeIds.length === 0) {
    throw queueError("execution_task_employee_filter_empty");
  }
  const safeStatuses = statuses === null
    ? null
    : Array.from(new Set((Array.isArray(statuses) ? statuses : []).map((value) =>
      requiredToken(value, "status", 40)
    )));
  if (safeStatuses !== null && (safeStatuses.length === 0 || safeStatuses.length > 20)) {
    throw queueError("execution_task_status_filter_invalid");
  }
  const safeLimit = boundedInteger(limit, "limit", 1, 500);
  const excluded = normalizeExcludedTaskTypes(excludedTaskTypes);
  if (!["queue", "recent"].includes(order)) throw queueError("execution_task_order_invalid");
  const employeeClause = safeEmployeeIds === null
    ? ""
    : `AND employee_id IN (${safeEmployeeIds.map(() => "?").join(", ")})`;
  const statusClause = safeStatuses === null
    ? ""
    : `AND status IN (${safeStatuses.map(() => "?").join(", ")})`;
  return database.prepare(`
    SELECT * FROM execution_tasks
    WHERE tenant_scope = ? AND actor_issuer = ? AND actor_subject_digest = ?
      ${employeeClause}
      ${statusClause}
      ${excluded.length ? `AND task_type NOT IN (${excluded.map(() => "?").join(", ")})` : ""}
    ORDER BY ${order === "recent"
      ? "updated_at DESC, enqueue_seq DESC"
      : "employee_id ASC, queue_order ASC, enqueue_seq ASC"}
    LIMIT ?
  `).all(
    safeTenantScope,
    safeActorIssuer,
    safeActorSubjectDigest,
    ...(safeEmployeeIds || []),
    ...(safeStatuses || []),
    ...excluded,
    safeLimit,
  );
}

function reorderCurrentUserRuntimeTaskRows(database, value = {}) {
  const identity = normalizeReorderIdentity(value);
  database.exec("BEGIN IMMEDIATE");
  try {
    const employeeClause = identity.employeeIds.map(() => "?").join(", ");
    const activeEmployeeRows = database.prepare(`
      SELECT DISTINCT employee_id FROM execution_tasks
      WHERE tenant_scope = ? AND actor_issuer = ? AND actor_subject_digest = ?
        AND employee_id IN (${employeeClause}) AND status IN ('queued', 'running', 'waiting')
    `).all(
      identity.tenantScope,
      identity.actorIssuer,
      identity.actorSubjectDigest,
      ...identity.employeeIds,
    );
    if (activeEmployeeRows.length !== 1) {
      throw queueError(
        "runtime_task_queue_employee_identity_conflict",
        "runtime task queue aliases do not resolve to one active physical employee lane",
      );
    }
    identity.employeeId = activeEmployeeRows[0].employee_id;
    const currentRows = readQueuedRows(database, identity);
    const currentRevision = currentUserQueueRevision(currentRows.map(queueRevisionTask));
    if (currentRevision !== identity.expectedRevision) {
      throw queueError("runtime_task_queue_revision_conflict", "runtime task queue changed before reorder");
    }
    if (currentRows.length !== identity.orderedTaskIds.length ||
      currentRows.some((row) => !identity.orderedTaskIds.includes(row.task_id))) {
      throw queueError(
        "runtime_task_queue_set_conflict",
        "runtime task queue reorder must name the exact current queued set",
      );
    }
    if (currentRows.every((row, index) => row.task_id === identity.orderedTaskIds[index])) {
      database.exec("COMMIT");
      return Object.freeze({
        changed: false,
        revision: currentRevision,
        rows: Object.freeze(currentRows),
      });
    }
    const slots = currentRows.map((row) => row.queue_order);
    const temporaryBase = Number(database.prepare(`
      SELECT COALESCE(MAX(queue_order), 0) AS max_order FROM execution_tasks WHERE tenant_scope = ?
    `).get(identity.tenantScope).max_order);
    if (!Number.isSafeInteger(temporaryBase) ||
      temporaryBase < 0 || temporaryBase + identity.orderedTaskIds.length > Number.MAX_SAFE_INTEGER) {
      throw queueError("runtime_task_queue_order_exhausted", "runtime task queue order has no safe temporary range");
    }
    const update = database.prepare(`
      UPDATE execution_tasks SET queue_order = ?
      WHERE tenant_scope = ? AND task_id = ? AND actor_issuer = ? AND actor_subject_digest = ?
        AND employee_id = ? AND status = 'queued'
    `);
    writeOrder(identity.orderedTaskIds.map((_, index) => temporaryBase + index + 1));
    writeOrder(slots);
    const rows = readQueuedRows(database, identity);
    const revision = currentUserQueueRevision(rows.map(queueRevisionTask));
    database.exec("COMMIT");
    return Object.freeze({ changed: true, revision, rows: Object.freeze(rows) });

    function writeOrder(orders) {
      for (let index = 0; index < identity.orderedTaskIds.length; index += 1) {
        const changed = update.run(
          orders[index],
          identity.tenantScope,
          identity.orderedTaskIds[index],
          identity.actorIssuer,
          identity.actorSubjectDigest,
          identity.employeeId,
        );
        if (changed.changes !== 1) {
          throw queueError("runtime_task_queue_revision_conflict", "runtime task queue changed during reorder");
        }
      }
    }
  } catch (error) {
    rollbackIfActive(database);
    throw error;
  }
}

function readQueuedRows(database, identity) {
  return database.prepare(`
    SELECT * FROM execution_tasks
    WHERE tenant_scope = ? AND actor_issuer = ? AND actor_subject_digest = ?
      AND employee_id = ? AND status = 'queued'
    ORDER BY queue_order ASC, enqueue_seq ASC
  `).all(identity.tenantScope, identity.actorIssuer, identity.actorSubjectDigest, identity.employeeId);
}

function normalizeReorderIdentity(value) {
  const identity = {
    tenantScope: requiredToken(value.tenantScope, "tenantScope", 160),
    actorIssuer: requiredToken(value.actorIssuer, "actorIssuer", 160),
    actorSubjectDigest: requiredDigest(value.actorSubjectDigest, "actorSubjectDigest"),
    expectedRevision: String(value.expectedRevision || "").trim(),
  };
  const employeeIds = value.employeeIds ?? (value.employeeId ? [value.employeeId] : []);
  identity.employeeIds = Array.from(new Set((Array.isArray(employeeIds) ? employeeIds : []).map((employeeId) =>
    requiredToken(employeeId, "employeeId", 160)
  )));
  if (identity.employeeIds.length === 0 || identity.employeeIds.length > 20) {
    throw queueError("runtime_task_queue_employee_filter_invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(identity.expectedRevision)) {
    throw queueError("runtime_task_queue_revision_invalid");
  }
  if (!Array.isArray(value.orderedTaskIds) || value.orderedTaskIds.length < 2 ||
    value.orderedTaskIds.length > 100) {
    throw queueError("runtime_task_queue_order_invalid");
  }
  identity.orderedTaskIds = value.orderedTaskIds.map((taskId) => requiredToken(taskId, "taskId", 128));
  if (new Set(identity.orderedTaskIds).size !== identity.orderedTaskIds.length) {
    throw queueError("runtime_task_queue_order_duplicate");
  }
  return identity;
}

function queueRevisionTask(row) {
  return { taskId: row.task_id, status: row.status, revision: row.revision, queueOrder: row.queue_order };
}

function requiredToken(value, field, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw queueError(`execution_task_${field}_invalid`);
  }
  return normalized;
}

function requiredDigest(value, field) {
  const normalized = String(value || "").trim();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw queueError(`execution_task_${field}_invalid`);
  return normalized;
}

function boundedInteger(value, field, min, max) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw queueError(`execution_task_${field}_invalid`);
  }
  return normalized;
}

function normalizeSchemaSql(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")
    .trim().toLowerCase();
}

function rollbackIfActive(database) {
  try {
    database.exec("ROLLBACK");
  } catch {
    // SQLite may already have rolled the transaction back.
  }
}

function queueError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export {
  createRuntimeTaskQueueSchemaV15,
  listCurrentUserRuntimeTaskRows,
  reorderCurrentUserRuntimeTaskRows,
  validateRuntimeTaskQueueSchemaV15,
};
