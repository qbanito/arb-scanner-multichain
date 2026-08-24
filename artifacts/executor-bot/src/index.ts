import { buildChainClients } from "./chains";
import { loadConfig } from "./config";
import { runLoop } from "./executor";
import { runHighValueWatcher } from "./liquidation/highValueWatcher";
import { runLiquidationLoop } from "./liquidation/liquidationExecutor";
import { logger } from "./logger";

const config = loadConfig();
const chainClients = buildChainClients(config);

runLoop(config, chainClients).catch((err) => {
  logger.fatal({ err }, "executor-bot crashed");
  process.exit(1);
});

if (config.enableLiquidations) {
  if (!config.graphApiKey) {
    logger.warn(
      "ENABLE_LIQUIDATIONS=true but GRAPH_API_KEY is not set — liquidation scanner will not start",
    );
  } else {
    runLiquidationLoop(config, chainClients).catch((err) => {
      logger.fatal({ err }, "liquidation scanner crashed");
      process.exit(1);
    });
    runHighValueWatcher(config, chainClients).catch((err) => {
      logger.fatal({ err }, "high-value liquidation watcher crashed");
      process.exit(1);
    });
  }
}
