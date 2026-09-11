import Link from 'next/link';
import type { ReactNode } from 'react';

export function LegalDocument({ title, eyebrow, complete, children }: { title: string; eyebrow: string; complete: boolean; children: ReactNode }) {
  return <main className="legal-page">
    <header><Link className="brand" href="/"><span>A</span><strong>altegro</strong></Link><nav aria-label="Rechtliche Informationen"><Link href="/impressum">Impressum</Link><Link href="/datenschutz">Datenschutz</Link></nav></header>
    <article className="legal-document">
      <p className="eyebrow">{eyebrow}</p><h1>{title}</h1>
      {!complete && <p className="legal-warning" role="status">Die Pflichtangaben des Betreibers müssen vor der Veröffentlichung vollständig konfiguriert werden.</p>}
      {children}
      <p className="legal-updated">Stand: 11. September 2026</p>
    </article>
  </main>;
}
