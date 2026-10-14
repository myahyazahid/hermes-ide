export interface ScriptedReply {
  text?: string;
  toolCalls?: { name: string; arguments: object }[];
  delayMs?: number;
  rejectTools?: boolean;
  /** Only answer the agent whose user message contains this text. */
  when?: string;
}

export interface MockRequest {
  method: string;
  path: string;
  auth?: string;
  body?: any;
}

export interface OpenAIMock {
  port: number;
  baseUrl: string;
  requests: MockRequest[];
  script(replies: ScriptedReply[]): void;
  scriptFim(replies: { text: string; delayMs?: number }[]): void;
  fimRequests(): MockRequest[];
  setDefault(reply: ScriptedReply): void;
  failModel(model: string, status: number): void;
  chatRequests(): MockRequest[];
  close(): Promise<void>;
}

export function startOpenAIMock(opts?: {
  port?: number;
  apiKey?: string;
  models?: Record<string, unknown>[];
}): Promise<OpenAIMock>;

export function bagOfWords(text: string, dims?: number): number[];
