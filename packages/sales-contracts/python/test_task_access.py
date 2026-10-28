import json
from pathlib import Path
import unittest
from sales_contracts import hash_canonical_json
from task_access import authorize_task_read, issue_task_permit, TaskAccessDenied

ROOT = Path(__file__).resolve().parents[1]


def fixture():
    return json.loads((ROOT / "fixtures/task-access.json").read_text())


def inputs(case):
    f = fixture()
    for key in ["lease", "handoff", "permit", "request"]:
        f[key].update(case.get(key + "_patch", {}))
    f["now"] = case.get("now", f["now"])
    if not case.get("permit_patch", {}).get("request_sha256"):
        f["permit"]["request_sha256"] = hash_canonical_json(f["request"])
    return f


class TaskAccessTest(unittest.TestCase):
    def test_shared_authorization_cases(self):
        cases = json.loads((ROOT / "fixtures/task-access-cases.json").read_text())
        for case in cases:
            f = inputs(case)
            with self.subTest(case=case["id"]):
                if case["accepted"]:
                    self.assertEqual(
                        authorize_task_read(
                            f["lease"],
                            f["handoff"],
                            f["permit"],
                            f["request"],
                            f["now"],
                        ),
                        f["request"],
                    )
                else:
                    with self.assertRaises(TaskAccessDenied):
                        authorize_task_read(
                            f["lease"],
                            f["handoff"],
                            f["permit"],
                            f["request"],
                            f["now"],
                        )

    def test_current_authority_and_strict_types(self):
        f = fixture()
        self.assertEqual(
            issue_task_permit(f["request"], f["authority"], f["now"]), f["permit"]
        )
        for patch in [
            {"source_verified": False},
            {"source_verified": 1},
            {"mode": "paused"},
            {"mode": "human_owned"},
            {"mode": "unknown"},
            {"work_state": "finished"},
            {"run_id": "old_run"},
            {"task_revision": 2},
            {"task_revision": True},
            {"client_id": "client_b"},
            {"control_epoch": 2},
            {"allowed_actions": ["product.read"]},
        ]:
            with self.subTest(patch=patch), self.assertRaises(TaskAccessDenied):
                issue_task_permit(f["request"], {**f["authority"], **patch}, f["now"])


if __name__ == "__main__":
    unittest.main()
