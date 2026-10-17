import type { Metadata } from "next";
import DeployStatus from "./deploy-status";

export const metadata: Metadata = {
  title: "Status · BugFlix",
};

export default function StatusPage() {
  return <DeployStatus />;
}
