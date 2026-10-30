/**
 * Normalisation, against the **shared fixture list**.
 *
 * `PART_NUMBER_SPELLINGS` below is the same list the backend's `test_normalize.py`
 * uses. That is the entire mitigation for the duplicated normalisation logic
 * (ARCHITECTURE.md §8.3): the rules exist on both sides because offline search has no
 * server, and the list is what turns "they should agree" into a test that fails when
 * they do not.
 *
 * If this list changes, the backend's copy changes in the same change set.
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeName,
  normalizePhone,
  normalizeSku,
  normalizeVehicleNumber,
  rankOffline,
} from './normalize';

/**
 * Real part-number spellings a counter hand types, grouped by the product they mean.
 *
 * Shared with `bmbackend/tests/unit/test_normalize.py`.
 */
const PART_NUMBER_SPELLINGS: Array<readonly string[]> = [
  ['TT-407-BS', 'tt407bs', 'tt 407 bs', 'TT.407.BS', 'tt/407/bs', 'Tt-407-Bs'],
  ['MB-CP-01', 'mbcp01', 'mb cp 01', 'MB.CP.01'],
  ['6204-2RS', '62042rs', '6204 2rs', '6204/2RS'],
  ['HF-3509', 'hf3509', 'hf 3509', 'HF.3509'],
];

describe('normalizeSku — every spelling of one part code is one key (FR-CAT-006)', () => {
  for (const spellings of PART_NUMBER_SPELLINGS) {
    it(`treats ${spellings.join(' / ')} as the same part`, () => {
      const keys = new Set(spellings.map(normalizeSku));
      expect(keys.size).toBe(1);
    });
  }

  it('keeps genuinely different codes different', () => {
    // The rule removes separators; it must not remove information. `TT-407` and
    // `TT-408` are different parts and a cashier picking the wrong one is a wrong
    // part fitted to a customer's vehicle.
    expect(normalizeSku('TT-407-BS')).not.toBe(normalizeSku('TT-408-BS'));
    expect(normalizeSku('6204')).not.toBe(normalizeSku('6205'));
  });

  it('strips accents so a decomposed and a composed form match', () => {
    expect(normalizeSku('DÜRR-12')).toBe(normalizeSku('DURR-12'));
  });

  it('returns an empty key for input with no alphanumerics', () => {
    // `''` here, `None` on the server, and the difference is deliberate: there the
    // value is a stored column under a partial unique index that has to permit many
    // products with no part code, while here it is only ever a search key.
    // `rankOffline` checks for the empty string before comparing, so an empty key
    // never matches everything. Recorded in both suites rather than left to be
    // rediscovered.
    expect(normalizeSku('---')).toBe('');
  });
});

describe('normalizeName — a name is read by a human, so spaces survive', () => {
  it('collapses runs of whitespace to one space', () => {
    expect(normalizeName('  Brake   Shoe  Set ')).toBe('brake shoe set');
  });

  it('does not remove the spaces that make a name readable', () => {
    // Deliberately different from `normalizeSku`: `brakeshoeset` would make a prefix
    // search on "brake shoe" impossible.
    expect(normalizeName('Brake Shoe Set')).toBe('brake shoe set');
    expect(normalizeName('Brake Shoe Set')).not.toBe('brakeshoeset');
  });
});

describe('normalizePhone and normalizeVehicleNumber', () => {
  it('compares phone numbers by their last ten digits', () => {
    // One number however it was written (FR-CUST-004). Keeping the last ten drops a
    // country code or a trunk `0` without having to work out which is which.
    //
    // This suite is why the rule is here at all: the client originally kept every
    // digit, so `+91-9876543210` hashed differently from `9876543210` and the same
    // customer would have been filed twice — once from a bill typed offline and once
    // from the same bill typed online.
    const forms = [
      '9876543210',
      '98765 43210',
      '(98765) 43210',
      '+91-9876543210',
      '098765 43210',
    ];
    for (const written of forms) {
      expect(normalizePhone(written), written).toBe('9876543210');
    }
  });

  it('compares vehicle numbers however they are written', () => {
    const forms = ['KA 01 AB 1234', 'ka-01-ab-1234', 'KA01AB1234'];
    expect(new Set(forms.map(normalizeVehicleNumber)).size).toBe(1);
  });
});

describe('rankOffline — the same tier order as the server', () => {
  const rows = [
    {
      normalized_sku: normalizeSku('TT-407-BS'),
      normalized_name: normalizeName('Brake Shoe Set Tata 407'),
      barcode: null,
    },
    {
      normalized_sku: normalizeSku('TT-407-BSX'),
      normalized_name: normalizeName('Brake Shoe Set Tata 407 Extra'),
      barcode: null,
    },
    {
      normalized_sku: normalizeSku('ZZ-999'),
      normalized_name: normalizeName('Tata Brake Cable'),
      barcode: '8901234567890',
    },
  ];

  it('puts an exact SKU match first', () => {
    const ranked = rankOffline(rows, 'tt407bs');
    expect(ranked[0]?.kind).toBe('exact_sku');
    expect(ranked[0]?.item.normalized_sku).toBe('tt407bs');
  });

  it('ranks a SKU prefix above a name prefix', () => {
    const ranked = rankOffline(rows, 'tt407');
    expect(ranked[0]?.kind).toBe('sku_prefix');
  });

  it('matches a name prefix when no code matches', () => {
    const ranked = rankOffline(rows, 'brake shoe');
    expect(ranked[0]?.kind).toBe('name_prefix');
  });

  it('matches a barcode as a code, not as a name', () => {
    const ranked = rankOffline(rows, '8901234567890');
    expect(ranked[0]?.kind).toBe('barcode');
  });

  it('falls back to a substring and says so', () => {
    // Labelled `fuzzy` because there is no trigram similarity offline. The UI tells the
    // user results come from the cached list and may be incomplete rather than
    // implying offline search is as good as online.
    const ranked = rankOffline(rows, 'cable');
    expect(ranked[0]?.kind).toBe('fuzzy');
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(rankOffline(rows, '')).toEqual([]);
    expect(rankOffline(rows, '   ')).toEqual([]);
  });

  it('breaks ties by name so results do not reorder between keystrokes', () => {
    const ranked = rankOffline(rows, 'tt407');
    const names = ranked.map((hit) => hit.item.normalized_name);
    expect(names).toEqual([...names].sort());
  });
});
