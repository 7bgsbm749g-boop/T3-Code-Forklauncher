// Migration 056 was added after compatibility migrations 057 and 058 had shipped
// in some environments. The migrator only runs IDs greater than the latest
// recorded migration, so replay its idempotent CREATE IF NOT EXISTS schema here.
import Migration0056 from "./056_ForkGithubActions.ts";

export default Migration0056;
