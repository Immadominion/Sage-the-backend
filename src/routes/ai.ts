/**
 * Sage AI Routes — Chat (Claude) + Transcribe (OpenAI STT) + Conversations
 *
 * POST /ai/chat          — Send message to Sage AI, get response
 * POST /ai/transcribe    — Upload audio, get transcribed text
 * GET  /ai/conversations — List user's conversations
 * GET  /ai/conversations/:id — Get conversation by ID
 * DELETE /ai/conversations/:id — Delete conversation
 * GET  /ai/status        — Check AI service availability
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { v4 as uuidv4 } from "uuid";
import { eq, and, desc } from "drizzle-orm";

import { requireAuth, type AuthVariables } from "../middleware/auth.js";
import { aiService, type ChatMessage } from "../services/ai.js";
import { db } from "../db/index.js";
import { conversations, bots, positions } from "../db/schema.js";
import { logger } from "../middleware/logger.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

const ai = new Hono<{ Variables: AuthVariables }>();

// All AI routes require authentication
ai.use("*", requireAuth);

// ═══════════════════════════════════════════════════════════════
// POST /ai/chat — Send message to Sage AI
// ═══════════════════════════════════════════════════════════════

const chatSchema = z.object({
    message: z.string().min(1).max(4000),
    conversationId: z.string().optional(),
    type: z.enum(["setup", "portfolio", "general"]).default("general"),
    currentParams: z.object({
        entryScoreThreshold: z.number().optional(),
        minVolume24h: z.number().optional(),
        minLiquidity: z.number().optional(),
        maxLiquidity: z.number().optional(),
        positionSizeSOL: z.number().optional(),
        maxConcurrentPositions: z.number().optional(),
        defaultBinRange: z.number().optional(),
        profitTargetPercent: z.number().optional(),
        stopLossPercent: z.number().optional(),
        maxHoldTimeMinutes: z.number().optional(),
        maxDailyLossSOL: z.number().optional(),
        cooldownMinutes: z.number().optional(),
    }).optional(),
});

ai.post("/chat", zValidator("json", chatSchema), async (c) => {
    const userId = c.get("userId");
    const { message, conversationId, type, currentParams } = c.req.valid("json");

    if (!aiService.isLlmAvailable) {
        return c.json({ error: "AI_UNAVAILABLE", message: "AI service is not configured" }, 503);
    }

    try {
        // Load or create conversation
        let conversation: typeof conversations.$inferSelect | null = null;
        let messageHistory: ChatMessage[] = [];

        if (conversationId) {
            const [existing] = await db
                .select()
                .from(conversations)
                .where(
                    and(
                        eq(conversations.conversationId, conversationId),
                        eq(conversations.userId, userId)
                    )
                )
                .limit(1);

            if (existing) {
                conversation = existing;
                messageHistory = (existing.messages as ChatMessage[]) || [];
            }
        }

        // Add user message
        const userMessage: ChatMessage = {
            role: "user",
            content: message,
            timestamp: new Date().toISOString(),
        };
        messageHistory.push(userMessage);

        // Build portfolio context for all conversation types.
        // This gives Claude awareness of the user's bots/positions regardless
        // of whether they're setting up a strategy or asking about their portfolio.
        let portfolioContext = undefined;
        portfolioContext = await buildPortfolioContext(userId);

        // Call Claude
        const response = await aiService.chat(type, messageHistory, portfolioContext, currentParams);

        // Add assistant message (include strategyParams per-message
        // so individual messages carry their params through restore).
        const assistantMessage: ChatMessage = {
            role: "assistant",
            content: response.message,
            timestamp: new Date().toISOString(),
            ...(response.strategyParams && { strategyParams: response.strategyParams }),
        };
        messageHistory.push(assistantMessage);

        // Persist conversation
        const newConversationId = conversationId || uuidv4();
        const title =
            conversation?.title || generateTitle(message);

        if (conversation) {
            // Update existing
            await db
                .update(conversations)
                .set({
                    messages: messageHistory,
                    extractedParams: response.strategyParams || conversation.extractedParams,
                    updatedAt: new Date(),
                })
                .where(eq(conversations.id, conversation.id));
        } else {
            // Create new
            await db.insert(conversations).values({
                conversationId: newConversationId,
                userId,
                type,
                title,
                messages: messageHistory,
                extractedParams: response.strategyParams || null,
            });
        }

        return c.json({
            conversationId: newConversationId,
            message: response.message,
            strategyParams: response.strategyParams || null,
            actions: response.actions || null,
        });
    } catch (error) {
        logger.error({ error, userId }, "AI chat error");
        return c.json(
            {
                error: "AI_ERROR",
                message: error instanceof Error ? error.message : "AI service error",
            },
            500
        );
    }
});

// ═══════════════════════════════════════════════════════════════
// POST /ai/transcribe — Upload audio for STT
// ═══════════════════════════════════════════════════════════════

ai.post("/transcribe", async (c) => {
    if (!aiService.isSttAvailable) {
        return c.json(
            { error: "STT_UNAVAILABLE", message: "Speech-to-text is not configured" },
            503
        );
    }

    try {
        const body = await c.req.parseBody();
        const audioFile = body["audio"];

        if (!audioFile || !(audioFile instanceof File)) {
            return c.json(
                { error: "INVALID_INPUT", message: "No audio file provided. Send as multipart with key 'audio'" },
                400
            );
        }

        // Validate file size (25MB max per OpenAI)
        if (audioFile.size > 25 * 1024 * 1024) {
            return c.json(
                { error: "FILE_TOO_LARGE", message: "Audio file must be under 25MB" },
                400
            );
        }

        const buffer = Buffer.from(await audioFile.arrayBuffer());
        const text = await aiService.transcribe(buffer, audioFile.name);

        return c.json({ text });
    } catch (error) {
        logger.error({ error }, "Transcription error");
        return c.json(
            {
                error: "TRANSCRIPTION_ERROR",
                message: error instanceof Error ? error.message : "Transcription failed",
            },
            500
        );
    }
});

// ═══════════════════════════════════════════════════════════════
// GET /ai/conversations — List user's conversations
// ═══════════════════════════════════════════════════════════════

ai.get("/conversations", async (c) => {
    const userId = c.get("userId");

    const rows = await db
        .select({
            conversationId: conversations.conversationId,
            type: conversations.type,
            title: conversations.title,
            messageCount: conversations.messages, // We'll count client-side
            extractedParams: conversations.extractedParams,
            createdAt: conversations.createdAt,
            updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.updatedAt))
        .limit(50);

    const result = rows.map((r) => ({
        conversationId: r.conversationId,
        type: r.type,
        title: r.title,
        messageCount: Array.isArray(r.messageCount) ? r.messageCount.length : 0,
        hasStrategyParams: r.extractedParams !== null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    }));

    return c.json({ conversations: result });
});

// ═══════════════════════════════════════════════════════════════
// GET /ai/conversations/:id — Get full conversation
// ═══════════════════════════════════════════════════════════════

ai.get("/conversations/:id", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");

    const [conversation] = await db
        .select()
        .from(conversations)
        .where(
            and(
                eq(conversations.conversationId, conversationId),
                eq(conversations.userId, userId)
            )
        )
        .limit(1);

    if (!conversation) {
        return c.json({ error: "NOT_FOUND", message: "Conversation not found" }, 404);
    }

    return c.json({
        conversationId: conversation.conversationId,
        type: conversation.type,
        title: conversation.title,
        messages: conversation.messages,
        extractedParams: conversation.extractedParams,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
    });
});

// ═══════════════════════════════════════════════════════════════
// DELETE /ai/conversations/:id — Delete conversation
// ═══════════════════════════════════════════════════════════════

ai.delete("/conversations/:id", async (c) => {
    const userId = c.get("userId");
    const conversationId = c.req.param("id");

    await db
        .delete(conversations)
        .where(
            and(
                eq(conversations.conversationId, conversationId),
                eq(conversations.userId, userId)
            )
        );

    return c.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// GET /ai/status — Check AI service availability
// ═══════════════════════════════════════════════════════════════

ai.get("/status", async (c) => {
    return c.json({
        llm: aiService.isLlmAvailable,
        stt: aiService.isSttAvailable,
        models: {
            llm: "claude-haiku-4-5",
            stt: "gpt-4o-mini-transcribe",
        },
    });
});

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Generate a short title from the first message */
function generateTitle(firstMessage: string): string {
    const cleaned = firstMessage.trim().replace(/\n/g, " ");
    if (cleaned.length <= 50) return cleaned;
    return cleaned.slice(0, 47) + "...";
}

/** Build portfolio context from user's bots and positions */
async function buildPortfolioContext(userId: number) {
    try {
        // Get user's bots
        const userBots = await db
            .select()
            .from(bots)
            .where(eq(bots.userId, userId));

        // Get recent closed positions
        const recentPositions = await db
            .select()
            .from(positions)
            .where(
                and(
                    eq(positions.userId, userId),
                    eq(positions.status, "closed")
                )
            )
            .orderBy(desc(positions.updatedAt))
            .limit(20);

        // Get active positions
        const activePositions = await db
            .select()
            .from(positions)
            .where(
                and(
                    eq(positions.userId, userId),
                    eq(positions.status, "active")
                )
            );

        const totalTrades = userBots.reduce((sum, b) => sum + b.totalTrades, 0);
        const winningTrades = userBots.reduce((sum, b) => sum + b.winningTrades, 0);
        const totalPnlLamports = userBots.reduce((sum, b) => sum + b.totalPnlLamports, 0);

        return {
            totalBots: userBots.length,
            runningBots: userBots.filter((b) => b.status === "running").length,
            totalTrades,
            winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
            totalPnlSOL: totalPnlLamports / LAMPORTS_PER_SOL,
            activePositions: activePositions.length,
            recentTrades: recentPositions.slice(0, 10).map((p) => ({
                pool: p.poolName,
                pnlSOL: (p.realizedPnlLamports ?? 0) / LAMPORTS_PER_SOL,
                duration: p.exitTimestamp && p.entryTimestamp
                    ? `${Math.round((p.exitTimestamp - p.entryTimestamp) / 60000)}min`
                    : "unknown",
                exitReason: p.exitReason ?? "unknown",
            })),
        };
    } catch (error) {
        logger.warn({ error }, "Failed to build portfolio context");
        return undefined;
    }
}

export default ai;
