import json
from pathlib import Path
import unittest
from sales_contracts import validate_contract, parse_contract, parse_strict_json, canonicalize_json

ROOT = Path(__file__).resolve().parents[1]

class ContractsTest(unittest.TestCase):
    def test_all_contract_fixtures(self):
        for kind in ('inquiry', 'mail-snapshot', 'control-command', 'approval', 'run-context'):
            with self.subTest(kind=kind):
                value = json.loads((ROOT / 'fixtures' / f'{kind}.json').read_text())
                self.assertEqual(validate_contract(kind, value), value)
                with self.assertRaises(ValueError):
                    validate_contract(kind, {**value, 'schema_version': '2.0'})
    def test_no_coercion_or_chat_link(self):
        value = json.loads((ROOT / 'fixtures/inquiry.json').read_text())
        with self.assertRaises(ValueError):
            validate_contract('inquiry', {**value, 'conversation_id': 'private-chat'})
        with self.assertRaises(ValueError):
            validate_contract('inquiry', {**value, 'requirements': {'confirmed_summary': 'need', 'quantity': '500'}})
    def test_unicode_and_lexical_integer_keys(self):
        self.assertEqual(canonicalize_json({'😀': 1, '\uE000': 2, '2': 2, '10': 10, '1': 1}), '{"1":1,"10":10,"2":2,"":2,"😀":1}')
    def test_strict_wire(self):
        for raw in ['{"id":1,"\\u0069d":2}', '9007199254740993', '1.0', '1e0', '{"a":1,}', '/*x*/{}', 'NaN', '"\\ud800"']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_strict_json(raw)
    def test_non_json_values(self):
        cycle = {}; cycle['self'] = cycle
        for value in [1.5, float('inf'), 9007199254740992, {1: 'number-key'}, ('tuple',), cycle]:
            with self.subTest(value=type(value)), self.assertRaises(ValueError):
                canonicalize_json(value)
    def test_pause_does_not_require_stale_revision(self):
        self.assertEqual(parse_contract('control-command', '{"schema_version":"1.0","command_id":"pause_1","action":"pause"}')['action'], 'pause')
        with self.assertRaises(ValueError):
            validate_contract('control-command', {'schema_version':'1.0','command_id':'approve_1','action':'approve'})

if __name__ == '__main__':
    unittest.main()
