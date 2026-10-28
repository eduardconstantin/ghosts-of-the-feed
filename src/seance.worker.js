import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

const MODEL = "onnx-community/gemma-3-270m-it-ONNX";

let generator;

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "load") {
      if (!generator) {
        generator = await pipeline("text-generation", MODEL, {
          dtype: "fp16",
          progress_callback: (update) => {
            self.postMessage({ type: "progress", update });
          },
        });
      }
      self.postMessage({ type: "ready", model: MODEL });
      return;
    }

    if (message.type === "summon") {
      if (!generator) throw new Error("The model is not loaded yet.");
      const output = await generator(message.messages, {
        max_new_tokens: 140,
        do_sample: true,
        temperature: 0.8,
        top_p: 0.9,
      });
      const chat = output?.[0]?.generated_text;
      const last = Array.isArray(chat) ? chat.at(-1)?.content : chat;
      self.postMessage({
        type: "speech",
        id: message.id,
        text: stripThinking(String(last || "")).trim(),
      });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
