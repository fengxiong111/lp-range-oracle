import { analyzeToken } from "./src/index.js";
const address = process.argv[2];
if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error("INVALID_EVM_ADDRESS");
const artifact = await analyzeToken(address);
console.log(JSON.stringify(artifact, null, 2));
