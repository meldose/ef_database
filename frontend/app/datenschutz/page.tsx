import type { Metadata } from 'next';
import { LegalDocument } from '@/components/LegalDocument';
import { legalConfiguration } from '@/lib/legal';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Datenschutz · Altegro', robots: { index: true, follow: true } };

export default function DatenschutzPage() {
  const legal = legalConfiguration();
  return <LegalDocument title="Datenschutzerklärung" eyebrow="Informationen nach Art. 13 und 14 DSGVO" complete={legal.complete}>
    <section><h2>1. Verantwortlicher</h2><address><strong>{legal.operatorName || 'Betreibername nicht konfiguriert'}</strong><br />{legal.street}<br />{legal.city}<br />{legal.country}<br />E-Mail: {legal.email ? <a href={`mailto:${legal.email}`}>{legal.email}</a> : 'Nicht konfiguriert'}</address></section>
    <section><h2>2. Verarbeitete Daten</h2><p>Altegro verarbeitet Benutzer- und Kontodaten, Anmelde- und Sicherheitsprotokolle, Rollen und Berechtigungen, Roboterdaten und Telemetrie, technische Ereignisse, Wartungs- und Serviceinformationen, Supportnachrichten sowie revisionssichere Aktivitätsnachweise.</p></section>
    <section><h2>3. Zwecke und Rechtsgrundlagen</h2><p>Die Verarbeitung erfolgt zur Bereitstellung und Absicherung der Plattform, Durchführung von Service- und Wartungsleistungen, Erkennung technischer Störungen, Erfüllung vertraglicher und gesetzlicher Pflichten sowie zur Wahrung berechtigter Sicherheits- und Betriebsinteressen. Rechtsgrundlagen sind insbesondere Art. 6 Abs. 1 lit. b, c und f DSGVO.</p></section>
    <section><h2>4. Empfänger und Auftragsverarbeiter</h2><p>Daten werden nur an berechtigte Kunden-, Service- und Plattformnutzer sowie an vertraglich gebundene Hosting-, Kommunikations-, CRM-, Service- und Robotik-Anbieter übermittelt, soweit dies für den jeweiligen Zweck erforderlich ist. Übermittlungen in Drittländer erfolgen nur mit einer Grundlage nach Kapitel V DSGVO.</p></section>
    <section><h2>5. Speicherdauer</h2><p>Personenbezogene Daten werden nur so lange gespeichert, wie dies für den jeweiligen Zweck, vertragliche Nachweise, Sicherheitsanforderungen oder gesetzliche Aufbewahrungspflichten erforderlich ist. Sitzungen und technische Protokolle werden regelmäßig begrenzt; Audit-, Wartungs- und Robot-Passport-Nachweise können aufgrund vertraglicher oder rechtlicher Nachweispflichten länger aufbewahrt werden.</p></section>
    <section><h2>6. Cookies und lokale Speicherung</h2><p>Die Plattform verwendet ein technisch notwendiges, geschütztes Sitzungscookie. Darstellungs- und Bedienpräferenzen können lokal im Browser gespeichert werden. Marketing- oder Tracking-Cookies werden nicht eingesetzt, sofern sie nicht später ausdrücklich ergänzt und entsprechend eingewilligt werden.</p></section>
    <section><h2>7. Ihre Rechte</h2><p>Betroffene Personen haben im gesetzlichen Umfang Rechte auf Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch. Eine erteilte Einwilligung kann jederzeit mit Wirkung für die Zukunft widerrufen werden. Beschwerden können an die zuständige Datenschutzaufsichtsbehörde gerichtet werden.</p></section>
    <section><h2>8. Sicherheit und Kontakt</h2><p>Altegro setzt rollenbasierte Zugriffe, Transportverschlüsselung, verwaltete Geheimnisse, Protokollierung und technische Überwachung ein. Datenschutzanfragen richten Sie an {legal.email ? <a href={`mailto:${legal.email}`}>{legal.email}</a> : 'die noch zu konfigurierende Kontaktadresse'}.</p></section>
  </LegalDocument>;
}
