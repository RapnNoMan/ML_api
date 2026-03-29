const { getRecentUserPrompts } = require("./getRecentUserPrompts");
const { getVoyageMessageEmbedding } = require("./getVoyageMessageEmbedding");
const { getVectorSearchTextsWithScores } = require("./getVectorSearchTextsWithScores");
const { rerankVoyageDocuments } = require("./rerankVoyageDocuments");

const VOYAGE_EMBED_MODEL = "voyage-4-large";
const VOYAGE_RERANK_MODEL = "rerank-2.5";
const VECTOR_HISTORY_LIMIT = 1;
const VECTOR_DIRECT_TOP_K = 5;
const VECTOR_SCORE_MIN = 0.2;
const RERANK_SCORE_MIN = 0.1;
const DIRECT_SKIP_RERANK_THRESHOLDS = [0.88, 0.68, 0.58, 0.5];

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampUnitScore(value) {
  const num = toFiniteNumber(value);
  if (num === null) return null;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function normalizeChunkCandidate(item) {
  const chunkText = String(
    item?.chunk_text ?? item?.chunkText ?? item?.text ?? item?.document ?? ""
  ).trim();
  if (!chunkText) return null;

  const distance = toFiniteNumber(item?.distance);
  const score =
    clampUnitScore(item?.score ?? item?.similarity) ??
    (distance === null ? null : clampUnitScore(1 - distance));

  return {
    chunk_text: chunkText,
    distance,
    score,
  };
}

function hasHighVectorConfidence(items) {
  const topItems = (Array.isArray(items) ? items : []).slice(0, DIRECT_SKIP_RERANK_THRESHOLDS.length);
  if (topItems.length === 0) return false;

  return topItems.every((item, index) => {
    const score = toFiniteNumber(item?.score);
    return score !== null && score >= DIRECT_SKIP_RERANK_THRESHOLDS[index];
  });
}

async function getRelevantKnowledgeChunks({
  supId,
  supKey,
  voyageApiKey,
  outputDimension,
  agentId,
  anonId,
  chatId,
  message,
}) {
  const timings = {
    recentPromptsMs: null,
    embeddingMs: null,
    vectorSearchMs: null,
    rerankMs: null,
  };
  let ragQueryText = String(message ?? "");
  const recentPromptsStartedAt = Date.now();
  const recentPromptsResult = await getRecentUserPrompts({
    supId,
    supKey,
    agentId,
    anonId,
    chatId,
    limit: VECTOR_HISTORY_LIMIT,
  });
  timings.recentPromptsMs = Date.now() - recentPromptsStartedAt;
  if (!recentPromptsResult.ok) return recentPromptsResult;

  const promptParts = Array.isArray(recentPromptsResult.prompts)
    ? [...recentPromptsResult.prompts, String(message)]
    : [String(message)];
  ragQueryText = promptParts.filter(Boolean).join("\n");

  const embeddingStartedAt = Date.now();
  const embeddingResult = await getVoyageMessageEmbedding({
    apiKey: voyageApiKey,
    message: ragQueryText,
    model: VOYAGE_EMBED_MODEL,
    inputType: "query",
    outputDimension,
  });
  timings.embeddingMs = Date.now() - embeddingStartedAt;
  if (!embeddingResult.ok) return embeddingResult;

  const vectorSearchStartedAt = Date.now();
  const vectorResult = await getVectorSearchTextsWithScores({
    supId,
    supKey,
    agentId,
    embedding: embeddingResult.embedding,
  });
  timings.vectorSearchMs = Date.now() - vectorSearchStartedAt;
  if (!vectorResult.ok) return vectorResult;

  const vectorCandidates = (Array.isArray(vectorResult.items) ? vectorResult.items : [])
    .map(normalizeChunkCandidate)
    .filter(Boolean);
  const skippedByVectorThreshold = [];
  const filteredVectorCandidates = vectorCandidates.filter((item) => {
    const score = toFiniteNumber(item.score);
    const keep = score === null || score >= VECTOR_SCORE_MIN;
    if (!keep) {
      skippedByVectorThreshold.push({
        ...item,
        skipped_reason: "vector_score_below_threshold",
      });
    }
    return keep;
  });

  const skipRerank = hasHighVectorConfidence(filteredVectorCandidates);
  let rerankUsed = false;
  let rerankCandidates = filteredVectorCandidates;
  let rerankReturnedCandidates = [];
  const skippedByRerankThreshold = [];

  if (!skipRerank && filteredVectorCandidates.length > 1) {
    const rerankStartedAt = Date.now();
    const rerankResult = await rerankVoyageDocuments({
      apiKey: voyageApiKey,
      query: String(message),
      documents: filteredVectorCandidates.map((item) => item.chunk_text),
      model: VOYAGE_RERANK_MODEL,
      topK: VECTOR_DIRECT_TOP_K,
    });
    timings.rerankMs = Date.now() - rerankStartedAt;
    if (!rerankResult.ok) return rerankResult;

    rerankUsed = true;
    rerankReturnedCandidates = (Array.isArray(rerankResult.results) ? rerankResult.results : [])
      .map((item) => {
        const index = Number(item?.index);
        if (!Number.isInteger(index) || index < 0 || index >= filteredVectorCandidates.length) {
          return null;
        }
        return {
          ...filteredVectorCandidates[index],
          rerank_score: clampUnitScore(item?.relevance_score ?? item?.score),
        };
      })
      .filter(Boolean);

    rerankCandidates = rerankReturnedCandidates.filter((item) => {
        const score = toFiniteNumber(item.rerank_score);
        const keep = score === null || score >= RERANK_SCORE_MIN;
        if (!keep) {
          skippedByRerankThreshold.push({
            ...item,
            skipped_reason: "rerank_score_below_threshold",
          });
        }
        return keep;
      });
  }

  const finalCandidates = (rerankUsed ? rerankCandidates : filteredVectorCandidates)
    .slice(0, VECTOR_DIRECT_TOP_K);

  const finalChunkTexts = finalCandidates.map((item) => item.chunk_text);

  return {
    ok: true,
    chunks: finalChunkTexts,
    debug: {
      queryText: ragQueryText,
      queryTextLength: ragQueryText.length,
      thresholds: {
        vectorMinScore: VECTOR_SCORE_MIN,
        rerankMinScore: RERANK_SCORE_MIN,
        skipRerankThresholds: DIRECT_SKIP_RERANK_THRESHOLDS,
        maxFinalChunks: VECTOR_DIRECT_TOP_K,
      },
      timings,
      rerankUsed,
      skipRerank,
      vectorCandidateCount: vectorCandidates.length,
      vectorFilteredCount: filteredVectorCandidates.length,
      finalChunkCount: finalCandidates.length,
      topVectorScores: vectorCandidates.slice(0, 5).map((item) => item.score),
      topRerankScores: rerankUsed
        ? rerankCandidates.slice(0, 5).map((item) => item.rerank_score ?? null)
        : [],
      vectorCandidates,
      skippedByVectorThreshold,
      rerankReturnedCandidates,
      skippedByRerankThreshold,
      finalCandidates,
      finalChunkTexts,
    },
  };
}

module.exports = {
  getRelevantKnowledgeChunks,
};
