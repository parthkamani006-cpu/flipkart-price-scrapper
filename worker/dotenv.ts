/**
 * Load a local .env, as a side effect of being imported.
 *
 * This is its own module for one reason: ES module imports are hoisted. Calling
 * `dotenv.config()` at the top of the entry file would still run *after* every
 * import in that file had been evaluated, so anything reading `process.env` at
 * module scope would read it empty. Making the load an import means the module
 * graph orders it — this file is imported first, so it runs first.
 *
 * (It happens that nothing here reads env at import time; `supabaseAdmin()` and
 * `readEnv()` are both lazy. That is not a property worth depending on.)
 *
 * A no-op in GitHub Actions, where there is no .env file and the values come
 * from repository secrets. Real environment variables always win over the file,
 * which is what makes `SUPABASE_URL=... npm run worker` behave as expected.
 */

import { config } from 'dotenv';

config({ path: ['.env.local', '.env'] });
