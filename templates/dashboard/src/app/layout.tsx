import type { Metadata } from 'next'
import '@donmai/dashboard/styles'
import './globals.css'

export const metadata: Metadata = {
  title: 'AgentFactory Dashboard',
  description: 'AI agent fleet management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}</body>
    </html>
  )
}
