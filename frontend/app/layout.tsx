import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'Altegro · Robot Operations',
  description: 'Manufacturer-neutral robot operations and Passport platform'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
