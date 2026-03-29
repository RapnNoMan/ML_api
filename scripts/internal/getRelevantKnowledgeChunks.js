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
  let ragQueryText = String(message ?? "");
  const recentPromptsResult = await getRecentUserPrompts({
    supId,
    supKey,
    agentId,
    anonId,
    chatId,
    limit: VECTOR_HISTORY_LIMIT,
  });
  if (!recentPromptsResult.ok) return recentPromptsResult;

  const promptParts = Array.isArray(recentPromptsResult.prompts)
    ? [...recentPromptsResult.prompts, String(message)]
    : [String(message)];
  ragQueryText = promptParts.filter(Boolean).join("\n");

  const embeddingResult = await getVoyageMessageEmbedding({
    apiKey: voyageApiKey,
    message: ragQueryText,
    model: VOYAGE_EMBED_MODEL,
    inputType: "query",
    outputDimension,
  });
  if (!embeddingResult.ok) return embeddingResult;

  const vectorResult = await getVectorSearchTextsWithScores({
    supId,
    supKey,
    agentId,
    embedding: embeddingResult.embedding,
  });
  if (!vectorResult.ok) return vectorResult;

  const vectorCandidates = (Array.isArray(vectorResult.items) ? vectorResult.items : [])
    .map(normalizeChunkCandidate)
    .filter(Boolean);
  const filteredVectorCandidates = vectorCandidates.filter((item) => {
    const score = toFiniteNumber(item.score);
    return score === null || score >= VECTOR_SCORE_MIN;
  });

  const skipRerank = hasHighVectorConfidence(filteredVectorCandidates);
  let rerankUsed = false;
  let rerankCandidates = filteredVectorCandidates;

  if (!skipRerank && filteredVectorCandidates.length > 1) {
    const rerankResult = await rerankVoyageDocuments({
      apiKey: voyageApiKey,
      query: String(message),
      documents: filteredVectorCandidates.map((item) => item.chunk_text),
      model: VOYAGE_RERANK_MODEL,
      topK: VECTOR_DIRECT_TOP_K,
    });
    if (!rerankResult.ok) return rerankResult;

    rerankUsed = true;
    rerankCandidates = (Array.isArray(rerankResult.results) ? rerankResult.results : [])
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
      .filter(Boolean)
      .filter((item) => {
        const score = toFiniteNumber(item.rerank_score);
        return score === null || score >= RERANK_SCORE_MIN;
      });
  }

  const finalCandidates = (rerankUsed ? rerankCandidates : filteredVectorCandidates)
    .slice(0, VECTOR_DIRECT_TOP_K);

  return {
    ok: true,
    chunks: finalCandidates.map((item) => item.chunk_text),
    debug: {
      rerankUsed,
      skipRerank,
      vectorCandidateCount: vectorCandidates.length,
      vectorFilteredCount: filteredVectorCandidates.length,
      finalChunkCount: finalCandidates.length,
      topVectorScores: vectorCandidates.slice(0, 5).map((item) => item.score),
      topRerankScores: rerankUsed
        ? rerankCandidates.slice(0, 5).map((item) => item.rerank_score ?? null)
        : [],
    },
  };
}

module.exports = {
  getRelevantKnowledgeChunks,
};
