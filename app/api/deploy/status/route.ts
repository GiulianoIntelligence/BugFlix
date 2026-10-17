import { GateConfigError, gateFetch, noStoreJson, readBody } from "@/lib/gate";
import type { DeployStatusResult } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const upstream = await gateFetch("/deploy/status");
    const result: DeployStatusResult = {
      ok: upstream.ok,
      status: upstream.status,
      body: await readBody(upstream),
      checkedAt: new Date().toISOString(),
    };
    return noStoreJson(result);
  } catch (error) {
    const message = error instanceof GateConfigError ? error.message : "The deploy gate could not be reached";
    return noStoreJson({ error: message }, 502);
  }
}
