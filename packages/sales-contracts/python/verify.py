import json
import sys
from sales_contracts import canonicalize_json, hash_canonical_json, parse_strict_json, parse_contract, validate_contract

cases = json.load(sys.stdin)
results = []
for case in cases:
    try:
        if case['operation'] == 'validate':
            validate_contract(case['kind'], case['value'])
            result = {'accepted': True}
        elif case['operation'] == 'parse':
            parse_contract(case['kind'], case['raw'])
            result = {'accepted': True}
        else:
            value = parse_strict_json(case['raw'])
            result = {'accepted': True, 'canonical': canonicalize_json(value), 'sha256': hash_canonical_json(value)}
    except ValueError:
        result = {'accepted': False}
    results.append({'id': case['id'], **result})
print(json.dumps(results, ensure_ascii=False))
