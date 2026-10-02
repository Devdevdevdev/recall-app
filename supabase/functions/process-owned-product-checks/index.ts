import { createProductCheckWorkerHandler } from '../_shared/productCheck/handler.ts';
import { constantTimeEqual, productCheckStores } from '../_shared/productCheck/server.ts';

// Administrative worker for due product checks. Phase 17.7a-1: local only, not
// scheduled and not called by run-recall-automation (that is 17.7a-2).
Deno.serve(
  createProductCheckWorkerHandler({
    authorized(request) {
      const expected = Deno.env.get('RECALL_MATCHING_KEY');
      const provided = request.headers.get('x-recall-matching-key');
      return Boolean(expected && provided && constantTimeEqual(expected, provided));
    },
    createStores: productCheckStores,
  }),
);
