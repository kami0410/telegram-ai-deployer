import { describe, expect, it, vi } from "vitest";
import {
  DeepSeekError,
  requestChat,
  requestMemoryUpdate,
  requestPersonaDraft,
  type DeepSeekOptions,
} from "../src/deepseek";
import { PERSONA_V1 } from "../src/persona/seed";

function options(fetcher: typeof fetch): DeepSeekOptions {
  return {
    apiKey: "test-deepseek-key",
    model: "deepseek-v4-flash",
    maxOutputTokens: 1_200,
    timeoutMs: 90_000,
    fetcher,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

describe("DeepSeek chat client", () => {
  it("retries one malformed successful response before returning the answer", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("not-json")
        : jsonResponse({
            choices: [{ message: { content: "这次有回复了" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
    });

    await expect(requestChat(options(fetcher), [
      { role: "user", content: "hello" },
    ])).resolves.toMatchObject({ content: "这次有回复了" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses V4 Flash with thinking disabled and returns bounded usage", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-deepseek-key",
      );
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "deepseek-v4-flash",
        thinking: { type: "disabled" },
        stream: false,
        max_tokens: 1_200,
      });
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "嗯嗯嗯" } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 8,
          total_tokens: 128,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 40,
        },
      });
    });

    await expect(
      requestChat(options(fetcher), [
        { role: "system", content: "safe prompt" },
        { role: "user", content: "hello" },
      ]),
    ).resolves.toEqual({
      content: "嗯嗯嗯",
      usage: {
        inputTokens: 120,
        outputTokens: 8,
        totalTokens: 128,
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 40,
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.deepseek.com/chat/completions",
      expect.any(Object),
    );
  });

  it.each([
    [429, "rate_limited", true],
    [500, "upstream_5xx", true],
    [503, "upstream_5xx", true],
    [401, "upstream_4xx", false],
    [403, "upstream_4xx", false],
  ] as const)("classifies HTTP %i without exposing its body", async (status, code, retryable) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ secret: "must-not-leak" }, { status }),
    );

    const caught = await requestChat(options(fetcher), [
      { role: "user", content: "hello" },
    ]).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(DeepSeekError);
    expect(caught).toMatchObject({ code, status, retryable });
    expect(String(caught)).not.toContain("must-not-leak");
  });

  it.each([
    ["malformed JSON", new Response("not-json"), "invalid_response"],
    [
      "empty choice",
      jsonResponse({ choices: [], usage: {} }),
      "invalid_response",
    ],
    [
      "oversized response",
      new Response("{}", { headers: { "content-length": "2097153" } }),
      "response_too_large",
    ],
  ])("rejects %s safely", async (_name, response, code) => {
    const fetcher = vi.fn<typeof fetch>(async () => response.clone());
    await expect(
      requestChat(options(fetcher), [{ role: "user", content: "hello" }]),
    ).rejects.toMatchObject({ code });
  });

  it("classifies aborts and network failures as retryable", async () => {
    const aborting = vi.fn<typeof fetch>(async () => {
      throw new DOMException("timed out", "AbortError");
    });
    const timingOut = vi.fn<typeof fetch>(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const network = vi.fn<typeof fetch>(async () => {
      throw new TypeError("connection details must not leak");
    });

    await expect(
      requestChat(options(aborting), [{ role: "user", content: "hello" }]),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
    await expect(
      requestChat(options(timingOut), [{ role: "user", content: "hello" }]),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
    const caught = await requestChat(options(network), [
      { role: "user", content: "hello" },
    ]).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: "network_error", retryable: true });
    expect(String(caught)).not.toContain("connection details");
  });
});

describe("DeepSeek memory extraction", () => {
  it("requires explicit stable preferences to be extracted as facts, not buried in episodes", async () => {
    let promptContent = "";
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      if (typeof body === "object" && body !== null && "messages" in body) {
        const messages = (body as { messages: Array<{ role: string; content: string }> }).messages;
        promptContent = messages.find((message) => message.role === "system")?.content ?? "";
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "用户说了吃辣的事。",
                through_message_id: 12,
                stable_facts: [{
                  category: "preference",
                  fact_key: "spicy_food",
                  fact_value: "OWNER 喜欢吃辣",
                  confidence: "high",
                  source_message_id: 12,
                }],
                episodes: [{
                  category: "interest",
                  content: "用户今天吃了板面并加了很多辣",
                  people: [],
                  topics: [],
                  occurred_at: 1_750_000_000,
                  source_message_id: 12,
                }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      });
    });

    await expect(
      requestMemoryUpdate(options(fetcher), {
        previousSummary: null,
        sourceMessages: [
          { id: 12, role: "user", content: "我今天吃的板面，我加了好多辣，我喜欢吃辣" },
        ],
      }),
    ).resolves.toMatchObject({
      stableFacts: [{ factKey: "spicy_food", factValue: "OWNER 喜欢吃辣" }],
      episodes: [{ content: "用户今天吃了板面并加了很多辣" }],
    });
    expect(promptContent).toContain("“我喜欢/我爱/我更喜欢/我习惯/我一直”");
    expect(promptContent).toContain("必须单独提取为 stable_fact");
  });

  it("accepts only explicit categories, confidence, and source message IDs", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ response_format: { type: "json_object" } });
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "OWNER 最近在准备考试。",
                through_message_id: 12,
                stable_facts: [
                  {
                    category: "study",
                    fact_key: "current_exam",
                    fact_value: "OWNER 最近在准备考试",
                    confidence: "high",
                    source_message_id: 12,
                  },
                ],
                episodes: [
                  {
                    category: "study",
                    content: "考试前感到焦虑",
                    people: ["OWNER"],
                    topics: ["考试"],
                    occurred_at: 1_750_000_000,
                    source_message_id: 12,
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      });
    });

    await expect(
      requestMemoryUpdate(options(fetcher), {
        previousSummary: null,
        sourceMessages: [
          { id: 11, role: "assistant", content: "最近忙什么呢" },
          { id: 12, role: "user", content: "我在准备考试" },
        ],
      }),
    ).resolves.toMatchObject({
      summary: "OWNER 最近在准备考试。",
      throughMessageId: 12,
      stableFacts: [
        {
          category: "study",
          factKey: "current_exam",
          confidence: "high",
          sourceMessageId: 12,
        },
      ],
      episodes: [
        {
          category: "study",
          content: "考试前感到焦虑",
          people: ["OWNER"],
          topics: ["考试"],
          occurredAt: 1_750_000_000,
          sourceMessageId: 12,
        },
      ],
    });
  });

  it("accepts a JSON response wrapped in a markdown code fence", async () => {
    const memory = {
      summary: "已提炼的摘要",
      through_message_id: 12,
      stable_facts: [],
      episodes: [],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(memory)}\n\`\`\`` } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await expect(
      requestMemoryUpdate(options(fetcher), {
        previousSummary: null,
        sourceMessages: [{ id: 12, role: "user", content: "source" }],
      }),
    ).resolves.toMatchObject({ summary: "已提炼的摘要", throughMessageId: 12 });
  });

  it("extracts only relationship state grounded in a user message", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          summary: "约定考后继续聊",
          stable_facts: [],
          episodes: [],
          relationship_states: [
            {
              kind: "open_thread",
              value: "等待 OWNER 考完分享结果",
              source_message_id: 12,
              evidence: "考完再跟你说结果",
            },
            {
              kind: "shared_moment",
              value: "Yuan 今天陪 OWNER 去了图书馆",
              source_message_id: 11,
              evidence: "陪你去了图书馆",
            },
          ],
        }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await expect(requestMemoryUpdate(options(fetcher), {
      previousSummary: null,
      sourceMessages: [
        { id: 11, role: "assistant", content: "我今天陪你去了图书馆" },
        { id: 12, role: "user", content: "我明天考完再跟你说结果" },
      ],
    })).resolves.toMatchObject({
      relationshipStates: [{
        kind: "open_thread",
        value: "等待 OWNER 考完分享结果",
        sourceMessageId: 12,
      }],
    });
  });

  it("extracts graph items only from owned user evidence", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          summary: "用户调整了学习计划",
          stable_facts: [],
          episodes: [],
          relationship_states: [],
          graph_nodes: [
            {
              type: "goal",
              key: "study_plan",
              value: "准备研究生考试",
              confidence: "high",
              source_message_id: 12,
            },
            {
              type: "place",
              key: "yuan_location",
              value: "图书馆",
              confidence: "high",
              source_message_id: 11,
            },
          ],
          graph_edges: [{
            from_type: "person",
            from_key: "kami",
            to_type: "goal",
            to_key: "study_plan",
            relation: "related_to",
            confidence: "high",
            source_message_id: 12,
          }],
          time_layers: {},
        }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await expect(requestMemoryUpdate(options(fetcher), {
      previousSummary: null,
      sourceMessages: [
        { id: 11, role: "assistant", content: "我刚才去了图书馆" },
        { id: 12, role: "user", content: "我的计划改成准备研究生考试" },
      ],
    })).resolves.toMatchObject({
      graphNodes: [{
        type: "goal",
        key: "study_plan",
        value: "准备研究生考试",
        confidence: "high",
        sourceMessageId: 12,
      }],
      graphEdges: [{
        fromType: "person",
        fromKey: "kami",
        toType: "goal",
        toKey: "study_plan",
        relation: "related_to",
        confidence: "high",
        sourceMessageId: 12,
      }],
    });
  });

  it("accepts memory JSON when the model adds prose or a thinking block", async () => {
    const memory = {
      summary: "已提炼的摘要",
      through_message_id: 12,
      stable_facts: [],
      episodes: [],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{
          message: {
            content: `<think>先检查对话来源。</think>\n提取结果如下：\n\`\`\`json\n${JSON.stringify(memory)}\n\`\`\``,
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await expect(
      requestMemoryUpdate(options(fetcher), {
        previousSummary: null,
        sourceMessages: [{ id: 12, role: "user", content: "source" }],
      }),
    ).resolves.toMatchObject({ summary: "已提炼的摘要", throughMessageId: 12 });
  });

  it("normalizes nonstandard but valid memory JSON instead of rejecting the batch", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: 42,
              through_message_id: 999,
              stable_facts: [{
                category: "other",
                fact_key: "考试计划",
                fact_value: "正在准备考试",
                confidence: "certain",
                source_message_id: 999,
              }],
              episodes: "none",
            }),
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await expect(
      requestMemoryUpdate(options(fetcher), {
        previousSummary: null,
        sourceMessages: [{ id: 12, role: "user", content: "source" }],
      }),
    ).resolves.toMatchObject({
      summary: "42",
      throughMessageId: 12,
      stableFacts: [],
      episodes: [],
    });
  });

  it("recovers an invalid source id only when the fact is grounded in a user message", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({
          summary: "准备考试",
          through_message_id: 12,
          stable_facts: [{
            category: "study",
            fact_key: "exam_plan",
            fact_value: "正在准备考试",
            confidence: "high",
            source_message_id: 999,
            evidence: "正在准备考试",
          }],
          episodes: [],
        }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await expect(requestMemoryUpdate(options(fetcher), {
      previousSummary: null,
      sourceMessages: [
        { id: 10, role: "user", content: "我最近正在准备考试" },
        { id: 11, role: "assistant", content: "加油呀" },
        { id: 12, role: "user", content: "还有点紧张" },
      ],
    })).resolves.toMatchObject({
      stableFacts: [{ factKey: "exam_plan", sourceMessageId: 10 }],
    });
  });

  it.each([
    {
      summary: "x",
      through_message_id: 99,
      stable_facts: [],
      episodes: [],
    },
    {
      summary: "x",
      through_message_id: 12,
      stable_facts: [
        {
          category: "invented",
          fact_key: "x",
          fact_value: "y",
          confidence: "high",
          source_message_id: 12,
        },
      ],
      episodes: [],
    },
    {
      summary: "x",
      through_message_id: 12,
      stable_facts: [
        {
          category: "study",
          fact_key: "x",
          fact_value: "y",
          confidence: "certain",
          source_message_id: 12,
        },
      ],
      episodes: [],
    },
    {
      summary: "x",
      through_message_id: 12,
      stable_facts: [],
      episodes: [
        {
          category: "study",
          content: "推测出来的焦虑",
          people: [],
          topics: ["考试"],
          occurred_at: 1_750_000_000,
          source_message_id: 99,
        },
      ],
    },
  ])("accepts nonstandard memory JSON without blocking the summary", async (memory) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(memory) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    await expect(
      requestMemoryUpdate(options(fetcher), {
        previousSummary: null,
        sourceMessages: [
          { id: 12, role: "user", content: "source" },
        ],
      }),
    ).resolves.toMatchObject({ summary: "x", throughMessageId: 12 });
  });
});

describe("DeepSeek persona draft generation", () => {
  it("routes behavioral expression instructions to rules instead of literal markers", async () => {
    const draft = {
      confidence: "high",
      operations: [
        {
          operation: "add",
          path: "expression.markers",
          value: ["<不要每次对话都使用🌚>"],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(draft) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    );

    await expect(
      requestPersonaDraft(options(fetcher), {
        operation: "addition",
        currentSnapshot: PERSONA_V1,
        triggerText: "<不要每次对话都使用🌚>",
      }),
    ).resolves.toMatchObject({
      summary: "新增到 expression.rules",
      impactScope: "expression.rules",
      operations: [
        {
          operation: "add",
          path: "expression.rules",
          value: ["不要每次对话都使用🌚"],
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enables thinking only when explicitly requested", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ thinking: { type: "enabled" } });
      return jsonResponse({
        choices: [{ message: { role: "assistant", content: "answer" } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    });

    await requestChat({ ...options(fetcher), thinking: "enabled" }, [
      { role: "user", content: "complex question" },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps persona additions to one explicit fact and ignores model embellishment", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const responses = [
      {
        summary: "新增两项推断",
        impactScope: "coreTraits.rules",
        confidence: "high",
        operations: [
          { operation: "add", path: "coreTraits.rules", value: ["喜欢早起"] },
          { operation: "add", path: "proactive.rules", value: ["每天主动联系"] },
        ],
      },
      {
        summary: "新增习惯",
        impactScope: "coreTraits.rules",
        confidence: "high",
        operations: [
          {
            operation: "add",
            path: "coreTraits.rules",
            value: ["她喜欢早起，而且每天都会主动联系"],
          },
        ],
      },
    ];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses[requestBodies.length - 1];
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(response) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    });

    await expect(
      requestPersonaDraft(options(fetcher), {
        operation: "addition",
        currentSnapshot: PERSONA_V1,
        triggerText: "她偶尔会早起",
      }),
    ).resolves.toMatchObject({
      summary: "新增到 coreTraits.rules",
      impactScope: "coreTraits.rules",
      operations: [
        {
          operation: "add",
          path: "coreTraits.rules",
          value: ["她偶尔会早起"],
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requestBodies)).not.toContain("currentSnapshot");
    expect(requestBodies[0]).toMatchObject({
      thinking: { type: "enabled" },
    });
  });

  it("derives advisory metadata when the safe operations are valid", async () => {
    const draft = {
      confidence: "高",
      operations: [
        {
          operation: "add",
          path: "coreTraits.rules",
          value: ["偶尔会早起"],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(draft) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    );

    await expect(
      requestPersonaDraft(options(fetcher), {
        operation: "addition",
        currentSnapshot: PERSONA_V1,
        triggerText: "她偶尔会早起",
      }),
    ).resolves.toMatchObject({
      summary: "新增到 coreTraits.rules",
      impactScope: "coreTraits.rules",
      confidence: "medium",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts fenced JSON and the common impact_scope field alias", async () => {
    const draft = {
      summary: "补充偶尔早起的习惯",
      impact_scope: "coreTraits.rules",
      confidence: "high",
      operations: [
        {
          operation: "add",
          path: "coreTraits.rules",
          value: ["偶尔会早起"],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        choices: [
          { message: { content: `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` } },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    );

    await expect(
      requestPersonaDraft(options(fetcher), {
        operation: "addition",
        currentSnapshot: PERSONA_V1,
        triggerText: "她偶尔会早起",
      }),
    ).resolves.toMatchObject({
      summary: "新增到 coreTraits.rules",
      impactScope: "coreTraits.rules",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("regenerates once with stricter instructions after invalid draft JSON", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const responses = [
      {
        summary: "新增习惯",
        impactScope: "unknown.path",
        confidence: "high",
        operations: [
          { operation: "add", path: "unknown.path", value: "偶尔早起" },
        ],
      },
      {
        summary: "补充偶尔早起的习惯",
        impactScope: "coreTraits.rules",
        confidence: "high",
        operations: [
          {
            operation: "add",
            path: "coreTraits.rules",
            value: ["偶尔会早起"],
          },
        ],
      },
    ];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      const response = responses[requestBodies.length - 1];
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(response) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    });

    await expect(
      requestPersonaDraft(options(fetcher), {
        operation: "addition",
        currentSnapshot: PERSONA_V1,
        triggerText: "她偶尔会早起",
      }),
    ).resolves.toMatchObject({
      summary: "新增到 coreTraits.rules",
      impactScope: "coreTraits.rules",
      usage: {
        inputTokens: 40,
        outputTokens: 20,
        totalTokens: 60,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requestBodies[1])).toContain("上一份草稿未通过验证");
  });
});
