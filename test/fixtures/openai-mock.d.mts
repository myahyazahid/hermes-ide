export interface ScriptedReply {
  text?: string;
  toolCalls?: { name: string; arguments: object }[];
  delayMs?: number;
  rejectTools?: boolean;
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
  chatRequests(): MockRequest[];
  close(): Promise<void>;
}

export function startOpenAIMock(opts?: {
  port?: number;
  apiKey?: string;
  models?: Record<string, unknown>[];
}): Promise<OpenAIMock>;

export function bagOfWords(text: string, dims?: number): number[];
