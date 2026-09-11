import type { Metadata } from 'next';
import { LegalDocument } from '@/components/LegalDocument';
import { legalConfiguration } from '@/lib/legal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Impressum · Altegro', robots: { index: true, follow: true } };

export default function ImpressumPage() {
  const legal = legalConfiguration();
  return <LegalDocument title="Impressum" eyebrow="Angaben gemäß § 5 DDG" complete={legal.complete}>
    <section><h2>Anbieter</h2><address><strong>{legal.operatorName || 'Betreibername nicht konfiguriert'}</strong><br />{legal.street || 'Straße und Hausnummer nicht konfiguriert'}<br />{legal.city || 'PLZ und Ort nicht konfiguriert'}<br />{legal.country}</address></section>
    <section><h2>Vertretungsberechtigte Person</h2><p>{legal.representative || 'Nicht konfiguriert'}</p></section>
    <section><h2>Kontakt</h2><p>E-Mail: {legal.email ? <a href={`mailto:${legal.email}`}>{legal.email}</a> : 'Nicht konfiguriert'}<br />{legal.phone && <>Telefon: <a href={`tel:${legal.phone}`}>{legal.phone}</a></>}</p></section>
    {legal.register && <section><h2>Registereintrag</h2><p>{legal.register}</p></section>}
    {legal.vatId && <section><h2>Umsatzsteuer-ID</h2><p>Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: {legal.vatId}</p></section>}
    <section><h2>Verantwortlich für journalistisch-redaktionelle Inhalte</h2><p>{legal.contentResponsible || legal.representative || 'Nicht konfiguriert'}<br />{legal.street}<br />{legal.city}</p></section>
    <section><h2>Verbraucherstreitbeilegung</h2><p>Der Betreiber erklärt in der finalen rechtlichen Prüfung, ob er bereit oder verpflichtet ist, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p></section>
  </LegalDocument>;
}
