import { afterEach, describe, expect, it } from 'vitest';
import { legalConfiguration } from './legal';

const keys = ['LEGAL_OPERATOR_NAME', 'LEGAL_REPRESENTATIVE', 'LEGAL_STREET', 'LEGAL_CITY', 'LEGAL_COUNTRY', 'LEGAL_EMAIL'] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  keys.forEach((key) => {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  });
});

describe('legal configuration', () => {
  it('rejects an incomplete public legal identity', () => {
    keys.forEach((key) => delete process.env[key]);
    expect(legalConfiguration().complete).toBe(false);
  });

  it('accepts the required operator and contact fields', () => {
    process.env.LEGAL_OPERATOR_NAME = 'Example GmbH';
    process.env.LEGAL_REPRESENTATIVE = 'Example Person';
    process.env.LEGAL_STREET = 'Example Street 1';
    process.env.LEGAL_CITY = '12345 Example';
    process.env.LEGAL_EMAIL = 'legal@example.test';
    expect(legalConfiguration()).toMatchObject({ complete: true, country: 'Deutschland' });
  });
});
