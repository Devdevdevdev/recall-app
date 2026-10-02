import { createCheckOwnedProductHandler } from '../_shared/productCheck/handler.ts';
import { authenticateUser, productCheckStores } from '../_shared/productCheck/server.ts';

// User-facing: verified JWT, one owned product per request, no AI. Disabled until
// private.recall_automation_control.product_check_enabled is set (default false).
Deno.serve(
  createCheckOwnedProductHandler({
    authenticate: authenticateUser,
    createStores: productCheckStores,
  }),
);
