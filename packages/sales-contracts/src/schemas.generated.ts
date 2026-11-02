// Generated from schemas/*.schema.json. Run pnpm generate; do not edit.
export const CONTRACT_SCHEMAS = {
  "inquiry": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:inquiry:1.0",
    "title": "InquirySubmitted",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "event_id",
      "client_id",
      "business_line",
      "source_installation_id",
      "source",
      "source_record_id",
      "source_revision",
      "submitted_at",
      "contact",
      "requirements",
      "product_snapshot_refs",
      "attachment_refs"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "event_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "client_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "business_line": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "source_installation_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "source": {
        "enum": [
          "website_oem",
          "website_product",
          "website_assistant"
        ]
      },
      "source_record_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "source_revision": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "submitted_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?Z$",
        "maxLength": 27,
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "contact": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "email"
        ],
        "properties": {
          "email": {
            "type": "string",
            "format": "email",
            "maxLength": 254,
            "pattern": "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "name": {
            "type": "string",
            "maxLength": 200
          },
          "company": {
            "type": "string",
            "maxLength": 300
          }
        }
      },
      "requirements": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "confirmed_summary"
        ],
        "properties": {
          "confirmed_summary": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000
          },
          "quantity": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1000000000
          }
        }
      },
      "product_snapshot_refs": {
        "type": "array",
        "maxItems": 50,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      },
      "attachment_refs": {
        "type": "array",
        "maxItems": 20,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1800
        }
      }
    }
  },
  "mail-snapshot": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:mail-snapshot:1.0",
    "title": "MailSnapshot",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "task_id",
      "client_id",
      "business_line",
      "logical_message_id",
      "version",
      "source_revision",
      "context_epoch",
      "sender_id",
      "from",
      "reply_to",
      "to",
      "cc",
      "bcc",
      "approved_headers",
      "subject",
      "html_ref",
      "text_ref",
      "attachments",
      "evidence_refs",
      "unresolved_items",
      "content_sha256"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "client_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "business_line": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "logical_message_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "version": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "source_revision": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "context_epoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "sender_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "from": {
        "type": "string",
        "format": "email",
        "maxLength": 254,
        "pattern": "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "reply_to": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "email",
          "maxLength": 254,
          "pattern": "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
          "not": {
            "pattern": "[\\r\\n]"
          }
        },
        "maxItems": 10,
        "minItems": 0,
        "uniqueItems": true
      },
      "to": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "email",
          "maxLength": 254,
          "pattern": "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
          "not": {
            "pattern": "[\\r\\n]"
          }
        },
        "maxItems": 50,
        "minItems": 1,
        "uniqueItems": true
      },
      "cc": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "email",
          "maxLength": 254,
          "pattern": "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
          "not": {
            "pattern": "[\\r\\n]"
          }
        },
        "maxItems": 50,
        "minItems": 0,
        "uniqueItems": true
      },
      "bcc": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "email",
          "maxLength": 254,
          "pattern": "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
          "not": {
            "pattern": "[\\r\\n]"
          }
        },
        "maxItems": 50,
        "minItems": 0,
        "uniqueItems": true
      },
      "approved_headers": {
        "type": "object",
        "additionalProperties": false,
        "required": [],
        "properties": {
          "In-Reply-To": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "References": {
            "type": "string",
            "minLength": 1,
            "maxLength": 998,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          }
        }
      },
      "subject": {
        "type": "string",
        "minLength": 1,
        "maxLength": 998,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "html_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "text_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "attachments": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "artifact_id",
            "filename",
            "mime",
            "size",
            "sha256"
          ],
          "properties": {
            "artifact_id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "pattern": "^[^\\r\\n]+$",
              "not": {
                "pattern": "[\\r\\n]"
              }
            },
            "filename": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "pattern": "^[^/\\\\\\r\\n]+$",
              "not": {
                "pattern": "[\\r\\n]"
              }
            },
            "mime": {
              "type": "string",
              "minLength": 3,
              "maxLength": 100
            },
            "size": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "sha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$",
              "minLength": 64,
              "maxLength": 64
            }
          }
        },
        "maxItems": 20,
        "minItems": 0,
        "uniqueItems": true
      },
      "evidence_refs": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "pattern": "^[^\\r\\n]+$",
          "not": {
            "pattern": "[\\r\\n]"
          }
        },
        "maxItems": 50,
        "minItems": 0,
        "uniqueItems": true
      },
      "unresolved_items": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000
        },
        "maxItems": 50,
        "minItems": 0,
        "uniqueItems": true
      },
      "reply_target": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "inbox_id",
          "thread_id",
          "email_id"
        ],
        "properties": {
          "inbox_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "thread_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "email_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          }
        }
      },
      "content_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$",
        "minLength": 64,
        "maxLength": 64
      },
      "resend_draft_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      }
    }
  },
  "control-command": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:control-command:1.0",
    "title": "ControlCommand",
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schema_version",
          "command_id",
          "action",
          "expected_task_revision",
          "target_version",
          "target_content_sha256"
        ],
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "command_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "action": {
            "const": "approve"
          },
          "expected_task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "target_version": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "target_content_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$",
            "minLength": 64,
            "maxLength": 64
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schema_version",
          "command_id",
          "action",
          "expected_task_revision",
          "instruction"
        ],
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "command_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "action": {
            "const": "revise"
          },
          "expected_task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "instruction": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000,
            "pattern": "[^\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schema_version",
          "command_id",
          "action",
          "expected_task_revision",
          "target_version"
        ],
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "command_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "action": {
            "const": "reject"
          },
          "expected_task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "target_version": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "instruction": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000,
            "pattern": "[^\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schema_version",
          "command_id",
          "action"
        ],
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "command_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "action": {
            "const": "pause"
          },
          "expected_task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schema_version",
          "command_id",
          "action"
        ],
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "command_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "action": {
            "const": "takeover"
          },
          "expected_task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "schema_version",
          "command_id",
          "action",
          "expected_task_revision"
        ],
        "properties": {
          "schema_version": {
            "const": "1.0"
          },
          "command_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "action": {
            "const": "resume"
          },
          "expected_task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "instruction": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4000,
            "pattern": "[^\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
          }
        }
      }
    ]
  },
  "approval": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:approval:1.0",
    "title": "Approval",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "approval_id",
      "client_id",
      "task_id",
      "logical_message_id",
      "operator_id",
      "channel",
      "snapshot_version",
      "content_sha256",
      "sender_id",
      "recipients_sha256",
      "control_epoch",
      "context_epoch",
      "approved_at",
      "expires_at"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "approval_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "client_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "logical_message_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "operator_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "channel": {
        "enum": [
          "wecom",
          "web"
        ]
      },
      "snapshot_version": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "content_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$",
        "minLength": 64,
        "maxLength": 64
      },
      "sender_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "recipients_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$",
        "minLength": 64,
        "maxLength": 64
      },
      "control_epoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "context_epoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "approved_at": {
        "type": "string",
        "format": "date-time",
        "maxLength": 27,
        "pattern": "^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?Z$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "expires_at": {
        "type": "string",
        "format": "date-time",
        "maxLength": 27,
        "pattern": "^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?Z$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      }
    }
  },
  "run-context": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:run-context:1.0",
    "title": "SalesRunContext",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "client_id",
      "business_line",
      "task_id",
      "run_id",
      "runtime_id",
      "source_ref",
      "control_epoch",
      "inquiry_snapshot_ref",
      "output_dir_ref",
      "allowed_tools"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "client_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "business_line": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "run_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "runtime_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "source_ref": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "installation_id",
          "kind",
          "id",
          "revision"
        ],
        "properties": {
          "installation_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "kind": {
            "enum": [
              "website_oem",
              "website_product",
              "website_assistant"
            ]
          },
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          },
          "revision": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[^\\r\\n]+$",
            "not": {
              "pattern": "[\\r\\n]"
            }
          }
        }
      },
      "control_epoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "inquiry_snapshot_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "output_dir_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[^\\r\\n]+$",
        "not": {
          "pattern": "[\\r\\n]"
        }
      },
      "allowed_tools": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "pattern": "^[^\\r\\n]+$",
          "not": {
            "pattern": "[\\r\\n]"
          }
        },
        "maxItems": 30,
        "minItems": 0,
        "uniqueItems": true
      }
    }
  },
  "client-bindings": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:client-bindings:1.0",
    "title": "ClientBindings",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "enabled",
      "bindings"
    ],
    "properties": {
      "schema_version": {
        "const": "1.0"
      },
      "enabled": {
        "type": "boolean"
      },
      "bindings": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "client_id",
            "active",
            "business_lines",
            "source_installation_id",
            "runtime_id",
            "knowledge_scope_ref",
            "credential_refs",
            "resend_team_id",
            "resend_inbox_id",
            "allowed_sender_ids",
            "permitted_operator_ids",
            "automation_mode",
            "test_recipient_allowlist",
            "environment",
            "control_epoch",
            "connections"
          ],
          "properties": {
            "client_id": {
              "$ref": "#/$defs/id"
            },
            "active": {
              "type": "boolean"
            },
            "business_lines": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/id"
              },
              "minItems": 1,
              "maxItems": 20,
              "uniqueItems": true
            },
            "source_installation_id": {
              "$ref": "#/$defs/id"
            },
            "runtime_id": {
              "$ref": "#/$defs/id"
            },
            "knowledge_scope_ref": {
              "$ref": "#/$defs/id"
            },
            "credential_refs": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "channel",
                "resend"
              ],
              "properties": {
                "channel": {
                  "$ref": "#/$defs/id"
                },
                "resend": {
                  "$ref": "#/$defs/id"
                },
                "apollo": {
                  "$ref": "#/$defs/id"
                }
              }
            },
            "resend_team_id": {
              "$ref": "#/$defs/id"
            },
            "resend_inbox_id": {
              "$ref": "#/$defs/id"
            },
            "apollo_workspace_id": {
              "$ref": "#/$defs/id"
            },
            "allowed_sender_ids": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/id"
              },
              "minItems": 1,
              "maxItems": 20,
              "uniqueItems": true
            },
            "permitted_operator_ids": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/id"
              },
              "minItems": 0,
              "maxItems": 50,
              "uniqueItems": true
            },
            "automation_mode": {
              "enum": [
                "disabled",
                "draft_only",
                "test_sending",
                "approval_required"
              ]
            },
            "test_recipient_allowlist": {
              "type": "array",
              "items": {
                "type": "string",
                "format": "email",
                "maxLength": 254,
                "pattern": "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$",
                "not": {
                  "pattern": "[\\r\\n]"
                }
              },
              "minItems": 0,
              "maxItems": 100,
              "uniqueItems": true
            },
            "environment": {
              "enum": [
                "test",
                "production"
              ]
            },
            "control_epoch": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "connections": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "connection_id",
                  "credential_ref",
                  "active",
                  "actor",
                  "actions"
                ],
                "properties": {
                  "connection_id": {
                    "$ref": "#/$defs/id"
                  },
                  "credential_ref": {
                    "$ref": "#/$defs/id"
                  },
                  "active": {
                    "type": "boolean"
                  },
                  "actor": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "kind",
                      "id"
                    ],
                    "properties": {
                      "kind": {
                        "enum": [
                          "runtime",
                          "operator",
                          "publisher"
                        ]
                      },
                      "id": {
                        "$ref": "#/$defs/id"
                      }
                    }
                  },
                  "actions": {
                    "type": "array",
                    "items": {
                      "enum": [
                        "inquiry.read",
                        "product.read",
                        "asset.read",
                        "artifact.write",
                        "mail.send",
                        "mail.approve",
                        "task.pause",
                        "task.takeover",
                        "task.resume",
                        "connection.manage"
                      ]
                    },
                    "minItems": 1,
                    "maxItems": 10,
                    "uniqueItems": true
                  }
                }
              },
              "minItems": 1,
              "maxItems": 100,
              "uniqueItems": true
            }
          }
        },
        "minItems": 0,
        "maxItems": 50,
        "uniqueItems": true
      }
    },
    "$defs": {
      "id": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$",
        "maxLength": 200
      }
    }
  },
  "sales-auth-handoff": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:auth:handoff:1",
    "title": "SourceHandoff",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocol",
      "client_id",
      "business_line",
      "source_installation_id",
      "environment",
      "handoff_sha256",
      "source",
      "state",
      "created_at"
    ],
    "properties": {
      "protocol": {
        "const": "sales-auth/1"
      },
      "client_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "business_line": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "source_installation_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "environment": {
        "enum": [
          "test",
          "production"
        ]
      },
      "handoff_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "source": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "id",
          "revision"
        ],
        "properties": {
          "kind": {
            "enum": [
              "oem",
              "product"
            ]
          },
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "revision": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          }
        }
      },
      "state": {
        "enum": [
          "ready",
          "revoked"
        ]
      },
      "created_at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    }
  },
  "sales-auth-lease": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:auth:lease:1",
    "title": "TaskReadLease",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocol",
      "client_id",
      "business_line",
      "source_installation_id",
      "environment",
      "runtime_id",
      "control_epoch",
      "task_id",
      "run_id",
      "task_revision",
      "connection_id",
      "lease_sha256",
      "handoff_sha256",
      "source",
      "asset_refs",
      "product_scope",
      "allowed_actions",
      "audience",
      "issued_at",
      "expires_at",
      "revoked"
    ],
    "properties": {
      "protocol": {
        "const": "sales-auth/1"
      },
      "client_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "business_line": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "source_installation_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "environment": {
        "enum": [
          "test",
          "production"
        ]
      },
      "runtime_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "control_epoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "run_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "task_revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "connection_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "lease_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "handoff_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "source": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "id",
          "revision"
        ],
        "properties": {
          "kind": {
            "enum": [
              "oem",
              "product"
            ]
          },
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "revision": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          }
        }
      },
      "asset_refs": {
        "type": "array",
        "maxItems": 20,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1800,
          "pattern": "^[A-Za-z0-9_-]+$"
        }
      },
      "product_scope": {
        "const": "approved_catalog"
      },
      "allowed_actions": {
        "type": "array",
        "minItems": 1,
        "maxItems": 3,
        "uniqueItems": true,
        "items": {
          "enum": [
            "inquiry.read",
            "product.read",
            "asset.read"
          ]
        }
      },
      "audience": {
        "const": "channel.sales.read"
      },
      "issued_at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expires_at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "revoked": {
        "type": "boolean"
      }
    }
  },
  "sales-auth-request": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:auth:request:1",
    "title": "TaskReadRequest",
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "protocol",
          "client_id",
          "business_line",
          "source_installation_id",
          "environment",
          "runtime_id",
          "control_epoch",
          "task_id",
          "run_id",
          "task_revision",
          "connection_id",
          "lease_sha256",
          "handoff_sha256",
          "request_id",
          "action",
          "resource"
        ],
        "properties": {
          "protocol": {
            "const": "sales-auth/1"
          },
          "client_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "business_line": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "source_installation_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "environment": {
            "enum": [
              "test",
              "production"
            ]
          },
          "runtime_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "control_epoch": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "task_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "connection_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "lease_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "handoff_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "request_id": {
            "type": "string",
            "minLength": 16,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "action": {
            "const": "inquiry.read"
          },
          "resource": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind",
              "id"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "oem",
                  "product"
                ]
              },
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
              }
            }
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "protocol",
          "client_id",
          "business_line",
          "source_installation_id",
          "environment",
          "runtime_id",
          "control_epoch",
          "task_id",
          "run_id",
          "task_revision",
          "connection_id",
          "lease_sha256",
          "handoff_sha256",
          "request_id",
          "action",
          "resource"
        ],
        "properties": {
          "protocol": {
            "const": "sales-auth/1"
          },
          "client_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "business_line": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "source_installation_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "environment": {
            "enum": [
              "test",
              "production"
            ]
          },
          "runtime_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "control_epoch": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "task_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "connection_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "lease_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "handoff_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "request_id": {
            "type": "string",
            "minLength": 16,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "action": {
            "const": "product.read"
          },
          "resource": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "ids",
              "page",
              "page_size"
            ],
            "properties": {
              "ids": {
                "type": "array",
                "minItems": 1,
                "maxItems": 5,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "id"
                  ],
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
                    },
                    "revision": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
                    }
                  }
                }
              },
              "page": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100000
              },
              "page_size": {
                "type": "integer",
                "minimum": 1,
                "maximum": 50
              }
            }
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "protocol",
          "client_id",
          "business_line",
          "source_installation_id",
          "environment",
          "runtime_id",
          "control_epoch",
          "task_id",
          "run_id",
          "task_revision",
          "connection_id",
          "lease_sha256",
          "handoff_sha256",
          "request_id",
          "action",
          "resource"
        ],
        "properties": {
          "protocol": {
            "const": "sales-auth/1"
          },
          "client_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "business_line": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "source_installation_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "environment": {
            "enum": [
              "test",
              "production"
            ]
          },
          "runtime_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "control_epoch": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "task_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "run_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "task_revision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "connection_id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
          },
          "lease_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "handoff_sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "request_id": {
            "type": "string",
            "minLength": 16,
            "maxLength": 128,
            "pattern": "^[A-Za-z0-9_-]+$"
          },
          "action": {
            "const": "asset.read"
          },
          "resource": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "ref"
            ],
            "properties": {
              "ref": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1800,
                "pattern": "^[A-Za-z0-9_-]+$"
              },
              "range": {
                "type": "string",
                "maxLength": 80,
                "pattern": "^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$"
              }
            }
          }
        }
      }
    ]
  },
  "sales-auth-authority": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:auth:authority:1",
    "title": "TaskAuthority",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocol",
      "client_id",
      "business_line",
      "source_installation_id",
      "environment",
      "runtime_id",
      "control_epoch",
      "task_id",
      "run_id",
      "task_revision",
      "handoff_sha256",
      "source_verified",
      "mode",
      "work_state",
      "allowed_actions"
    ],
    "properties": {
      "protocol": {
        "const": "sales-auth/1"
      },
      "client_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "business_line": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "source_installation_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "environment": {
        "enum": [
          "test",
          "production"
        ]
      },
      "runtime_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_:/.-]*$"
      },
      "control_epoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "task_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "run_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9_-]+$"
      },
      "task_revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "handoff_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "source_verified": {
        "type": "boolean"
      },
      "mode": {
        "enum": [
          "agent_active",
          "paused",
          "human_owned",
          "disabled",
          "cancelled"
        ]
      },
      "work_state": {
        "enum": [
          "preparing",
          "waiting",
          "review_ready",
          "finished",
          "failed"
        ]
      },
      "allowed_actions": {
        "type": "array",
        "minItems": 1,
        "maxItems": 3,
        "uniqueItems": true,
        "items": {
          "enum": [
            "inquiry.read",
            "product.read",
            "asset.read"
          ]
        }
      }
    }
  },
  "sales-auth-permit": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "urn:channel:sales:auth:permit:1",
    "title": "TaskPermit",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocol",
      "request_sha256",
      "allowed",
      "issued_at",
      "expires_at"
    ],
    "properties": {
      "protocol": {
        "const": "sales-auth/1"
      },
      "request_sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "allowed": {
        "const": true
      },
      "issued_at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expires_at": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    }
  }
};
