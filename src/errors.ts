/**
 * Typed error hierarchy for eve-lark.
 *
 * All errors extend a common base so consumers can `instanceof LarkChannelError`
 * to catch anything thrown by the channel.
 */

export class LarkChannelError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LarkConfigError extends LarkChannelError {}

export class LarkSignatureError extends LarkChannelError {}

export class LarkDecryptError extends LarkChannelError {}

export interface LarkApiErrorBody {
  code?: number | undefined;
  msg?: string | undefined;
}

export class LarkApiError extends LarkChannelError {
  readonly code: number | undefined;
  readonly body: LarkApiErrorBody | undefined;
  readonly status: number | undefined;

  constructor(
    message: string,
    opts?: {
      code?: number | undefined;
      body?: LarkApiErrorBody | undefined;
      status?: number | undefined;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts?.cause });
    this.code = opts?.code;
    this.body = opts?.body;
    this.status = opts?.status;
  }
}
