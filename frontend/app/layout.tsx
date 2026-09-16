import type { Metadata } from 'next';
import './styles.css';
import './features.css';
import { I18nProvider } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Altegro · Robot Operations',
  description: 'Manufacturer-neutral robot operations and Passport platform'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><I18nProvider>{children}</I18nProvider></body>
    </html>
  );
}
