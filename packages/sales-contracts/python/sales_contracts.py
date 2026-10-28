"""Shared sales data validation; contains no operator authorization or transport."""
import hashlib
import json
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
KINDS = ('inquiry', 'mail-snapshot', 'control-command', 'approval', 'run-context', 'client-bindings', 'sales-auth-handoff', 'sales-auth-lease', 'sales-auth-request', 'sales-auth-authority', 'sales-auth-permit')
MAX_BYTES = 262_144
MAX_INTEGER = 9_007_199_254_740_991

class ContractValidationError(ValueError):
    pass

def _fail():
    raise ContractValidationError('Expected bounded, lossless JSON')

def canonicalize_json(value):
    active = set()
    budget = 0
    def emit(part):
        nonlocal budget
        try:
            budget += len(part.encode('utf-8'))
        except UnicodeError:
            _fail()
        if budget > MAX_BYTES:
            _fail()
        return part
    def quoted(text):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in text):
            _fail()
        return emit(json.dumps(text, ensure_ascii=False, separators=(',', ':')))
    def encode(item, depth):
        if depth > 64:
            _fail()
        if item is None:
            return emit('null')
        if type(item) is bool:
            return emit('true' if item else 'false')
        if type(item) is int:
            if abs(item) > MAX_INTEGER:
                _fail()
            return emit(str(item))
        if type(item) is str:
            return quoted(item)
        if type(item) not in (list, dict) or id(item) in active:
            _fail()
        active.add(id(item))
        try:
            if type(item) is list:
                emit('['); emit(']')
                parts = []
                for index, child in enumerate(item):
                    if index:
                        emit(',')
                    parts.append(encode(child, depth + 1))
                return '[' + ','.join(parts) + ']'
            if any(type(key) is not str for key in item):
                _fail()
            emit('{'); emit('}')
            parts = []
            for key in sorted(item):
                if parts:
                    emit(',')
                parts.append(quoted(key) + emit(':') + encode(item[key], depth + 1))
            return '{' + ','.join(parts) + '}'
        finally:
            active.remove(id(item))
    return encode(value, 0)

def hash_canonical_json(value):
    return hashlib.sha256(canonicalize_json(value).encode('utf-8')).hexdigest()

def parse_strict_json(raw):
    if type(raw) is not str:
        _fail()
    try:
        if len(raw.encode('utf-8')) > MAX_BYTES:
            _fail()
    except UnicodeError:
        _fail()
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                _fail()
            result[key] = value
        return result
    def integer(text):
        if len(text) > 17:
            _fail()
        result = int(text)
        if abs(result) > MAX_INTEGER:
            _fail()
        return result
    def rejected(_):
        _fail()
    try:
        result = json.loads(raw, object_pairs_hook=pairs, parse_int=integer,
                            parse_float=rejected, parse_constant=rejected)
    except (ValueError, RecursionError) as error:
        raise ContractValidationError('Invalid strict JSON') from error
    canonicalize_json(result)
    return result

_VALIDATORS = {}
for _kind in KINDS:
    _schema = json.loads((ROOT / 'schemas' / f'{_kind}.schema.json').read_text())
    Draft202012Validator.check_schema(_schema)
    _VALIDATORS[_kind] = Draft202012Validator(_schema, format_checker=FormatChecker())

def validate_contract(kind, value):
    if kind not in _VALIDATORS:
        raise ContractValidationError('Unknown contract kind')
    copy = json.loads(canonicalize_json(value))
    if next(_VALIDATORS[kind].iter_errors(copy), None) is not None:
        raise ContractValidationError(f'Invalid {kind}')
    return copy

def parse_contract(kind, raw):
    return validate_contract(kind, parse_strict_json(raw))
