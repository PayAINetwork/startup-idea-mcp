import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMcpPaidHandler } from "mcpay/handler";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withX402Client } from "mcpay/client";
import { createSigner, isEvmSignerWallet, isSvmSignerWallet, SupportedEVMNetworks, SupportedSVMNetworks } from "x402/types";
import OpenAI from "openai";
import { config } from "dotenv";

config();

const app = new Hono();


type InputArticle = {
    uuid?: string;
    title?: string;
    url?: string;
    link?: string;
    description?: string;
    keywords?: string | null;
    snippet?: string | null;
    image_url?: string | null;
    language?: string;
    published_at?: string;
    source?: string | null;
    categories?: string[] | null;
    relevance_score?: number | null;
    locale?: string | null;
};

type NormalizedArticle = {
    title: string;
    url: string | undefined;
    summary: string;
};

async function getBusinessNewsFromMcp(params: { evmPrivateKey: `0x${string}`; svmPrivateKey: string }): Promise<unknown> {
    const client = new Client({ name: "startup-idea-mcp-client", version: "1.0.0" });
    const mcpServerUrl = process.env.BIZNEWS_MCP_SERVER_URL || "";
    const transport = new StreamableHTTPClientTransport(new URL(mcpServerUrl));
    await client.connect(transport);

    const evmSigner = await createSigner("base-sepolia", params.evmPrivateKey);
    if (!isEvmSignerWallet(evmSigner)) {
        throw new Error("Failed to create EVM signer");
    }

    const svmSigner = await createSigner("solana-devnet", params.svmPrivateKey);
    if (!isSvmSignerWallet(svmSigner)) {
        throw new Error("Failed to create SVM signer");
    }

    const x402Client = withX402Client(client as Client, {
        wallet: {
            evm: evmSigner,
            svm: svmSigner,
        },
        confirmationCallback: async (payment) => {
            const preferredSvm = payment.find((p) => p.network === "solana-devnet");
            if (preferredSvm) {
                return { network: preferredSvm.network as typeof SupportedSVMNetworks[number] };
            }
            const preferredEvm = payment.find((p) => p.network === "base-sepolia");
            if (preferredEvm) {
                return { network: preferredEvm.network as typeof SupportedEVMNetworks[number] };
            }
            return false;
        },
    });

    const res = await x402Client.callTool({
        name: "business_news",
        arguments: {},
    },
    undefined,
    {timeout: 300000}
    );

    const content = (res as any)?.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((c) => c.type === "text")?.text || "";
    console.log("text from biznews-mcp: ", text);
    try {
        return JSON.parse(text || "{}");
    } catch {
        return {};
    }
}

function normalizeArticles(raw: unknown): NormalizedArticle[] {
    const list: unknown[] = Array.isArray(raw)
        ? raw
        : typeof raw === "object" && raw !== null
        ? Array.isArray((raw as any).data)
            ? ((raw as any).data as unknown[])
            : Array.isArray((raw as any).articles)
            ? ((raw as any).articles as unknown[])
            : []
        : [];

    return list
        .map((item) => coerceInputArticle(item))
        .map((a) => {
            const title = String(a.title ?? "Untitled");
            const url = typeof a.url === "string" ? a.url : typeof a.link === "string" ? a.link : undefined;
            const summarySource =
                typeof (a as any).snippet === "string"
                    ? (a as any).snippet
                    : typeof a.description === "string"
                    ? a.description
                    : typeof (a as any).content === "string"
                    ? (a as any).content
                    : "";
            const summary = summarySource ? String(summarySource).slice(0, 800) : "";
            return { title, url, summary };
        })
        .filter((a) => Boolean(a.title));
}

function coerceInputArticle(u: unknown): InputArticle {
    if (typeof u === "object" && u !== null) {
        return u as InputArticle;
    }
    return {} as InputArticle;
}

function buildPrompt(articles: NormalizedArticle[]): string {
    const articlesBlock = JSON.stringify(articles, null, 2);
    return [
        "You are a pragmatic startup analyst. You produce concise, actionable, strictly-JSON outputs only.",
        "You are given a curated list of news headlines and articles along with their URLs that affect businesses.",
        "They may affect existing businesses or create new business opportunities.",
        "Search all of the articles for additional information that may be relevant to the opportunity.",
        "Analyze all the articles and pick the one that creates the strongest opportunity for a new startup.",
        "Return STRICT JSON only, matching exactly this schema:",
        JSON.stringify(
            {
                opportunity: "<what is the business opportunity>",
                tam: {
                    estimate: "<dollar estimate and units, e.g., $2B/year>",
                    methodology: "<1-2 sentence method to estimate TAM>",
                },
                whyNow: "<why is now the right time>",
                gettingStarted: ["<step 1>", "<step 2>", "<step 3>"],
                source: { title: "<headline title>", url: "<link to article>" },
            },
            null,
            2
        ),
        "Do not include any narration, explanations, or code fences.",
        "Here are the headlines:",
        articlesBlock,
    ].join("\n\n");
}

function parseJsonFromText(text: string): unknown | null {
    if (!text) return null;
    const trimmed = text.trim();
    const fenceMatch = trimmed.match(/```[a-zA-Z]*\n([\s\S]*?)\n```/);
    const candidate: string = fenceMatch && typeof fenceMatch[1] === "string" ? fenceMatch[1] : trimmed;
    try {
        return JSON.parse(candidate);
    } catch {
        const jsonLike = candidate.match(/\{[\s\S]*\}$/);
        if (jsonLike) {
            try {
                return JSON.parse(jsonLike[0]);
            } catch {}
        }
        return null;
    }
}


const handler = createMcpPaidHandler(
    (server) => {
        server.paidTool(
            "idea_of_the_day",
            "Generate a startup idea of the day from latest business news",
            "$0.50",
            {},
            {},
            async () => {
                const openaiApiKey = process.env.OPENAI_API_KEY as string | undefined;
                const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
                const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;

                if (!openaiApiKey) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) }],
                    };
                }
                if (!evmPrivateKey || !svmPrivateKey) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: "Missing EVM_PRIVATE_KEY or SVM_PRIVATE_KEY" }) }],
                    };
                }

                // Connect to external MCP (biznews) and fetch business news
                const biznews = await getBusinessNewsFromMcp({ evmPrivateKey, svmPrivateKey });
                const articles = normalizeArticles(biznews).slice(0, 6);
                
                if (articles.length === 0) {
                    return {
                        content: [{ type: "text", text: JSON.stringify({ error: "No articles returned from news source" }) }],
                    };
                }

                // Analyze with OpenAI
                const openai = new OpenAI({ apiKey: openaiApiKey as string });
                const prompt = buildPrompt(articles);

                const completion = await openai.responses.create({
                    model: "o4-mini",
                    tools: [{ type: "web_search_preview", search_context_size: "medium" }],
                    input: prompt,
                });

                const content = completion.output_text ?? "";
                console.log("Completion from openai: ", content);
                const parsed = parseJsonFromText(content);
                if (!parsed) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({ error: "Failed to parse model output", raw: content }),
                            },
                        ],
                    };
                }

                return {
                    content: [{ type: "text", text: JSON.stringify(parsed) }],
                };
            }
        );
    },
    {
        facilitator: {
            url: process.env.FACILITATOR_URL as `${string}://${string}`
        },
        recipient: {
            "evm": {address: process.env.EVM_RECIPIENT_ADDRESS as string, isTestnet: true},
            "svm": {address: process.env.SVM_RECIPIENT_ADDRESS as string, isTestnet: true}
        }
    },
    {
        serverInfo: { name: "startup-idea-mcp", version: "1.0.0" },
    },
    {
        maxDuration: 300,
        verboseLogs: true
    }
);

app.use("*", (c) => {
    console.log("[MCP] Request received");
    console.log("[MCP] Request headers:", c.req.raw.headers);
    console.log("[MCP] Request body:", c.req.raw.body);
    console.log("[MCP] Request url:", c.req.raw.url);
    console.log("[MCP] Request method:", c.req.raw.method);
    console.log("[MCP] Request headers:", c.req.raw.headers);
    console.log("[MCP] Request body:", c.req.raw.body);
    console.log("[MCP] Request url:", c.req.raw.url);
    console.log("[MCP] Request method:", c.req.raw.method);
    return handler(c.req.raw);
});

serve({
    fetch: app.fetch,
    port: 3022,
});

console.log("Server is running on port http://localhost:3022");