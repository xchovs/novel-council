import { describe, expect, it } from "vitest";
import { extractJson } from "../src/core/validation/json-extract.js";

describe("json-extract（R04 缓解）", () => {
  it("提取 ```json 围栏块", () => {
    const text = '前言\n```json\n{"verdict":"accept"}\n```\n后记';
    expect(extractJson(text)?.data).toEqual({ verdict: "accept" });
  });

  it("提取无语言标记的围栏块", () => {
    const text = '```\n{"a":1}\n```';
    expect(extractJson(text)?.data).toEqual({ a: 1 });
  });

  it("提取散文中的裸 JSON 对象", () => {
    const text = '我的评议如下：{"verdict":"revise","x":[1,2]} 以上。';
    expect(extractJson(text)?.data).toEqual({ verdict: "revise", x: [1, 2] });
  });

  it("字符串内的花括号不影响配平", () => {
    const text = '{"a":"}{","b":2}';
    expect(extractJson(text)?.data).toEqual({ a: "}{", b: 2 });
  });

  it("字符串内的转义引号不影响配平", () => {
    const text = '{"a":"\\"}","b":3}';
    expect(extractJson(text)?.data).toEqual({ a: '"}', b: 3 });
  });

  it("围栏块不可解析时回退到括号配平", () => {
    const text = '```json\n{broken\n```\n{"verdict":"reject"}';
    expect(extractJson(text)?.data).toEqual({ verdict: "reject" });
  });

  it("无 JSON 时返回 null", () => {
    expect(extractJson("完全没有对象")).toBeNull();
    expect(extractJson('{"unclosed": ')).toBeNull();
  });

  it("数组等非对象 JSON 不被接受（成员输出必须是对象）", () => {
    expect(extractJson("[1,2,3]")).toBeNull();
  });
});
