import type { Metadata } from "next";
import { Bricolage_Grotesque, JetBrains_Mono, Mukta } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"] });
// Mukta covers Devanagari; Kannada, Tamil and Bengali fall back to the system's Noto faces.
const body = Mukta({ variable: "--font-body", subsets: ["latin", "devanagari"], weight: ["400", "500", "600"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Munshi",
  description: "A voice-first AI bookkeeper for Indian shops.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
