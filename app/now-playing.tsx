"use client";

import MuxPlayer, { type MuxPlayerRefAttributes } from "@mux/mux-player-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Media, MediaResult } from "@/lib/types";

type View = { state: "loading" } | MediaResult;

const EMPTY_RECHECK_MS = 30_000;

async function fetchMedia(): Promise<MediaResult> {
  try {
    const response = await fetch("/api/media/current", { cache: "no-store" });
    const result = (await response.json()) as MediaResult;
    return response.ok ? result : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

export default function NowPlaying() {
  const [view, setView] = useState<View>({ state: "loading" });
  const latest = useRef(0);

  const load = useCallback(async (quiet = false) => {
    const request = ++latest.current;
    if (!quiet) setView({ state: "loading" });
    const result = await fetchMedia();
    if (request === latest.current) setView(result);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (view.state !== "empty") return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(true);
    }, EMPTY_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [view.state, load]);

  if (view.state === "ready") return <Player key={view.media.playbackId} media={view.media} />;

  return (
    <div className="frame" aria-busy={view.state === "loading"}>
      {view.state === "loading" && (
        <div className="panel" role="status">
          <span className="spinner" aria-hidden="true" />
          <span className="sr-only">Loading</span>
        </div>
      )}
      {view.state === "empty" && (
        <div className="panel">
          <p className="panel-title">Nothing scheduled yet</p>
          <button type="button" className="ghost-button" onClick={() => void load()}>
            Check again
          </button>
        </div>
      )}
      {view.state === "error" && (
        <div className="panel" role="alert">
          <p className="panel-title panel-title-error">Something went wrong</p>
          <p className="panel-text">We couldn&apos;t load what&apos;s playing.</p>
          <button type="button" className="ghost-button" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

function Player({ media }: { media: Media }) {
  const player = useRef<MuxPlayerRefAttributes>(null);
  const [overlay, setOverlay] = useState(true);

  return (
    <>
      <div className="frame" data-overlay={overlay}>
        <MuxPlayer
          ref={player}
          playbackId={media.playbackId}
          metadata={media.title ? { video_title: media.title } : undefined}
          accentColor="#19d6ff"
          primaryColor="#ffffff"
          onPlay={() => setOverlay(false)}
          onError={() => setOverlay(false)}
        />
        {overlay && (
          <button
            type="button"
            className="play"
            aria-label="Play"
            onClick={() => void player.current?.play()?.catch(() => undefined)}
          >
            <span className="play-core">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.9-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z" />
              </svg>
            </span>
          </button>
        )}
      </div>
      {(media.title || media.description) && (
        <section className="details">
          {media.title && <h1 className="details-title">{media.title}</h1>}
          {media.description && <p className="details-text">{media.description}</p>}
        </section>
      )}
    </>
  );
}
