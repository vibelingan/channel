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
