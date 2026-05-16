import type { Metadata } from "next";
import { Fira_Code, Inter, Montserrat } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const fontMontserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
});

const fontInter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const fontFiraMono = Fira_Code({
  variable: "--font-fira-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Native Gen · Campaign workflow lab",
  description:
    "DAG-style creative workflows with Fal-powered generations, local saves, and social export packs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontMontserrat.variable} ${fontInter.variable} ${fontFiraMono.variable} h-full font-sans`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
