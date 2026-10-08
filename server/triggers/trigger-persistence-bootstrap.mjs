import path from "node:path";
import { resolveDigitalWorkforceDataDir } from "../local-data-root.mjs";
import { createSqliteTriggerEventRepository } from "./sqlite-trigger-event-repository.mjs";
import { createSqliteTriggerConfigRepository } from "./sqlite-trigger-config-repository.mjs";

const TRIGGER_EVENT_DATABASE_FILE = "trigger-events.sqlite";

function createTriggerPersistence({ env = process.env, projectRoot } = {}) {
  const dataDir = resolveDigitalWorkforceDataDir({ env, projectRoot });
  const configuredPath = String(env.TRIGGER_EVENT_DATABASE_PATH || "").trim();
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new TypeError("TRIGGER_EVENT_DATABASE_PATH must be absolute");
  }
  const databasePath = path.normalize(configuredPath || path.join(dataDir, TRIGGER_EVENT_DATABASE_FILE));
  const repository = createSqliteTriggerEventRepository({ databasePath });
  const configRepository = createSqliteTriggerConfigRepository({ databasePath });
  return Object.freeze({
    close: () => {
      configRepository.close();
      repository.close();
    },
    configRepository,
    databasePath,
    mode: "sqlite",
    productionReady: false,
    repository,
  });
}

export {
  TRIGGER_EVENT_DATABASE_FILE,
  createTriggerPersistence,
};
