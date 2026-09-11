export interface LegalConfiguration {
  operatorName: string;
  representative: string;
  street: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  register: string;
  vatId: string;
  contentResponsible: string;
  complete: boolean;
}

export function legalConfiguration(): LegalConfiguration {
  const configuration = {
    operatorName: process.env.LEGAL_OPERATOR_NAME || '',
    representative: process.env.LEGAL_REPRESENTATIVE || '',
    street: process.env.LEGAL_STREET || '',
    city: process.env.LEGAL_CITY || '',
    country: process.env.LEGAL_COUNTRY || 'Deutschland',
    email: process.env.LEGAL_EMAIL || '',
    phone: process.env.LEGAL_PHONE || '',
    register: process.env.LEGAL_REGISTER || '',
    vatId: process.env.LEGAL_VAT_ID || '',
    contentResponsible: process.env.LEGAL_CONTENT_RESPONSIBLE || ''
  };
  return { ...configuration, complete: ['operatorName', 'representative', 'street', 'city', 'email'].every((key) => Boolean(configuration[key as keyof typeof configuration])) };
}
