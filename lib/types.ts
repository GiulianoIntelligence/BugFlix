export type Media = {
  playbackId: string;
  title: string | null;
  description: string | null;
};

export type MediaResult =
  | { state: "ready"; media: Media }
  | { state: "empty" }
  | { state: "error" };

export type DeployStatusResult = {
  ok: boolean;
  status: number;
  body: unknown;
  checkedAt: string;
};
