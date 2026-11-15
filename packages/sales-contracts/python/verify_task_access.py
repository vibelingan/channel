import json
import sys
from test_task_access import inputs
from task_access import authorize_task_read

results = []
for case in json.load(sys.stdin):
    f = inputs(case)
    try:
        authorize_task_read(
            f["lease"], f["handoff"], f["permit"], f["request"], f["now"]
        )
        accepted = True
    except ValueError:
        accepted = False
    results.append({"id": case["id"], "accepted": accepted})
print(json.dumps(results))
