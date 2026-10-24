import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildXlsx } from './testing/xlsx-fixture.ts';
import { readSheetJs } from './xlsx-sheetjs.ts';

test('SheetJS adapter preserves the Channel source-sheet contract for the first worksheet', () => {
  const bytes = buildXlsx({
    sheets: [
      {
        name: 'Import',
        rows: [
          [
            ' padded ',
            '000123',
            { numeric: '1.2300e+5' },
            { boolean: true },
            { error: '#DIV/0!' },
            { formula: 'cached formula' },
            { dateSerial: 45291.5 },
          ],
          ['left', null, 'right'],
        ],
      },
      { name: 'Ignored', rows: [['must not be selected']] },
    ],
  });

  assert.deepEqual(readSheetJs(bytes), {
    name: 'Import',
    rows: [
      {
        rowNumber: 1,
        cells: [
          { text: ' padded ', kind: 'text', dateFormatted: false },
          { text: '000123', kind: 'text', dateFormatted: false },
          { text: '1.2300e+5', kind: 'number', dateFormatted: false },
          { text: 'TRUE', kind: 'boolean', dateFormatted: false },
          { text: '#DIV/0!', kind: 'error', dateFormatted: false },
          { text: 'cached formula', kind: 'text', dateFormatted: false },
          { text: '45291.5', kind: 'number', dateFormatted: true },
        ],
      },
      {
        rowNumber: 2,
        cells: [
          { text: 'left', kind: 'text', dateFormatted: false },
          undefined,
          { text: 'right', kind: 'text', dateFormatted: false },
        ],
      },
    ],
  });
});
