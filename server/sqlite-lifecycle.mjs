export function closeSqliteDatabase(database) {
  if (database.isOpen === false) return;
  try { database.close(); } catch (error) {
    if (error.code !== "ERR_INVALID_STATE") throw error;
  }
}

// Constructors own handles until initialization succeeds and ownership transfers.
export function initializeSqliteDatabase(database, initialize) {
  try { return initialize(database); } catch (error) {
    try { closeSqliteDatabase(database); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "sqlite_initialization_failed", { cause: error });
    }
    throw error;
  }
}
