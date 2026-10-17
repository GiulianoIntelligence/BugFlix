import { gateFetch, noStoreJson, readBody } from "@/lib/gate";
import type { Media, MediaResult } from "@/lib/types";

export const dynamic = "force-dynamic";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toMedia(body: unknown): Media | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const playbackId = text(record.playbackId) ?? text(record.playback_id);
  if (!playbackId) return null;
  return { playbackId, title: text(record.title), description: text(record.description) };
}

export async function GET(): Promise<Response> {
  try {
    const upstream = await gateFetch("/media/current");
    if (upstream.status === 204) return noStoreJson({ state: "empty" } satisfies MediaResult);
    if (!upstream.ok) return noStoreJson({ state: "error" } satisfies MediaResult, 502);
    const media = toMedia(await readBody(upstream));
    return noStoreJson((media ? { state: "ready", media } : { state: "empty" }) satisfies MediaResult);
  } catch {
    return noStoreJson({ state: "error" } satisfies MediaResult, 502);
  }
}
