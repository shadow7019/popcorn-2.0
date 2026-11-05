import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { PwaRegister } from "@/components/pwa-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://pocorntime.antideploy.app"),
  title: "Popcorn Time — Stream Movies & TV Shows",
  description:
    "Browse trending movies and TV shows, watch trailers and stream instantly. Powered by TMDB.",
  keywords: ["movies", "tv shows", "streaming", "watch online", "trailers", "TMDB"],
  manifest: "/manifest.webmanifest",
  applicationName: "Popcorn Time",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Popcorn Time",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    title: "Popcorn Time — Stream Movies & TV Shows",
    description: "Browse trending movies and TV shows, watch trailers and stream instantly.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Popcorn Time" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Popcorn Time — Stream Movies & TV Shows",
    description: "Browse trending movies and TV shows, watch trailers and stream instantly.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0b10",
  width: "device-width",
  initialScale: 1,
  // app-like phone behavior (APK WebView): no accidental pinch/double-tap
  // zoom, and the keyboard resizes the page instead of covering controls
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-screen antialiased bg-background text-foreground`}
      >
        {children}
        <PwaRegister />
        <Toaster />
      </body>
    </html>
  );
}
