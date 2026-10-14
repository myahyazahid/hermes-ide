import { describe, expect, it } from "vitest";
import { addCall, parseApiCallLine } from "../../src/core/apiCallLog";

const LINE =
  "2026-10-13 00:14:37,351 INFO [20261012_225951_c7ea3c] agent.conversation_loop: API call #3: model=ag/gemini-3.8-flash-high provider=custom in=181583 out=89 total=181672 latency=6.6s cache=177397/181583 (98%) id=chatcmpl-x";

describe("parseApiCallLine", () => {
  it("reads the tokens of one model request from Hermes' log", () => {
    expect(parseApiCallLine(LINE)).toEqual({
      session: "20261012_225951_c7ea3c", model: "ag/gemini-3.8-flash-high", input: 181583, output: 89, cached: 177397,
    });
  });

  it("works without a session tag or cache figures", () => {
    expect(parseApiCallLine("2026-10-14 10:00:00 [INFO] agent.conversation_loop: API call #1: model=m provider=p in=10 out=2 total=12 latency=1.0s")).toEqual({
      session: undefined, model: "m", input: 10, output: 2, cached: 0,
    });
  });

  it("ignores other log lines", () => {
    expect(parseApiCallLine("INFO something: API call failed after 3 retries")).toBeUndefined();
    expect(parseApiCallLine("INFO Loaded env from x")).toBeUndefined();
  });

  it("sums calls", () => {
    const a = parseApiCallLine(LINE)!;
    expect(addCall(addCall(undefined, a), a)).toEqual({ calls: 2, input: 363166, output: 178, cached: 354794 });
  });
});
