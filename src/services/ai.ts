/**
 * Sage AI Service — Claude LLM + OpenAI STT
 *
 * Wraps Anthropic Claude (strategy config + portfolio advice) and
 * OpenAI speech-to-text (gpt-4o-mini-transcribe).
 *
 * Budget: ~$1 OpenAI STT + ~$4 Anthropic Claude = $5 total.
 * Model: claude-haiku-4-5 ($1/$5 per MTok I/O) → ~889 exchanges.
 * STT: gpt-4o-mini-transcribe ($0.003/min) → ~666 utterances.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import config from "../config.js";
import { logger } from "../middleware/logger.js";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    timestamp: string;
    strategyParams?: StrategyParams;
}

export interface StrategyParams {
    entryScoreThreshold?: number;
    minVolume24h?: number;
    minLiquidity?: number;
    maxLiquidity?: number;
    positionSizeSOL?: number;
    maxConcurrentPositions?: number;
    defaultBinRange?: number;
    profitTargetPercent?: number;
    stopLossPercent?: number;
    maxHoldTimeMinutes?: number;
    maxDailyLossSOL?: number;
    cooldownMinutes?: number;
}

export interface ChatResponse {
    message: string;
    strategyParams?: StrategyParams;
    actions?: AppAction[];
}

/** An action the AI wants to perform in the app. */
export interface AppAction {
    type: string;
    payload: Record<string, unknown>;
}

export interface PortfolioContext {
    totalBots: number;
    runningBots: number;
    totalTrades: number;
    winRate: number;
    totalPnlSOL: number;
    activePositions: number;
    recentTrades: Array<{
        pool: string;
        pnlSOL: number;
        duration: string;
        exitReason: string;
    }>;
}

// ═══════════════════════════════════════════════════════════════
// System Prompts
// ═══════════════════════════════════════════════════════════════

const SETUP_SYSTEM_PROMPT = `You are Sage — a concise, decisive AI that configures Meteora DLMM LP bot strategies.

## How to Behave
- Keep every response to 2-3 sentences max. No bullet lists, no essays.
- Be decisive: propose parameters immediately from whatever the user tells you. Don't interrogate them.
- After the user's FIRST message, call set_strategy_parameters with your best-guess config and briefly explain your reasoning.
- If the user gives vague input ("I'm conservative", "go aggressive"), that's enough — pick a profile and set it.
- Only ask ONE follow-up question if truly ambiguous, and even then, propose a default alongside it.
- You can update params incrementally on follow-up messages.
- IMPORTANT: Do NOT use markdown asterisks (*text* or **text**). Write plainly. Mention NFA once, not every message.

## Reference Profiles
- Conservative: 0.5 SOL, entry 200, profit 5%, stop 4%, 3 concurrent, 10 bins, hold 120min
- Balanced: 1.0 SOL, entry 150, profit 8%, stop 6%, 5 concurrent, 10 bins, hold 240min
- Aggressive: 2.0 SOL, entry 100, profit 12%, stop 10%, 8 concurrent, 15 bins, hold 360min

## Parameter Ranges (for clamping)
- entryScoreThreshold: 50-300 (default 150)
- minVolume24h: $100-$50k (default $1000)
- minLiquidity: $0-$50k (default $100)
- maxLiquidity: $10k-$5M (default $1M)
- positionSizeSOL: 0.1-10.0 (default 1.0)
- maxConcurrentPositions: 1-20 (default 5)
- defaultBinRange: 1-50 (default 10)
- profitTargetPercent: 1-25% (default 8%)
- stopLossPercent: 1-20% (default 6%)
- maxHoldTimeMinutes: 15-1440 (default 240)
- maxDailyLossSOL: 0.5-25.0 (default 3.0)
- cooldownMinutes: 0-240 (default 79)`;

const PORTFOLIO_SYSTEM_PROMPT = `You are Sage — a concise AI assistant for Meteora DLMM LP portfolio analysis and the user's agentic assistant inside the Sage app.

## How to Behave
- Keep responses to 2-3 sentences. Be data-driven: reference actual numbers. NFA.
- Do NOT use markdown asterisks (*text* or **text**). Write plainly.
- When the user asks about their portfolio, bots, or trades, use get_portfolio_summary to fetch fresh data before answering.
- When the user asks to change the app's theme or colors, use change_app_theme immediately.

## What You Can Do
- Answer questions about the user's LP bots, positions, win rate, and PnL
- Change the app's color theme (dark, light, midnight, solana)
- Provide strategy advice based on portfolio performance
- Explain Meteora DLMM concepts

## Available Themes
- dark: Default dark mode with green accents
- light: Clean light mode
- midnight: Deep navy-dark with blue accents
- solana: Dark mode with Solana green/purple branding`;

// ═══════════════════════════════════════════════════════════════
// Claude Tool Definitions
// ═══════════════════════════════════════════════════════════════

const SET_STRATEGY_TOOL: Anthropic.Tool = {
    name: "set_strategy_parameters",
    description:
        "Set the user's LP trading strategy parameters based on the conversation. " +
        "Call this when you have enough information to configure their strategy. " +
        "You can set all parameters at once or just the ones discussed.",
    input_schema: {
        type: "object" as const,
        properties: {
            entryScoreThreshold: {
                type: "number",
                description: "Entry score threshold (50-300). Higher = more selective.",
            },
            minVolume24h: {
                type: "number",
                description: "Minimum 24h volume in USD (100-50000).",
            },
            minLiquidity: {
                type: "number",
                description: "Minimum pool liquidity in USD (0-50000).",
            },
            maxLiquidity: {
                type: "number",
                description: "Maximum pool liquidity in USD (10000-5000000).",
            },
            positionSizeSOL: {
                type: "number",
                description: "Position size in SOL (0.1-10.0).",
            },
            maxConcurrentPositions: {
                type: "integer",
                description: "Max concurrent positions (1-20).",
            },
            defaultBinRange: {
                type: "integer",
                description: "Bin range width (1-50).",
            },
            profitTargetPercent: {
                type: "number",
                description: "Profit target percentage (1-25).",
            },
            stopLossPercent: {
                type: "number",
                description: "Stop loss percentage (1-20).",
            },
            maxHoldTimeMinutes: {
                type: "integer",
                description: "Max hold time in minutes (15-1440).",
            },
            maxDailyLossSOL: {
                type: "number",
                description: "Daily loss limit in SOL (0.5-25.0).",
            },
            cooldownMinutes: {
                type: "integer",
                description: "Cooldown between positions in minutes (0-240).",
            },
        },
        required: [],
    },
};

const CHANGE_THEME_TOOL: Anthropic.Tool = {
    name: "change_app_theme",
    description:
        "Change the app's color theme. Use when the user asks to change the look/feel/color of the app. " +
        "Available themes: dark (default dark mode), light (light mode), midnight (deeper dark with blue accents), " +
        "solana (dark with Solana green/purple branding).",
    input_schema: {
        type: "object" as const,
        properties: {
            theme: {
                type: "string",
                enum: ["dark", "light", "midnight", "solana"],
                description: "The theme to switch to.",
            },
        },
        required: ["theme"],
    },
};

const GET_PORTFOLIO_SUMMARY_TOOL: Anthropic.Tool = {
    name: "get_portfolio_summary",
    description:
        "Get a summary of the user's trading bots and positions. " +
        "Use when the user asks about their portfolio, bots, performance, or trades.",
    input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
    },
};

/** Tools available during general/portfolio conversations (agentic assistant). */
const GENERAL_TOOLS: Anthropic.Tool[] = [
    CHANGE_THEME_TOOL,
    GET_PORTFOLIO_SUMMARY_TOOL,
];

// ═══════════════════════════════════════════════════════════════
// AI Service
// ═══════════════════════════════════════════════════════════════

class AiService {
    private anthropic: Anthropic | null = null;
    private openai: OpenAI | null = null;

    constructor() {
        if (config.ANTHROPIC_API_KEY) {
            this.anthropic = new Anthropic({
                apiKey: config.ANTHROPIC_API_KEY,
            });
            logger.info("Anthropic Claude initialized (claude-haiku-4-5)");
        } else {
            logger.warn("ANTHROPIC_API_KEY not set — AI chat disabled");
        }

        if (config.OPENAI_API_KEY) {
            this.openai = new OpenAI({
                apiKey: config.OPENAI_API_KEY,
            });
            logger.info("OpenAI STT initialized (gpt-4o-mini-transcribe)");
        } else {
            logger.warn("OPENAI_API_KEY not set — voice input disabled");
        }
    }

    get isLlmAvailable(): boolean {
        return this.anthropic !== null;
    }

    get isSttAvailable(): boolean {
        return this.openai !== null;
    }

    /**
     * Send a message to Claude and get a response.
     * For setup conversations, Claude may use the set_strategy_parameters tool.
     */
    async chat(
        conversationType: "setup" | "portfolio" | "general",
        messages: ChatMessage[],
        portfolioContext?: PortfolioContext,
        currentParams?: StrategyParams
    ): Promise<ChatResponse> {
        if (!this.anthropic) {
            throw new Error("Anthropic API key not configured");
        }

        // Build system prompt
        let systemPrompt =
            conversationType === "setup"
                ? SETUP_SYSTEM_PROMPT
                : PORTFOLIO_SYSTEM_PROMPT;

        // Inject portfolio context if available
        if (portfolioContext) {
            systemPrompt += `\n\n## Current Portfolio Data\n${JSON.stringify(portfolioContext, null, 2)}`;
        }

        // Inject current strategy params so Claude can modify incrementally
        if (currentParams && Object.keys(currentParams).length > 0) {
            systemPrompt += `\n\n## User's Current Strategy Parameters\nThe user already has these parameters configured. When they ask for changes, update only the relevant values and keep the rest. Call set_strategy_parameters with the FULL updated set (current values + changes).\n${JSON.stringify(currentParams, null, 2)}`;
        }

        // Convert our messages to Anthropic format
        const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
            role: m.role,
            content: m.content,
        }));

        // Include tools based on conversation type
        const tools =
            conversationType === "setup"
                ? [SET_STRATEGY_TOOL]
                : GENERAL_TOOLS;

        // Retry helper for transient Anthropic errors (529 overloaded, 503, etc.)
        const callWithRetry = async <T>(fn: () => Promise<T>, retries = 3): Promise<T> => {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    return await fn();
                } catch (err: any) {
                    const status = err?.status ?? err?.error?.status;
                    const isRetryable = status === 529 || status === 503 || status === 500;
                    if (!isRetryable || attempt === retries) throw err;
                    const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                    logger.warn({ attempt, status, delay }, "Anthropic overloaded — retrying");
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
            throw new Error("Retry exhausted"); // unreachable
        };

        try {
            const response = await callWithRetry(() =>
                this.anthropic!.messages.create({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 400,
                    system: systemPrompt,
                    messages: anthropicMessages,
                    tools,
                })
            );

            // Parse response — may contain text + tool use
            let textContent = "";
            let strategyParams: StrategyParams | undefined;
            const actions: AppAction[] = [];
            const toolResults: Array<{
                id: string;
                result: string;
            }> = [];

            for (const block of response.content) {
                if (block.type === "text") {
                    textContent += block.text;
                } else if (block.type === "tool_use") {
                    if (block.name === "set_strategy_parameters") {
                        strategyParams = block.input as StrategyParams;
                        if (strategyParams) {
                            strategyParams = this.clampParams(strategyParams);
                        }
                        toolResults.push({
                            id: block.id,
                            result: "Parameters applied successfully.",
                        });
                    } else if (block.name === "change_app_theme") {
                        const input = block.input as { theme: string };
                        actions.push({
                            type: "change_theme",
                            payload: { theme: input.theme },
                        });
                        toolResults.push({
                            id: block.id,
                            result: `Theme changed to ${input.theme}.`,
                        });
                    } else if (block.name === "get_portfolio_summary") {
                        // Use the portfolio context already passed to chat()
                        toolResults.push({
                            id: block.id,
                            result: portfolioContext
                                ? JSON.stringify(portfolioContext)
                                : "No portfolio data available yet. The user may not have set up any bots.",
                        });
                    }
                }
            }

            // If Claude used tools, send tool results and get final text
            if (toolResults.length > 0) {
                // Combine all tool results into one user message
                const allToolResults = toolResults.map((tr) => ({
                    type: "tool_result" as const,
                    tool_use_id: tr.id,
                    content: tr.result,
                }));

                const followUp = await callWithRetry(() =>
                    this.anthropic!.messages.create({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 400,
                        system: systemPrompt,
                        messages: [
                            ...anthropicMessages,
                            { role: "assistant", content: response.content },
                            {
                                role: "user",
                                content: allToolResults,
                            },
                        ],
                        tools,
                    })
                );

                // Get the text from the follow-up
                for (const block of followUp.content) {
                    if (block.type === "text") {
                        textContent += (textContent ? "\n\n" : "") + block.text;
                    }
                }
            }

            logger.info(
                {
                    type: conversationType,
                    inputTokens: response.usage.input_tokens,
                    outputTokens: response.usage.output_tokens,
                    hasParams: !!strategyParams,
                },
                "Claude response"
            );

            return {
                message: textContent || "I wasn't able to generate a response. Please try again.",
                strategyParams,
                actions: actions.length > 0 ? actions : undefined,
            };
        } catch (error: any) {
            logger.error({ error }, "Claude API error");
            const status = error?.status ?? error?.error?.status;
            if (status === 529 || error?.message?.includes("Overloaded")) {
                throw new Error("Sage is busy right now — please try again in a few seconds.");
            }
            throw new Error(
                `AI service error: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Transcribe audio to text using OpenAI gpt-4o-mini-transcribe.
     */
    async transcribe(
        audioBuffer: Buffer,
        filename: string = "audio.webm"
    ): Promise<string> {
        if (!this.openai) {
            throw new Error("OpenAI API key not configured");
        }

        try {
            // Create a File object from buffer
            const blob = new Blob([new Uint8Array(audioBuffer)], {
                type: this.getMimeType(filename),
            });
            const file = new File([blob], filename, {
                type: this.getMimeType(filename),
            });

            const transcription = await this.openai.audio.transcriptions.create({
                file,
                model: "gpt-4o-mini-transcribe",
                language: "en",
            });

            logger.info(
                { chars: transcription.text.length },
                "Audio transcribed"
            );

            return transcription.text;
        } catch (error) {
            logger.error({ error }, "OpenAI STT error");
            throw new Error(
                `Transcription error: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Clamp strategy parameters to valid ranges.
     */
    private clampParams(params: StrategyParams): StrategyParams {
        const clamped: StrategyParams = {};

        if (params.entryScoreThreshold !== undefined)
            clamped.entryScoreThreshold = Math.max(50, Math.min(300, params.entryScoreThreshold));
        if (params.minVolume24h !== undefined)
            clamped.minVolume24h = Math.max(100, Math.min(50000, params.minVolume24h));
        if (params.minLiquidity !== undefined)
            clamped.minLiquidity = Math.max(0, Math.min(50000, params.minLiquidity));
        if (params.maxLiquidity !== undefined)
            clamped.maxLiquidity = Math.max(10000, Math.min(5000000, params.maxLiquidity));
        if (params.positionSizeSOL !== undefined)
            clamped.positionSizeSOL = Math.max(0.1, Math.min(10.0, params.positionSizeSOL));
        if (params.maxConcurrentPositions !== undefined)
            clamped.maxConcurrentPositions = Math.max(1, Math.min(20, Math.round(params.maxConcurrentPositions)));
        if (params.defaultBinRange !== undefined)
            clamped.defaultBinRange = Math.max(1, Math.min(50, Math.round(params.defaultBinRange)));
        if (params.profitTargetPercent !== undefined)
            clamped.profitTargetPercent = Math.max(1, Math.min(25, params.profitTargetPercent));
        if (params.stopLossPercent !== undefined)
            clamped.stopLossPercent = Math.max(1, Math.min(20, params.stopLossPercent));
        if (params.maxHoldTimeMinutes !== undefined)
            clamped.maxHoldTimeMinutes = Math.max(15, Math.min(1440, Math.round(params.maxHoldTimeMinutes)));
        if (params.maxDailyLossSOL !== undefined)
            clamped.maxDailyLossSOL = Math.max(0.5, Math.min(25.0, params.maxDailyLossSOL));
        if (params.cooldownMinutes !== undefined)
            clamped.cooldownMinutes = Math.max(0, Math.min(240, Math.round(params.cooldownMinutes)));

        return clamped;
    }

    private getMimeType(filename: string): string {
        const ext = filename.split(".").pop()?.toLowerCase();
        const mimeTypes: Record<string, string> = {
            mp3: "audio/mpeg",
            mp4: "audio/mp4",
            mpeg: "audio/mpeg",
            mpga: "audio/mpeg",
            m4a: "audio/mp4",
            wav: "audio/wav",
            webm: "audio/webm",
            ogg: "audio/ogg",
        };
        return mimeTypes[ext ?? ""] || "audio/webm";
    }
}

// Singleton
export const aiService = new AiService();
