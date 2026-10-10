import { describeProvider } from "./providers.js";
import { runStorageContract } from "./contract.js";

describeProvider("memory", (harness) => {
  runStorageContract(harness.name, (options) => harness.open(options));
});
