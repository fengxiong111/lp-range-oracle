import { fetchConfigured, fetchDexScreener, fetchGecko, enhancementAdapters } from "./adapters/public.js";
import { buildAnalysis } from "./analytics/engine.js";
export async function analyzeToken(address: string) { const sources = [...await fetchConfigured(address), await fetchGecko(address), await fetchDexScreener(address), ...enhancementAdapters(address)]; return buildAnalysis(address, sources); }
export { buildAnalysis } from "./analytics/engine.js";
export type * from "./schema/types.js";
