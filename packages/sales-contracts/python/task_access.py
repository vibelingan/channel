"""Sales task policy; caller must authenticate transport and load current records."""

if __package__:
    from .sales_contracts import hash_canonical_json, validate_contract, MAX_INTEGER
else:
    from sales_contracts import hash_canonical_json, validate_contract, MAX_INTEGER


class TaskAccessDenied(ValueError):
    pass


SCOPE = ("client_id", "business_line", "source_installation_id", "environment")
TASK = (
    *SCOPE,
    "runtime_id",
    "control_epoch",
    "task_id",
    "run_id",
    "task_revision",
    "handoff_sha256",
)


def authorize_task_read(lease_value, handoff_value, permit_value, request_value, now):
    try:
        _clock(now)
        lease = validate_contract("sales-auth-lease", lease_value)
        handoff = validate_contract("sales-auth-handoff", handoff_value)
        permit = validate_contract("sales-auth-permit", permit_value)
        request = validate_contract("sales-auth-request", request_value)
        for key in (*TASK, "connection_id", "lease_sha256"):
            _match(lease[key], request[key])
        for key in (*SCOPE, "handoff_sha256"):
            _match(lease[key], handoff[key])
        _match(
            hash_canonical_json(lease["source"]), hash_canonical_json(handoff["source"])
        )
        if (
            handoff["state"] != "ready"
            or handoff["created_at"] > lease["issued_at"]
            or lease["revoked"]
        ):
            raise TaskAccessDenied()
        _window(lease["issued_at"], lease["expires_at"], now, 300)
        _window(permit["issued_at"], permit["expires_at"], now, 10)
        _match(permit["request_sha256"], hash_canonical_json(request))
        if request["action"] not in lease["allowed_actions"]:
            raise TaskAccessDenied()
        if request["action"] == "inquiry.read" and any(
            request["resource"][key] != lease["source"][key] for key in ["kind", "id"]
        ):
            raise TaskAccessDenied()
        if (
            request["action"] == "asset.read"
            and request["resource"]["ref"] not in lease["asset_refs"]
        ):
            raise TaskAccessDenied()
        return request
    except (ValueError, TypeError, KeyError):
        raise TaskAccessDenied("Sales task access denied") from None


def issue_task_permit(request_value, authority_value, now):
    try:
        _clock(now)
        _clock(now + 10)
        request = validate_contract("sales-auth-request", request_value)
        authority = validate_contract("sales-auth-authority", authority_value)
        for key in TASK:
            _match(authority[key], request[key])
        if (
            authority["source_verified"] is not True
            or authority["mode"] != "agent_active"
            or authority["work_state"] != "preparing"
            or request["action"] not in authority["allowed_actions"]
        ):
            raise TaskAccessDenied()
        return {
            "protocol": "sales-auth/1",
            "allowed": True,
            "request_sha256": hash_canonical_json(request),
            "issued_at": now,
            "expires_at": now + 10,
        }
    except (ValueError, TypeError, KeyError):
        raise TaskAccessDenied("Sales task access denied") from None


def _clock(now):
    if type(now) is not int or not 0 <= now <= MAX_INTEGER:
        raise TaskAccessDenied()


def _match(left, right):
    if type(left) is not type(right) or left != right:
        raise TaskAccessDenied()


def _window(start, end, now, maximum):
    if start > now or end <= now or end <= start or end - start > maximum:
        raise TaskAccessDenied()
