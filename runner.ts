import { analyzeToken } from "./src/index.js"; import { buildAnalysisFromTruth } from "./src/truth.js"; import { readFile } from "node:fs/promises";
const address = process.argv[2];
if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("INVALID_EVM_ADDRESS");
const artifact = process.argv[3] ? buildAnalysisFromTruth(JSON.parse(await readFile(process.argv[3], "utf8"))) : await analyzeToken(address);
console.log(JSON.stringify(artifact, null, 2));
