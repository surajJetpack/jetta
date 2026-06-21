import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jetta — Autonomous Support Engine",
  description: "Support agent for Jetpack Apps and GetSign.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
