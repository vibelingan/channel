"""Check this design package; never contacts providers or runs product code."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
args_parser = argparse.ArgumentParser()
args_parser.add_argument('--schema', action='store_true', help='Also validate JSON Schema with jsonschema package')
args_parser.add_argument('--channel-source', type=Path, help='Original protected Channel checkout when validating from another clone')
args = args_parser.parse_args()
plan = json.loads((ROOT / 'plan.json').read_text())
units = plan['units']
by_id = {item['id']: item for item in units}
assert len(by_id) == len(units) == 23
allowed_statuses = {'planned_not_implemented', 'implemented_verified_offline', 'verified_code_snapshot'}
assert all(item['status'] in allowed_statuses and not item['live_enabled'] for item in units)
for item in units:
    if item['status'] != 'planned_not_implemented':
        assert (ROOT / item['evidence_ref']).is_file(), item['id']
visited, visiting, order = set(), set(), []
def visit(key):
    assert key in by_id, f'Unknown dependency: {key}'
    assert key not in visiting, f'Cycle at {key}'
    if key in visited:
        return
    visiting.add(key)
    for dep in by_id[key]['depends_on']:
        visit(dep)
    visiting.remove(key)
    visited.add(key)
    order.append(key)
for key in by_id:
    visit(key)
for item in units:
    assert (ROOT / item['design']).is_file()
    assert item['id'] in (ROOT / 'EXECUTION-PLAN.md').read_text()
    assert item['primary_test'] or item['id'] in ('SG1.0', 'SG6.0')
links = 0
for file in ROOT.rglob('*.md'):
    if 'reference' in file.relative_to(ROOT).parts:
        continue  # historical source snapshots retain original relative links
    for target in re.findall(r'(?<!!)\[[^\]]+\]\(([^)]+)\)', file.read_text()):
        if target.startswith(('http://', 'https://', '#', 'mailto:')):
            continue
        target = target.split('#', 1)[0].strip('<>')
        assert (file.parent / target).exists(), f'Broken local link {file}: {target}'
        links += 1
common_git = Path(subprocess.check_output(['git', 'rev-parse', '--git-common-dir'], cwd=ROOT, text=True).strip())
if not common_git.is_absolute():
    common_git = (ROOT / common_git).resolve()
channel_source = args.channel_source.resolve() if args.channel_source else common_git.parent
def resolve_source_path(path):
    return Path(path.replace('${CHANNEL_SOURCE}', str(channel_source)).replace('${SALES_WORKTREE}', str(ROOT.parents[1])))

manifest = json.loads((ROOT / 'evidence/source-manifest.json').read_text())
for source in manifest['sources']:
    if 'copy' in source:
        assert hashlib.sha256((ROOT / source['copy']).read_bytes()).hexdigest() == source['sha256']
    if source.get('role') == 'read_only_uncommitted_other_workstream':
        assert hashlib.sha256(resolve_source_path(source['path']).read_bytes()).hexdigest() == source['sha256'], f'Protected source changed: {source["path"]}'
schema_result = 'not_requested'
if args.schema:
    from jsonschema import Draft202012Validator, FormatChecker
    schema = json.loads((ROOT / 'contracts/inquiry.schema.json').read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    validator.validate(json.loads((ROOT / 'contracts/inquiry.example.json').read_text()))
    for name in ('inquiry.invalid-missing-record.json', 'inquiry.invalid-chat-link.json'):
        assert list(validator.iter_errors(json.loads((ROOT / 'contracts' / name).read_text()))), name
    schema_result = '1 valid accepted, 2 invalid rejected; not an authorization test'
print(json.dumps({'status':'passed','unit_count':len(units),'dag':'acyclic','topological_order':order,'local_links_checked':links,'historical_copies':'hashes_match','protected_source_docs':'hashes_match','schema':schema_result,'scope':'design package checks only; no implementation or live validation'},ensure_ascii=False,indent=2))
