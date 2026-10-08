import { createMemoryProductLookupCache } from '../_shared/productLookup/cache.ts';
import { createIdentifyProductHandler } from '../_shared/productLookup/handler.ts';
import {
  createOpenFoodFactsProvider,
  offUserAgent,
} from '../_shared/productLookup/openFoodFacts.ts';
import { authenticateUser } from '../_shared/productCheck/server.ts';

// Phase 17.3c user endpoint: name/brand suggestion from Open Food Facts only. Disabled unless
// PRODUCT_LOOKUP_ENABLED=true; OFF is never called unless OFF_USER_AGENT_CONTACT holds a project
// contact address. The cache is per isolate and non-durable (no table in this phase).
const userAgent = offUserAgent(Deno.env.get('OFF_USER_AGENT_CONTACT'));
const provider = userAgent ? createOpenFoodFactsProvider({ fetch, userAgent }) : null;

Deno.serve(
  createIdentifyProductHandler({
    authenticate: authenticateUser,
    enabled: () => Deno.env.get('PRODUCT_LOOKUP_ENABLED') === 'true',
    provider: () => provider,
    cache: createMemoryProductLookupCache(),
  }),
);
