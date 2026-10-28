// Generated from schemas/*.schema.json. Run pnpm generate; do not edit.
export interface InquirySubmitted {
  schema_version: "1.0";
  event_id: string;
  client_id: string;
  business_line: string;
  source_installation_id: string;
  source: "website_oem" | "website_product" | "website_assistant";
  source_record_id: string;
  source_revision: string;
  submitted_at: string;
  contact: {
    email: string;
    name?: string;
    company?: string;
  };
  requirements: {
    confirmed_summary: string;
    quantity?: number;
  };
  /**
   * @maxItems 50
   */
  product_snapshot_refs: string[];
  /**
   * @maxItems 20
   */
  attachment_refs: string[];
}

export interface MailSnapshot {
  schema_version: "1.0";
  task_id: string;
  client_id: string;
  business_line: string;
  logical_message_id: string;
  version: number;
  source_revision: string;
  context_epoch: number;
  sender_id: string;
  from: string;
  /**
   * @minItems 0
   * @maxItems 10
   */
  reply_to: string[];
  /**
   * @minItems 1
   * @maxItems 50
   */
  to: [string, ...string[]];
  /**
   * @minItems 0
   * @maxItems 50
   */
  cc: string[];
  /**
   * @minItems 0
   * @maxItems 50
   */
  bcc: string[];
  approved_headers: {
    "In-Reply-To"?: string;
    References?: string;
  };
  subject: string;
  html_ref: string;
  text_ref: string;
  /**
   * @minItems 0
   * @maxItems 20
   */
  attachments: {
    artifact_id: string;
    filename: string;
    mime: string;
    size: number;
    sha256: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 50
   */
  evidence_refs: string[];
  /**
   * @minItems 0
   * @maxItems 50
   */
  unresolved_items: string[];
  reply_target?: {
    inbox_id: string;
    thread_id: string;
    email_id: string;
  };
  content_sha256: string;
  resend_draft_id?: string;
}

export type ControlCommand =
  | {
      schema_version: "1.0";
      command_id: string;
      action: "approve";
      expected_task_revision: number;
      target_version: number;
      target_content_sha256: string;
    }
  | {
      schema_version: "1.0";
      command_id: string;
      action: "revise";
      expected_task_revision: number;
      instruction: string;
    }
  | {
      schema_version: "1.0";
      command_id: string;
      action: "reject";
      expected_task_revision: number;
      target_version: number;
      instruction?: string;
    }
  | {
      schema_version: "1.0";
      command_id: string;
      action: "pause";
      expected_task_revision?: number;
    }
  | {
      schema_version: "1.0";
      command_id: string;
      action: "takeover";
      expected_task_revision?: number;
    }
  | {
      schema_version: "1.0";
      command_id: string;
      action: "resume";
      expected_task_revision: number;
      instruction?: string;
    };

export interface Approval {
  schema_version: "1.0";
  approval_id: string;
  client_id: string;
  task_id: string;
  logical_message_id: string;
  operator_id: string;
  channel: "wecom" | "web";
  snapshot_version: number;
  content_sha256: string;
  sender_id: string;
  recipients_sha256: string;
  control_epoch: number;
  context_epoch: number;
  approved_at: string;
  expires_at: string;
}

export interface SalesRunContext {
  schema_version: "1.0";
  client_id: string;
  business_line: string;
  task_id: string;
  run_id: string;
  runtime_id: string;
  source_ref: {
    installation_id: string;
    kind: "website_oem" | "website_product" | "website_assistant";
    id: string;
    revision: string;
  };
  control_epoch: number;
  inquiry_snapshot_ref: string;
  output_dir_ref: string;
  /**
   * @minItems 0
   * @maxItems 30
   */
  allowed_tools: string[];
}

export type Id = string;

export interface ClientBindings {
  schema_version: "1.0";
  enabled: boolean;
  /**
   * @minItems 0
   * @maxItems 50
   */
  bindings: {
    client_id: Id;
    active: boolean;
    /**
     * @minItems 1
     * @maxItems 20
     */
    business_lines: [Id, ...Id[]];
    source_installation_id: Id;
    runtime_id: Id;
    knowledge_scope_ref: Id;
    credential_refs: {
      channel: Id;
      resend: Id;
      apollo?: Id;
    };
    resend_team_id: Id;
    resend_inbox_id: Id;
    apollo_workspace_id?: Id;
    /**
     * @minItems 1
     * @maxItems 20
     */
    allowed_sender_ids: [Id, ...Id[]];
    /**
     * @minItems 0
     * @maxItems 50
     */
    permitted_operator_ids: Id[];
    automation_mode: "disabled" | "draft_only" | "test_sending" | "approval_required";
    /**
     * @minItems 0
     * @maxItems 100
     */
    test_recipient_allowlist: string[];
    environment: "test" | "production";
    control_epoch: number;
    /**
     * @minItems 1
     * @maxItems 100
     */
    connections: [
      {
        connection_id: Id;
        credential_ref: Id;
        active: boolean;
        actor: {
          kind: "runtime" | "operator" | "publisher";
          id: Id;
        };
        /**
         * @minItems 1
         * @maxItems 10
         */
        actions: [
          (
            | "inquiry.read"
            | "product.read"
            | "asset.read"
            | "artifact.write"
            | "mail.send"
            | "mail.approve"
            | "task.pause"
            | "task.takeover"
            | "task.resume"
            | "connection.manage"
          ),
          ...(
            | "inquiry.read"
            | "product.read"
            | "asset.read"
            | "artifact.write"
            | "mail.send"
            | "mail.approve"
            | "task.pause"
            | "task.takeover"
            | "task.resume"
            | "connection.manage"
          )[]
        ];
      },
      ...{
        connection_id: Id;
        credential_ref: Id;
        active: boolean;
        actor: {
          kind: "runtime" | "operator" | "publisher";
          id: Id;
        };
        /**
         * @minItems 1
         * @maxItems 10
         */
        actions: [
          (
            | "inquiry.read"
            | "product.read"
            | "asset.read"
            | "artifact.write"
            | "mail.send"
            | "mail.approve"
            | "task.pause"
            | "task.takeover"
            | "task.resume"
            | "connection.manage"
          ),
          ...(
            | "inquiry.read"
            | "product.read"
            | "asset.read"
            | "artifact.write"
            | "mail.send"
            | "mail.approve"
            | "task.pause"
            | "task.takeover"
            | "task.resume"
            | "connection.manage"
          )[]
        ];
      }[]
    ];
  }[];
}

export interface SourceHandoff {
  protocol: "sales-auth/1";
  client_id: string;
  business_line: string;
  source_installation_id: string;
  environment: "test" | "production";
  handoff_sha256: string;
  source: {
    kind: "oem" | "product";
    id: string;
    revision: string;
  };
  state: "ready" | "revoked";
  created_at: number;
}

export interface TaskReadLease {
  protocol: "sales-auth/1";
  client_id: string;
  business_line: string;
  source_installation_id: string;
  environment: "test" | "production";
  runtime_id: string;
  control_epoch: number;
  task_id: string;
  run_id: string;
  task_revision: number;
  connection_id: string;
  lease_sha256: string;
  handoff_sha256: string;
  source: {
    kind: "oem" | "product";
    id: string;
    revision: string;
  };
  /**
   * @maxItems 20
   */
  asset_refs: string[];
  product_scope: "approved_catalog";
  /**
   * @minItems 1
   * @maxItems 3
   */
  allowed_actions: [
    "inquiry.read" | "product.read" | "asset.read",
    ...("inquiry.read" | "product.read" | "asset.read")[]
  ];
  audience: "channel.sales.read";
  issued_at: number;
  expires_at: number;
  revoked: boolean;
}

export type TaskReadRequest =
  | {
      protocol: "sales-auth/1";
      client_id: string;
      business_line: string;
      source_installation_id: string;
      environment: "test" | "production";
      runtime_id: string;
      control_epoch: number;
      task_id: string;
      run_id: string;
      task_revision: number;
      connection_id: string;
      lease_sha256: string;
      handoff_sha256: string;
      request_id: string;
      action: "inquiry.read";
      resource: {
        kind: "oem" | "product";
        id: string;
      };
    }
  | {
      protocol: "sales-auth/1";
      client_id: string;
      business_line: string;
      source_installation_id: string;
      environment: "test" | "production";
      runtime_id: string;
      control_epoch: number;
      task_id: string;
      run_id: string;
      task_revision: number;
      connection_id: string;
      lease_sha256: string;
      handoff_sha256: string;
      request_id: string;
      action: "product.read";
      resource: {
        /**
         * @minItems 1
         * @maxItems 5
         */
        ids: [
          {
            id: string;
            revision?: string;
          },
          ...{
            id: string;
            revision?: string;
          }[]
        ];
        page: number;
        page_size: number;
      };
    }
  | {
      protocol: "sales-auth/1";
      client_id: string;
      business_line: string;
      source_installation_id: string;
      environment: "test" | "production";
      runtime_id: string;
      control_epoch: number;
      task_id: string;
      run_id: string;
      task_revision: number;
      connection_id: string;
      lease_sha256: string;
      handoff_sha256: string;
      request_id: string;
      action: "asset.read";
      resource: {
        ref: string;
        range?: string;
      };
    };

export interface TaskAuthority {
  protocol: "sales-auth/1";
  client_id: string;
  business_line: string;
  source_installation_id: string;
  environment: "test" | "production";
  runtime_id: string;
  control_epoch: number;
  task_id: string;
  run_id: string;
  task_revision: number;
  handoff_sha256: string;
  source_verified: boolean;
  mode: "agent_active" | "paused" | "human_owned" | "disabled" | "cancelled";
  work_state: "preparing" | "waiting" | "review_ready" | "finished" | "failed";
  /**
   * @minItems 1
   * @maxItems 3
   */
  allowed_actions: [
    "inquiry.read" | "product.read" | "asset.read",
    ...("inquiry.read" | "product.read" | "asset.read")[]
  ];
}

export interface TaskPermit {
  protocol: "sales-auth/1";
  request_sha256: string;
  allowed: true;
  issued_at: number;
  expires_at: number;
}
