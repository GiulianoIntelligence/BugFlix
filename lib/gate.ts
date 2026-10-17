export class GateConfigError extends Error {}

export async function gateFetch(path: string): Promise<Response> {
  const base = process.env.DEPLOYBUG_GATE_URL;
  const token = process.env.BUGFLIX_GATE_TOKEN;
  if (!base || !token) {
    throw new GateConfigError("DEPLOYBUG_GATE_URL and BUGFLIX_GATE_TOKEN must be set");
  }
  return fetch(`${base.replace(/\/+$/, "")}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
}

export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
