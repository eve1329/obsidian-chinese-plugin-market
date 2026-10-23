import { afterEach, describe, expect, it, vi } from "vitest";
import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { ApiEmbeddingProvider } from "@semantic/embedding";

afterEach(resetHttpClient);

describe("ApiEmbeddingProvider · 服务商接口路径", () => {
	it.each([
		["https://api.openai.com", "https://api.openai.com/v1/embeddings"],
		["https://api.openai.com/v1/embeddings", "https://api.openai.com/v1/embeddings"],
		["https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4/embeddings"],
		["https://open.bigmodel.cn/api/paas/v4/embeddings/", "https://open.bigmodel.cn/api/paas/v4/embeddings"],
		["https://gateway.example/embeddings", "https://gateway.example/embeddings"],
	])("%s 请求正确端点", async (baseURL, url) => {
		const request = vi.fn().mockResolvedValue({ status: 200, json: { data: [{ index: 0, embedding: [1, 0] }] } });
		setHttpClient({ request });
		const provider = new ApiEmbeddingProvider({ baseURL, apiKey: "test-key", model: "embedding-3" });
		await expect(provider.embed(["hello"])).resolves.toEqual([[1, 0]]);
		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith(expect.objectContaining({ url, method: "POST" }));
	});
});
