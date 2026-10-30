export class AssistantTransportError extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
    readonly expired = false,
  ) {
    super(message);
  }
}
