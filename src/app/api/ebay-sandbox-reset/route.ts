import { z } from "zod";

import {
  isEbaySandboxListingConfigured,
  resetSandboxComicInfoSkus,
} from "@/lib/ebay-sandbox";

export const runtime = "nodejs";

/** Large inventories may need more than the default serverless limit. */
export const maxDuration = 60;

const bodySchema = z.object({
  confirm: z.literal("RESET_SANDBOX_CI_SKUS"),
});

export async function POST(request: Request) {
  if (!isEbaySandboxListingConfigured()) {
    return Response.json(
      { error: "eBay sandbox listing is not configured on the server." },
      { status: 503 },
    );
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      {
        error:
          'Request body must be exactly { "confirm": "RESET_SANDBOX_CI_SKUS" }.',
      },
      { status: 400 },
    );
  }

  try {
    const result = await resetSandboxComicInfoSkus();
    return Response.json({
      ok: true,
      ciSkusFound: result.ciSkusFound,
      skusProcessed: result.skusProcessed,
      offersRemoved: result.offersRemoved,
      errors: result.errors,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "eBay sandbox reset failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
