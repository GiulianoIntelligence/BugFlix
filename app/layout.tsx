import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import ServiceWorkerRegistration from "./service-worker-registration";
import "./globals.css";

export const metadata: Metadata = {
  title: "BugFlix",
  applicationName: "BugFlix",
  appleWebApp: { capable: true, title: "BugFlix", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#050507",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="cinema" aria-hidden="true">
          <span className="light light-left" />
          <span className="light light-right" />
        </div>
        <header className="topbar">
          <Link href="/" className="brand" aria-label="BugFlix home">
            Bug<span>Flix</span>
          </Link>
          <nav>
            <Link href="/status" className="nav-link">
              Status
            </Link>
          </nav>
        </header>
        <main className="stage">{children}</main>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
