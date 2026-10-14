// Live token counts. ACP reports usage only when a whole turn ends, but Hermes logs every model
// request to stderr as it returns:
//   ... INFO [<session>] agent.conversation_loop: API call #3: model=m provider=p in=181583 out=89 total=181672 latency=6.6s cache=177397/181583 (98%) ...
// Summing those lines gives the real input/output of a running turn, the same numbers a router's dashboard shows.

export interface ApiCall {
  /** Hermes' log tag for the agent session, when the line has one. */
  session?: string;
  model?: string;
  input: number;
  output: number;
  cached: number;
}

const LINE = /API call #\d+:(.*)$/;

export function parseApiCallLine(line: string): ApiCall | undefined {
  const m = LINE.exec(line);
  if (!m) return undefined;
  const fields = m[1];
  const num = (key: string) => {
    const v = new RegExp(`\\b${key}=(\\d+)`).exec(fields);
    return v ? Number(v[1]) : undefined;
  };
  const input = num("in");
  const output = num("out");
  if (input === undefined || output === undefined) return undefined;
  const cached = /\bcache=(\d+)\//.exec(fields);
  // The ACP stderr format is "<time> [INFO] <logger>: ..."; a file log may add "[<session>]" too.
  const session = /\[(?!(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)\])([^\]\s]+)\][^[]*API call #/.exec(line);
  return {
    session: session?.[1],
    model: /\bmodel=(\S+)/.exec(fields)?.[1],
    input,
    output,
    cached: cached ? Number(cached[1]) : 0,
  };
}

export interface LiveUsage {
  calls: number;
  input: number;
  output: number;
  cached: number;
}

export function addCall(total: LiveUsage | undefined, call: ApiCall): LiveUsage {
  const t = total ?? { calls: 0, input: 0, output: 0, cached: 0 };
  return { calls: t.calls + 1, input: t.input + call.input, output: t.output + call.output, cached: t.cached + call.cached };
}
