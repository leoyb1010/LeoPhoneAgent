import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

const client = createAnthropic({
  apiKey: process.env.ZCODE_API_KEY,
  baseURL: process.env.ZCODE_TEST_MODEL_BASE_URL, // [leo] 手动探测脚本：端点由环境变量给出
});

const result = await generateText({
  model: client("glm-4"),
  prompt: "say hello in 3 words",
});

console.log("Result:", result);
