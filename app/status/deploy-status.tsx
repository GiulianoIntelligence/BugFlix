"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeployStatusResult } from "@/lib/types";

type View =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "done"; result: DeployStatusResult };

async function fetchStatus(): Promise<Exclude<View, { state: "loading" }>> {
  try {
    const response = await fetch("/api/deploy/status", { cache: "no-store" });
    const data = (await response.json()) as DeployStatusResult | { error: string };
    if (!response.ok || "error" in data) {
      return { state: "error", message: "error" in data ? data.error : `Request failed (${response.status})` };
    }
    return { state: "done", result: data };
  } catch {
    return { state: "error", message: "The status request failed" };
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function Body({ body }: { body: unknown }) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length === 0) return <p className="panel-text">Empty response</p>;
    return (
      <dl className="status-list">
        {entries.map(([key, value]) => (
          <div key={key} className="status-row">
            <dt>{key}</dt>
            <dd>
              {value !== null && typeof value === "object" ? <pre>{formatValue(value)}</pre> : formatValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (body === null || body === "") return <p className="panel-text">Empty response</p>;
  return <pre className="status-raw">{formatValue(body)}</pre>;
}

export default function DeployStatus() {
  const [view, setView] = useState<View>({ state: "loading" });
  const latest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latest.current;
    setView({ state: "loading" });
    const next = await fetchStatus();
    if (request === latest.current) setView(next);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="status">
      <div className="status-head">
        <h1 className="status-title">Deploy status</h1>
        <button type="button" className="ghost-button" onClick={() => void load()} disabled={view.state === "loading"}>
          Refresh
        </button>
      </div>
      <div className="card" aria-busy={view.state === "loading"}>
        {view.state === "loading" && (
          <div className="card-center" role="status">
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">Loading</span>
          </div>
        )}
        {view.state === "error" && (
          <div className="card-center" role="alert">
            <p className="panel-title panel-title-error">Something went wrong</p>
            <p className="panel-text">{view.message}</p>
          </div>
        )}
        {view.state === "done" && (
          <>
            <div className="status-meta">
              <span className={view.result.ok ? "badge badge-ok" : "badge badge-bad"}>HTTP {view.result.status}</span>
              <time dateTime={view.result.checkedAt}>{new Date(view.result.checkedAt).toLocaleTimeString()}</time>
            </div>
            <Body body={view.result.body} />
          </>
        )}
      </div>
    </section>
  );
}
